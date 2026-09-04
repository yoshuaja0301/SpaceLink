// @vitest-environment node
/**
 * The sync server, exercised over real HTTP against a real folder.
 *
 * Nothing here is mocked: a temporary directory stands in for the vault, the
 * server listens on a real port, and every assertion about what is on disk is
 * read straight back with `fs`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { accountForSession, addAccount, loadAccounts, saveAccounts, sessionId, verifyLogin } from './accounts.mjs'
import { createSyncServer, takeKeys } from './index.mjs'
import { VaultConflictError, VaultStore, hashOf } from './vaultStore.mjs'
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
/** @type {import('node:fs').FSWatcher | null} */
let watcher

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'spacelink-server-'))
  sync = createSyncServer({ vault, token: TOKEN, distDir: join(vault, '__no_dist__') })
  listener = createServer((request, response) => void sync.handle(request, response))
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  watching = new AbortController()
  watcher = sync.startWatching(watching.signal)
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
    expect(await health.json()).toMatchObject({ ok: true, service: 'spacelink' })

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

  it('says a note is too large, and leaves the connection fit to use again', async () => {
    // 32 MB is the cap, and the server has a sentence for exceeding it. It was
    // never delivered: the connection was destroyed before the 413 could leave,
    // so a reader saving an enormous note saw a network error and no reason.
    //
    // Answering without hanging up opened the opposite hole: the megabytes the
    // server stopped reading stay queued on a keep-alive connection, and the
    // next request on it is parsed from those. Both halves are checked here
    // over one deliberate connection — one socket, kept alive — because that
    // is the only way the second failure shows at all.
    const { Agent, request: httpRequest } = await import('node:http')
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    /** Send one request over that single socket. */
    const overTheSameSocket = (path, options = {}, body = null) =>
      new Promise((done, fail) => {
        const sent = httpRequest(`${base}${path}`, { agent, headers: { authorization: `Bearer ${TOKEN}` }, ...options }, (answer) => {
          let text = ''
          answer.on('data', (chunk) => (text += String(chunk)))
          answer.on('end', () => done({ status: answer.statusCode, text }))
        })
        sent.on('error', fail)
        sent.end(body)
      })

    try {
      const refused = await overTheSameSocket('/api/file?path=TooBig.md', { method: 'PUT' }, 'x'.repeat(33 * 1024 * 1024))
      expect(refused.status).toBe(413)
      expect(JSON.parse(refused.text).error).toMatch(/too large to sync/i)

      // The next call. On a poisoned connection this hangs or resets.
      const after = await overTheSameSocket('/api/file?path=Home.md')
      expect(after.status, 'the refusal left the connection unusable').toBe(200)
      expect(after.text).toContain('# Home')
      // And nothing of the refused note was written.
      expect((await overTheSameSocket('/api/file?path=TooBig.md')).status).toBe(404)
    } finally {
      agent.destroy()
    }
  }, 60_000)

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
    expect(events.some((event) => String(event.path ?? '').includes('.spacelink-tmp-'))).toBe(false)
    expect(events.some((event) => String(event.path ?? '').endsWith('.tmp'))).toBe(false)
  })

  it('notices a note the server itself saved being deleted, and put back, outside the app', async () => {
    // Every save the server makes is an atomic replace; Node's emulated
    // recursive watch on Linux reports nothing more about a file after one.
    await call('/api/file?path=Home.md', { method: 'PUT', headers: { 'x-spacelink-client': 'device-a' }, body: '# Home\n\nsaved\n' })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const gone = await waitFor(
      (event) => event.type === 'remove' && event.path === 'Home.md',
      async () => {
        await unlink(join(vault, 'Home.md'))
      },
    )
    expect(gone.found, `saw ${JSON.stringify(gone.events)}`).toBe(true)

    const back = await waitFor(
      (event) => event.type === 'upsert' && event.path === 'Home.md',
      async () => {
        await writeFile(join(vault, 'Home.md'), '# Home\n\nsaved\n')
      },
    )
    expect(back.found, `saw ${JSON.stringify(back.events)}`).toBe(true)
  })

  it('announces the notes inside a folder that arrived whole', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'spacelink-moved-'))
    await mkdir(join(staging, 'Deeper'), { recursive: true })
    await writeFile(join(staging, 'Inside.md'), '# Inside\n')
    await writeFile(join(staging, 'Deeper/Further.md'), '# Further\n')
    try {
      // Both notes, in whatever order the folder is read.
      const wanted = new Set(['Moved/Inside.md', 'Moved/Deeper/Further.md'])
      const { found, events } = await waitFor(
        (event) => {
          if (event.type === 'upsert') wanted.delete(event.path)
          return wanted.size === 0
        },
        async () => {
          await rename(staging, join(vault, 'Moved'))
        },
      )
      expect(found, `saw ${JSON.stringify(events)}`).toBe(true)
    } finally {
      await rm(join(vault, 'Moved'), { recursive: true, force: true })
      await rm(staging, { recursive: true, force: true })
    }
  })

  it('announces the notes of a folder that was moved out whole', async () => {
    // Deleting a folder file by file is seen by that folder's own watch;
    // moving the folder away is seen only by its parent, which says nothing
    // about what was inside.
    await call('/api/files') // so the store has seen Ideas/Seed.md
    const parked = await mkdtemp(join(tmpdir(), 'spacelink-parked-'))
    try {
      const { found, events } = await waitFor(
        (event) => event.type === 'remove' && event.path === 'Ideas/Seed.md',
        async () => {
          await rename(join(vault, 'Ideas'), join(parked, 'Ideas'))
        },
      )
      expect(found, `saw ${JSON.stringify(events)}`).toBe(true)
    } finally {
      await rm(parked, { recursive: true, force: true })
    }
  })

  it('tags an API write with the device that made it, so it can ignore its own echo', async () => {
    const { events } = await waitFor(
      (event) => event.path === 'Home.md' && event.origin === 'device-a',
      async () => {
        await call('/api/file?path=Home.md', {
          method: 'PUT',
          headers: { 'x-spacelink-client': 'device-a' },
          body: '# Home\n\ntagged\n',
        })
      },
    )
    // The first Home.md event on the stream may be the watcher's echo of the
    // beforeEach write; the API's own is the one tagged.
    expect(events.some((event) => event.path === 'Home.md' && event.origin === 'device-a')).toBe(true)
    expect(events.filter((event) => event.path === 'Home.md' && event.type === 'upsert').every((event) => event.hash)).toBe(true)
  })
})

describe('being launched by another program', () => {
  it('lets the system pick a port, and says which one it picked', async () => {
    const { spawn } = await import('node:child_process')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { fileURLToPath } = await import('node:url')

    const folder = await mkdtemp(join(tmpdir(), 'spacelink-ready-'))
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

      expect(ready.spacelink).toBe('ready')
      expect(ready.token).toBe(TOKEN)
      expect(ready.vault).toBe(folder)
      // The whole point: a real port, not the 0 that was asked for.
      expect(ready.port).toBeGreaterThan(0)
      expect(ready.url).toBe(`http://127.0.0.1:${ready.port}/`)

      // …and it is genuinely listening there.
      const health = await fetch(`${ready.url}api/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ ok: true, service: 'spacelink' })
    } finally {
      child.kill('SIGTERM')
      await rm(folder, { recursive: true, force: true })
    }
  }, 30_000)

  it('starts from a path with a space in it', async () => {
    // Inside SpaceLink.app the server lives wherever the app was put — under
    // "/Applications/My Apps/" or a home folder with a space in its name. The
    // guard that decides "am I the program?" used to compare import.meta.url
    // (percent-encoded) against a URL built from the raw argv path, which
    // never matched such a path: the server loaded, ran nothing, and exited.
    const { spawn } = await import('node:child_process')
    const { cp, mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { fileURLToPath } = await import('node:url')

    const root = await mkdtemp(join(tmpdir(), 'spacelink-spaced-'))
    const copy = join(root, 'My Apps', 'SpaceLink.app', 'Contents', 'Resources', 'server')
    await cp(fileURLToPath(new URL('./', import.meta.url)), copy, { recursive: true })
    const child = spawn(process.execPath, [join(copy, 'index.mjs'), '--vault', join(root, 'vault'), '--port', '0', '--print-ready', '--token', TOKEN])

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
        child.on('exit', (code) => {
          clearTimeout(timer)
          rejectPromise(new Error(`exited with ${code} before reporting ready — the program guard did not recognise its own path`))
        })
      })
      expect(ready.spacelink).toBe('ready')
      expect((await fetch(`${ready.url}api/health`)).status).toBe(200)
    } finally {
      child.kill('SIGTERM')
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('stops by itself when whatever launched it goes away', async () => {
    const { spawn } = await import('node:child_process')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { fileURLToPath } = await import('node:url')

    const folder = await mkdtemp(join(tmpdir(), 'spacelink-leash-'))
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

    const folder = await mkdtemp(join(tmpdir(), 'spacelink-quiet-'))
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
      expect(output).not.toMatch(/"spacelink":"ready"/)
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

  it('says whether the folder was chosen or merely defaulted to', () => {
    // Serving `./vault` when nobody said otherwise is a convenience. Writing
    // it into an account record is not: it would depend on where the person
    // was standing when they typed the command, and would be kept for good.
    expect(parseArgs([]).vaultChosen).toBe(false)
    expect(parseArgs([]).vault).toMatch(/[\\/]vault$/)
    expect(parseArgs(['--vault', '/tmp/notes']).vaultChosen).toBe(true)
    expect(parseArgs(['/tmp/notes']).vaultChosen).toBe(true)
  })

  it('takes a token as it was pasted, padding and all', () => {
    // A token is copied out of a terminal, and a copy brings a newline or a
    // space with it. The server compares byte for byte, so that one character
    // is the difference between the token that was handed out and the one
    // being checked against.
    expect(parseArgs(['--token', ' abc123 ']).token).toBe('abc123')
    expect(parseArgs(['--token', '\tabc123\n']).token).toBe('abc123')
    expect(parseArgs(['--token', 'abc123']).token).toBe('abc123')
  })

  it('refuses a --token with nothing in it rather than quietly serving under another', () => {
    // `--token "$SPACELINK_TOKEN"` with the variable unset. The empty string
    // was falsy, so the stored token was used instead and printed on the ready
    // line as though it were the one that had been passed — while every device
    // was configured with the one that was meant to be.
    expect(() => parseArgs(['--token', ''])).toThrow(/--token was given nothing/)
    expect(() => parseArgs(['--token', '   '])).toThrow(/--token was given nothing/)
  })

  it('reads the account commands', () => {
    const options = parseArgs(['--accounts', '/tmp/a.json', '--add-account', 'me@example.com', '--password', 'secret'])
    expect(options).toMatchObject({
      accounts: '/tmp/a.json',
      addAccount: 'me@example.com',
      password: 'secret',
      listAccounts: false,
      setPassword: null,
    })
    expect(parseArgs(['--list-accounts']).listAccounts).toBe(true)
    expect(parseArgs(['--set-password', 'me@example.com']).setPassword).toBe('me@example.com')
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

  it('takes the same padded token the header door takes', async () => {
    // Both halves, because the bug was the disagreement between them. Node
    // strips the padding off a header value on the way in, so a token pasted
    // with the newline a terminal copy brings was accepted by every endpoint
    // and refused only here, where a query parameter arrives exactly as it was
    // written. The vault opened, listed and saved, and never received one
    // change from another device — with nothing anywhere saying why.
    const padded = `${TOKEN}\n`
    const header = await fetch(`${base}/api/files`, { headers: { authorization: `Bearer ${padded}` } })
    expect(header.status).toBe(200)
    const controller = new AbortController()
    const stream = await fetch(`${base}/api/events?token=${encodeURIComponent(padded)}`, {
      signal: controller.signal,
    })
    expect(stream.status).toBe(200)
    controller.abort()
  })

  it('is not opened by a credential that is nothing at all', async () => {
    // `tokensMatch` compares two strings, and two empty strings are equal. A
    // server built with an empty token therefore matched a caller who sent no
    // credential whatsoever, and served them every note in the vault.
    const root = await mkdtemp(join(tmpdir(), 'spacelink-blank-'))
    await writeFile(join(root, 'Private.md'), '# Private\n')
    const server = createSyncServer({ vault: root, token: '', distDir: join(root, '__no_dist__') })
    const alone = createServer((request, response) => void server.handle(request, response))
    await new Promise((resolve) => alone.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${alone.address().port}`
    try {
      expect((await fetch(`${at}/api/files`)).status).toBe(401)
      expect((await fetch(`${at}/api/files`, { headers: { authorization: 'Bearer ' } })).status).toBe(401)
      expect((await fetch(`${at}/api/events?token=`)).status).toBe(401)
    } finally {
      await new Promise((resolve) => alone.close(resolve))
      await rm(root, { recursive: true, force: true })
    }
  })
})


describe('a vault with folders in it from the start', () => {
  it('notices a note inside one of them changing in place', async () => {
    // The root is watched before the tree is walked; the walk must still
    // reach the folders that were already there.
    const root = await mkdtemp(join(tmpdir(), 'spacelink-tree-'))
    await mkdir(join(root, 'Ideas/Deeper'), { recursive: true })
    await writeFile(join(root, 'Ideas/Seed.md'), '# Seed\n')
    await writeFile(join(root, 'Ideas/Deeper/Leaf.md'), '# Leaf\n')
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(root, '__no_dist__') })
    const controller = new AbortController()
    /** @type {any[]} */
    const seen = []
    server.listeners.add({
      write: (chunk) => {
        for (const line of String(chunk).split('\n')) if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6)))
      },
    })
    const watcher = server.startWatching(controller.signal)
    try {
      expect(watcher).not.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 300)) // the walk
      await writeFile(join(root, 'Ideas/Seed.md'), '# Seed\n\nchanged in place\n')
      await writeFile(join(root, 'Ideas/Deeper/Leaf.md'), '# Leaf\n\nchanged too\n')
      const started = Date.now()
      const wanted = () => ['Ideas/Seed.md', 'Ideas/Deeper/Leaf.md'].every((path) => seen.some((event) => event.type === 'upsert' && event.path === path))
      while (!wanted() && Date.now() - started < 8_000) await new Promise((resolve) => setTimeout(resolve, 25))
      expect(wanted(), `saw ${JSON.stringify(seen)}`).toBe(true)
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * A vault whose folder is not there any more.
 *
 * With accounts this stopped being exotic: a folder is named once, in a config
 * file, and nothing checks it again. Somebody renames their notes folder, or an
 * external drive is not mounted at login, and the server is still serving that
 * account.
 *
 * On its own server, because the test removes the folder out from under it.
 */
