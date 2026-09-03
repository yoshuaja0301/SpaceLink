// @ts-check
/**
 * Accounts, passwords and sessions.
 *
 * The server has served one vault behind one long random token since it was
 * written. A token is unguessable, so nothing had to defend it: 43 random
 * characters cannot be brute-forced through an HTTP endpoint. A password can,
 * and that is the whole reason this file is careful.
 *
 * Three rules shape it:
 *
 *  - **Node builtins only.** The server has no dependencies and keeps none, so
 *    the password hash is `scrypt` out of `node:crypto` rather than bcrypt or
 *    argon2. scrypt is a memory-hard KDF and is the right tool; the parameters
 *    below are what make it worth having.
 *  - **The vault stays a folder of Markdown files.** An account record names
 *    the directory it owns. Nothing about a note moves into a database.
 *  - **A stolen file must not be a stolen account.** The password is stored as
 *    a salted scrypt hash, and a session token is stored as a SHA-256 of
 *    itself — so `accounts.json` in a backup, or in a screenshot, is not a way
 *    in.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

/**
 * scrypt's cost. N=2^15 with r=8 needs 128·N·r = 32 MiB per hash, which is the
 * point — an attacker with a stolen file pays that for every guess. Node's
 * default `maxmem` is exactly 32 MiB and the call fails at the boundary, so it
 * is raised here rather than the cost lowered.
 *
 * These live in the stored record, not only in this constant: raising the cost
 * later must not lock out everyone hashed under the old one.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 }

/** How long a device stays signed in before it has to prove itself again. */
export const SESSION_DAYS = 30

/** A password shorter than this is refused when the account is made. */
export const MIN_PASSWORD_LENGTH = 8

/**
 * @typedef {object} Account
 * @property {string} id            Stable, opaque, and what a session refers to.
 * @property {string} email         Stored as typed; compared case-insensitively.
 * @property {string} vault         Absolute path to this account's folder of notes.
 * @property {string} salt          Base64, 16 bytes.
 * @property {string} hash          Base64 scrypt output.
 * @property {{ N: number, r: number, p: number, keylen: number }} kdf
 * @property {number} createdAt
 */

/**
 * @typedef {object} Session
 * @property {string} id        SHA-256 of the token the device holds. Not the token.
 * @property {string} accountId
 * @property {string} device    A label the device sent, for the sessions list.
 * @property {number} createdAt
 * @property {number} expiresAt
 */

/** @typedef {{ accounts: Account[], sessions: Session[] }} AccountsFile */

/** An empty store, used for a file that is missing or unreadable. */
function emptyStore() {
  return { accounts: [], sessions: [] }
}

/**
 * Read the accounts file. A file that is missing is an empty store; a file that
 * is corrupt is an error, because silently treating it as empty would let a
 * server start with no accounts and no explanation for where they went.
 * @param {string} file
 * @returns {Promise<AccountsFile>}
 */
export async function loadAccounts(file) {
  /** @type {string} */
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore()
    throw error
  }
  if (raw.trim() === '') return emptyStore()
  /** @type {any} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON. Move it aside to start over, or repair it — it holds every account.`)
  }
  return {
    accounts: Array.isArray(parsed?.accounts) ? parsed.accounts : [],
    sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
  }
}

/**
 * Write the accounts file, whole or not at all.
 *
 * Through a temporary file and a rename, for the same reason a note is: an
 * interrupted write here would leave every account unreachable. Mode 0600
 * because it holds password hashes.
 * @param {string} file
 * @param {AccountsFile} store
 */
export async function saveAccounts(file, store) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const body = `${JSON.stringify({ accounts: store.accounts, sessions: store.sessions }, null, 2)}\n`
  await writeFile(temporary, body, { mode: 0o600 })
  await rename(temporary, file)
}

/** Emails differ only by case as often as by accident; compare them folded. */
export function sameEmail(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
}

/**
 * @param {Account[]} accounts
 * @param {string} email
 * @returns {Account | null}
 */
export function findAccount(accounts, email) {
  return accounts.find((account) => sameEmail(account.email, email)) ?? null
}

