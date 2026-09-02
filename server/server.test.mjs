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

describe('the whole vault in one response', () => {
  /** Read an NDJSON body into its records. */
  const records = async (response) =>
    (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

  it('sends every note, with its text, in one request', async () => {
    const response = await call('/api/bundle')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/ndjson/)

    const lines = await records(response)
    expect(lines[0]).toMatchObject({ type: 'head', notes: 2 })
    expect(lines.at(-1)).toEqual({ type: 'end' })

    const notes = lines.filter((line) => line.type === 'note')
    expect(notes.map((n) => n.path).sort()).toEqual(['Home.md', 'Ideas/Seed.md'])
    expect(notes.find((n) => n.path === 'Home.md').text).toBe(await onDisk('Home.md'))
    // The hash is the same one a listing reports, so a device can use the
    // bundle to prime its conditional writes.
    const listed = (await (await call('/api/files')).json()).files
    for (const note of notes) {
      expect(note.hash).toBe(listed.find((f) => f.path === note.path).hash)
    }
  })

  it('names attachments without shipping their bytes', async () => {
    await writeFile(join(vault, 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const lines = await records(await call('/api/bundle'))

    const attachment = lines.find((line) => line.type === 'attachment')
    expect(attachment).toMatchObject({ path: 'diagram.png', isMarkdown: false })
    expect(attachment.text).toBeUndefined()
    expect(lines.some((line) => line.type === 'note' && line.path === 'diagram.png')).toBe(false)

    await rm(join(vault, 'diagram.png'), { force: true })
  })

  it('leaves out what the rest of the API leaves out', async () => {
    await mkdir(join(vault, '.obsidian'), { recursive: true })
    await writeFile(join(vault, '.obsidian/workspace.md'), 'private\n')
    await mkdir(join(vault, 'node_modules'), { recursive: true })
    await writeFile(join(vault, 'node_modules/junk.md'), 'junk\n')

    const body = await (await call('/api/bundle')).text()
    expect(body).not.toMatch(/obsidian|node_modules|private|junk/)

    await rm(join(vault, '.obsidian'), { recursive: true, force: true })
    await rm(join(vault, 'node_modules'), { recursive: true, force: true })
  })

  it('needs the token like everything else', async () => {
    expect((await fetch(`${base}/api/bundle`)).status).toBe(401)
  })
})

describe('hashes are not recomputed for files that did not change', () => {
  it('reads each file once across repeated listings', async () => {
    const store = new VaultStore(vault)
    const first = await store.list()
    expect(first.length).toBeGreaterThan(0)

    // Nothing has changed, so a second listing must not read a single byte.
    let reads = 0
    const realHashFor = store.hashFor.bind(store)
    store.hashFor = async (absolute, info) => {
      const before = store.hashes.get(absolute)
      const hash = await realHashFor(absolute, info)
      if (!before || before.hash !== hash || before.mtimeMs !== info.mtimeMs) reads += 1
      return hash
    }
    const second = await store.list()
    expect(second).toEqual(first)
    expect(reads).toBe(0)
  })

  it('notices a file that actually changed', async () => {
    const store = new VaultStore(vault)
    const before = (await store.list()).find((f) => f.path === 'Home.md')

    // A whole millisecond later, so the mtime genuinely differs.
    await new Promise((resolve) => setTimeout(resolve, 12))
    await writeFile(join(vault, 'Home.md'), '# Home\n\nrewritten by something else\n')

    const after = (await store.list()).find((f) => f.path === 'Home.md')
    expect(after.hash).not.toBe(before.hash)
    expect(after.hash).toBe(hashOf(await onDisk('Home.md')))
  })

  it('forgets a file it removed, and moves the hash with a rename', async () => {
    const store = new VaultStore(vault)
    await store.list()
    const home = join(vault, 'Home.md')
    const hash = store.hashes.get(home).hash

    await store.rename('Home.md', 'Moved.md')
    expect(store.hashes.has(home)).toBe(false)
    expect(store.hashes.get(join(vault, 'Moved.md')).hash).toBe(hash)

    await store.remove('Moved.md')
    expect(store.hashes.has(join(vault, 'Moved.md'))).toBe(false)
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

describe('being launched by another program', () => {
  it('lets the system pick a port, and says which one it picked', async () => {
    const { spawn } = await import('node:child_process')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { fileURLToPath } = await import('node:url')

    const folder = await mkdtemp(join(tmpdir(), 'spacefore-ready-'))
    const entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
    const child = spawn(process.execPath, [entry, '--vault', folder, '--port', '0', '--print-ready', '--token', TOKEN])

    try {
      const ready = await new Promise((resolvePromise, rejectPromise) => {
        let buffered = ''
        const timer = setTimeout(() => rejectPromise(new Error(`no ready line; stdout was:\n${buffered}`)), 15_000)
        child.stdout.on('data', (chunk) => {
          buffered += String(chunk)
          const line = buffered.split('\n').find((candidate) => candidate.startsWith('{'))
          if (!line) return
          clearTimeout(timer)
          resolvePromise(JSON.parse(line))
        })
        child.on('error', rejectPromise)
      })

      expect(ready.spacefore).toBe('ready')
      expect(ready.token).toBe(TOKEN)
      expect(ready.vault).toBe(folder)
      // The whole point: a real port, not the 0 that was asked for.
      expect(ready.port).toBeGreaterThan(0)
      expect(ready.url).toBe(`http://127.0.0.1:${ready.port}/`)

      // …and it is genuinely listening there.
      const health = await fetch(`${ready.url}api/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ ok: true, service: 'spacefore' })
    } finally {
      child.kill('SIGTERM')
      await rm(folder, { recursive: true, force: true })
    }
  }, 30_000)

  it('stops by itself when whatever launched it goes away', async () => {
    const { spawn } = await import('node:child_process')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { fileURLToPath } = await import('node:url')

    const folder = await mkdtemp(join(tmpdir(), 'spacefore-leash-'))
    const entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
    const child = spawn(process.execPath, [entry, '--vault', folder, '--port', '0', '--print-ready', '--token', TOKEN], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    try {
      const ready = await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('no ready line')), 15_000)
        let buffered = ''
        child.stdout.on('data', (chunk) => {
          buffered += String(chunk)
          const line = buffered.split('\n').find((candidate) => candidate.startsWith('{'))
          if (!line) return
          clearTimeout(timer)
          resolvePromise(JSON.parse(line))
        })
      })
      expect((await fetch(`${ready.url}api/health`)).status).toBe(200)

      // The parent lets go of stdin — which is what happens when it quits or
      // crashes. Nothing is signalled; the server has to notice on its own.
      child.stdin.end()

      const code = await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('it was still running 10 s later')), 10_000)
        child.on('exit', (value) => {
          clearTimeout(timer)
          resolvePromise(value)
        })
      })
      expect(code).toBe(0)

      // …and it really let go of the port.
      await expect(fetch(`${ready.url}api/health`)).rejects.toThrow()
    } finally {
      child.kill('SIGKILL')
      await rm(folder, { recursive: true, force: true })
    }
  }, 40_000)

  it('keeps the token off stdout unless it was asked for', async () => {
    const { spawn } = await import('node:child_process')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { fileURLToPath } = await import('node:url')

    const folder = await mkdtemp(join(tmpdir(), 'spacefore-quiet-'))
    const entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
    const child = spawn(process.execPath, [entry, '--vault', folder, '--port', '0', '--token', TOKEN])

    try {
      const output = await new Promise((resolvePromise) => {
        let buffered = ''
        child.stdout.on('data', (chunk) => {
          buffered += String(chunk)
          if (buffered.includes('Reaching it from outside')) resolvePromise(buffered)
        })
        setTimeout(() => resolvePromise(buffered), 12_000)
      })
      // The banner still shows a person their token — that is what it is for —
      // but no machine-readable line appears for a caller that did not ask.
      expect(output).not.toMatch(/"spacefore":"ready"/)
    } finally {
      child.kill('SIGTERM')
      await rm(folder, { recursive: true, force: true })
    }
  }, 30_000)
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


describe('a folder that vanishes while the watcher is scanning it', () => {
  /** A server of its own, so emitting an error here cannot disturb the rest. */
  async function watched() {
    const root = await mkdtemp(join(tmpdir(), 'spacefore-watch-'))
    await writeFile(join(root, 'Home.md'), '# Home\n')
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(root, '__no_dist__') })
    const controller = new AbortController()
    const watcher = server.startWatching(controller.signal)
    return { root, watcher, stop: () => controller.abort() }
  }

  const enoent = () => Object.assign(new Error('scandir failed'), { code: 'ENOENT', syscall: 'scandir' })

  it('listens for the watcher’s errors at all', async () => {
    // This is the whole bug. On Linux a recursive watch is emulated in
    // JavaScript, and a folder deleted mid-scan is reported by *emitting* an
    // error — which an EventEmitter with no listener rethrows, killing the
    // process. It never travels through the async iterator, so the `for await`
    // this used to be written as could not catch it however it was wrapped.
    const { watcher, stop } = await watched()
    try {
      expect(watcher).not.toBeNull()
      expect(watcher.listenerCount('error')).toBeGreaterThan(0)
    } finally {
      stop()
    }
  })

  it('shrugs off an ENOENT and keeps watching the rest of the vault', async () => {
    const { watcher, stop } = await watched()
    let closed = false
    const close = watcher.close.bind(watcher)
    watcher.close = () => {
      closed = true
      close()
    }
    try {
      expect(() => watcher.emit('error', enoent())).not.toThrow()
      // The folder is gone and there is nothing to do about it; everything
      // else in the vault is still worth watching.
      expect(closed).toBe(false)
    } finally {
      stop()
    }
  })

  it('gives up, and says so, on an error that is not a missing folder', async () => {
    const { watcher, stop } = await watched()
    let closed = false
    const close = watcher.close.bind(watcher)
    watcher.close = () => {
      closed = true
      close()
    }
    const said = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (text) => {
      said.push(String(text))
      return true
    }
    try {
      expect(() => watcher.emit('error', Object.assign(new Error('too many files'), { code: 'EMFILE' }))).not.toThrow()
      expect(closed).toBe(true)
      expect(said.join('')).toMatch(/stopped watching the vault/)
    } finally {
      process.stderr.write = write
      stop()
    }
  })

  it('does not start at all once the signal is already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spacefore-watch-'))
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(root, '__no_dist__') })
    const controller = new AbortController()
    controller.abort()
    expect(server.startWatching(controller.signal)).toBeNull()
  })
})