describe('a vault whose folder has been moved away', () => {
  /** @type {string} */
  let home
  /** @type {string} */
  let notes
  /** @type {import('node:http').Server} */
  let listener
  /** @type {string} */
  let at

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'spacelink-gone-'))
    notes = join(home, 'Notes')
    await mkdir(join(notes, 'Ideas'), { recursive: true })
    await writeFile(join(notes, 'Home.md'), '# Home\n')
    await writeFile(join(notes, 'Ideas/Seed.md'), '# Seed\n')

    const sync = createSyncServer({ vault: notes, token: TOKEN, distDir: join(home, '__no_dist__') })
    listener = createServer((request, response) => void sync.handle(request, response))
    await new Promise((done) => listener.listen(0, '127.0.0.1', done))
    const address = listener.address()
    at = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(async () => {
    await new Promise((done) => listener.close(done))
    await rm(home, { recursive: true, force: true })
  })

  const ask = (path, init = {}) =>
    fetch(`${at}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } })

  it('lists what is there while it is there', async () => {
    const { files } = await (await ask('/api/files')).json()
    expect(files.map((file) => file.path).sort()).toEqual(['Home.md', 'Ideas/Seed.md'])
  })

  it('does not report a folder it cannot see as a vault with no notes in it', async () => {
    // The defect this exists for. `list()` swallowed every readdir failure, so
    // a moved folder came back as `200 {"files":[]}` — the app told, with a
    // success, that the person has no notes. "I cannot see your notes" and
    // "you have no notes" are not the same sentence and must not share a reply.
    await rename(notes, join(home, 'Notes-moved'))
    try {
      const response = await ask('/api/files')
      expect(response.status, 'a missing vault answered as an empty one').not.toBe(200)
      expect(response.status).toBe(503)
      expect((await response.json()).error).toMatch(/not there|moved|mounted/i)
    } finally {
      await rename(join(home, 'Notes-moved'), notes)
    }
  })

  it('says the same thing when a whole vault is asked for, rather than dropping the connection', async () => {
    // `/api/bundle` wrote its head before listing anything, so a failure after
    // that could only kill the socket: the app saw a network error where a
    // sentence would have done.
    await rename(notes, join(home, 'Notes-moved'))
    try {
      const response = await ask('/api/bundle')
      expect(response.status).toBe(503)
      expect((await response.json()).error).toMatch(/not there|moved|mounted/i)
    } finally {
      await rename(join(home, 'Notes-moved'), notes)
    }
  })

  it('says it plainly on a save, rather than as an unexplained fault', async () => {
    await rename(notes, join(home, 'Notes-moved'))
    try {
      const response = await ask('/api/file?path=New.md', { method: 'PUT', body: 'x' })
      expect(response.status).toBe(503)
      const { error } = await response.json()
      expect(error).toMatch(/not there|moved|mounted/i)
      // And never Node's own wording, which names the whole path on disk.
      expect(error).not.toMatch(/ENOENT|realpath/)
      expect(error).not.toContain(home)
    } finally {
      await rename(join(home, 'Notes-moved'), notes)
    }
  })

  it('comes back by itself once the folder is back', async () => {
    // The failure must not be remembered: an unmounted drive is mounted again,
    // and the app should simply start working rather than need a restart.
    //
    // Where the root really is gets worked out once and kept, so this has to
    // provoke that lookup *while the folder is missing* — a failure left in
    // that memory outlives the problem, and the server refuses until somebody
    // restarts it.
    await rename(notes, join(home, 'Notes-moved'))
    expect((await ask('/api/files')).status).toBe(503)
    expect((await ask('/api/file?path=Nope.md', { method: 'PUT', body: 'x' })).status).toBe(503)
    await rename(join(home, 'Notes-moved'), notes)

    const response = await ask('/api/files')
    expect(response.status).toBe(200)
    expect((await response.json()).files.map((file) => file.path).sort()).toEqual(['Home.md', 'Ideas/Seed.md'])

    // And a *write*, which is the path that remembers where the root really
    // is. A failure kept in that memory would outlast the problem: the drive
    // comes back and the server still refuses, until somebody restarts it.
    const written = await ask('/api/file?path=Back.md', { method: 'PUT', body: '# Back\n' })
    expect(written.status, 'the vault stayed unreachable after its folder returned').toBe(200)
    await rm(join(notes, 'Back.md'), { force: true })
  })

})

describe('a folder that vanishes while the watcher is scanning it', () => {
  /** A server of its own, so emitting an error here cannot disturb the rest. */
  async function watched() {
    const root = await mkdtemp(join(tmpdir(), 'spacelink-watch-'))
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
    const root = await mkdtemp(join(tmpdir(), 'spacelink-watch-'))
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(root, '__no_dist__') })
    const controller = new AbortController()
    controller.abort()
    expect(server.startWatching(controller.signal)).toBeNull()
  })

  it('waits for a vault folder that is not there yet, and watches it once it is', async () => {
    // The folder can be missing exactly when the watch is set up: a server
    // started before an external drive is plugged in, or an account whose
    // folder is made a moment after `--add-account`. Measured: the first
    // failure was final. That vault was listed and written correctly for the
    // rest of the run and never announced a change again — a device syncing
    // by hand and no sign anything was wrong.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-late-'))
    const root = join(home, 'NotYet')
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(home, '__no_dist__') })
    const controller = new AbortController()
    const said = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (text) => void said.push(String(text)) || true

    const changes = []
    server.listeners.add({ writableEnded: false, destroyed: false, write: (text) => void changes.push(text) })
    try {
      expect(server.startWatching(controller.signal), 'a missing folder gave up instead of waiting').not.toBeNull()
      expect(said.join(''), 'nothing said about a folder it is waiting for').toMatch(/is not there yet/)

      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'Arrived.md'), '# Arrived\n')
      // Past the retry, and then some for the change to be announced.
      await new Promise((done) => setTimeout(done, 7000))
      await writeFile(join(root, 'Typed.md'), '# Typed\n')
      await new Promise((done) => setTimeout(done, 1200))

      expect(changes.join(''), 'the folder came back and was still not watched').toContain('Typed.md')
    } finally {
      process.stderr.write = write
      controller.abort()
      await rm(home, { recursive: true, force: true })
    }
  }, 20_000)

  it('stops waiting for a folder once the watch is closed', async () => {
    // The wait is a timer that re-arms itself, and `close()` is what has to
    // end it. Closing without a signal to abort — which is how the watch is
    // stopped when the vault turns out to be unwatchable — would otherwise
    // leave it re-arming for the life of the process, once per server.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-late-'))
    const root = join(home, 'NeverMade')
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(home, '__no_dist__') })
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = () => true
    try {
      const watcher = server.startWatching()
      expect(watcher).not.toBeNull()
      watcher.close()

      // The folder appears after the watch was closed. Nothing should pick
      // it up.
      await mkdir(root, { recursive: true })
      const changes = []
      server.listeners.add({ writableEnded: false, destroyed: false, write: (text) => void changes.push(text) })
      await new Promise((done) => setTimeout(done, 7000))
      await writeFile(join(root, 'TooLate.md'), '# Too late\n')
      await new Promise((done) => setTimeout(done, 1200))
      expect(changes, 'a closed watch went on waiting for the folder').toEqual([])
    } finally {
      process.stderr.write = write
      await rm(home, { recursive: true, force: true })
    }
  }, 20_000)

  it('does not wait on a vault it could never watch, however long it waits', async () => {
    // Only a missing folder is worth waiting for: it is the one failure that
    // comes back by itself. A path that cannot be a folder at all would
    // re-try every few seconds for the life of the process and never once
    // get anywhere, with nothing said about why the vault is silent.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-late-'))
    await writeFile(join(home, 'notafolder'), 'this is a file\n')
    const root = join(home, 'notafolder', 'inside')
    const server = createSyncServer({ vault: root, token: TOKEN, distDir: join(home, '__no_dist__') })
    const said = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (text) => void said.push(String(text)) || true
    const controller = new AbortController()
    try {
      server.startWatching(controller.signal)
      expect(said.join(''), 'nothing said about a vault that cannot be watched').toMatch(/could not watch the vault/)
      expect(said.join(''), 'it is waiting for something that will never arrive').not.toMatch(/is not there yet/)
    } finally {
      process.stderr.write = write
      controller.abort()
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('a device that goes away half-way through the bundle', () => {
  it('releases the handler instead of waiting forever for a drain', async () => {
    // A response whose buffer is always full and whose socket then closes:
    // the `drain` the handler used to wait for is never coming.
    const { EventEmitter } = await import('node:events')
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      writeHead() {
        this.headersSent = true
      },
      write() {
        return false
      },
      end() {
        this.writableEnded = true
      },
    })
    const request = { method: 'GET', url: '/api/bundle', headers: { authorization: `Bearer ${TOKEN}` } }

    const handled = sync.handle(request, response)
    await new Promise((resolve) => setTimeout(resolve, 50))
    response.destroyed = true
    response.emit('close')

    const outcome = await Promise.race([handled.then(() => 'released'), new Promise((resolve) => setTimeout(() => resolve('stuck'), 2_000))])
    expect(outcome).toBe('released')
    expect(response.writableEnded).toBe(false) // nothing was written to a closed socket
  })
})

describe('a request that is not an address', () => {
  it('survives GET /%ZZ without a token, and keeps serving', async () => {
    // Nothing checks the token before the static file server, so anyone on
    // the network could send this; it used to reject the handler's promise,
    // which nobody awaited, and Node ended the process.
    const bad = await fetch(`${base}/%ZZ`)
    expect(bad.status).toBe(400)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })

  it('keeps the message of an error nobody planned for to itself — it names the vault on disk', async () => {
    const list = sync.store.list
    sync.store.list = async () => {
      throw new Error(`EACCES: permission denied, scandir '${vault}'`)
    }
    try {
      const response = await call('/api/files')
      expect(response.status).toBe(500)
      const text = await response.text()
      expect(text).not.toContain(vault)
      expect(JSON.parse(text)).toEqual({ error: 'Something went wrong.' })
    } finally {
      sync.store.list = list
    }
  })

  it('answers a rename with a body that is not JSON with a 400, not a stack trace', async () => {
    const response = await call('/api/rename', { method: 'POST', body: '{not json' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/JSON/)
  })
})

describe('a request path that begins with two slashes', () => {
  it('is a path, not the start of a host', async () => {
    // `GET //` used to throw "Invalid URL" out of the request handler, which
    // nobody awaited: the process ended. Anyone who can reach the port could
    // send it, and a browser will, for a link written `//something`.
    const doubled = await fetch(`${base}//`)
    const single = await fetch(`${base}/`)
    expect(doubled.status).toBe(single.status)
    expect(doubled.status).toBeLessThan(500)
    expect((await fetch(`${base}///`)).status).toBeLessThan(500)
    expect((await fetch(`${base}//assets/app.js`)).status).toBeLessThan(500)
  })

  it('does not let a doubled slash reach the API under another name', async () => {
    // Parsed as a host, `//api/health` became `/health` and fell through to the
    // static files — the API answering at a path that is not its own, or not
    // answering at one that is, are both ways to be wrong.
    const health = await fetch(`${base}//api/health`)
    expect(health.status).toBeLessThan(500)
    // Whatever it answers, it is not the health endpoint answering.
    expect(await health.text()).not.toMatch(/"service"\s*:\s*"spacelink"/)

    // …while the API itself is unmoved.
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await call('/api/files')).status).toBe(200)
  })
})

