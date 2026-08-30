// @vitest-environment node
/**
 * The sync server, exercised over real HTTP against a real folder.
 *
 * Nothing here is mocked: a temporary directory stands in for the vault, the
 * server listens on a real port, and every assertion about what is on disk is
 * read straight back with `fs`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSyncServer } from './index.mjs'
import { VaultStore, hashOf } from './vaultStore.mjs'
import { generateToken, parseArgs, tokensMatch } from './config.mjs'

const TOKEN = 'a'.repeat(43)

/** @type {string} */
let vault
/** @type {import('node:http').Server} */
let listener
/** @type {string} */
let base
/** @type {{ startWatching: Function, store: VaultStore }} */
let sync
/** @type {AbortController} */
let watching

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'spacefore-server-'))
  sync = createSyncServer({ vault, token: TOKEN, distDir: join(vault, '__no_dist__') })
  listener = createServer((request, response) => void sync.handle(request, response))
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  watching = new AbortController()
  void sync.startWatching(watching.signal)
})

afterAll(async () => {
  watching.abort()
  await new Promise((resolve) => listener.close(resolve))
  await rm(vault, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const name of ['Home.md', 'Journal.md']) {
    await rm(join(vault, name), { force: true })
  }
  await rm(join(vault, 'Ideas'), { recursive: true, force: true })
  await writeFile(join(vault, 'Home.md'), '# Home\n\nSee [[Ideas/Seed]].\n')
  await mkdir(join(vault, 'Ideas'), { recursive: true })
  await writeFile(join(vault, 'Ideas/Seed.md'), '# Seed\n')
})

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
function call(path, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })
}

const onDisk = (name) => readFile(join(vault, name), 'utf8')

