// @vitest-environment node
/**
 * Accounts, passwords and sessions — against real files in a real directory.
 *
 * Nothing is mocked. A password is hashed with the scrypt the server ships
 * with, the file is written and read back off disk, and the checks that matter
 * are the ones an attacker would try: the wrong password, a stolen file, a
 * session that outlived its password, a script guessing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { accountForSession, accountProblems, addAccount, createAttemptLimiter, createSession, findAccount, hashPassword, loadAccounts, MIN_PASSWORD_LENGTH, plainText, revokeSession, sameEmail, saveAccounts, SESSION_DAYS, sessionId, setPassword, updateAccounts, verifyLogin, verifyPassword } from './accounts.mjs'

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
    expect(await loadAccounts(join(home, 'nothing.json'))).toEqual({ accounts: [], sessions: [], unreadable: 0 })
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

describe('text that came from somewhere else', () => {
  it('refuses an address that would forge a line in the listing', async () => {
    // `--list-accounts` is the command you run to see who can reach your
    // notes. An address holding a newline prints a second `notes` line under
    // its own entry; one holding an erase sequence rewrites the line it is on.
    // The command that answers "who has access?" must not be something an
    // address can lie to.
    const file = join(home, 'accounts.json')
    const vault = join(home, 'Notes')
    for (const bad of [
      'victim@example.com\n      notes  /somewhere-else',
      'a@b.c\u001b[2K\u001b[Gimposter@example.com',
      'a@b.c\rimposter@example.com',
      'tab@ex\tample.com',
    ]) {
      await expect(addAccount({ file, email: bad, password: PASSWORD, vault }), JSON.stringify(bad)).rejects.toThrow()
    }
    expect((await loadAccounts(file)).accounts).toHaveLength(0)
  })

  it('refuses an address with nothing either side of the @, or more than one', async () => {
    const file = join(home, 'accounts.json')
    const vault = join(home, 'Notes')
    for (const bad of ['@example.com', 'me@', 'me@@example.com', 'no-at-sign', '@', 'a b@example.com']) {
      await expect(addAccount({ file, email: bad, password: PASSWORD, vault }), bad).rejects.toThrow()
    }
  })

  it('still takes the addresses people actually have', async () => {
    // Not an attempt at RFC 5322: a rule strict enough to be clever would
    // refuse real addresses. `me@nas` is a perfectly good address on a network
    // that has one.
    const file = join(home, 'accounts.json')
    const vault = join(home, 'Notes')
    for (const good of ['me@nas', 'first.last+tag@example.co.uk', "o'brien@example.com", 'me@[192.168.1.20]']) {
      await expect(addAccount({ file, email: good, password: PASSWORD, vault }), good).resolves.toMatchObject({
        email: good,
      })
    }
  }, 30_000)

  it('keeps control characters out of a device label, which a client chooses', async () => {
    // The label arrives in a request header. Sliced to 80 characters was not
    // enough: eighty characters of escape sequence is still an escape sequence.
    const account = await make()
    const file = join(home, 'accounts.json')
    const { session } = await createSession({
      file,
      account,
      device: 'a Mac\u001b[2K\u001b[Gsomething else\nnotes  /elsewhere',
    })
    // The escape itself is gone, so what is left is inert text: without the
    // ESC in front of it, `[2K` is four characters a terminal simply prints.
    expect(session.device).toBe('a Mac[2K[Gsomething elsenotes  /elsewhere')
    expect(session.device).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    // And it is stored that way, not merely returned that way.
    const stored = JSON.parse(await readFile(file, 'utf8')).sessions.at(-1)
    expect(stored.device).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
  })

  it('drops control characters and keeps everything else', () => {
    expect(plainText('a Mac')).toBe('a Mac')
    expect(plainText('an iPhone — Ana’s')).toBe('an iPhone — Ana’s')
    expect(plainText('one\ntwo')).toBe('onetwo')
    expect(plainText('\u001b[31mred\u001b[0m')).toBe('[31mred[0m')
    expect(plainText(undefined)).toBe('')
  })
})

describe('changing the file while something else is changing it', () => {
  it('keeps every session when several devices sign in at the same moment', async () => {
    // The shape that broke: read, change, write, with nothing stopping two of
    // them overlapping. Measured before the fix — six simultaneous sign-ins,
    // three sessions left, three devices told 401 on their next request.
    const account = await make()
    const file = join(home, 'accounts.json')
    const made = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createSession({ file, account, device: `device ${index}` })),
    )
    const store = await loadAccounts(file)
    expect(store.sessions).toHaveLength(8)
    // And every token handed out actually works.
    for (const { token } of made) {
      expect(accountForSession(store, token), token.slice(0, 8)).toMatchObject({ email: account.email })
    }
  }, 30_000)

  it('does not lose a session to an account being made beside it', async () => {
    // The documented way to make an account is a terminal command run while the
    // server is up. Before the fix that command took every session with it.
    const account = await make()
    const file = join(home, 'accounts.json')
    const [session] = await Promise.all([
      createSession({ file, account, device: 'a phone' }),
      addAccount({ file, email: 'newcomer@example.com', password: PASSWORD, vault: join(home, 'Notes') }),
      createSession({ file, account, device: 'a laptop' }),
    ])
    const store = await loadAccounts(file)
    expect(store.accounts.map((one) => one.email)).toContain('newcomer@example.com')
    expect(store.sessions).toHaveLength(2)
    expect(accountForSession(store, session.token)).toMatchObject({ email: account.email })
  }, 30_000)

  it('refuses the second of two identical accounts made at once', async () => {
    // The duplicate check has to happen inside the lock, or both callers read a
    // file without the address in it and both write themselves into it.
    const file = join(home, 'accounts.json')
    const vault = join(home, 'Notes')
    const results = await Promise.allSettled([
      addAccount({ file, email: 'twin@example.com', password: PASSWORD, vault }),
      addAccount({ file, email: 'twin@example.com', password: PASSWORD, vault }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const store = await loadAccounts(file)
    expect(store.accounts.filter((one) => sameEmail(one.email, 'twin@example.com'))).toHaveLength(1)
  }, 30_000)

  it('writes nothing when the change finds nothing to do', async () => {
    // Signing out can be asked for without credentials — it has to be, since
    // its whole job is to retire one — so a token nobody has ever held must not
    // cost a rewrite of this file, nor the lock while it happens.
    const account = await make()
    const file = join(home, 'accounts.json')
    const { token } = await createSession({ file, account, device: 'a Mac' })

    const before = (await stat(file)).mtimeMs
    await new Promise((done) => setTimeout(done, 20))
    expect(await revokeSession({ file, token: 'a token nobody has ever held' })).toBe(false)
    expect((await stat(file)).mtimeMs, 'a token that matched nothing rewrote the file').toBe(before)

    // And the check is not vacuous: a real one does rewrite it.
    expect(await revokeSession({ file, token })).toBe(true)
    expect((await stat(file)).mtimeMs).not.toBe(before)
  })

  it('leaves no lock behind when the change itself fails', async () => {
    // A lock kept after an error would block every later write until it went
    // stale — which is a working server that stops being able to sign anyone in.
    const file = join(home, 'accounts.json')
    await expect(
      updateAccounts(file, () => {
        throw new Error('no')
      }),
    ).rejects.toThrow('no')
    expect(existsSync(`${file}.lock`)).toBe(false)
    // And the next write still goes through.
    await expect(updateAccounts(file, (store) => store.accounts.length)).resolves.toBeGreaterThanOrEqual(0)
  })

  it('takes a lock left behind by a process that died', async () => {
    // Otherwise one crash at the wrong moment locks the accounts file for good.
    const file = join(home, 'accounts.json')
    await writeFile(`${file}.lock`, '')
    const longAgo = new Date(Date.now() - 60_000)
    await utimes(`${file}.lock`, longAgo, longAgo)

    await expect(updateAccounts(file, () => 'went through')).resolves.toBe('went through')
    expect(existsSync(`${file}.lock`)).toBe(false)
  }, 20_000)

  it('waits for a lock that is being held right now, rather than barging in', async () => {
    const file = join(home, 'accounts.json')
    await writeFile(`${file}.lock`, '')
    try {
      const order = []
      const blocked = updateAccounts(file, () => void order.push('write')).catch(() => order.push('gave up'))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(order, 'it wrote while somebody else held the lock').toEqual([])
      await rm(`${file}.lock`, { force: true })
      await blocked
      expect(order).toEqual(['write'])
    } finally {
      await rm(`${file}.lock`, { force: true })
    }
  }, 20_000)
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

  it('is not a place an anonymous caller can put things', async () => {
    // Every attempt names its own key — an email typed into the request — so a
    // run of logins for made-up addresses would grow this map for as long as
    // it was fed. Nothing else ever revisits those keys, so nothing else ever
    // sweeps them.
    const limiter = createAttemptLimiter({ maxKeys: 50 })
    for (let attempt = 0; attempt < 5_000; attempt += 1) limiter.fail(`made-up-${attempt}@example.com`)
    expect(limiter.size).toBeLessThanOrEqual(50)
  })

  it('keeps the run it is still counting and drops the ones nobody is making', () => {
    const limiter = createAttemptLimiter({ maxKeys: 3 })
    const now = 1_000_000
    // A guesser working on one address, among a crowd of one-off keys.
    limiter.fail('victim@example.com', now)
    limiter.fail('victim@example.com', now + 1)
    for (let index = 0; index < 10; index += 1) limiter.fail(`noise-${index}@example.com`, now + 2 + index)
    // The victim's key was the least recently touched, so it goes — which is
    // correct: it is the *recent* run that is worth counting, and the crowd of
    // one-offs is itself the thing being counted now.
    expect(limiter.size).toBeLessThanOrEqual(3)
    // Whatever survived, the map is bounded and the newest key is in it.
    expect(limiter.retryAfter(`noise-9@example.com`, now + 12)).toBe(0)
  })

  it('forgets a run once nobody has made an attempt for long enough', () => {
    const limiter = createAttemptLimiter({ forgetAfterMs: 1000, maxKeys: 100 })
    const now = 5_000_000
    for (let index = 0; index < 10; index += 1) limiter.fail(`stale-${index}@example.com`, now)
    expect(limiter.size).toBe(10)
    // One more attempt, an hour later: the sweep goes with it.
    limiter.fail('fresh@example.com', now + 10_000)
    expect(limiter.size).toBe(1)
  })
})

describe('the attempt limiter, under a run of made-up addresses', () => {
  const t0 = 1_000_000

  it('keeps a lock-out through a run of fresh keys that would otherwise push it out', () => {
    // Every attempt names its own key, so the map has a cap, and the cap
    // evicts the least recently touched. Measured with the cap at 50: lock a
    // target out for 64 s, fail 60 made-up addresses once each, and the
    // target's wait was 0 — its record had been evicted to make room, and the
    // five free guesses were back. At the real cap that is ten thousand
    // requests to buy five more guesses at one account.
    const limiter = createAttemptLimiter({ freeAttempts: 5, maxKeys: 50 })
    for (let i = 0; i < 12; i += 1) limiter.fail('victim@example.com', t0)
    const wait = limiter.retryAfter('victim@example.com', t0)
    expect(wait).toBeGreaterThan(60_000)

    for (let i = 0; i < 60; i += 1) limiter.fail(`nobody${i}@example.com`, t0 + 1)

    expect(limiter.retryAfter('victim@example.com', t0 + 2), 'the lock-out was evicted by fresh keys').toBe(wait - 2)
    expect(limiter.size, 'the cap was not held').toBeLessThanOrEqual(50)
  })

  it('still holds the cap when every key it has is serving a lock-out', () => {
    // Keeping locked-out keys must not turn the cap into a suggestion: a run
    // that locks out thirty keys against a cap of ten still holds ten.
    const limiter = createAttemptLimiter({ freeAttempts: 1, maxKeys: 10 })
    for (let key = 0; key < 30; key += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) limiter.fail(`locked${key}`, t0 + key)
    }
    expect(limiter.size).toBe(10)
  })

  it('evicts the least recently touched fresh key, not the locked one it is older than', () => {
    // Whether a key is serving a lock-out decides first; among the rest, the
    // least recently touched goes, as before.
    const limiter = createAttemptLimiter({ freeAttempts: 1, maxKeys: 3 })
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.fail('locked', t0)
    limiter.fail('fresh-a', t0 + 1)
    limiter.fail('fresh-b', t0 + 2)
    limiter.fail('fresh-c', t0 + 3) // over the cap by one
    expect(limiter.retryAfter('locked', t0 + 4), 'the oldest key went, and it was the locked one').toBeGreaterThan(0)
    expect(limiter.size).toBe(3)
    // Which fresh key went can only be seen by counting again: a key that
    // survived is at two failures and locked; one that was evicted starts over.
    limiter.fail('fresh-b', t0 + 5)
    expect(limiter.retryAfter('fresh-b', t0 + 5), 'fresh-b, touched more recently, was the one evicted').toBeGreaterThan(0)
    limiter.fail('fresh-a', t0 + 6)
    expect(limiter.retryAfter('fresh-a', t0 + 6), 'fresh-a, the least recently touched, survived').toBe(0)
  })

  it('never evicts the key that was just counted, even with every other key locked out', () => {
    // The map full of locked-out keys made the one being counted the only
    // unlocked key, and so the one evicted — on every attempt. It never
    // accumulated a count and never locked out: sixty thousand requests to
    // fill the map that way bought unlimited guesses at one account for as
    // long as the fill lasted.
    const limiter = createAttemptLimiter({ freeAttempts: 5, maxKeys: 10 })
    for (let key = 0; key < 10; key += 1) {
      for (let attempt = 0; attempt < 7; attempt += 1) limiter.fail(`locked${key}`, t0)
    }
    for (let attempt = 0; attempt < 6; attempt += 1) limiter.fail('victim@example.com', t0 + 1)
    expect(limiter.retryAfter('victim@example.com', t0 + 1), 'the guessed-at key never accumulated a count').toBeGreaterThan(0)
    expect(limiter.size).toBe(10)
  })

  it('stops protecting a key once its lock-out has elapsed', () => {
    // A key whose wait is over is an ordinary key again, and the oldest of
    // those goes first — otherwise a map of once-locked keys could never be
    // pruned of them until the hour that forgets a run.
    const limiter = createAttemptLimiter({ freeAttempts: 1, maxKeys: 3 })
    for (let attempt = 0; attempt < 2; attempt += 1) limiter.fail('was-locked', t0) // a one-second wait
    limiter.fail('fresh-a', t0 + 1)
    limiter.fail('fresh-b', t0 + 2)
    limiter.fail('fresh-c', t0 + 5000) // the wait on was-locked is long over
    expect(limiter.size).toBe(3)
    limiter.fail('fresh-a', t0 + 5001)
    expect(limiter.retryAfter('fresh-a', t0 + 5001), 'fresh-a went instead of the key whose wait was over').toBeGreaterThan(0)
  })
})

describe('the label a device signs in under', () => {
  /** @type {string} */ let home
  /** @type {string} */ let file
  /** @type {import('./accounts.mjs').Account} */ let account
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'spacelink-label-'))
    file = join(home, 'accounts.json')
    account = await addAccount({ file, email: 'label@example.com', password: 'a long enough password', vault: home })
  })
  afterAll(() => rm(home, { recursive: true, force: true }))

  it('is cut by character, so an emoji at the edge is kept whole or dropped, never halved', async () => {
    // Measured: 'a' and then fifty keys, cut at eighty code units, stored
    // with half a surrogate pair on the end — and printed by --list-accounts
    // as a replacement mark where the last key should be.
    const { session } = await createSession({ file, account, device: 'a' + '🔑'.repeat(100) })
    expect(session.device.isWellFormed(), 'half a character was stored').toBe(true)
    // Eighty characters, which for this label is more than eighty code units.
    expect([...session.device]).toHaveLength(80)
    expect(session.device.endsWith('🔑'), 'the cut landed inside the last key').toBe(true)
  })

  it('falls back to "a device" for a label that is blank, not only for one that is missing', async () => {
    // The header can be sent and empty — `??` treats '' as present — and
    // the listing then showed "signed in   —" with nothing before the dash.
    // A label that is only control characters is blank too, once they go.
    for (const blank of ['', '   ', '\u0007\u0000', ' \u001b ']) {
      const { session } = await createSession({ file, account, device: blank })
      expect(session.device, JSON.stringify(blank)).toBe('a device')
    }
  })

  it('keeps an ordinary label as it was', async () => {
    const { session } = await createSession({ file, account, device: 'a Mac' })
    expect(session.device).toBe('a Mac')
  })
})