describe('two devices saving the same note at the same moment', () => {
  it('lets exactly one conditional write through at the store', async () => {
    const store = new VaultStore(vault)
    const { hash } = await store.read('Home.md')
    const results = await Promise.allSettled([
      store.write('Home.md', Buffer.from('device A edit\n'), hash),
      store.write('Home.md', Buffer.from('device B edit\n'), hash),
    ])
    const conflicts = results.filter((result) => result.status === 'rejected' && result.reason instanceof VaultConflictError)
    expect(conflicts, JSON.stringify(results)).toHaveLength(1)
    const winner = results.findIndex((result) => result.status === 'fulfilled')
    expect(await onDisk('Home.md')).toBe(winner === 0 ? 'device A edit\n' : 'device B edit\n')
  })

  it('answers one PUT with 200 and the other with 409 over HTTP', async () => {
    const etag = (await call('/api/file?path=Home.md')).headers.get('etag')
    const [a, b] = await Promise.all([
      call('/api/file?path=Home.md', { method: 'PUT', headers: { 'if-match': etag, 'x-spacelink-client': 'device-a' }, body: 'device A edit\n' }),
      call('/api/file?path=Home.md', { method: 'PUT', headers: { 'if-match': etag, 'x-spacelink-client': 'device-b' }, body: 'device B edit\n' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const refused = a.status === 409 ? a : b
    expect((await refused.json()).currentHash).toBe(hashOf(await onDisk('Home.md')))
  })
})

describe('a link inside the vault', () => {
  /** @type {string} */
  let outside

  beforeAll(async () => {
    outside = await mkdtemp(join(tmpdir(), 'spacelink-outside-'))
    await writeFile(join(outside, 'secret.md'), 'top secret\n')
    await writeFile(join(outside, 'victim.md'), 'keep me\n')
    await symlink(outside, join(vault, 'link'))
    await symlink(join(vault, 'Ideas'), join(vault, 'Alias'))
  })

  afterAll(async () => {
    await unlink(join(vault, 'link')).catch(() => {})
    await unlink(join(vault, 'Alias')).catch(() => {})
    await rm(outside, { recursive: true, force: true })
  })

  it('is not read through, whatever it points at', async () => {
    const read = await call(`/api/file?path=${encodeURIComponent('link/secret.md')}`)
    expect(read.status).toBe(400)
    expect(JSON.stringify(await read.json())).not.toContain(outside)
  })

  it('is not written or deleted through', async () => {
    const write = await call(`/api/file?path=${encodeURIComponent('link/planted.md')}`, { method: 'PUT', body: 'planted' })
    expect(write.status).toBe(400)
    await expect(readFile(join(outside, 'planted.md'), 'utf8')).rejects.toThrow()

    const remove = await call(`/api/file?path=${encodeURIComponent('link/victim.md')}`, { method: 'DELETE' })
    expect(remove.status).toBe(400)
    expect(await readFile(join(outside, 'victim.md'), 'utf8')).toBe('keep me\n')
  })

  it('is absent from the listing and from the file API alike', async () => {
    const { files } = await (await call('/api/files')).json()
    const paths = files.map((file) => file.path)
    expect(paths).toContain('Ideas/Seed.md')
    expect(paths.some((path) => path.startsWith('Alias/') || path.startsWith('link/'))).toBe(false)
    expect((await call(`/api/file?path=${encodeURIComponent('Alias/Seed.md')}`)).status).toBe(400)
  })
})

describe('what the watcher tells the other devices', { timeout: 20_000 }, () => {
  /** @type {any[]} */
  const captured = []
  const tap = {
    write: (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.startsWith('data: ')) captured.push(JSON.parse(line.slice(6)))
      }
    },
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  /** @param {() => boolean} condition */
  async function until(condition, timeoutMs = 8_000) {
    const started = Date.now()
    while (!condition() && Date.now() - started < timeoutMs) await sleep(25)
    return condition()
  }

  beforeAll(() => {
    sync.listeners.add(tap)
  })
  afterAll(() => {
    sync.listeners.delete(tap)
  })
  beforeEach(() => {
    captured.length = 0
  })

  it('announces a note that was deleted and then put back with the same bytes after an API write', async () => {
    const body = '# Home\n\nsaved by device A\n'
    await call('/api/file?path=Home.md', { method: 'PUT', headers: { 'x-spacelink-client': 'device-a' }, body })
    await sleep(400) // the watcher's echo of that write goes by, suppressed as it should be
    captured.length = 0

    // `git stash`, or an editor that saves by delete-and-create. The event is
    // put through the watcher by hand as well: Node's emulated recursive watch
    // on Linux loses a file after an atomic replace, and this test is about
    // what the server says when told, not whether the emulation tells it.
    await unlink(join(vault, 'Home.md'))
    watcher?.emit('change', 'rename', 'Home.md')
    expect(
      await until(() => captured.some((event) => event.type === 'remove' && event.path === 'Home.md')),
      `events after the delete: ${JSON.stringify(captured)}`,
    ).toBe(true)
    await writeFile(join(vault, 'Home.md'), body)
    watcher?.emit('change', 'rename', 'Home.md')

    // The same bytes as device A's write — but every device was just told the
    // note is gone, so this is news, not an echo.
    const back = await until(() => captured.some((event) => event.type === 'upsert' && event.path === 'Home.md'))
    expect(back, `events after the file came back: ${JSON.stringify(captured)}`).toBe(true)
  })

  it('does not echo an API rename back as an anonymous write of the new name', async () => {
    const response = await call('/api/rename', {
      method: 'POST',
      headers: { 'x-spacelink-client': 'device-a', 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'Ideas/Seed.md', to: 'Ideas/Moved.md' }),
    })
    expect(response.status).toBe(200)
    await sleep(1_000)
    // The renaming device has its note marked unsaved until its own save
    // lands; an origin-less upsert would read to it as somebody else's edit.
    const stray = captured.filter((event) => event.type === 'upsert' && event.path === 'Ideas/Moved.md' && !event.origin)
    expect(stray, `all events: ${JSON.stringify(captured)}`).toEqual([])
    expect(captured.some((event) => event.type === 'rename' && event.to === 'Ideas/Moved.md' && event.origin === 'device-a')).toBe(true)
  })

  it('neither announces nor serves a note in a hidden folder, which the listing leaves out', async () => {
    await mkdir(join(vault, '.github'), { recursive: true })
    await writeFile(join(vault, '.github/notes.md'), '# not a note\n')
    try {
      await sleep(600)
      const { files } = await (await call('/api/files')).json()
      expect(files.map((file) => file.path)).not.toContain('.github/notes.md')
      expect(captured.some((event) => event.path === '.github/notes.md')).toBe(false)
      expect((await call(`/api/file?path=${encodeURIComponent('.github/notes.md')}`)).status).toBe(400)
    } finally {
      await rm(join(vault, '.github'), { recursive: true, force: true })
    }
  })

  it('does not announce a folder as a removed note', async () => {
    await mkdir(join(vault, 'Fresh Folder'), { recursive: true })
    try {
      await sleep(600)
      expect(captured.filter((event) => event.path === 'Fresh Folder')).toEqual([])
    } finally {
      await rm(join(vault, 'Fresh Folder'), { recursive: true, force: true })
    }
  })
})

describe('a path that names a folder, or runs through a file', () => {
  it('is refused with a 4xx that does not reveal where the vault is on disk', async () => {
    const attempts = [
      call('/api/file?path=Ideas', { method: 'DELETE' }),
      call('/api/file?path=Ideas', { method: 'PUT', body: 'x' }),
      call('/api/rename', { method: 'POST', body: JSON.stringify({ from: 'Ideas/Seed.md', to: 'Home.md/Seed.md' }) }),
      call(`/api/file?path=${encodeURIComponent('Home.md/inside.md')}`, { method: 'PUT', body: 'x' }),
    ]
    for (const response of await Promise.all(attempts)) {
      const text = await response.text()
      expect(response.status, text).toBeGreaterThanOrEqual(400)
      expect(response.status, text).toBeLessThan(500)
      expect(text).not.toContain(vault)
    }
    expect(await onDisk('Ideas/Seed.md')).toBe('# Seed\n')
    expect(await onDisk('Home.md')).toContain('# Home')
  })
})

/**
 * Accounts: the same login, on every device, reaching one person's notes.
 *
 * The server has always served one folder behind one long random token. That
 * works for a machine you own and fails for the thing people actually want —
 * to sign in on the Mac and the phone and see the same notes. So a second
 * credential was added at the same door, and the whole risk of that change is
 * *leakage*: one account reaching another's notes, or hearing another's edits.
 *
 * These run against a second server with three accounts and three folders,
 * because that is the only arrangement in which leakage can be observed at
 * all. Nothing here is mocked — real HTTP, real password hashes, real files.
 */
describe('signing in with an account', { timeout: 40_000 }, () => {
  const MY_PASSWORD = 'a long enough password'
  const THEIR_PASSWORD = 'another long password'

  /** @type {string} */ let home
  /** @type {string} */ let accountsFile
  /** @type {string} */ let primaryVault
  /** @type {string} */ let myVault
  /** @type {string} */ let theirVault
  /** @type {string} */ let teamVault
  /** @type {import('node:http').Server} */ let accountsListener
  /** @type {string} */ let at
  /** @type {ReturnType<typeof createSyncServer>} */ let accountsSync
  /** @type {AbortController} */ let accountsWatching

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'spacelink-accounts-'))
    accountsFile = join(home, 'accounts.json')
    primaryVault = join(home, 'Primary')
    myVault = join(home, 'MyNotes')
    theirVault = join(home, 'TheirNotes')
    teamVault = join(home, 'TeamNotes')
    for (const folder of [primaryVault, myVault, theirVault, teamVault]) await mkdir(folder, { recursive: true })
    await writeFile(join(teamVault, 'Plan.md'), '# Plan\n')
    await writeFile(join(primaryVault, 'Shared.md'), '# Shared\n')
    await writeFile(join(myVault, 'Mine.md'), '# Mine\n')
    await writeFile(join(theirVault, 'Theirs.md'), '# Theirs\n')

    await addAccount({ file: accountsFile, email: 'me@example.com', password: MY_PASSWORD, vault: myVault })
    // Stored as typed, matched case-insensitively — a person signing in from a
    // phone keyboard should not be told their address does not exist.
    await addAccount({ file: accountsFile, email: 'You@Example.com', password: THEIR_PASSWORD, vault: theirVault })
    await addAccount({ file: accountsFile, email: 'shared@example.com', password: MY_PASSWORD, vault: primaryVault })
    // Its own account, so the wrong guesses the timing check makes are not
    // added to another test's run and tripping the rate limiter.
    await addAccount({ file: accountsFile, email: 'timing@example.com', password: MY_PASSWORD, vault: myVault })
    await addAccount({ file: accountsFile, email: 'clears@example.com', password: MY_PASSWORD, vault: myVault })
    // Two people, one folder — and not the folder the server was started on.
    await addAccount({ file: accountsFile, email: 'ana@example.com', password: MY_PASSWORD, vault: teamVault })
    await addAccount({ file: accountsFile, email: 'budi@example.com', password: MY_PASSWORD, vault: teamVault })
    // Its own account: this one's password gets changed out from under it.
    await addAccount({ file: accountsFile, email: 'revoked@example.com', password: MY_PASSWORD, vault: primaryVault })
    // Its own account too: this one holds a stream open while the accounts
    // file is unreadable, which is not a state to leave another test in.
    await addAccount({ file: accountsFile, email: 'fragile@example.com', password: MY_PASSWORD, vault: myVault })

    accountsSync = createSyncServer({
      vault: primaryVault,
      token: TOKEN,
      distDir: join(home, '__no_dist__'),
      accountsFile,
    })
    accountsListener = createServer((request, response) => void accountsSync.handle(request, response))
    await new Promise((done) => accountsListener.listen(0, '127.0.0.1', done))
    const address = accountsListener.address()
    at = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    accountsWatching = new AbortController()
    accountsSync.startWatching(accountsWatching.signal)
  })

  afterAll(async () => {
    accountsWatching.abort()
    await new Promise((done) => accountsListener.close(done))
    await rm(home, { recursive: true, force: true })
  })

  /** @param {string} email @param {string} password */
  const login = (email, password, headers = {}) =>
    fetch(`${at}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, password }),
    })

  /** @param {string} email @param {string} password */
  async function signIn(email, password) {
    const response = await login(email, password)
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    return body
  }

  /** @param {string} token @param {string} path */
  const as = (token, path, init = {}) =>
    fetch(`${at}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

  /** The note names a credential can see, which is the whole question here. */
  async function notesFor(token) {
    const response = await as(token, '/api/files')
    expect(response.status).toBe(200)
    const { files } = await response.json()
    return files.map((file) => file.path).sort()
  }

  /**
   * A live change stream, collecting into an array the test can read.
   *
   * Deliberately not the outer `waitFor`: the interesting assertion here is
   * that something *never* arrives, which needs the events kept rather than a
   * promise that resolves on the first match.
   */
  async function openStream(token) {
    const controller = new AbortController()
    const response = await fetch(`${at}/api/events?token=${encodeURIComponent(token)}`, { signal: controller.signal })
    expect(response.status).toBe(200)
    /** @type {any[]} */
    const events = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state = { closed: false }
    const pump = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        for (const chunk of chunks) {
          const line = chunk.trim()
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)))
        }
      }
      state.closed = true
    })().catch(() => {
      state.closed = true
    })
    return { events, state, close: () => (controller.abort(), pump) }
  }

  const settle = (ms = 400) => new Promise((done) => setTimeout(done, ms))

  it('refuses the wrong password, and says nothing about which addresses exist', async () => {
    const wrong = await login('me@example.com', 'not the password')
    const missing = await login('nobody@example.com', 'not the password')
    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    // Byte for byte the same answer: a difference here is an address oracle.
    expect(await wrong.text()).toBe(await missing.text())
  })

  it('takes as long to refuse an address with no account as one with', async () => {
    // Wording the two refusals identically is not enough. Checking a real
    // password costs a deliberate ~90 ms of scrypt; skipping that for an
    // address nobody has would answer in about one, and the difference is
    // readable from across a network. So the miss pays for a hash too.
    const time = async (email) => {
      const started = performance.now()
      const response = await login(email, 'not the password')
      expect(response.status).toBe(401)
      return performance.now() - started
    }
    // Three each, alternating, and the fastest of each kept: a busy machine can
    // make any single request slow, but nothing can make one faster than the
    // work it did.
    const hits = []
    const misses = []
    for (let round = 0; round < 3; round += 1) {
      hits.push(await time('timing@example.com'))
      misses.push(await time(`nobody-${round}@example.com`))
    }
    const fastestHit = Math.min(...hits)
    const fastestMiss = Math.min(...misses)
    // A hash is ~90 ms and skipping it is ~1 ms, so half is a wide margin that
    // still fails outright if the work is ever skipped.
    expect(fastestMiss, `hit ${fastestHit.toFixed(1)}ms vs miss ${fastestMiss.toFixed(1)}ms`).toBeGreaterThan(
      fastestHit / 2,
    )
  }, 30_000)

  it('does not accept a password that is merely close', async () => {
    for (const attempt of [MY_PASSWORD.toUpperCase(), MY_PASSWORD.slice(0, -1), `${MY_PASSWORD} `, '']) {
      expect((await login('me@example.com', attempt)).status).toBe(401)
    }
  })

  it('hands back a session token, the account name, and nothing about the disk', async () => {
    const body = await signIn('me@example.com', MY_PASSWORD)
    expect(body.token).toMatch(/^[\w-]{40,}$/)
    expect(body.email).toBe('me@example.com')
    // The folder's name is useful to show; its path is the server's business.
    expect(body.vault).toBe('MyNotes')
    expect(JSON.stringify(body)).not.toContain(home)
    expect(JSON.stringify(body)).not.toContain(MY_PASSWORD)
  })

  it('matches the address however it was typed', async () => {
    const body = await signIn('YOU@example.COM', THEIR_PASSWORD)
    expect(body.email).toBe('You@Example.com')
    expect(body.vault).toBe('TheirNotes')
  })

  it('gives each account its own notes, and no way to reach the other', async () => {
    const mine = await signIn('me@example.com', MY_PASSWORD)
    const theirs = await signIn('you@example.com', THEIR_PASSWORD)

    expect(await notesFor(mine.token)).toEqual(['Mine.md'])
    expect(await notesFor(theirs.token)).toEqual(['Theirs.md'])

    // Not merely absent from the listing — unreachable by name.
    expect((await as(mine.token, '/api/file?path=Theirs.md')).status).toBe(404)
    expect((await as(theirs.token, '/api/file?path=Mine.md')).status).toBe(404)

    // And a write lands in the writer's folder, not in the other's.
    const written = await as(mine.token, '/api/file?path=Only%20Mine.md', { method: 'PUT', body: '# Only mine\n' })
    expect(written.status).toBe(200)
    expect(await readFile(join(myVault, 'Only Mine.md'), 'utf8')).toBe('# Only mine\n')
    expect(await notesFor(theirs.token)).toEqual(['Theirs.md'])
    await rm(join(myVault, 'Only Mine.md'), { force: true })
  })

  it('never sends one account the other account’s edits', async () => {
    // The reason the server keeps a change stream per vault rather than one
    // for the whole process: a listener attached to the wrong set would hear
    // the *paths and hashes* of notes it can never open.
    const mine = await signIn('me@example.com', MY_PASSWORD)
    const theirs = await signIn('you@example.com', THEIR_PASSWORD)
    const stream = await openStream(mine.token)
    try {
      await settle(100)
      expect((await as(theirs.token, '/api/file?path=Loud.md', { method: 'PUT', body: 'x' })).status).toBe(200)
      await settle()
      expect(stream.events).toEqual([])

      // The same stream is not simply broken: its own account's edit arrives.
      expect((await as(mine.token, '/api/file?path=Quiet.md', { method: 'PUT', body: 'y' })).status).toBe(200)
      await settle()
      expect(stream.events.map((event) => event.path)).toEqual(['Quiet.md'])
    } finally {
      await stream.close()
      await rm(join(theirVault, 'Loud.md'), { force: true })
      await rm(join(myVault, 'Quiet.md'), { force: true })
    }
  })

  it('tells a signed-in device an edit made outside the app, in its own vault', async () => {
    // A vault opened when someone signed in, after the server was already
    // watching, must be watched too — otherwise editing a note in Finder would
    // reach every device except the ones that use an account.
    const mine = await signIn('me@example.com', MY_PASSWORD)
    const stream = await openStream(mine.token)
    try {
      await settle(200)
      await writeFile(join(myVault, 'From Finder.md'), '# Written outside\n')
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !stream.events.some((event) => event.path === 'From Finder.md')) await settle(100)
      expect(stream.events.map((event) => event.path)).toContain('From Finder.md')
    } finally {
      await stream.close()
      await rm(join(myVault, 'From Finder.md'), { force: true })
    }
  })

  it('says who is signed in, without being asked for a password again', async () => {
    const mine = await signIn('me@example.com', MY_PASSWORD)
    const me = await (await as(mine.token, '/api/auth/me')).json()
    expect(me).toEqual({ signedIn: true, email: 'me@example.com', vault: 'MyNotes' })
  })

  it('still takes the access token the Mac app was launched with', async () => {
    // Accounts were added beside the token, not in front of it: an app already
    // paired with `--token` must keep working across the upgrade.
    expect(await notesFor(TOKEN)).toEqual(['Shared.md'])
    const me = await (await as(TOKEN, '/api/auth/me')).json()
    expect(me).toEqual({ signedIn: false, email: null, vault: 'Primary' })
  })

  it('serves one vault to one set of listeners, however it was reached', async () => {
    // `shared@example.com` owns the folder the server was started on, so an
    // account and the access token are two ways to the same notes. Opening a
    // second view of those files would be two watchers and two echo windows
    // over one folder, and the tell is what the other device hears: the write
    // itself, named with who made it, rather than the *filesystem* noticing a
    // moment later that something changed and saying so anonymously. A device
    // that cannot tell an edit apart from its own save fights itself.
    const shared = await signIn('shared@example.com', MY_PASSWORD)
    expect(await notesFor(shared.token)).toEqual(['Shared.md'])
    const stream = await openStream(shared.token)
    try {
      await settle(100)
      const written = await as(TOKEN, '/api/file?path=Both.md', {
        method: 'PUT',
        body: 'z',
        headers: { 'x-spacelink-client': 'the-mac-app' },
      })
      expect(written.status).toBe(200)
      await settle()
      // Exactly one — the write, once, not the write and then its echo.
      expect(stream.events).toEqual([
        { type: 'upsert', path: 'Both.md', hash: hashOf(Buffer.from('z')), origin: 'the-mac-app' },
      ])
    } finally {
      await stream.close()
      await rm(join(primaryVault, 'Both.md'), { force: true })
    }
  })

  it('gives two accounts that share a folder one view of it, not two', async () => {
    // The guide's own "several people, several vaults" section describes two
    // accounts on one folder, and the rule that a folder is opened once was
    // written for the folder named on the command line only. Two accounts on
    // any *other* shared folder each got their own watcher and their own echo
    // window over the same files.
    //
    // The tell is what the second person hears: the write itself, named with
    // who made it, rather than the filesystem noticing a moment later and
    // saying so anonymously.
    const ana = await signIn('ana@example.com', MY_PASSWORD)
    const budi = await signIn('budi@example.com', MY_PASSWORD)
    expect(await notesFor(ana.token)).toEqual(await notesFor(budi.token))

    const stream = await openStream(budi.token)
    try {
      await settle(100)
      const written = await as(ana.token, '/api/file?path=Together.md', {
        method: 'PUT',
        body: '# Together\n',
        headers: { 'x-spacelink-client': 'ana-laptop' },
      })
      expect(written.status).toBe(200)
      await settle()
      expect(stream.events).toEqual([
        {
          type: 'upsert',
          path: 'Together.md',
          hash: hashOf(Buffer.from('# Together\n')),
          origin: 'ana-laptop',
        },
      ])
    } finally {
      await stream.close()
      await rm(join(teamVault, 'Together.md'), { force: true })
    }
  })

  it('signs one device out without signing the others out', async () => {
    const phone = await signIn('me@example.com', MY_PASSWORD)
    const laptop = await signIn('me@example.com', MY_PASSWORD)
    expect(phone.token).not.toBe(laptop.token)

    const out = await as(phone.token, '/api/auth/logout', { method: 'POST' })
    expect(out.status).toBe(200)

    expect((await as(phone.token, '/api/files')).status).toBe(401)
    expect((await as(laptop.token, '/api/files')).status).toBe(200)
  })

  it('says a sign-in body is too large, rather than hanging up on it', async () => {
    // The limit exists so the one endpoint an unauthenticated caller can reach
    // cannot be used to spend the server's memory. Refusing it was right; the
    // way it refused was not — the connection was destroyed before the answer
    // could leave, and the caller saw only `fetch failed`.
    const response = await fetch(`${at}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'me@example.com', password: 'x'.repeat(1024 * 1024) }),
    })
    expect(response.status).toBe(413)
    // And in the caller's own terms: it is not a file, and not a syntax error.
    const body = await response.json()
    expect(body.error).toMatch(/sign-in request is too large/i)
    expect(body.error).not.toMatch(/json|file/i)
  })

  it('reads the Bearer scheme without regard to case, as the RFC says', async () => {
    // The app always sends `Bearer`. A person at a terminal who typed
    // `bearer` was told their token was not accepted, and sent to copy it
    // again when it was fine all along.
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const response = await fetch(`${at}/api/files`, { headers: { authorization: `${scheme} ${TOKEN}` } })
      expect(response.status, scheme).toBe(200)
    }
    // Case is the only latitude: another scheme carrying the token is not it.
    const basic = await fetch(`${at}/api/files`, { headers: { authorization: `Basic ${TOKEN}` } })
    expect(basic.status).toBe(401)
  })

  it('answers a body that is JSON but not an object with a 400, quietly', async () => {
    // `null` is valid JSON. It parsed cleanly and then threw on `.email`,
    // which reached the caller as a 500 — and, thrown before the limiter had
    // counted anything, wrote a line to stderr per request for anyone on the
    // network, no token needed and no cost. Measured: 40 of them, one log line
    // each, and the limiter none the wiser.
    const said = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (text) => void said.push(String(text)) || true
    try {
      for (const body of ['null', '[]', '"just a string"', '123', 'true']) {
        const response = await fetch(`${at}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        expect(response.status, `body ${body}`).toBe(400)
        expect(((await response.json()).error ?? '').toLowerCase(), `body ${body}`).toContain('json object')
      }
      expect(said, 'a body the caller controls wrote to the log').toEqual([])
    } finally {
      process.stderr.write = write
    }
  })

  it('stops an open change stream once the session behind it is revoked', async () => {
    // A stream is authorised when it opens and can stay open for days. Asked
    // once and never again, a device whose password had been changed — the
    // command that promises to sign every device out — kept receiving every
    // change to the vault, by path and by hash, for as long as its connection
    // happened to last. Measured: a note written *after* the change arrived.
    const { setPassword } = await import('./accounts.mjs')
    const lost = await signIn('revoked@example.com', MY_PASSWORD)
    const stream = await openStream(lost.token)
    try {
      await settle(200)
      expect((await as(TOKEN, '/api/file?path=Seen.md', { method: 'PUT', body: 'a' })).status).toBe(200)
      await settle()
      expect(stream.events.map((event) => event.path), 'the stream was not working to begin with').toEqual(['Seen.md'])

      // The owner changes the password, from anywhere.
      await setPassword({ file: accountsFile, email: 'revoked@example.com', password: 'a brand new long password' })
      expect((await as(lost.token, '/api/files')).status).toBe(401)

      // The already-open stream has to notice too, not only new requests.
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !stream.state.closed) await settle(200)
      expect(stream.state.closed, 'a revoked device kept its change stream open').toBe(true)

      const seen = stream.events.length
      expect((await as(TOKEN, '/api/file?path=Unseen.md', { method: 'PUT', body: 'b' })).status).toBe(200)
      await settle(600)
      expect(stream.events.length, 'a revoked device was still being told about changes').toBe(seen)

      // And the server is not left holding it: a dead response kept in the
      // listeners is written to on every change, once per revoked device, for
      // as long as the server runs.
      expect(accountsSync.listeners.has(undefined)).toBe(false)
      expect(accountsSync.listeners.size, 'a revoked stream was left in the listeners').toBe(0)
    } finally {
      await stream.close()
      await rm(join(primaryVault, 'Seen.md'), { force: true })
      await rm(join(primaryVault, 'Unseen.md'), { force: true })
    }
  }, 40_000)

  it('leaves a stream alone for as long as its credential holds', async () => {
    // The other half of asking again: a stream that is still allowed must
    // survive being asked, and go on delivering. A check that closed every
    // stream on its next tick would look like the feature working right up
    // until somebody left the app open for a minute.
    const mine = await signIn('me@example.com', MY_PASSWORD)
    const stream = await openStream(mine.token)
    try {
      // Comfortably longer than the interval that re-checks the credential.
      await settle(7000)
      expect(stream.state.closed, 'a valid stream was closed by the re-check').toBe(false)

      expect((await as(mine.token, '/api/file?path=Later.md', { method: 'PUT', body: 'c' })).status).toBe(200)
      await settle()
      expect(stream.events.map((event) => event.path)).toContain('Later.md')
    } finally {
      await stream.close()
      await rm(join(myVault, 'Later.md'), { force: true })
    }
  }, 40_000)

  it('survives an accounts file it cannot read while a stream is open', async () => {
    // Re-checking a stream means reading the accounts file on a timer, and a
    // file can go bad: a half-written save, a hand edit, a drive answering EIO.
    // Measured before this was guarded: the rejection escaped the interval and
    // ended the process — one unreadable file took down every device's sync,
    // not the one device whose credential could not be confirmed.
    const escaped = []
    const collect = (error) => escaped.push(error)
    process.on('unhandledRejection', collect)

    const mine = await signIn('fragile@example.com', MY_PASSWORD)
    // Read after signing in: the sign-in wrote this session into the file, and
    // restoring a snapshot taken before it would revoke the very stream under
    // test — the fix would then be indistinguishable from the bug.
    const original = await readFile(accountsFile, 'utf8')
    const stream = await openStream(mine.token)
    try {
      await settle(200)
      await writeFile(accountsFile, '{ not JSON at all')

      // Past the interval, several times over.
      await settle(7000)
      expect(escaped.map((error) => String(error?.message ?? error)), 'the re-check threw where nothing catches').toEqual([])
      expect(stream.state.closed, 'an unreadable file signed a device out').toBe(false)
      // And the server is still serving: the plain token never needed the file.
      expect((await as(TOKEN, '/api/files')).status).toBe(200)

      // Repaired, the stream carries on rather than needing a reconnect.
      await writeFile(accountsFile, original)
      await settle(6000)
      expect(stream.state.closed, 'a repaired file did not save the stream').toBe(false)
      expect((await as(mine.token, '/api/file?path=Repaired.md', { method: 'PUT', body: 'd' })).status).toBe(200)
      await settle()
      expect(stream.events.map((event) => event.path)).toContain('Repaired.md')
    } finally {
      process.off('unhandledRejection', collect)
      await writeFile(accountsFile, original)
      await stream.close()
      await rm(join(myVault, 'Repaired.md'), { force: true })
    }
  }, 60_000)

  it('survives a change landing on a stream it has just ended itself', async () => {
    // The window the revocation check opens: `response.end()` returns, and the
    // connection's `close` — which is what takes the listener out of the set —
    // is a later tick. A note saved in between is broadcast to a response that
    // has ended. That does not throw where the loop could catch it: `write()`
    // returns false and raises an `error` event with nothing listening, which
    // ends the process. Measured against a real ServerResponse:
    // ERR_STREAM_WRITE_AFTER_END, uncaught, exit code 9.
    //
    // A real response cannot be held in that state on purpose — `close` fires
    // within a tick or two, long before an HTTP round-trip comes back — so the
    // window is held open by a stand-in that answers `write()` the way the
    // measured one did. The half below runs the realistic path as well.
    const escaped = []
    const collect = (error) => escaped.push(error)
    process.on('uncaughtException', collect)
    process.on('unhandledRejection', collect)

    let written = 0
    const ended = {
      writableEnded: true,
      destroyed: false,
      write() {
        written += 1
        // What Node does: nothing the caller can catch, and then a throw from
        // a job nobody owns.
        queueMicrotask(() => {
          throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
        })
        return false
      },
    }
    // An account on the folder the server was started on, so its stream shares
    // the listeners this test reaches into.
    const mine = await signIn('shared@example.com', MY_PASSWORD)
    const stream = await openStream(mine.token)
    try {
      await settle(200)
      expect(accountsSync.listeners.size, 'the stream never reached the server').toBe(1)
      accountsSync.listeners.add(ended)

      expect((await as(TOKEN, '/api/file?path=Landed.md', { method: 'PUT', body: 'e' })).status).toBe(200)
      await settle()

      expect(written, 'a stream that had ended was written to anyway').toBe(0)
      expect(escaped.map((error) => error?.code ?? String(error)), 'a broadcast to an ended stream escaped').toEqual([])
      // And it is gone, rather than being skipped on every change for as long
      // as the server runs.
      expect(accountsSync.listeners.has(ended), 'an ended stream was kept in the listeners').toBe(false)

      // The live stream beside it was not collateral: it still got the change.
      expect(stream.events.map((event) => event.path)).toContain('Landed.md')

      // And the realistic path, end to end: a real response the server ends
      // itself, then a change, then the server still serving everybody.
      const [live] = [...accountsSync.listeners]
      live.end()
      expect((await as(TOKEN, '/api/file?path=Landed2.md', { method: 'PUT', body: 'f' })).status).toBe(200)
      await settle()
      expect(escaped.map((error) => error?.code ?? String(error))).toEqual([])
      expect((await as(TOKEN, '/api/files')).status).toBe(200)
    } finally {
      process.off('uncaughtException', collect)
      process.off('unhandledRejection', collect)
      accountsSync.listeners.delete(ended)
      await stream.close()
      await rm(join(primaryVault, 'Landed.md'), { force: true })
      await rm(join(primaryVault, 'Landed2.md'), { force: true })
    }
  })

  it('keeps the token out of the file it writes, so a stolen backup is not a way in', async () => {
    const mine = await signIn('me@example.com', MY_PASSWORD)
    const stored = await readFile(accountsFile, 'utf8')
    expect(stored).not.toContain(mine.token)
    expect(stored).not.toContain(MY_PASSWORD)
    expect(stored).not.toContain(THEIR_PASSWORD)
    // What is stored is the hash of the token, and it is enough to sign in with.
    expect(stored).toContain(sessionId(mine.token))
  })

  it('notices an account added from the terminal while it is running', async () => {
    // Accounts are made with a command on the machine that holds the notes.
    // Having to restart the server to use one would make that unusable.
    const later = join(home, 'LaterNotes')
    await mkdir(later, { recursive: true })
    await writeFile(join(later, 'Later.md'), '# Later\n')
    expect((await login('later@example.com', MY_PASSWORD)).status).toBe(401)

    await addAccount({ file: accountsFile, email: 'later@example.com', password: MY_PASSWORD, vault: later })
    const body = await signIn('later@example.com', MY_PASSWORD)
    expect(await notesFor(body.token)).toEqual(['Later.md'])
  })

  it('slows a run of wrong passwords, and lets the right one through afterwards', async () => {
    const guess = () => login('slow@example.com', 'wrong every time')
    let refused = null
    for (let attempt = 0; attempt < 12 && !refused; attempt += 1) {
      const response = await guess()
      if (response.status === 429) refused = response
      else expect(response.status).toBe(401)
    }
    expect(refused, 'guessing was never slowed down').not.toBeNull()
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('Try again in') })

    // A person who mistyped their password must not be locked out for good.
    await addAccount({ file: accountsFile, email: 'slow@example.com', password: MY_PASSWORD, vault: myVault })
    const wait = Number(refused.headers.get('retry-after')) * 1000
    await settle(wait + 300)
    expect((await login('slow@example.com', MY_PASSWORD)).status).toBe(200)
  })

  it('starts the count over once the right password arrives', async () => {
    // Otherwise the next mistype after a successful sign-in resumes an
    // escalating wait the person already worked off — and since an attempt is
    // now counted when it starts, even the successful one leaves a mark unless
    // this clears it.
    const near = () => login('clears@example.com', 'wrong').then((response) => response.status)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await near(), `guess ${attempt + 1} should still be allowed`).toBe(401)
    }
    expect((await login('clears@example.com', MY_PASSWORD)).status).toBe(200)

    // The run is over, so this is guess number one again rather than number
    // seven — allowed through to be refused on its merits.
    expect(await near()).toBe(401)
  }, 30_000)

  it('offers no way to make an account over the network', async () => {
    // The choice this server is built around: accounts exist because someone
    // typed a command on the machine holding the notes. There is no sign-up
    // form, so there is no sign-up form to attack.
    const before = JSON.parse(await readFile(accountsFile, 'utf8')).accounts.length
    const payload = JSON.stringify({ email: 'intruder@example.com', password: 'a long enough password' })
    const tries = ['/api/auth/register', '/api/auth/signup', '/api/accounts', '/api/auth/account']
    for (const path of tries) {
      for (const token of [null, TOKEN]) {
        const response = await fetch(`${at}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: payload,
        })
        expect([401, 404], `${path} as ${token ? 'the token' : 'a stranger'}`).toContain(response.status)
      }
    }
    expect(JSON.parse(await readFile(accountsFile, 'utf8')).accounts.length).toBe(before)
    expect((await login('intruder@example.com', 'a long enough password')).status).toBe(401)
  })

  it('will not buffer a large body for a caller who has not signed in', async () => {
    // The one endpoint an unauthenticated caller can reach. A note may be 32 MB
    // and this may not: without a cap of its own, anyone who can see the port
    // could make the server hold whatever they cared to send.
    //
    // The password here is the *right* one, so the only reason this can fail is
    // the size. A body that is merely wrong would be refused either way and
    // would prove nothing.
    const response = await fetch(`${at}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'me@example.com', password: MY_PASSWORD, padding: 'x'.repeat(200_000) }),
      // The socket is destroyed mid-send, which `fetch` reports as a failure
      // rather than as a status. That counts as refused.
    }).catch(() => ({ status: 0, json: async () => ({}) }))
    expect(response.status, 'an oversized sign-in was accepted').not.toBe(200)
    expect(await response.json().catch(() => ({}))).not.toHaveProperty('token')

    // And the server is still there, and still signs the same person in.
    expect((await fetch(`${at}/api/health`)).status).toBe(200)
    expect((await login('me@example.com', MY_PASSWORD)).status).toBe(200)
  })

  it('does not let a stranger make it rewrite its accounts file', async () => {
    // `/api/auth/logout` is answered before any credential is checked, because
    // the thing it retires *is* the credential. That makes it the one write
    // path an anonymous caller can reach — and measured before this was fixed,
    // three hundred nonsense tokens meant three hundred read-modify-writes of
    // the accounts file, each one holding its lock while real sign-ins queued.
    const before = (await stat(accountsFile)).mtimeMs
    await new Promise((done) => setTimeout(done, 20))

    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        fetch(`${at}/api/auth/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer nonsense-${index}` },
        }).then((response) => response.status),
      ),
    )
    // Still answered the same way to everyone: whether that token was a session
    // is not news an unauthenticated caller needs.
    expect([...new Set(statuses)]).toEqual([200])
    expect((await stat(accountsFile)).mtimeMs, 'a stranger made the server rewrite its accounts').toBe(before)

    // And a real sign-out still reaches the file.
    const device = await signIn('me@example.com', MY_PASSWORD)
    expect((await as(device.token, '/api/auth/logout', { method: 'POST' })).status).toBe(200)
    expect((await as(device.token, '/api/files')).status).toBe(401)
  }, 30_000)

  it('answers a stranger without queueing behind whatever is writing', async () => {
    // Not rewriting the file is half of it. The other half is not asking for
    // the lock at all: a token nobody has ever held is settled from the store
    // already in memory, so a flood of them cannot hold real sign-ins up behind
    // it. Held deliberately here rather than raced for, so this measures the
    // shape rather than the machine's mood.
    const { updateAccounts } = await import('./accounts.mjs')
    const held = updateAccounts(accountsFile, async () => {
      await new Promise((done) => setTimeout(done, 1500))
    })
    try {
      await settle(100)
      const started = performance.now()
      const response = await fetch(`${at}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: 'Bearer a token nobody has ever held' },
      })
      const took = performance.now() - started
      expect(response.status).toBe(200)
      expect(took, `it waited ${took.toFixed(0)}ms for a lock it had no need of`).toBeLessThan(700)
    } finally {
      await held
    }
  }, 30_000)

  it('refuses a body that is not JSON without taking the server down', async () => {
    const response = await fetch(`${at}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })
    expect(response.status).toBe(400)
    expect((await fetch(`${at}/api/health`)).status).toBe(200)
  })
})