/**
 * Hash a password for storage. The salt is fresh per account, so two people
 * with the same password do not share a hash.
 * @param {string} password
 * @returns {Promise<{ salt: string, hash: string, kdf: { N: number, r: number, p: number, keylen: number } }>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = /** @type {Buffer} */ (await scrypt(password, salt, SCRYPT.keylen, SCRYPT))
  return {
    salt: salt.toString('base64'),
    hash: derived.toString('base64'),
    kdf: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
  }
}

/**
 * Is this the account's password?
 *
 * Hashed with the parameters stored on the record rather than today's, so a
 * later change of cost does not lock anybody out. Compared in constant time:
 * a comparison that returns early tells an attacker how much of a guess was
 * right.
 * @param {string} password
 * @param {Account} account
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, account) {
  try {
    const parameters = account.kdf ?? { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen }
    const expected = Buffer.from(account.hash, 'base64')
    const derived = /** @type {Buffer} */ (
      await scrypt(password, Buffer.from(account.salt, 'base64'), parameters.keylen, {
        N: parameters.N,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT.maxmem,
      })
    )
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  } catch {
    // A record with a broken salt or unusable parameters is not a password
    // that matches. Never an exception that reads as a server fault.
    return false
  }
}

/**
 * A record no password can match, hashed at the same cost as a real one.
 *
 * Its salt is fixed and its "hash" is 64 zero bytes: `verifyPassword` will
 * derive a key and fail the comparison, which is all this is for.
 */
const DECOY = {
  salt: Buffer.alloc(16).toString('base64'),
  hash: Buffer.alloc(SCRYPT.keylen).toString('base64'),
  kdf: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
}

/**
 * The account this email and password belong to, or null.
 *
 * An address with no account still costs one full hash. Without that, the two
 * refusals are worded identically and take visibly different times — about
 * 90 ms against 1 — which is an oracle for which addresses have accounts, with
 * extra steps. Answering slowly is the price of answering the same.
 *
 * @param {Account[]} accounts
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Account | null>}
 */
export async function verifyLogin(accounts, email, password) {
  const account = findAccount(accounts, email)
  if (!account) {
    await verifyPassword(password, /** @type {any} */ (DECOY))
    return null
  }
  return (await verifyPassword(password, account)) ? account : null
}

/**
 * Create an account. The caller has already decided this is allowed — there is
 * no sign-up endpoint, only the command line.
 * @param {{ file: string, email: string, password: string, vault: string }} details
 * @returns {Promise<Account>}
 */
export async function addAccount({ file, email, password, vault }) {
  const address = String(email ?? '').trim()
  if (!address.includes('@') || address.length < 3) throw new Error(`"${address}" does not look like an email address.`)
  if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  const store = await loadAccounts(file)
  if (findAccount(store.accounts, address)) throw new Error(`There is already an account for ${address}.`)

  const { salt, hash, kdf } = await hashPassword(password)
  /** @type {Account} */
  const account = {
    id: randomBytes(9).toString('base64url'),
    email: address,
    vault: resolve(vault),
    salt,
    hash,
    kdf,
    createdAt: Date.now(),
  }
  store.accounts.push(account)
  await saveAccounts(file, store)
  return account
}

/**
 * Change an account's password, and sign out every device it was signed in on.
 *
 * Signing the devices out is the point: a password is changed because it may
 * be known, and a session that outlived it would make the change decorative.
 * @param {{ file: string, email: string, password: string }} details
 * @returns {Promise<Account>}
 */
