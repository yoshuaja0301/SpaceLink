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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// @ts-expect-error — plain JavaScript, typed by JSDoc rather than declarations
import { createSyncServer } from '../../../server/index.mjs'
import { comparePaths } from './paths'
// @ts-expect-error — plain JavaScript, typed by JSDoc rather than declarations
import { addAccount, setPassword } from '../../../server/accounts.mjs'
import {
  createRemoteVault,
  describeDevice,
  deviceId,
  normalizeServerUrl,
  openWithAccount,
  probeServer,
  RemoteConflict,
  RemoteRefused,
  signIn,
  signOut,
} from './remoteVault'

const TOKEN = 'b'.repeat(43)

let vault: string
let listener: Server
let origin: string
let stopWatching: AbortController

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), 'spacelink-remote-'))
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

describe('signing in', () => {
  const PASSWORD = 'a long enough password'

  let home: string
  let accountVault: string
  let accountsListener: Server
  let accountOrigin: string

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'spacelink-signin-'))
    accountVault = join(home, 'Notebook')
    await mkdir(accountVault, { recursive: true })
    await writeFile(join(accountVault, 'Only Mine.md'), '# Only mine\n')
    const accountsFile = join(home, 'accounts.json')
    await addAccount({ file: accountsFile, email: 'me@example.com', password: PASSWORD, vault: accountVault })

    const sync = createSyncServer({
      vault: join(home, 'Unused'),
      token: 'c'.repeat(43),
      distDir: join(home, '__no_dist__'),
      accountsFile,
    })
    accountsListener = createServer((request, response) => void sync.handle(request, response))
    await new Promise<void>((resolve) => accountsListener.listen(0, '127.0.0.1', () => resolve()))
    const address = accountsListener.address()
    accountOrigin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>((resolve) => accountsListener.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  })

  it('comes back with a session and the name of the vault it opened', async () => {
    const result = await signIn(accountOrigin, 'me@example.com', PASSWORD)
    expect(result).toMatchObject({ ok: true, email: 'me@example.com', name: 'Notebook' })
    if (!result.ok) return
    // The session, not the password: what the device keeps must be revocable
    // from somewhere else without changing the password.
    expect(result.token).not.toBe(PASSWORD)
    expect(result.token.length).toBeGreaterThan(20)

    const vault = await createRemoteVault({ url: accountOrigin, token: result.token, email: result.email })
    expect((await vault.list()).map((file) => file.path)).toEqual(['Only Mine.md'])
  }, 20_000)

  it('does not leave a session behind when the vault will not open', async () => {
    // The account is real, the password is right, and the folder it points at
    // is not there — a typo in `--add-account`, or a drive not plugged in.
    // Measured before this: every attempt left a signed-in device on the
    // server that nobody held, listed by `--list-accounts` as present, and
    // clearable only by changing the password. Three tries, three phantoms.
    const stray = join(home, 'strays.json')
    await addAccount({ file: stray, email: 'typo@example.com', password: PASSWORD, vault: join(home, 'NotThere') })
    const sync = createSyncServer({
      vault: join(home, 'Unused'),
      token: 'd'.repeat(43),
      distDir: join(home, '__no_dist__'),
      accountsFile: stray,
    })
    const server = createServer((request, response) => void sync.handle(request, response))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const sessions = async (): Promise<unknown[]> => JSON.parse(await readFile(stray, 'utf8')).sessions

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await expect(openWithAccount(url, 'typo@example.com', PASSWORD)).rejects.toThrow()
      }
      expect(await sessions(), 'a device that never got in is still signed in').toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)

  it('tells a refused credential apart from a server that is away', async () => {
    // `--set-password` is documented as signing every device out, so this is
    // the everyday case, not an edge one. Measured before this: the server
    // answered 200 on /api/health and 401 on the credential, and the reader
    // was told their server could not be reached and to reload once it was
    // back — which it already was, and reloading would never have helped.
    const revoked = join(home, 'revoked.json')
    await addAccount({ file: revoked, email: 'lost@example.com', password: PASSWORD, vault: accountVault })
    const sync = createSyncServer({
      vault: join(home, 'Unused'),
      token: 'f'.repeat(43),
      distDir: join(home, '__no_dist__'),
      accountsFile: revoked,
    })
    const server = createServer((request, response) => void sync.handle(request, response))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    try {
      const session = await signIn(url, 'lost@example.com', PASSWORD)
      expect(session.ok).toBe(true)
      if (!session.ok) return

      // The owner changes the password from the terminal, from anywhere.
      await setPassword({ file: revoked, email: 'lost@example.com', password: 'a different long password' })

      // The device relaunches, and the server is up the whole time.
      expect((await fetch(`${url}/api/health`)).status, 'the server is not the problem').toBe(200)
      await expect(
        createRemoteVault({ url, token: session.token, email: 'lost@example.com' }),
      ).rejects.toBeInstanceOf(RemoteRefused)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)

  it('does not call a server that is simply away a refused credential', async () => {
    // The other half. Nothing is listening on this port, so the failure is the
    // network — the pairing is good and comes back by itself.
    const away = 'http://127.0.0.1:1'
    await expect(createRemoteVault({ url: away, token: 'g'.repeat(43) })).rejects.not.toBeInstanceOf(RemoteRefused)
    await expect(createRemoteVault({ url: away, token: 'g'.repeat(43) })).rejects.toThrow(/could not reach/i)
  }, 20_000)

  it('refuses to pair with a vault the server cannot read, in the server’s own words', async () => {
    // The pairing check answered from the vault's *name* — a string on the
    // server's own command line — without ever looking at the folder. So a
    // vault whose folder is missing paired successfully, the connection was
    // saved, and the reader met the failure on their first listing instead —
    // and on every launch afterwards, since the saved pairing is what the app
    // reconnects to.
    const stray = join(home, 'unreadable.json')
    await addAccount({ file: stray, email: 'gone@example.com', password: PASSWORD, vault: join(home, 'AlsoNotThere') })
    const sync = createSyncServer({
      vault: join(home, 'Unused'),
      token: 'e'.repeat(43),
      distDir: join(home, '__no_dist__'),
      accountsFile: stray,
    })
    const server = createServer((request, response) => void sync.handle(request, response))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    try {
      const session = await signIn(url, 'gone@example.com', PASSWORD)
      expect(session.ok, 'the sign-in itself should still work').toBe(true)
      if (!session.ok) return

      const probe = await probeServer(url, session.token, 'account')
      expect(probe.ok, 'paired with a vault the server cannot read').toBe(false)
      // Not "the server answered 503": the reader is told the folder is
      // missing, which is the one sentence that says what to do about it.
      if (!probe.ok) expect(probe.error).toMatch(/folder this vault lives in is not there/i)
      await signOut(url, session.token)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30_000)

  it('keeps the session when the vault does open, which is the whole point', async () => {
    const opened = await openWithAccount(accountOrigin, 'me@example.com', PASSWORD)
    expect((await opened.adapter.list()).map((file) => file.path)).toEqual(['Only Mine.md'])
    expect(opened.email).toBe('me@example.com')
    // The token it came back with is a working one, not one it has just ended.
    const probe = await probeServer(accountOrigin, opened.token, 'account')
    expect(probe.ok, 'the session was signed out on the way through').toBe(true)
    await signOut(accountOrigin, opened.token)
  }, 20_000)

  it('passes the server’s own words back when the password is wrong', async () => {
    const result = await signIn(accountOrigin, 'me@example.com', 'not the password')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/do not match an account/i)
  }, 20_000)

  it('says a server without accounts is not broken, just not that kind of server', async () => {
    // `origin` is the suite's other server, started with a token and no
    // accounts file. Its 404 means "no accounts here", and a person staring at
    // a sign-in form deserves to be told which credential this server wants.
    const result = await signIn(origin, 'me@example.com', PASSWORD)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/access token/i)
  })

  it('does not read a router’s 404 out loud to someone typing a password', async () => {
    // A SpaceLink server from before accounts existed has no such route at
    // all, and answers the way it answers any unknown address. Repeating that
    // back — "No such endpoint: POST /api/auth/login" — tells the person
    // nothing they can act on, and reads like the app is broken.
    const older = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'No such endpoint: POST /api/auth/login' }))
    })
    await new Promise<void>((resolve) => older.listen(0, '127.0.0.1', () => resolve()))
    try {
      const address = older.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const result = await signIn(`http://127.0.0.1:${port}`, 'me@example.com', PASSWORD)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toMatch(/access token/i)
      expect(result.error).not.toMatch(/endpoint/i)
    } finally {
      await new Promise<void>((resolve) => older.close(() => resolve()))
    }
  })

  it('says it could not reach an address that is not listening', async () => {
    const result = await signIn('http://127.0.0.1:1', 'me@example.com', PASSWORD)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/could not reach/i)
  })

  it('signs this device out without touching the others', async () => {
    const phone = await signIn(accountOrigin, 'me@example.com', PASSWORD)
    const laptop = await signIn(accountOrigin, 'me@example.com', PASSWORD)
    expect(phone.ok && laptop.ok).toBe(true)
    if (!phone.ok || !laptop.ok) return

    await signOut(accountOrigin, phone.token)
    expect((await probeServer(accountOrigin, phone.token, 'account')).ok).toBe(false)
    expect((await probeServer(accountOrigin, laptop.token, 'account')).ok).toBe(true)
  }, 30_000)

  it('does not throw when there is no server to sign out of', async () => {
    await expect(signOut('http://127.0.0.1:1', 'anything')).resolves.toBeUndefined()
  })

  it('tells an expired sign-in from a rotated token, because the fix differs', async () => {
    const asAccount = await probeServer(accountOrigin, 'not a session', 'account')
    const asToken = await probeServer(accountOrigin, 'not a token', 'token')
    expect(asAccount.ok).toBe(false)
    expect(asToken.ok).toBe(false)
    if (asAccount.ok || asToken.ok) return
    expect(asAccount.error).toMatch(/sign in again/i)
    expect(asToken.error).toMatch(/copy it again/i)
  })

  it('names the kind of device it is, and nothing sharper than that', () => {
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('an iPhone or iPad')
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('a Mac')
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('a Windows PC')
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14)')).toBe('an Android device')
    expect(describeDevice('something nobody has seen')).toBe('a browser')
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

describe('opening the whole vault at once', () => {
  const collect = async (adapter: Awaited<ReturnType<typeof connect>>): Promise<Map<string, string>> => {
    const all = new Map<string, string>()
    for await (const batch of adapter.readAll!()) for (const [path, text] of batch) all.set(path, text)
    return all
  }

  it('hands over every note in one pass', async () => {
    const adapter = await connect()
    const all = await collect(adapter)

    expect([...all.keys()].sort()).toEqual(['Home.md', 'Ideas/Seed.md'])
    expect(all.get('Home.md')).toBe(await onDisk('Home.md'))
    expect(all.get('Ideas/Seed.md')).toBe('# Seed\n')
  })

  it('leaves attachments out — they are fetched only when something needs them', async () => {
    await writeFile(join(vault, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const adapter = await connect()
    expect([...(await collect(adapter)).keys()]).not.toContain('photo.png')
    await rm(join(vault, 'photo.png'), { force: true })
  })

  it('learns each note’s hash on the way, so the first save is still conditional', async () => {
    const laptop = await connect()
    const phone = await connect()
    await collect(laptop) // the laptop opened the vault, and read nothing since

    // Somebody else changes the note the laptop believes it knows.
    await phone.write('Home.md', '# Home\n\nfrom the phone\n')

    // If the bundle had not carried hashes the laptop would write blindly and
    // clobber this. It must be a conflict instead.
    await expect(laptop.write('Home.md', '# Home\n\nfrom the laptop\n')).rejects.toBeInstanceOf(RemoteConflict)
    expect(await onDisk('Home.md')).toBe('# Home\n\nfrom the phone\n')

    for (const name of await filesInVault()) {
      if (name.includes('conflict')) await rm(join(vault, name), { force: true })
    }
  })

  it('copes with a vault of a few thousand notes', async () => {
    const many = join(vault, 'Many')
    await mkdir(many, { recursive: true })
    await Promise.all(
      Array.from({ length: 1200 }, (_, i) => writeFile(join(many, `Note ${i}.md`), `# Note ${i}\n\nbody ${i}\n`)),
    )

    const adapter = await connect()
    let batches = 0
    const all = new Map<string, string>()
    for await (const batch of adapter.readAll!()) {
      batches += 1
      for (const [path, text] of batch) all.set(path, text)
    }

    expect(all.size).toBe(1202)
    expect(all.get('Many/Note 999.md')).toBe('# Note 999\n\nbody 999\n')
    // Delivered in pieces, so a caller can paint between them.
    expect(batches).toBeGreaterThan(1)

    await rm(many, { recursive: true, force: true })
  }, 30_000)
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

describe('a conflict copy that cannot be written the usual way', () => {
  // 80 CJK characters are 240 bytes; with ".md" the name is 243 bytes, legal
  // everywhere (the limit is 255). The " (conflict …).md" suffix would take it
  // to 274, which no file system accepts.
  const longName = `${'記'.repeat(80)}.md`

  it('shortens the copy’s name to fit, rather than losing the text', async () => {
    const remote = await connect()
    await remote.write(longName, 'original\n')
    await writeFile(join(vault, longName), 'edited elsewhere\n') // another device

    const thrown = await remote.write(longName, 'my local edits\n').then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown).toBeInstanceOf(RemoteConflict)
    const copy = (thrown as RemoteConflict).conflictPath
    expect(Buffer.byteLength(copy, 'utf8')).toBeLessThanOrEqual(255)
    expect(copy).toMatch(/ \(conflict .*\)\.md$/)
    expect(await onDisk(copy)).toBe('my local edits\n')
    expect(await onDisk(longName)).toBe('edited elsewhere\n')
  })

  it('raises an ordinary error, not "your version was kept", when the server refuses the copy', async () => {
    const remote = await connect()
    await remote.write('Home.md', 'original\n')
    await writeFile(join(vault, 'Home.md'), 'edited elsewhere\n')

    // RemoteConflict is what makes the store drop the note's unsaved flag and
    // load the server's text over it: it may only be raised once the copy is
    // really there. Here the server cannot take it.
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (init?.method === 'PUT' && decodeURIComponent(url).includes('(conflict')) {
        return new Response(JSON.stringify({ error: 'no room' }), { status: 507 })
      }
      return realFetch(input, init)
    }
    try {
      const thrown = await remote.write('Home.md', 'my local edits\n').then(
        () => null,
        (error: unknown) => error,
      )
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).not.toBeInstanceOf(RemoteConflict)
      expect((thrown as Error).message).toMatch(/copy of this version could not be written/)
      expect(await filesInVault()).not.toContainEqual(expect.stringContaining('(conflict'))
    } finally {
      globalThis.fetch = realFetch
    }

    // The hash was left as it was, so the retry is refused again and writes a
    // copy — instead of carrying the server's hash and writing over its text.
    await expect(remote.write('Home.md', 'my local edits\n')).rejects.toBeInstanceOf(RemoteConflict)
    expect(await onDisk('Home.md')).toBe('edited elsewhere\n')
  })
})

describe('a rename announced by the change stream', () => {
  it('moves the known hash with it, so the next save of the new name is still conditional', async () => {
    const streams: FakeEventSource[] = []
    class FakeEventSource {
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      constructor(_url: string) {
        streams.push(this)
      }
      close(): void {}
    }
    ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
    try {
      const remote = await connect()
      await remote.list() // learns Home.md's hash
      if (!remote.watch) throw new Error('the remote vault has no change stream')
      remote.watch(() => {})
      // Another device renames Home.md through the API, and the stream says so.
      await fetch(`${origin}/api/rename`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-spacelink-client': 'other' },
        body: JSON.stringify({ from: 'Home.md', to: 'Start.md' }),
      })
      const announce = streams[0]?.onmessage
      if (!announce) throw new Error('the adapter never opened its change stream')
      announce({ data: JSON.stringify({ type: 'rename', from: 'Home.md', to: 'Start.md', origin: 'other' }) })
      // …and edits it before this device saves its own, older, version.
      await writeFile(join(vault, 'Start.md'), '# edited elsewhere\n')

      await expect(remote.write('Start.md', '# mine\n')).rejects.toBeInstanceOf(RemoteConflict)
      expect(await onDisk('Start.md')).toBe('# edited elsewhere\n')
    } finally {
      delete (globalThis as { EventSource?: unknown }).EventSource
    }
  })
})

describe('the remote adapter behaves like every other adapter', () => {
  it('throws "File not found" for a delete of a file that is not there', async () => {
    const remote = await connect()
    await expect(remote.remove('ghost.md')).rejects.toThrow('File not found: ghost.md')
  })

  it('treats a rename onto itself as nothing to do', async () => {
    const remote = await connect()
    await expect(remote.rename('Home.md', './Home.md')).resolves.toBeUndefined()
    expect(await onDisk('Home.md')).toContain('# Home')
  })

  it('lists in the shared comparePaths order, not the server’s', async () => {
    for (const name of ['b.md', 'B.md', 'a.md']) await writeFile(join(vault, name), '')
    const remote = await connect()
    const listed = (await remote.list()).map((file) => file.path)
    expect(listed).toEqual([...listed].sort(comparePaths))
    expect(listed.indexOf('B.md')).toBeLessThan(listed.indexOf('a.md'))
  })
})

describe('the change stream, when the connection drops', () => {
  /** A stand-in for `EventSource`, which jsdom does not have. */
  function fakeEventSource(): {
    opened: { url: string; open(): void; fail(): void; say(data: unknown): void }[]
    live(): number
    restore(): void
  } {
    class Fake {
      closed = false
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      constructor(public url: string) {
        instances.push(this)
      }
      close(): void {
        this.closed = true
      }
    }
    const instances: Fake[] = []
    const before = (globalThis as { EventSource?: unknown }).EventSource
    ;(globalThis as { EventSource?: unknown }).EventSource = Fake
    return {
      get opened() {
        // A closed EventSource delivers nothing more, and neither does this:
        // a stand-in that kept firing would hide the very thing being counted.
        return instances.map((instance) => ({
          url: instance.url,
          open: () => void (instance.closed || instance.onopen?.()),
          fail: () => void (instance.closed || instance.onerror?.()),
          say: (data: unknown) =>
            void (instance.closed || instance.onmessage?.({ data: JSON.stringify(data) })),
        }))
      },
      live: () => instances.filter((instance) => !instance.closed).length,
      restore: () => {
        if (before === undefined) delete (globalThis as { EventSource?: unknown }).EventSource
        else (globalThis as { EventSource?: unknown }).EventSource = before
      },
    }
  }

  /** Longer than the first back-off, which is a second. */
  const pastTheReconnect = () => new Promise((done) => setTimeout(done, 1400))

  it('opens one stream however many watchers there are', async () => {
    // Every watcher asks to connect; only the first should. The rest share the
    // one connection, which is the only reason a note edited elsewhere is not
    // fetched once per panel that happens to be listening.
    const sources = fakeEventSource()
    try {
      const remote = await connect()
      const stops = [remote.watch!(() => {}), remote.watch!(() => {}), remote.watch!(() => {})]
      expect(sources.opened, 'a stream per watcher').toHaveLength(1)
      for (const stop of stops) stop()
    } finally {
      sources.restore()
    }
  })

  it('waits out the back-off rather than reconnecting the moment a watcher arrives', async () => {
    // The back-off is what keeps a server that is down from being asked again
    // every second. A watcher added while it is waiting must not skip it:
    // opening a panel would otherwise reset the wait, and a device with a
    // busy interface would hammer a server that is simply not there.
    const sources = fakeEventSource()
    try {
      const remote = await connect()
      const stop = remote.watch!(() => {})
      sources.opened[0].fail()

      const alsoStop = remote.watch!(() => {})
      expect(sources.opened, 'a new watcher reconnected before the back-off was up').toHaveLength(1)

      await pastTheReconnect()
      expect(sources.opened, 'the back-off passed and nothing reconnected').toHaveLength(2)
      stop()
      alsoStop()
    } finally {
      sources.restore()
    }
  })

  it('opens one stream, not two, when a watcher arrives while it is reconnecting', async () => {
    // Measured before this held: a watcher added between the error and the
    // reconnect it had scheduled opened its own stream, and the reconnect then
    // opened another. Two live connections, every change announced twice.
    const sources = fakeEventSource()
    try {
      const remote = await connect()
      const stop = remote.watch!(() => {})
      expect(sources.opened).toHaveLength(1)

      sources.opened[0].fail()
      // Another part of the app starts watching before the reconnect fires.
      const alsoStop = remote.watch!(() => {})
      await pastTheReconnect()

      expect(sources.live(), 'the device is holding more than one stream open').toBe(1)
      stop()
      alsoStop()
    } finally {
      sources.restore()
    }
  })

  it('announces a change once however many times it has reconnected', async () => {
    // What two connections cost the reader: every note edited on another
    // device arriving twice, and every watcher doing its work twice.
    const sources = fakeEventSource()
    try {
      const remote = await connect()
      const seen: string[] = []
      const stop = remote.watch!((change) => seen.push(String(change.path)))
      sources.opened[0].fail()
      remote.watch!(() => {})
      await pastTheReconnect()

      for (const source of sources.opened) source.say({ type: 'upsert', path: 'Elsewhere.md', hash: 'x' })
      expect(seen, 'the same change arrived more than once').toEqual(['Elsewhere.md'])
      stop()
    } finally {
      sources.restore()
    }
  })

  it('leaves nothing open once the last watcher goes', async () => {
    // The part that outlived everything: a stream the adapter had lost track
    // of could not be closed by disposing the watchers, so it stayed open —
    // and counted by the server as a device worth writing to — for the life
    // of the page, whatever the reader did next.
    const sources = fakeEventSource()
    try {
      const remote = await connect()
      const stop = remote.watch!(() => {})
      sources.opened[0].fail()
      const alsoStop = remote.watch!(() => {})
      await pastTheReconnect()

      stop()
      alsoStop()
      expect(sources.live(), 'a change stream was left open with nothing holding it').toBe(0)
    } finally {
      sources.restore()
    }
  })

  it('does come back after a drop, which is the point of reconnecting at all', async () => {
    const sources = fakeEventSource()
    try {
      const remote = await connect()
      const seen: string[] = []
      const stop = remote.watch!((change) => seen.push(String(change.path)))
      sources.opened[0].open()
      sources.opened[0].fail()
      await pastTheReconnect()

      expect(sources.opened.length, 'the stream never came back').toBeGreaterThan(1)
      expect(sources.live()).toBe(1)
      sources.opened[sources.opened.length - 1].say({ type: 'upsert', path: 'Back.md', hash: 'x' })
      expect(seen, 'the stream came back but delivered nothing').toEqual(['Back.md'])
      stop()
    } finally {
      sources.restore()
    }
  })
})

describe('a server that never answers', () => {
  it('is given up on within ten seconds by the probe, the sign-in and the sign-out alike', async () => {
    // An address nothing is listening at does not fail quickly: the fetch
    // hangs until the connection times out, which on some stacks is minutes.
    // Measured with a fetch that never settles: the probe and the sign-in
    // were both still pending after fifteen seconds, and the picker's Connect
    // button sat on "Opening…" for all of it.
    // Never answers — but is still a fetch: it honours the signal it is
    // given, as the real one does. A stand-in that ignored the signal would
    // hang whatever the code under test did, and show nothing.
    const silent = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        }),
    )
    vi.stubGlobal('fetch', silent)
    try {
      const outcomes: Record<string, string> = { probe: 'still pending', signIn: 'still pending', signOut: 'still pending' }
      void probeServer('http://10.255.255.1:4899', 'x'.repeat(43)).then((r) => (outcomes.probe = r.ok ? 'ok' : r.error))
      void signIn('http://10.255.255.1:4899', 'me@example.com', 'a long enough password').then(
        (r) => (outcomes.signIn = r.ok ? 'ok' : r.error),
      )
      void signOut('http://10.255.255.1:4899', 'x'.repeat(43)).then(() => (outcomes.signOut = 'done'))

      await new Promise((done) => setTimeout(done, 11_000))

      expect(outcomes.probe, 'the probe never gave up').toMatch(/could not reach/i)
      expect(outcomes.signIn, 'the sign-in never gave up').toMatch(/could not reach/i)
      expect(outcomes.signOut, 'the sign-out never gave up').toBe('done')
      expect(silent).toHaveBeenCalledTimes(3)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 20_000)
})