describe('access control', () => {
  it('answers health without a token, and nothing else', async () => {
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, service: 'spacefore' })

    const files = await fetch(`${base}/api/files`)
    expect(files.status).toBe(401)
    // The refusal must not describe the vault it is protecting.
    expect(JSON.stringify(await files.json())).not.toMatch(/Home|Ideas/)
  })

  it('rejects a wrong token, including one that is a prefix of the real one', async () => {
    for (const bad of ['', 'nope', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const response = await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${bad}` } })
      expect(response.status, `token ${JSON.stringify(bad)}`).toBe(401)
    }
  })

  it('compares tokens without throwing on a length mismatch', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
    expect(tokensMatch('abc', '')).toBe(false)
    // @ts-expect-error deliberately wrong types
    expect(tokensMatch(null, undefined)).toBe(false)
  })

  it('generates tokens with real entropy', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()))
    expect(tokens.size).toBe(50)
    expect([...tokens][0].length).toBeGreaterThanOrEqual(43)
  })
})

describe('listing', () => {
  it('lists markdown and attachments, skipping dot-directories', async () => {
    await mkdir(join(vault, '.obsidian'), { recursive: true })
    await writeFile(join(vault, '.obsidian/workspace.md'), 'private')
    await mkdir(join(vault, 'node_modules'), { recursive: true })
    await writeFile(join(vault, 'node_modules/junk.md'), 'junk')
    await writeFile(join(vault, 'diagram.png'), Buffer.from([0x89, 0x50]))

    const { files } = await (await call('/api/files')).json()
    const paths = files.map((file) => file.path)
    expect(paths).toContain('Home.md')
    expect(paths).toContain('Ideas/Seed.md')
    expect(paths).toContain('diagram.png')
    expect(paths).not.toContain('.obsidian/workspace.md')
    expect(paths).not.toContain('node_modules/junk.md')
    expect(files.find((file) => file.path === 'diagram.png').isMarkdown).toBe(false)

    await rm(join(vault, 'diagram.png'), { force: true })
    await rm(join(vault, '.obsidian'), { recursive: true, force: true })
    await rm(join(vault, 'node_modules'), { recursive: true, force: true })
  })

  it('reports a hash that matches the bytes on disk', async () => {
    const { files } = await (await call('/api/files')).json()
    const entry = files.find((file) => file.path === 'Home.md')
    expect(entry.hash).toBe(hashOf(await readFile(join(vault, 'Home.md'))))
  })
})

describe('reading and writing', () => {
  it('round-trips a file and tags it with its hash', async () => {
    const response = await call('/api/file?path=Home.md')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('# Home')
    expect(response.headers.get('etag')).toBe(`"${hashOf(body)}"`)
  })

  it('writes to disk and announces the change', async () => {
    const response = await call('/api/file?path=Home.md', { method: 'PUT', body: '# Home\n\nEdited.\n' })
    expect(response.status).toBe(200)
    expect(await onDisk('Home.md')).toBe('# Home\n\nEdited.\n')
  })

  it('creates intermediate folders', async () => {
    const response = await call('/api/file?path=Deep/Down/Here.md', { method: 'PUT', body: '# Here\n' })
    expect(response.status).toBe(200)
    expect(await onDisk('Deep/Down/Here.md')).toBe('# Here\n')
    await rm(join(vault, 'Deep'), { recursive: true, force: true })
  })

  it('refuses a conditional write when the file changed underneath', async () => {
    const stale = hashOf('# Home\n\nSee [[Ideas/Seed]].\n')
    await writeFile(join(vault, 'Home.md'), '# Home\n\nChanged by another device.\n')

    const response = await call('/api/file?path=Home.md', {
      method: 'PUT',
      headers: { 'if-match': `"${stale}"` },
      body: '# Home\n\nMy version.\n',
    })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.currentHash).toBe(hashOf('# Home\n\nChanged by another device.\n'))
    // The other device's work is still there — nothing was overwritten.
    expect(await onDisk('Home.md')).toBe('# Home\n\nChanged by another device.\n')
  })

  it('accepts a conditional write when the hash still matches', async () => {
    const current = hashOf(await readFile(join(vault, 'Home.md')))
    const response = await call('/api/file?path=Home.md', {
      method: 'PUT',
      headers: { 'if-match': `"${current}"` },
      body: '# Home\n\nAgreed.\n',
    })
    expect(response.status).toBe(200)
    expect(await onDisk('Home.md')).toBe('# Home\n\nAgreed.\n')
  })

  it('supports create-only writes with If-Match: *', async () => {
    const created = await call('/api/file?path=Fresh.md', { method: 'PUT', headers: { 'if-match': '*' }, body: 'new' })
    expect(created.status).toBe(200)
    const again = await call('/api/file?path=Fresh.md', { method: 'PUT', headers: { 'if-match': '*' }, body: 'other' })
    expect(again.status).toBe(409)
    expect(await onDisk('Fresh.md')).toBe('new')
    await rm(join(vault, 'Fresh.md'), { force: true })
  })

  it('deletes and renames', async () => {
    const renamed = await call('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'Ideas/Seed.md', to: 'Ideas/Sprout.md' }),
    })
    expect(renamed.status).toBe(200)
    expect(await onDisk('Ideas/Sprout.md')).toBe('# Seed\n')

    const removed = await call('/api/file?path=Ideas/Sprout.md', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    await expect(onDisk('Ideas/Sprout.md')).rejects.toThrow()
  })

  it('will not rename onto an existing file', async () => {
    const response = await call('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'Ideas/Seed.md', to: 'Home.md' }),
    })
    expect(response.status).toBe(409)
    expect(await onDisk('Home.md')).toContain('# Home')
  })

  it('404s for a file that is not there', async () => {
    expect((await call('/api/file?path=Nope.md')).status).toBe(404)
    expect((await call('/api/file?path=Nope.md', { method: 'DELETE' })).status).toBe(404)
  })
})

describe('a request can never leave the vault', () => {
  const escapes = [
    '../outside.md',
    '..%2Foutside.md',
    'Ideas/../../outside.md',
    '/etc/passwd',
    '//etc/passwd',
    'Ideas/./../../outside.md',
    '.obsidian/workspace.md',
    'node_modules/evil.md',
  ]

  it.each(escapes)('refuses %s', async (path) => {
    const read = await call(`/api/file?path=${encodeURIComponent(path)}`)
    expect([400, 404]).toContain(read.status)

    const write = await call(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: 'pwned' })
    expect([400, 404]).toContain(write.status)
  })

  it('leaves nothing behind outside the vault', async () => {
    await call('/api/file?path=..%2Fescaped.md', { method: 'PUT', body: 'pwned' })
    await expect(readFile(join(vault, '..', 'escaped.md'), 'utf8')).rejects.toThrow()
  })

  it('rejects a null byte and an empty path', async () => {
    expect((await call('/api/file?path=')).status).toBe(400)
    expect((await call(`/api/file?path=${encodeURIComponent('a\0b.md')}`)).status).toBe(400)
  })
})

describe('change events', () => {
  /**
   * Watch the event stream until one matches, or the wait runs out.
   *
   * Waiting for a *specific* event rather than a count keeps this honest under
   * load: `fs.watch` can take its time when the machine is busy, and a fixed
   * budget turns that into a failure that says nothing about the server.
   *
   * @param {(event: any) => boolean} matches
   * @param {() => Promise<void>} trigger
   */
  async function waitFor(matches, trigger, timeoutMs = 15_000) {
    const controller = new AbortController()
    const response = await call('/api/events', { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    /** @type {any[]} */
    const events = []
    let buffer = ''

    let found = false
    const pump = (async () => {
      while (!found) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const chunk of buffer.split('\n\n')) {
          const line = chunk.trim()
          if (!line.startsWith('data: ')) continue
          const event = JSON.parse(line.slice(6))
          events.push(event)
          if (matches(event)) found = true
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
      }
    })().catch(() => {})

    await new Promise((resolve) => setTimeout(resolve, 100))
    await trigger()
    await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
    controller.abort()
    return { found, events }
  }

  it('announces an API write to every connected device', async () => {
    const { found } = await waitFor(
      (event) => event.type === 'upsert' && event.path === 'Home.md',
      async () => {
        await call('/api/file?path=Home.md', { method: 'PUT', body: '# Home\n\nvia the api\n' })
      },
    )
    expect(found).toBe(true)
  })

  it('announces a file changed outside the app', async () => {
    const { found, events } = await waitFor(
      (event) => event.type === 'upsert' && event.path === 'Journal.md',
      async () => {
        await writeFile(join(vault, 'Journal.md'), '# Journal\n\nwritten by another editor\n')
      },
    )
    expect(found, `saw ${JSON.stringify(events)}`).toBe(true)
  })

  it('never announces the scratch file an atomic write moves into place', async () => {
    const { events } = await waitFor(
      (event) => event.type === 'upsert' && event.path === 'Home.md',
      async () => {
        await call('/api/file?path=Home.md', { method: 'PUT', body: '# Home\n\natomic\n' })
      },
    )
    expect(events.some((event) => String(event.path ?? '').includes('.spacefore-tmp-'))).toBe(false)
    expect(events.some((event) => String(event.path ?? '').endsWith('.tmp'))).toBe(false)
  })

  it('tags an API write with the device that made it, so it can ignore its own echo', async () => {
    const { events } = await waitFor(
      (event) => event.path === 'Home.md' && event.origin === 'device-a',
      async () => {
        await call('/api/file?path=Home.md', {
          method: 'PUT',
          headers: { 'x-spacefore-client': 'device-a' },
          body: '# Home\n\ntagged\n',
        })
      },
    )
    expect(events.find((event) => event.path === 'Home.md')?.origin).toBe('device-a')
  })
})

describe('parseArgs', () => {
  it('reads the options a person would actually type', () => {
    const options = parseArgs(['--vault', '/tmp/notes', '--port', '5000', '--host', '0.0.0.0'])
    expect(options).toMatchObject({ vault: '/tmp/notes', port: 5000, host: '0.0.0.0' })
  })

  it('takes the vault as a bare argument', () => {
    expect(parseArgs(['/tmp/notes']).vault).toBe('/tmp/notes')
  })

  it('refuses nonsense rather than starting wrong', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/port/)
    expect(() => parseArgs(['--port', '99999'])).toThrow(/port/)
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/)
    expect(() => parseArgs(['--vault'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--tls-cert', 'c.pem'])).toThrow(/together/)
  })

  it('defaults to loopback, so the vault is not exposed by accident', () => {
    expect(parseArgs([]).host).toBe('127.0.0.1')
  })
})

describe('VaultStore', () => {
  it('writes atomically, leaving no temporary files behind', async () => {
    const store = new VaultStore(vault)
    await store.write('Atomic.md', Buffer.from('content'))
    const { files } = await (await call('/api/files')).json()
    expect(files.some((file) => file.path.endsWith('.tmp'))).toBe(false)
    expect(await onDisk('Atomic.md')).toBe('content')
    await rm(join(vault, 'Atomic.md'), { force: true })
  })

  it('does not touch the file when the content is unchanged', async () => {
    const store = new VaultStore(vault)
    const before = await store.write('Same.md', Buffer.from('same'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = await store.write('Same.md', Buffer.from('same'))
    expect(after.mtime).toBe(before.mtime)
    await rm(join(vault, 'Same.md'), { force: true })
  })
})

describe('the change stream accepts a query token', () => {
  it('authenticates EventSource, which cannot send headers', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/api/events?token=${encodeURIComponent(TOKEN)}`, { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    controller.abort()
  })

  it('still refuses a wrong query token', async () => {
    const response = await fetch(`${base}/api/events?token=nope`)
    expect(response.status).toBe(401)
  })

  it('does not accept a query token anywhere else', async () => {
    const response = await fetch(`${base}/api/files?token=${encodeURIComponent(TOKEN)}`)
    expect(response.status).toBe(401)
  })
})