export async function setPassword({ file, email, password }) {
  if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  const store = await loadAccounts(file)
  const account = findAccount(store.accounts, email)
  if (!account) throw new Error(`There is no account for ${email}.`)
  const { salt, hash, kdf } = await hashPassword(password)
  account.salt = salt
  account.hash = hash
  account.kdf = kdf
  store.sessions = store.sessions.filter((session) => session.accountId !== account.id)
  await saveAccounts(file, store)
  return account
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

/** The stored form of a session token: what the file holds instead of the token. */
export function sessionId(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** Sessions that have not expired, oldest first. */
export function liveSessions(store, now) {
  return store.sessions.filter((session) => session.expiresAt > now)
}

/**
 * Sign a device in. Returns the token the device keeps — the only time it
 * exists outside that device.
 * @param {{ file: string, account: Account, device?: string, now?: number }} details
 * @returns {Promise<{ token: string, session: Session }>}
 */
export async function createSession({ file, account, device = 'a device', now = Date.now() }) {
  const token = randomBytes(32).toString('base64url')
  /** @type {Session} */
  const session = {
    id: sessionId(token),
    accountId: account.id,
    device: String(device).slice(0, 80),
    createdAt: now,
    expiresAt: now + SESSION_DAYS * 24 * 60 * 60 * 1000,
  }
  const store = await loadAccounts(file)
  // Expired sessions are swept here rather than on a timer: this is the only
  // moment the file is being rewritten anyway.
  store.sessions = [...liveSessions(store, now), session]
  await saveAccounts(file, store)
  return { token, session }
}

/**
 * The account a session token belongs to, or null.
 *
 * Takes the store it was handed rather than reading the file: this runs on
 * every request, and reading and parsing a file per request would be a poor
 * way to spend a save.
 * @param {AccountsFile} store
 * @param {string} token
 * @param {number} [now]
 * @returns {Account | null}
 */
export function accountForSession(store, token, now = Date.now()) {
  if (typeof token !== 'string' || token === '') return null
  const id = sessionId(token)
  const session = store.sessions.find((candidate) => candidate.id === id)
  if (!session || session.expiresAt <= now) return null
  return store.accounts.find((account) => account.id === session.accountId) ?? null
}

/**
 * Sign one device out.
 * @param {{ file: string, token: string }} details
 * @returns {Promise<boolean>} whether there was a session to end
 */
export async function revokeSession({ file, token }) {
  const id = sessionId(token)
  const store = await loadAccounts(file)
  const before = store.sessions.length
  store.sessions = store.sessions.filter((session) => session.id !== id)
  if (store.sessions.length === before) return false
  await saveAccounts(file, store)
  return true
}

/* ------------------------------------------------------------------ *
 * Slowing down a password guesser
 * ------------------------------------------------------------------ */

/** Failures allowed before the wait starts growing. */
const FREE_ATTEMPTS = 5
/** The wait doubles per failure past that, up to this. */
const MAX_DELAY_MS = 15 * 60 * 1000
/** A quiet spell this long forgets a run of failures. */
const FORGET_AFTER_MS = 60 * 60 * 1000

/**
 * A count of recent failures per key, and how long that key must wait.
 *
 * The token the server has always used cannot be guessed; a password can, and
 * anyone on the same Wi-Fi can reach the port. This is what stands between a
 * weak password and a script — in memory, because a restart losing the
 * counters is a smaller problem than a file rewritten on every failed login.
 */
export function createAttemptLimiter({ freeAttempts = FREE_ATTEMPTS, maxDelayMs = MAX_DELAY_MS, forgetAfterMs = FORGET_AFTER_MS } = {}) {
  /** @type {Map<string, { failures: number, last: number }>} */
  const seen = new Map()

  /** How long `key` must wait before another attempt is worth making. */
  const retryAfterMs = (key, now) => {
    const record = seen.get(key)
    if (!record) return 0
    if (now - record.last > forgetAfterMs) {
      seen.delete(key)
      return 0
    }
    if (record.failures <= freeAttempts) return 0
    const delay = Math.min(maxDelayMs, 1000 * 2 ** (record.failures - freeAttempts - 1))
    return Math.max(0, record.last + delay - now)
  }

  return {
    /** @returns {number} milliseconds to wait, 0 when the attempt may proceed */
    retryAfter(key, now = Date.now()) {
      return retryAfterMs(key, now)
    },
    fail(key, now = Date.now()) {
      const record = seen.get(key)
      if (!record || now - record.last > forgetAfterMs) seen.set(key, { failures: 1, last: now })
      else seen.set(key, { failures: record.failures + 1, last: now })
    },
    /** A password that worked clears the run — the person is who they said. */
    succeed(key) {
      seen.delete(key)
    },
    get size() {
      return seen.size
    },
  }
}