describe('an accounts file that two backups or a hand edit have damaged', () => {
  const shell = (id, email) => ({ id, email, vault: `/notes/${id}`, salt: '', hash: '', kdf: {}, createdAt: 0 })

  it('names the account an address was taken from, and only that one', () => {
    // addAccount refuses a second account for one address, so this comes from
    // outside: a file edited by hand, or two merged. The first wins every
    // sign-in and the second can never be reached — which the listing showed
    // as two working accounts.
    const problems = accountProblems([
      shell('a', 'me@example.com'),
      shell('b', 'ME@Example.com'),
      shell('c', 'other@example.com'),
    ])
    expect(problems.get(1), 'the shadowed account was not named').toMatch(/already has this address/i)
    expect(problems.has(0), 'the account that does work was called broken').toBe(false)
    expect(problems.has(2)).toBe(false)
  })

  it('names every account in a shared id, because none of them can be resolved', () => {
    // Sharper: the id is the only link a session has to an account, and two
    // accounts holding one make that link unreadable in both directions.
    const problems = accountProblems([shell('same', 'one@example.com'), shell('same', 'two@example.com')])
    expect(problems.get(0)).toMatch(/shares its id/i)
    expect(problems.get(1)).toMatch(/shares its id/i)
  })

  it('finds nothing wrong with a file this server wrote', () => {
    expect(accountProblems([shell('a', 'one@example.com'), shell('b', 'two@example.com')]).size).toBe(0)
    expect(accountProblems([]).size).toBe(0)
  })

  it('leaves out an entry that is not a record at all, and counts it', async () => {
    // `null` where a record was deleted, or a bare address where one was
    // meant. Neither could ever match anything — but reading them as records
    // did: `--list-accounts` stopped on "Cannot read properties of null" and
    // printed no accounts whatsoever, and a single `null` among the accounts
    // made every request from every signed-in device a 500. Which of the two
    // broke depended only on where in the array it sat.
    const damaged = join(home, 'damaged.json')
    await writeFile(
      damaged,
      JSON.stringify({
        accounts: [null, shell('a', 'me@example.com'), 'me@example.com', ['me@example.com']],
        sessions: [{ id: 's', accountId: 'a' }, null],
      }),
    )
    const store = await loadAccounts(damaged)
    expect(store.accounts.map((account) => account.id)).toEqual(['a'])
    expect(store.sessions.map((session) => session.id)).toEqual(['s'])
    expect(store.unreadable, 'the entries that had to be left out were not counted').toBe(4)
    expect((await loadAccounts(file)).unreadable, 'a file this server wrote had entries left out').toBe(0)
  })

  it('never writes the count back into the file', async () => {
    // It says something about the file as it was read, not about the accounts.
    const damaged = join(home, 'counted.json')
    await writeFile(damaged, JSON.stringify({ accounts: [null, shell('a', 'me@example.com')], sessions: [] }))
    await updateAccounts(damaged, (store) => {
      store.sessions.push({ id: 's', accountId: 'a', device: 'a Mac', createdAt: 1, expiresAt: 2 })
    })
    expect(Object.keys(JSON.parse(await readFile(damaged, 'utf8')))).toEqual(['accounts', 'sessions'])
  })
})