/**
 * Making an account, from the machine that holds the notes.
 *
 * This is the only way one exists — there is no sign-up page, deliberately —
 * so the commands are the whole of the account system's front door and are
 * exercised as a person would run them, as a child process with real argv.
 */
describe('a page served from somewhere else', () => {
  it('is allowed to send the headers a sign-in needs', async () => {
    // The app is normally served by this same server, so this only matters
    // when it is not — a dev server on another port, say. A preflight that
    // omits a header the client sends makes the request fail before it is
    // made, and the browser reports it as a network error rather than as the
    // refused header it is.
    const preflight = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    const allowed = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const header of ['authorization', 'content-type', 'if-match', 'x-spacelink-client', 'x-spacelink-device']) {
      expect(allowed, header).toContain(header)
    }
    // And the header that says how long to wait after too many guesses, so a
    // cross-origin client can honour it rather than retrying straight away.
    expect((preflight.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('retry-after')
  })

  it('still needs a credential — being allowed to ask is not being let in', async () => {
    const response = await fetch(`${base}/api/files`, { headers: { origin: 'http://evil.example' } })
    expect(response.status).toBe(401)
  })
})

describe('a vault pointed at something that is not a folder', () => {
  it('says so, rather than saying the folder is missing', async () => {
    // Two different sentences, because they call for two different things.
    // A folder that is not there may come back — put it back, plug the drive
    // in. A path that is a file will never become a folder by waiting, and
    // being told to wait is the wrong instruction.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-shape-'))
    try {
      const file = join(home, 'notes.txt')
      await writeFile(file, 'a file, not a folder\n')
      const store = new VaultStore(file)
      await expect(store.list()).rejects.toThrow(/not a folder/i)
      await expect(store.list()).rejects.not.toThrow(/moved or renamed/i)

      const missing = new VaultStore(join(home, 'Gone'))
      await expect(missing.list()).rejects.toThrow(/moved or renamed/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('says so for a note read through it, too, not only for a listing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'spacelink-shape-'))
    try {
      const file = join(home, 'notes.txt')
      await writeFile(file, 'a file, not a folder\n')
      const store = new VaultStore(join(file, 'inside'))
      await expect(store.read('Home.md')).rejects.toThrow(/not a folder/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('the account commands', { timeout: 60_000 }, () => {
  /** @type {string} */
  let home
  /** @type {string} */
  let entry

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'spacelink-cli-'))
    const { fileURLToPath } = await import('node:url')
    entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
    await mkdir(join(home, 'Notes'), { recursive: true })
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /** Run the server's CLI and collect what a person would see. */
  async function run(...args) {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    const code = await new Promise((done) => child.on('close', done))
    return { code, out, err }
  }

  /** Run the CLI with something piped into it, the way a script would. */
  async function runWithInput(input, ...args) {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    child.stdin.end(input)
    const code = await new Promise((done) => child.on('close', done))
    return { code, out, err }
  }

  const accountsFile = () => join(home, 'accounts.json')
  const PASSWORD = 'a long enough password'

  it('makes an account, and does not start a server afterwards', async () => {
    const made = await run(
      '--vault', join(home, 'Notes'),
      '--accounts', accountsFile(),
      '--add-account', 'me@example.com',
      '--password', PASSWORD,
    )
    // The process must exit: `--add-account` is a command, not a flag that
    // also serves. A shell left hanging on it would look like a hang.
    expect(made.code, made.err).toBe(0)
    expect(made.out).toContain('me@example.com')
    expect(made.out).toContain(join(home, 'Notes'))

    const stored = JSON.parse(await readFile(accountsFile(), 'utf8'))
    expect(stored.accounts).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(PASSWORD)
  })

  it('refuses a second account for the same address, and says why', async () => {
    const again = await run(
      '--vault', join(home, 'Notes'),
      '--accounts', accountsFile(),
      '--add-account', 'ME@example.com',
      '--password', PASSWORD,
    )
    expect(again.code).toBe(1)
    expect(again.err).toMatch(/already an account/i)
    expect(JSON.parse(await readFile(accountsFile(), 'utf8')).accounts).toHaveLength(1)
  })

  it('marks an account the listing would otherwise show as working', async () => {
    // The listing is where somebody looks to see who can reach the notes, so
    // an account that cannot has to say so there. Neither of these can be made
    // by this server — they come from a hand edit or two merged backups.
    const damaged = join(home, 'damaged.json')
    await addAccount({ file: damaged, email: 'first@example.com', password: PASSWORD, vault: join(home, 'Notes') })
    await addAccount({ file: damaged, email: 'second@example.com', password: PASSWORD, vault: join(home, 'Notes') })
    const store = await loadAccounts(damaged)
    store.accounts[1].email = 'FIRST@example.com'
    await saveAccounts(damaged, store)

    const shown = await run('--accounts', damaged, '--list-accounts')
    expect(shown.code, shown.err).toBe(0)
    const [, forFirst = '', forSecond = ''] = shown.out.split(/\n {4}(?=\S)/)
    expect(forSecond, 'an unreachable account was listed as if it worked').toMatch(/can never be signed in to/i)
    expect(forFirst, 'the account that does work was marked broken').not.toMatch(/never be signed in/i)
  })

  it('refuses a vault that exists and is not a folder, while the person is still here', async () => {
    // Measured: --add-account took a path to a file cheerfully, printed "Sign
    // in from any device", and every request from the device that did got a
    // 503 — saying the folder had been moved or unmounted, which it had not.
    const notAFolder = join(home, 'not-a-folder.txt')
    await writeFile(notAFolder, 'this is a file\n')
    const refused = await run(
      '--vault', notAFolder,
      '--accounts', join(home, 'shapes.json'),
      '--add-account', 'shape@example.com',
      '--password', PASSWORD,
    )
    expect(refused.code, 'the account was made anyway').toBe(1)
    expect(refused.err).toMatch(/is not a folder/i)
    expect(existsSync(join(home, 'shapes.json')), 'an accounts file was written for it').toBe(false)
  })

  it('still accepts a folder that does not exist yet, which the server makes', async () => {
    // The other half: naming a folder before it exists is how most people
    // start, and refusing that would be worse than the bug.
    const made = await run(
      '--vault', join(home, 'NotYetMade'),
      '--accounts', join(home, 'later.json'),
      '--add-account', 'later@example.com',
      '--password', PASSWORD,
    )
    expect(made.code, made.err).toBe(0)
    expect((await loadAccounts(join(home, 'later.json'))).accounts).toHaveLength(1)
  })

  it('says in the listing when an account’s folder is not there', async () => {
    // The listing is where an owner looks to see where the notes live, and the
    // one place a folder mistyped in --add-account would be caught. It used to
    // print a path that is not there exactly like one that is, while every
    // device on that account was getting 503.
    const listing = join(home, 'listing.json')
    await addAccount({ file: listing, email: 'here@example.com', password: PASSWORD, vault: join(home, 'Notes') })
    await addAccount({ file: listing, email: 'typo@example.com', password: PASSWORD, vault: join(home, 'Notez') })

    const shown = await run('--accounts', listing, '--list-accounts')
    expect(shown.code, shown.err).toBe(0)
    const [, forHere = '', forTypo = ''] = shown.out.split(/\n {4}(?=\S)/)
    expect(forTypo, 'a missing folder was listed as if it were there').toMatch(/not there/i)
    expect(forHere, 'a folder that is there was called missing').not.toMatch(/not there/i)
  })

  it('takes a password piped in, one line per prompt', async () => {
    // What a script does instead of --password, which lands in shell history.
    // Measured before this: the first prompt read the pipe to its end, the
    // second waited for an end that had already come on a stream with nothing
    // left to keep the process alive, and Node exited — code 0, no account,
    // not a word. To a script that is success.
    const piped = join(home, 'piped.json')
    const made = await runWithInput(
      `${PASSWORD}\n${PASSWORD}\n`,
      '--vault', join(home, 'Notes'),
      '--accounts', piped,
      '--add-account', 'piped@example.com',
    )
    expect(made.code, made.err).toBe(0)
    expect(made.out).toContain('Made an account for piped@example.com')

    const store = await loadAccounts(piped)
    expect(store.accounts.map((account) => account.email)).toEqual(['piped@example.com'])
    // The password, not the password and the newline after it.
    expect(await verifyLogin(store.accounts, 'piped@example.com', PASSWORD), 'the piped password does not sign in').not.toBeNull()
  })

  it('fails out loud when the pipe runs out before the password is confirmed', async () => {
    // One line piped, two prompts. Exiting 0 with nothing made is the one
    // outcome a script cannot tell from success.
    const piped = join(home, 'piped-short.json')
    const short = await runWithInput(
      `${PASSWORD}\n`,
      '--vault', join(home, 'Notes'),
      '--accounts', piped,
      '--add-account', 'short@example.com',
    )
    expect(short.code, 'the process claimed success').toBe(1)
    expect(short.err).toMatch(/pipe it in twice|--password/i)
    expect((await loadAccounts(piped)).accounts, 'an account was made from an unconfirmed password').toEqual([])
  })

  it('refuses a password too short to be worth hashing', async () => {
    const short = await run(
      '--vault', join(home, 'Notes'),
      '--accounts', accountsFile(),
      '--add-account', 'short@example.com',
      '--password', 'abc',
    )
    expect(short.code).toBe(1)
    expect(short.err).toMatch(/at least \d+ characters/i)
    expect(JSON.parse(await readFile(accountsFile(), 'utf8')).accounts).toHaveLength(1)
  })

  it('lists the accounts and the devices signed in on each', async () => {
    const { createSession, loadAccounts } = await import('./accounts.mjs')
    const store = await loadAccounts(accountsFile())
    await createSession({ file: accountsFile(), account: store.accounts[0], device: 'an iPhone or iPad' })

    const listed = await run('--accounts', accountsFile(), '--list-accounts')
    expect(listed.code, listed.err).toBe(0)
    expect(listed.out).toContain('me@example.com')
    expect(listed.out).toContain(join(home, 'Notes'))
    // The device, so it is obvious whether the list holds one you no longer
    // recognise — which is the question you are asking when you run this.
    expect(listed.out).toContain('an iPhone or iPad')
    // Never the credentials themselves.
    expect(listed.out).not.toContain(PASSWORD)
    expect(listed.out).not.toMatch(/[A-Fa-f0-9]{64}/)
  })

  it('does not sign every device out when an account is made beside them', async () => {
    // The documented way to make an account is this command, run while the
    // server is up. It is a different *process*, so the queue that orders
    // writes inside one process cannot see it: without a lock on the file, the
    // command reads the accounts before the sessions are written and writes its
    // version back over them. Measured against a real server before the fix —
    // four devices signed in, four sessions gone, every one silently signed out.
    //
    // Reproduced here deliberately rather than hopefully: this process holds
    // the file open for a beat while the command runs, so the overlap happens
    // every time instead of only when the timing lands.
    const { addAccount: add, loadAccounts, updateAccounts, sessionId: idOf } = await import('./accounts.mjs')
    const beside = await mkdtemp(join(tmpdir(), 'spacelink-beside-'))
    try {
      const notes = join(beside, 'Notes')
      await mkdir(notes, { recursive: true })
      const file = join(beside, 'accounts.json')
      const account = await add({ file, email: 'here@example.com', password: PASSWORD, vault: notes })

      const tokens = Array.from({ length: 4 }, (_, index) => `token-for-device-${index}`)
      const holding = updateAccounts(file, async (store) => {
        store.sessions = tokens.map((token, index) => ({
          id: idOf(token),
          accountId: account.id,
          device: `device ${index}`,
          createdAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
        }))
        // Held open, so the command below is genuinely running at the same time.
        await new Promise((done) => setTimeout(done, 600))
      })

      await new Promise((done) => setTimeout(done, 50))
      const added = run('--vault', notes, '--accounts', file, '--add-account', 'newcomer@example.com', '--password', PASSWORD)
      const [, made] = await Promise.all([holding, added])
      expect(made.code, made.err).toBe(0)

      const store = await loadAccounts(file)
      expect(store.accounts.map((one) => one.email).sort(), 'the new account was written over').toEqual([
        'here@example.com',
        'newcomer@example.com',
      ])
      expect(store.sessions, 'a session was lost to the command running beside it').toHaveLength(4)
      for (const token of tokens) {
        expect(accountForSession(store, token), token).toMatchObject({ email: 'here@example.com' })
      }
    } finally {
      await rm(beside, { recursive: true, force: true })
    }
  }, 30_000)

  it('says what to do when there are no accounts yet', async () => {
    const empty = await run('--accounts', join(home, 'nothing.json'), '--list-accounts')
    expect(empty.code).toBe(0)
    expect(empty.out).toContain('--add-account')
  })

  it('changes a password, and signs out every device that was signed in', async () => {
    const { loadAccounts } = await import('./accounts.mjs')
    expect((await loadAccounts(accountsFile())).sessions.length).toBeGreaterThan(0)

    const changed = await run('--accounts', accountsFile(), '--set-password', 'me@example.com', '--password', 'a different long password')
    expect(changed.code, changed.err).toBe(0)
    expect(changed.out).toMatch(/signed out/i)

    // A password is changed because it may be known. A session that outlived
    // it would make the change decorative.
    expect((await loadAccounts(accountsFile())).sessions).toEqual([])
  })

  it('will not change the password of an account that does not exist', async () => {
    const missing = await run('--accounts', accountsFile(), '--set-password', 'nobody@example.com', '--password', PASSWORD)
    expect(missing.code).toBe(1)
    expect(missing.err).toMatch(/no account/i)
  })

  it('will not make an account without a folder for its notes', async () => {
    const homeless = await run('--accounts', accountsFile(), '--add-account', 'homeless@example.com', '--password', PASSWORD)
    expect(homeless.code).toBe(1)
    expect(homeless.err).toMatch(/--vault/)
  })

  it('offers the account commands in its help, where someone would look for them', async () => {
    const help = await run('--help')
    expect(help.code).toBe(0)
    for (const flag of ['--add-account', '--set-password', '--list-accounts', '--accounts']) {
      expect(help.out, flag).toContain(flag)
    }
    expect(help.out).toMatch(/no sign-up page/i)
  })
})

/**
 * Where the token and the accounts live after the app was renamed.
 *
 * This is the one piece of state a rename can strand: the folder is addressed
 * by name, and a server that quietly started against a fresh one would mint a
 * new token, find no accounts, and turn every paired device away with nothing
 * explaining why. Run as a child process with `HOME` pointed at a temporary
 * directory, because the path is resolved once when the module loads.
 */
/**
 * Hammering the sign-in endpoint.
 *
 * On a server of its own, deliberately: these tests exhaust the limiter for
 * the address they come from, which is the point of them, and sharing that
 * with the other tests would have them refuse perfectly good sign-ins made
 * afterwards. That is the limiter working — but in a test it reads as a
 * failure somewhere else entirely.
 */
describe('a caller leaning on the sign-in endpoint', { timeout: 60_000 }, () => {
  const PASSWORD = 'a long enough password'
  /** @type {string} */
  let home
  /** @type {import('node:http').Server} */
  let listener
  /** @type {string} */
  let at

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'spacelink-hammer-'))
    const notes = join(home, 'Notes')
    await mkdir(notes, { recursive: true })
    const accountsFile = join(home, 'accounts.json')
    await addAccount({ file: accountsFile, email: 'burst@example.com', password: PASSWORD, vault: notes })

    const sync = createSyncServer({ vault: notes, token: TOKEN, distDir: join(home, '__no_dist__'), accountsFile })
    listener = createServer((request, response) => void sync.handle(request, response))
    await new Promise((done) => listener.listen(0, '127.0.0.1', done))
    const address = listener.address()
    at = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(async () => {
    await new Promise((done) => listener.close(done))
    await rm(home, { recursive: true, force: true })
  })

  /** @param {string} email @param {string} password */
  const login = (email, password) =>
    fetch(`${at}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

  it('counts a burst of guesses sent all at once, not just one after another', async () => {
    // The limiter reads a count, then spends ~90ms hashing, then records the
    // failure. If it recorded only at the end, every request in a burst would
    // read the same count and pass together — which is not a slower attack but
    // an unlimited one. Measured before this was fixed: twenty concurrent
    // guesses, twenty 401s, nothing throttled.
    const guess = () => login('burst@example.com', 'wrong every time').then((response) => response.status)
    const statuses = await Promise.all(Array.from({ length: 20 }, guess))

    const refused = statuses.filter((status) => status === 429).length
    const reached = statuses.filter((status) => status === 401).length
    expect(reached + refused).toBe(20)
    // Five free attempts, so a handful get through and the rest do not. The
    // exact split does not matter; that most of them are stopped does.
    expect(refused, `only ${refused} of 20 concurrent guesses were throttled`).toBeGreaterThan(10)
    expect(reached).toBeLessThanOrEqual(8)
  }, 30_000)

  it('bounds how much a made-up address can cost, without conflating a real one', async () => {
    // The limiter holds ten thousand keys and takes each from the request
    // body, so its size was the caller's to choose: measured, ten thousand
    // four-thousand-character addresses came to 45 MB of heap, spent by
    // anyone on the network with no token and no account. Keys are cut to the
    // longest address an account can have — 254 — so two that differ only
    // past that share a key, and nothing that could ever match an account is
    // conflated.
    //
    // Its own server: the limiter is per server, and the bursts above leave
    // this address's budget well spent.
    const quiet = await mkdtemp(join(tmpdir(), 'spacelink-keys-'))
    const notes = join(quiet, 'Notes')
    await mkdir(notes, { recursive: true })
    const sync = createSyncServer({ vault: notes, token: TOKEN, distDir: join(quiet, '__no_dist__'), accountsFile: join(quiet, 'a.json') })
    await addAccount({ file: join(quiet, 'a.json'), email: 'real@example.com', password: PASSWORD, vault: notes })
    const server = createServer((request, response) => void sync.handle(request, response))
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const guess = (email) =>
      fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'not the password' }),
      })

    try {
      // Two addresses alike for their first 254 characters and different after.
      const head = 'x'.repeat(3900)
      for (let attempt = 0; attempt < 6; attempt += 1) await guess(`${head}a@example.com`)
      const sibling = await guess(`${head}b@example.com`)
      expect(sibling.status, 'a caller could mint a fresh key per request').toBe(429)

      // Two ordinary addresses are still two keys, which is the point of one —
      // including two that are alike almost all the way, since a cut too short
      // would count strangers against each other and lock out the wrong person.
      const nearly = `${'long-but-ordinary-'.repeat(11)}`.slice(0, 200)
      for (let attempt = 0; attempt < 6; attempt += 1) await guess(`${nearly}one@example.com`)
      const other = await guess(`${nearly}two@example.com`)
      expect(other.status, 'ordinary addresses were conflated into one key').toBe(401)
    } finally {
      await new Promise((done) => server.close(done))
      await rm(quiet, { recursive: true, force: true })
    }
  })

  it('counts one address under one key however it is capitalised', async () => {
    // Addresses match case-insensitively, so the limiter must count them that
    // way too: otherwise the budget is per capitalisation, and a guesser gets
    // a fresh one by shifting a letter.
    const quiet = await mkdtemp(join(tmpdir(), 'spacelink-case-'))
    const notes = join(quiet, 'Notes')
    await mkdir(notes, { recursive: true })
    const sync = createSyncServer({ vault: notes, token: TOKEN, distDir: join(quiet, '__no_dist__'), accountsFile: join(quiet, 'a.json') })
    await addAccount({ file: join(quiet, 'a.json'), email: 'Cased@Example.com', password: PASSWORD, vault: notes })
    const server = createServer((request, response) => void sync.handle(request, response))
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const guess = (email) =>
      fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'not the password' }),
      })

    try {
      for (let attempt = 0; attempt < 6; attempt += 1) await guess('cased@example.com')
      const shifted = await guess('CASED@EXAMPLE.COM')
      expect(shifted.status, 'a different capitalisation bought a fresh budget').toBe(429)
    } finally {
      await new Promise((done) => server.close(done))
      await rm(quiet, { recursive: true, force: true })
    }
  })

  it('tells an impossible address exactly what it tells a wrong password', async () => {
    // Refusing a 4,000-character address differently would be a way to learn
    // which shapes the server treats as real. It gets what any wrong guess does.
    const answer = await login(`${'y'.repeat(3900)}@example.com`, 'not the password')
    expect([401, 429], 'an impossible address was answered its own way').toContain(answer.status)
    if (answer.status === 401) expect((await answer.json()).error).toMatch(/do not match an account/i)
  })

  it('counts a caller who never repeats an address, too', async () => {
    // Every attempt names its own email, so limiting by email alone never
    // counts a caller who uses a fresh one each time — while each miss still
    // costs a deliberate 90ms and 32 MiB of scrypt. That is the whole endpoint
    // left free to exhaust, and it needs the caller's address to catch.
    const statuses = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        login(`nobody-${index}-${Date.now()}@example.com`, 'wrong').then((response) => response.status),
      ),
    )
    const refused = statuses.filter((status) => status === 429).length
    expect(refused, `${refused} of 40 unrelated-address guesses were throttled`).toBeGreaterThan(5)
  }, 30_000)

})

describe('the folder the server keeps its token in', { timeout: 60_000 }, () => {
  /** @type {string} */
  let entry

  beforeAll(async () => {
    const { fileURLToPath } = await import('node:url')
    entry = fileURLToPath(new URL('./index.mjs', import.meta.url))
  })

  /** Run the CLI with `HOME` pointed somewhere of our choosing. */
  async function runAt(home, ...args) {
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    const code = await new Promise((done) => child.on('close', done))
    return { code, out, err }
  }

  /** Ask the token module, with `HOME` pointed somewhere of our choosing. */
  async function tokenAt(home) {
    const { spawn } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const config = fileURLToPath(new URL('./config.mjs', import.meta.url))
    const script = `import(${JSON.stringify(config)}).then((m) => m.loadOrCreateToken()).then((r) => console.log(JSON.stringify(r)))`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += String(chunk)))
    child.stderr.on('data', (chunk) => (err += String(chunk)))
    const code = await new Promise((done) => child.on('close', done))
    if (code !== 0) throw new Error(err)
    return JSON.parse(out)
  }

  const modeOf = async (file) => ((await stat(file)).mode & 0o777).toString(8)

  it('tightens a token file that was left readable by everyone on the machine', async () => {
    // The token is the whole of the vault's access. The file is read on every
    // start and rewritten on none, so one left at 644 — by an older build, or
    // by whatever copied it here — stayed that way for as long as the token
    // was valid. Measured: 644 in, 644 out, token kept.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-home-'))
    try {
      const file = join(home, '.spacelink', 'server.json')
      await mkdir(join(home, '.spacelink'), { recursive: true })
      await writeFile(file, JSON.stringify({ token: 'q'.repeat(43) }), { mode: 0o644 })
      expect(await modeOf(file)).toBe('644')

      const got = await tokenAt(home)
      expect(got.created, 'a valid token was rotated').toBe(false)
      expect(got.token).toBe('q'.repeat(43))
      expect(await modeOf(file), 'still readable by every other user').toBe('600')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lands a fresh token at 600 even over a file that was 644', async () => {
    // `mode` on a write applies only to a file being created. A token rotated
    // into a file that already existed kept that file's mode — measured, 644.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-home-'))
    try {
      const file = join(home, '.spacelink', 'server.json')
      await mkdir(join(home, '.spacelink'), { recursive: true })
      await writeFile(file, JSON.stringify({ token: 'too-short' }), { mode: 0o644 })

      const got = await tokenAt(home)
      expect(got.created, 'a token too short to be one was kept').toBe(true)
      expect(await modeOf(file), 'the new token is readable by every other user').toBe('600')
      // And nothing half-written is left beside it.
      expect((await readdir(join(home, '.spacelink'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('is ~/.spacelink on a machine that has never run this server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'spacelink-home-'))
    try {
      await mkdir(join(home, 'Notes'), { recursive: true })
      const made = await runAt(home, '--vault', join(home, 'Notes'), '--add-account', 'me@example.com', '--password', 'a long enough password')
      expect(made.code, made.err).toBe(0)
      expect(JSON.parse(await readFile(join(home, '.spacelink', 'accounts.json'), 'utf8')).accounts).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('is the old ~/.spacefore when that is the only one there', async () => {
    // Someone who ran this server before the rename. Starting against an empty
    // ~/.spacelink would issue a new token and find no accounts, and every
    // device already paired would simply stop working.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-home-'))
    try {
      await mkdir(join(home, 'Notes'), { recursive: true })
      await mkdir(join(home, '.spacefore'), { recursive: true })
      const made = await runAt(
        home,
        '--vault', join(home, 'Notes'),
        '--accounts', join(home, '.spacefore', 'accounts.json'),
        '--add-account', 'me@example.com',
        '--password', 'a long enough password',
      )
      expect(made.code, made.err).toBe(0)

      // Now ask without naming the file: it must find the old folder.
      const listed = await runAt(home, '--list-accounts')
      expect(listed.code, listed.err).toBe(0)
      expect(listed.out).toContain(join(home, '.spacefore', 'accounts.json'))
      expect(listed.out).toContain('me@example.com')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('prefers ~/.spacelink once it exists, so nothing is read from two places', async () => {
    const home = await mkdtemp(join(tmpdir(), 'spacelink-home-'))
    try {
      await mkdir(join(home, 'Notes'), { recursive: true })
      await mkdir(join(home, '.spacefore'), { recursive: true })
      await runAt(
        home,
        '--vault', join(home, 'Notes'),
        '--accounts', join(home, '.spacefore', 'accounts.json'),
        '--add-account', 'me@example.com',
        '--password', 'a long enough password',
      )
      expect((await runAt(home, '--list-accounts')).out).toContain('.spacefore')

      await mkdir(join(home, '.spacelink'), { recursive: true })
      const listed = await runAt(home, '--list-accounts')
      expect(listed.code, listed.err).toBe(0)
      // The new folder wins outright — it is empty, and that is what it says.
      expect(listed.out).not.toContain(join(home, '.spacefore'))
      expect(listed.out).toContain('No accounts yet')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('a server started without accounts', () => {
  it('says so plainly rather than pretending a password was wrong', async () => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'me@example.com', password: 'a long enough password' }),
    })
    expect(response.status).toBe(404)
    expect((await response.json()).error).toContain('access token')
  })

  it('still answers who is signed in, for a token that is not an account', async () => {
    const me = await (await call('/api/auth/me')).json()
    expect(me.signedIn).toBe(false)
    expect(me.email).toBeNull()
  })

  it('takes a sign-out from a device that never signed in', async () => {
    const response = await call('/api/auth/logout', { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await call('/api/files')).status).toBe(200)
  })
})

describe('typing a password at the terminal', () => {
  // `takeKeys` is what the raw-mode prompt folds each chunk of input through.
  // A chunk is a keystroke when typing and the whole clipboard when pasting.
  const type = (...chunks) => {
    let state = { typed: '', done: false, interrupted: false }
    for (const chunk of chunks) {
      state = takeKeys(state.typed, chunk)
      if (state.done) break
    }
    return state
  }

  it('reads a paste that ends in a newline as the password and Enter, not as the password', () => {
    // A password manager's clipboard. Measured at a real terminal before this:
    // the newline went into the password, the prompt then waited for an Enter
    // that had already been pasted, and the account was made with a password
    // ending in `\n` — refused when typed into the app, with nothing said.
    expect(type('a long enough password\n')).toEqual({ typed: 'a long enough password', done: true, interrupted: false })
    expect(type('a long enough password\r\n')).toEqual({ typed: 'a long enough password', done: true, interrupted: false })
  })

  it('reads keystrokes one at a time, the ordinary way', () => {
    expect(type('p', 'a', 's', 's', '\r')).toEqual({ typed: 'pass', done: true, interrupted: false })
    expect(type('p', 'a').done).toBe(false)
  })

  it('drops what comes after the Enter rather than carrying it into the next prompt', () => {
    // A clipboard holding two lines. The second is not the answer to "Again:".
    expect(type('first\nsecond\n').typed).toBe('first')
  })

  it('takes backspace as one character, even when that character is an emoji', () => {
    expect(type('pas', 's', '\u007f', '\r').typed).toBe('pas')
    expect(type('pass🔑', '\u007f', '\r').typed).toBe('pass')
    expect(type('\u007f', '\r').typed).toBe('')
  })

  it('ends on Ctrl-D and reports Ctrl-C, without either landing in the password', () => {
    expect(type('pass', '\u0004')).toEqual({ typed: 'pass', done: true, interrupted: false })
    expect(type('pass', '\u0003')).toEqual({ typed: 'pass', done: true, interrupted: true })
  })
})
