// @vitest-environment node
/**
 * Accounts, passwords and sessions — against real files in a real directory.
 *
 * Nothing is mocked. A password is hashed with the scrypt the server ships
 * with, the file is written and read back off disk, and the checks that matter
 * are the ones an attacker would try: the wrong password, a stolen file, a
 * session that outlived its password, a script guessing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  MIN_PASSWORD_LENGTH,
  SESSION_DAYS,
  accountForSession,
  addAccount,
  createAttemptLimiter,
  createSession,
  findAccount,
  hashPassword,
  loadAccounts,
  revokeSession,
  sameEmail,
  saveAccounts,
  sessionId,
  setPassword,
  verifyLogin,
  verifyPassword,
} from './accounts.mjs'

/** @type {string} */
let home
/** @type {string} */
let file

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'spacelink-accounts-'))
  file = join(home, 'accounts.json')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const PASSWORD = 'correct horse battery staple'

const make = (over = {}) =>
  addAccount({ file, email: 'me@example.com', password: PASSWORD, vault: join(home, 'Notes'), ...over })

describe('passwords', () => {
  it('accepts the password it was given, and nothing else', async () => {
    const account = await make()
    expect(await verifyPassword(PASSWORD, account)).toBe(true)
    expect(await verifyPassword(`${PASSWORD} `, account)).toBe(false)
    expect(await verifyPassword(PASSWORD.toUpperCase(), account)).toBe(false)
    expect(await verifyPassword('', account)).toBe(false)
  })

  it('salts every account, so the same password is not the same hash', async () => {
    const first = await hashPassword(PASSWORD)
    const second = await hashPassword(PASSWORD)
    expect(first.salt).not.toBe(second.salt)
    expect(first.hash).not.toBe(second.hash)
    // …and both still verify, which is what the salt must not cost.
    for (const stored of [first, second]) {
      expect(await verifyPassword(PASSWORD, { ...stored, email: 'x', id: 'x', vault: '/x', createdAt: 0 })).toBe(true)
    }
  })

  it('is not stored anywhere in the file that holds it', async () => {
    await make()
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(PASSWORD)
    expect(raw).not.toContain('battery')
  })

  it('costs real memory, which is the whole point of scrypt', async () => {
    const { kdf } = await hashPassword('x'.repeat(12))
    // 128·N·r bytes per guess. Below this it is not worth having.
    expect((128 * kdf.N * kdf.r) / (1024 * 1024)).toBeGreaterThanOrEqual(32)
  })

  it('verifies against the parameters the record carries, not today’s', async () => {
    // A record hashed under a cheaper cost must keep working when the cost is
    // raised, or raising it locks everybody out.
    const cheap = { N: 1024, r: 8, p: 1, keylen: 64 }
    const { scrypt } = await import('node:crypto')
    const salt = Buffer.from('0123456789abcdef')
    const hash = await new Promise((done, fail) =>
      scrypt('old password', salt, cheap.keylen, cheap, (error, key) => (error ? fail(error) : done(key))),
    )
    const account = {
      id: 'a',
      email: 'old@example.com',
      vault: '/x',
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      kdf: cheap,
      createdAt: 0,
    }
    expect(await verifyPassword('old password', account)).toBe(true)
    expect(await verifyPassword('another password', account)).toBe(false)
  })

  it('answers false, never an exception, for a record that makes no sense', async () => {
    const broken = { id: 'a', email: 'a@b.c', vault: '/x', salt: 'not base64 !!', hash: '???', createdAt: 0 }
    expect(await verifyPassword(PASSWORD, broken)).toBe(false)
    expect(await verifyPassword(PASSWORD, { ...broken, kdf: { N: -1, r: 0, p: 0, keylen: 0 } })).toBe(false)
  })
})

describe('checking a sign-in', () => {
  it('returns the account for the right password, and null otherwise', async () => {
    const account = await make()
    const accounts = [account]
    expect(await verifyLogin(accounts, 'me@example.com', PASSWORD)).toMatchObject({ email: 'me@example.com' })
    expect(await verifyLogin(accounts, 'ME@EXAMPLE.COM', PASSWORD)).toMatchObject({ email: 'me@example.com' })
    expect(await verifyLogin(accounts, 'me@example.com', 'not the password')).toBeNull()
    expect(await verifyLogin(accounts, 'nobody@example.com', PASSWORD)).toBeNull()
  })

  it('spends the same work on an address nobody has', async () => {
    // The refusals are worded identically on purpose. If one of them returned
    // without hashing anything it would still answer far sooner, and the delay
    // would say which addresses have accounts.
    const accounts = [await make()]
    const time = async (email) => {
      const started = performance.now()
      expect(await verifyLogin(accounts, email, 'not the password')).toBeNull()
      return performance.now() - started
    }
    const hits = []
    const misses = []
    for (let round = 0; round < 3; round += 1) {
      hits.push(await time('me@example.com'))
      misses.push(await time(`nobody-${round}@example.com`))
    }
    const fastestHit = Math.min(...hits)
    const fastestMiss = Math.min(...misses)
    expect(fastestMiss, `hit ${fastestHit.toFixed(1)}ms vs miss ${fastestMiss.toFixed(1)}ms`).toBeGreaterThan(
      fastestHit / 2,
    )
  }, 30_000)
})

