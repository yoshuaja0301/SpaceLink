/// <reference types="node" />
/**
 * The sync client, against a real sync server.
 *
 * Node's types are pulled in for this file alone rather than for the whole app
 * project: the test starts a real HTTP server and writes real temporary
 * folders, but a component reaching for `process` should still be a type error.
 *
 * The server is started for real on a random port and given a real temporary
 * folder, so every assertion here is about bytes that actually reached disk.
 * The change stream is the one thing not covered: jsdom has no `EventSource`,
 * so live updates are exercised by the browser suite instead.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @ts-expect-error — plain JavaScript, typed by JSDoc rather than declarations
import { createSyncServer } from '../../../server/index.mjs'
import { createRemoteVault, deviceId, normalizeServerUrl, probeServer, RemoteConflict } from './remoteVault'

const TOKEN = 'b'.repeat(43)

let vault: string
let listener: Server
let origin: string
let stopWatching: AbortController

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'spacefore-remote-'))
  const sync = createSyncServer({ vault, token: TOKEN, distDir: join(vault, '__no_dist__') })
  listener = createServer((request, response) => void sync.handle(request, response))
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()))
  const address = listener.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  stopWatching = new AbortController()
  void sync.startWatching(stopWatching.signal)
})

afterAll(async () => {
  stopWatching.abort()
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  await rm(vault, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(join(vault, 'Ideas'), { recursive: true, force: true })
  for (const name of await filesInVault()) await rm(join(vault, name), { force: true })
  await writeFile(join(vault, 'Home.md'), '# Home\n\nSee [[Ideas/Seed]].\n')
  await mkdir(join(vault, 'Ideas'), { recursive: true })
  await writeFile(join(vault, 'Ideas/Seed.md'), '# Seed\n')
})

afterEach(() => {
  localStorage.clear()
})

async function filesInVault(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(vault).catch(() => [] as string[])
  return names.filter((name) => name.endsWith('.md'))
}

const onDisk = (name: string): Promise<string> => readFile(join(vault, name), 'utf8')
const connect = (): ReturnType<typeof createRemoteVault> => createRemoteVault({ url: origin, token: TOKEN })

describe('normalizeServerUrl', () => {
  it('accepts what a person would actually type', () => {
    expect(normalizeServerUrl('192.168.1.20:4899')).toBe('http://192.168.1.20:4899')
    expect(normalizeServerUrl(' https://notes.example.ts.net/ ')).toBe('https://notes.example.ts.net')
    expect(normalizeServerUrl('http://localhost:4899/some/path')).toBe('http://localhost:4899')
  })

  it('refuses what it cannot use', () => {
    expect(() => normalizeServerUrl('')).toThrow(/address/i)
    expect(() => normalizeServerUrl('   ')).toThrow(/address/i)
    expect(() => normalizeServerUrl('http://')).toThrow(/not a valid address/i)
  })
})

describe('probeServer', () => {
  it('reports the vault name when the address and token are right', async () => {
    const result = await probeServer(origin, TOKEN)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.name).toBe(vault.split('/').pop())
  })

  it('says the token was refused, not something vague', async () => {
    const result = await probeServer(origin, 'wrong-token')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toMatch(/token/i)
  })

  it('says it could not reach an address that is not listening', async () => {
    const result = await probeServer('http://127.0.0.1:1', TOKEN)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toMatch(/could not reach/i)
  })
})

describe('createRemoteVault', () => {
  it('refuses to build against a server that will not have it', async () => {
    await expect(createRemoteVault({ url: origin, token: 'nope' })).rejects.toThrow(/token/i)
  })

  it('lists what the server holds', async () => {
    const adapter = await connect()
    expect(adapter.kind).toBe('remote')
    expect(adapter.writable).toBe(true)

    const files = await adapter.list()
    expect(files.map((file) => file.path).sort()).toEqual(['Home.md', 'Ideas/Seed.md'])
    const home = files.find((file) => file.path === 'Home.md')!
    expect(home.isMarkdown).toBe(true)
    expect(home.name).toBe('Home')
  })

  it('reads and writes through to the folder on disk', async () => {
    const adapter = await connect()
    expect(await adapter.read('Home.md')).toContain('# Home')

    await adapter.write('Home.md', '# Home\n\nedited from a device\n')
    expect(await onDisk('Home.md')).toBe('# Home\n\nedited from a device\n')
  })

  it('creates a note in a folder that does not exist yet', async () => {
    const adapter = await connect()
    await adapter.write('Later/Thoughts.md', '# Thoughts\n')
    expect(await onDisk('Later/Thoughts.md')).toBe('# Thoughts\n')
    await rm(join(vault, 'Later'), { recursive: true, force: true })
  })

  it('renames, deletes and reports existence', async () => {
    const adapter = await connect()
    await adapter.list()

    await adapter.rename('Ideas/Seed.md', 'Ideas/Sprout.md')
    expect(await onDisk('Ideas/Sprout.md')).toBe('# Seed\n')
    expect(await adapter.exists('Ideas/Sprout.md')).toBe(true)
    expect(await adapter.exists('Ideas/Seed.md')).toBe(false)

    await adapter.remove('Ideas/Sprout.md')
    expect(await adapter.exists('Ideas/Sprout.md')).toBe(false)
  })

  it('says which note it could not read', async () => {
    const adapter = await connect()
    await expect(adapter.read('Nowhere.md')).rejects.toThrow(/Nowhere\.md/)
  })
})

describe('two devices editing the same note', () => {
  it('keeps both versions instead of choosing a winner', async () => {
    const laptop = await connect()
    const phone = await connect()

    // Both read the note, so both believe they are editing the same version.
    await laptop.read('Home.md')
    await phone.read('Home.md')

    await phone.write('Home.md', '# Home\n\nwritten on the phone\n')

    // The laptop's save is now against a version that no longer exists.
    let conflict: unknown
    try {
      await laptop.write('Home.md', '# Home\n\nwritten on the laptop\n')
    } catch (error) {
      conflict = error
    }

    expect(conflict).toBeInstanceOf(RemoteConflict)
    const conflictPath = (conflict as RemoteConflict).conflictPath
    expect(conflictPath).toMatch(/^Home \(conflict .+\)\.md$/)

    // The phone's version is untouched, and the laptop's is beside it.
    expect(await onDisk('Home.md')).toBe('# Home\n\nwritten on the phone\n')
    expect(await onDisk(conflictPath)).toBe('# Home\n\nwritten on the laptop\n')

    await rm(join(vault, conflictPath), { force: true })
  })

  it('does not keep making copies once the conflict is settled', async () => {
    const laptop = await connect()
    const phone = await connect()
    await laptop.read('Home.md')
    await phone.write('Home.md', '# Home\n\nphone again\n')

    await expect(laptop.write('Home.md', '# Home\n\nlaptop again\n')).rejects.toBeInstanceOf(RemoteConflict)

    // The adapter has taken on the server's version, so the next save is a
    // normal one — not a second conflict, and not a second copy.
    await laptop.write('Home.md', '# Home\n\nlaptop, having caught up\n')
    expect(await onDisk('Home.md')).toBe('# Home\n\nlaptop, having caught up\n')

    const copies = (await filesInVault()).filter((name) => name.includes('conflict'))
    expect(copies).toHaveLength(1)
    for (const name of copies) await rm(join(vault, name), { force: true })
  })

  it('writes a note nobody has read yet without pretending to know its hash', async () => {
    const adapter = await connect()
    // No prior read: an unconditional write is correct here, and must not be
    // mistaken for a conflict.
    await adapter.write('Brand New.md', '# Brand New\n')
    expect(await onDisk('Brand New.md')).toBe('# Brand New\n')
  })
})

describe('deviceId', () => {
  it('is stable for a browser profile', () => {
    const first = deviceId()
    expect(deviceId()).toBe(first)
    expect(first.length).toBeGreaterThan(8)
  })

  it('survives storage being unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })
    expect(() => deviceId()).not.toThrow()
    if (original) Object.defineProperty(window, 'localStorage', original)
  })
})