describe('a session whose account cannot be told apart from another', () => {
  const account = (id, email) => ({ id, email, vault: `/notes/${id}`, salt: '', hash: '', kdf: {}, createdAt: 0 })
  const session = (token, accountId) => ({
    id: sessionId(token),
    accountId,
    device: 'a device',
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  })

  it('is refused, rather than resolved to whichever account came first', () => {
    // Measured on a hand-edited file: an account signed in with its own
    // password, was told it had opened its own vault, and was handed somebody
    // else's notes — silently, because the id is all there is to go on.
    const store = {
      accounts: [account('same', 'me@example.com'), account('same', 'them@example.com')],
      sessions: [session('a-token', 'same')],
    }
    expect(accountForSession(store, 'a-token'), 'a guess was made about whose notes these are').toBeNull()
  })

  it('still resolves a session whose account is the only one with its id', () => {
    const store = {
      accounts: [account('mine', 'me@example.com'), account('theirs', 'them@example.com')],
      sessions: [session('a-token', 'theirs')],
    }
    expect(accountForSession(store, 'a-token')?.email).toBe('them@example.com')
  })
})

describe('an accounts path that cannot be read', () => {
  it('names it, and says a folder is a folder', async () => {
    // The corrupt-JSON case one line below this in the source has always named
    // the file and said what to do. A path that is a folder escaped as Node
    // wrote it — "EISDIR: illegal operation on a directory, read" — with the
    // path nowhere in it, so somebody who mistyped --accounts had nothing.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-acctshape-'))
    try {
      const folder = join(home, 'not-a-file')
      await mkdir(folder, { recursive: true })
      await expect(loadAccounts(folder)).rejects.toThrow(new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await expect(loadAccounts(folder)).rejects.toThrow(/is a folder, not a file/i)
      await expect(loadAccounts(folder), 'Node\'s own words reached the person').rejects.not.toThrow(/EISDIR/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('names it for a failure nobody anticipated, rather than passing Node\'s words through', async () => {
    // Not every way a read can fail is worth its own sentence, but every one
    // of them is worth naming the file: that is what tells somebody which of
    // their paths is wrong. A name too long for the filesystem stands in for
    // the whole class — a permission, a broken mount, a drive that answers EIO.
    const tooLong = join(tmpdir(), 'x'.repeat(300))
    await expect(loadAccounts(tooLong)).rejects.toThrow(/could not be read/i)
    await expect(loadAccounts(tooLong)).rejects.toThrow(/ENAMETOOLONG/)
    // The path is in it, which is the point.
    await expect(loadAccounts(tooLong)).rejects.toThrow(/xxxxxxxxxx/)
  })

  it('still treats a file that is not there as no accounts yet', async () => {
    // The one read failure that is not a failure: a first run.
    const home = await mkdtemp(join(tmpdir(), 'spacelink-acctshape-'))
    try {
      await expect(loadAccounts(join(home, 'never-made.json'))).resolves.toEqual({ accounts: [], sessions: [], unreadable: 0 })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('still names a file that is there and is not JSON', async () => {
    const home = await mkdtemp(join(tmpdir(), 'spacelink-acctshape-'))
    try {
      const broken = join(home, 'broken.json')
      await writeFile(broken, 'this is not json at all\n')
      await expect(loadAccounts(broken)).rejects.toThrow(/is not valid JSON/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