describe('making an account', () => {
  it('writes it down, readable only by its owner', async () => {
    const account = await make()
    expect(account.email).toBe('me@example.com')
    expect(account.vault).toBe(resolve(join(home, 'Notes')))
    expect(account.id).toMatch(/^[A-Za-z0-9_-]{8,}$/)

    const store = await loadAccounts(file)
    expect(store.accounts).toHaveLength(1)
    // The file holds password hashes: nobody else on the machine reads it.
    expect((await stat(file)).mode & 0o077).toBe(0)
  })

  it('refuses a second account for the same address, whatever the case', async () => {
    await make()
    await expect(make({ email: 'ME@Example.COM' })).rejects.toThrow(/already an account/)
    expect((await loadAccounts(file)).accounts).toHaveLength(1)
  })

  it('refuses a password too short to be worth hashing', async () => {
    await expect(make({ password: 'short' })).rejects.toThrow(new RegExp(`${MIN_PASSWORD_LENGTH} characters`))
    expect((await loadAccounts(file)).accounts).toHaveLength(0)
  })

  it('refuses something that is not an address', async () => {
    await expect(make({ email: 'nobody' })).rejects.toThrow(/does not look like an email/)
  })

  it('keeps several accounts apart, each with its own folder', async () => {
    const mine = await make()
    const theirs = await make({ email: 'you@example.com', vault: join(home, 'Their Notes') })
    const store = await loadAccounts(file)
    expect(store.accounts.map((account) => account.email).sort()).toEqual(['me@example.com', 'you@example.com'])
    expect(mine.vault).not.toBe(theirs.vault)
    expect(findAccount(store.accounts, 'YOU@example.com')?.id).toBe(theirs.id)
    expect(findAccount(store.accounts, 'nobody@example.com')).toBe(null)
  })

  it('folds the case of an address the way a person would', () => {
    expect(sameEmail('Me@Example.com', ' me@example.com ')).toBe(true)
    expect(sameEmail('me@example.com', 'me@example.org')).toBe(false)
    expect(sameEmail(undefined, '')).toBe(true)
  })
})

describe('the file the accounts live in', () => {
  it('is an empty store when it is not there yet', async () => {
    expect(await loadAccounts(join(home, 'nothing.json'))).toEqual({ accounts: [], sessions: [] })
  })

  it('says so when it is corrupt, rather than starting with no accounts', async () => {
    // Silently treating a damaged file as empty would lock the owner out with
    // no explanation, and invite a fresh account over the top.
    await writeFile(file, '{ this is not json')
    await expect(loadAccounts(file)).rejects.toThrow(/not valid JSON/)
  })

  it('is written whole or not at all, leaving nothing behind', async () => {
    await saveAccounts(file, { accounts: [], sessions: [] })
    await make()
    const left = (await readdir(home)).filter((name) => name.includes('.tmp'))
    expect(left).toEqual([])
  })
})

describe('sessions', () => {
  it('signs a device in, and recognises it again', async () => {
    const account = await make()
    const { token } = await createSession({ file, account, device: 'iPhone' })
    const store = await loadAccounts(file)
    expect(accountForSession(store, token)?.id).toBe(account.id)
    expect(store.sessions[0].device).toBe('iPhone')
  })

  it('never writes the token down — only what it hashes to', async () => {
    const account = await make()
    const { token } = await createSession({ file, account })
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(token)
    expect(raw).toContain(sessionId(token))
  })

  it('does not recognise a token it never issued', async () => {
    const account = await make()
    await createSession({ file, account })
    const store = await loadAccounts(file)
    expect(accountForSession(store, 'not-a-real-token')).toBe(null)
    expect(accountForSession(store, '')).toBe(null)
    expect(accountForSession(store, undefined)).toBe(null)
  })

  it('stops recognising it once it has expired', async () => {
    const account = await make()
    const { token } = await createSession({ file, account, now: 1_000 })
    const store = await loadAccounts(file)
    const day = 24 * 60 * 60 * 1000
    expect(accountForSession(store, token, 1_000 + SESSION_DAYS * day - 1)).not.toBe(null)
    expect(accountForSession(store, token, 1_000 + SESSION_DAYS * day + 1)).toBe(null)
  })

  it('sweeps expired sessions when the next one is made', async () => {
    const account = await make()
    const day = 24 * 60 * 60 * 1000
    await createSession({ file, account, device: 'old', now: 0 })
    await createSession({ file, account, device: 'new', now: (SESSION_DAYS + 1) * day })
    const store = await loadAccounts(file)
    expect(store.sessions.map((session) => session.device)).toEqual(['new'])
  })

  it('signs one device out without touching the others', async () => {
    const account = await make()
    const phone = await createSession({ file, account, device: 'iPhone' })
    const laptop = await createSession({ file, account, device: 'MacBook' })

    expect(await revokeSession({ file, token: phone.token })).toBe(true)
    expect(await revokeSession({ file, token: phone.token })).toBe(false)

    const store = await loadAccounts(file)
    expect(accountForSession(store, phone.token)).toBe(null)
    expect(accountForSession(store, laptop.token)?.id).toBe(account.id)
  })

  it('signs every device out when the password changes', async () => {
    // A password is changed because it may be known. A session that outlived
    // it would make the change decorative.
    const account = await make()
    const phone = await createSession({ file, account, device: 'iPhone' })
    const laptop = await createSession({ file, account, device: 'MacBook' })

    await setPassword({ file, email: 'me@example.com', password: 'a different long password' })

    const store = await loadAccounts(file)
    expect(store.sessions).toEqual([])
    expect(accountForSession(store, phone.token)).toBe(null)
    expect(accountForSession(store, laptop.token)).toBe(null)
    const updated = findAccount(store.accounts, 'me@example.com')
    expect(await verifyPassword('a different long password', updated)).toBe(true)
    expect(await verifyPassword(PASSWORD, updated)).toBe(false)
  })

  it('will not set a password on an account that is not there, or one too short', async () => {
    await make()
    await expect(setPassword({ file, email: 'nobody@example.com', password: 'long enough' })).rejects.toThrow(/no account/)
    await expect(setPassword({ file, email: 'me@example.com', password: 'tiny' })).rejects.toThrow(/characters/)
  })

  it('does not let one account’s session reach another account', async () => {
    const mine = await make()
    const theirs = await make({ email: 'you@example.com', vault: join(home, 'Their Notes') })
    const { token } = await createSession({ file, account: mine })
    const store = await loadAccounts(file)
    const found = accountForSession(store, token)
    expect(found?.id).toBe(mine.id)
    expect(found?.vault).not.toBe(theirs.vault)
  })
})

describe('slowing down a password guesser', () => {
  it('lets a few mistakes through, then makes the guesser wait longer and longer', () => {
    const limiter = createAttemptLimiter()
    const now = 1_000_000
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.retryAfter('me@example.com', now)).toBe(0)
      limiter.fail('me@example.com', now)
    }
    // Past the free ones the wait appears, and doubles.
    limiter.fail('me@example.com', now)
    const first = limiter.retryAfter('me@example.com', now)
    expect(first).toBeGreaterThan(0)
    limiter.fail('me@example.com', now)
    expect(limiter.retryAfter('me@example.com', now)).toBeGreaterThan(first)
  })

  it('caps the wait, so a run of failures cannot lock an account for ever', () => {
    const limiter = createAttemptLimiter({ maxDelayMs: 60_000 })
    const now = 1_000_000
    for (let attempt = 0; attempt < 40; attempt += 1) limiter.fail('me@example.com', now)
    expect(limiter.retryAfter('me@example.com', now)).toBeLessThanOrEqual(60_000)
  })

  it('forgets a run of failures after a quiet spell', () => {
    const limiter = createAttemptLimiter({ forgetAfterMs: 1000 })
    const now = 1_000_000
    for (let attempt = 0; attempt < 20; attempt += 1) limiter.fail('me@example.com', now)
    expect(limiter.retryAfter('me@example.com', now)).toBeGreaterThan(0)
    expect(limiter.retryAfter('me@example.com', now + 2000)).toBe(0)
  })

  it('clears the run the moment the right password arrives', () => {
    const limiter = createAttemptLimiter()
    const now = 1_000_000
    for (let attempt = 0; attempt < 20; attempt += 1) limiter.fail('me@example.com', now)
    expect(limiter.retryAfter('me@example.com', now)).toBeGreaterThan(0)
    limiter.succeed('me@example.com')
    expect(limiter.retryAfter('me@example.com', now)).toBe(0)
  })

  it('counts each address separately, so one guesser cannot lock another out', () => {
    const limiter = createAttemptLimiter()
    const now = 1_000_000
    for (let attempt = 0; attempt < 20; attempt += 1) limiter.fail('victim@example.com', now)
    expect(limiter.retryAfter('victim@example.com', now)).toBeGreaterThan(0)
    expect(limiter.retryAfter('someone-else@example.com', now)).toBe(0)
  })
})
