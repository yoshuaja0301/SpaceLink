#!/usr/bin/env node
// @ts-check
/**
 * SpaceLink sync server.
 *
 * Holds one vault — a folder of Markdown files — and serves both the app and a
 * small HTTP API over it, so every device you install the app on reads and
 * writes the same notes.
 *
 * Design notes worth knowing before changing anything here:
 *
 *  - **The vault on disk is the truth.** The server keeps no database and no
 *    copy. Anything that edits the folder — another editor, a sync client, you
 *    at the terminal — is picked up by the watcher and pushed to every device.
 *  - **Writes are conditional.** A client sends the hash it believed it was
 *    editing; a mismatch is a 409 with the current hash, never a silent
 *    overwrite. Two devices editing the same note offline end up with a
 *    conflict copy, not a lost note.
 *  - **Events are deduplicated.** An API write is announced immediately and the
 *    watcher's echo for the same content is dropped, so a device does not get
 *    told about its own save.
 */
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { watch as watchDirectory } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  accountForSession,
  addAccount,
  createAttemptLimiter,
  createSession,
  loadAccounts,
  plainText,
  revokeSession,
  setPassword,
  verifyLogin,
} from './accounts.mjs'
import { ACCOUNTS_FILE, HELP, loadOrCreateToken, parseArgs, tokensMatch } from './config.mjs'
import { SKIP_DIRECTORIES, TEMP_PREFIX, VaultConflictError, VaultNotFoundError, VaultPathError, VaultStore, hashOf } from './vaultStore.mjs'

/**
 * Where this file lives, used only to find `dist/`.
 *
 * Guarded because a bundler can load this module under a non-file URL (the test
 * runner does), and failing to locate `dist/` must not stop the API from
 * working — a caller can always pass `distDir` explicitly.
 */
const HERE = (() => {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return resolve(process.cwd(), 'server')
  }
})()
const DIST = resolve(HERE, '..', 'dist')

/** Bodies larger than this are refused outright rather than buffered. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** An email and a password, and nothing like a file. Unauthenticated, so small. */
const LOGIN_BODY_BYTES = 4 * 1024

/** How long an API write suppresses the watcher's echo for the same content. */
const ECHO_WINDOW_MS = 4000

/**
 * How often an open change stream is asked whether its credential still holds.
 *
 * The bound on how long a revoked device keeps hearing about a vault. Short,
 * because that is the point; and cheap, because the accounts file is only read
 * again when its mtime has moved.
 */
const REVOCATION_CHECK_MS = 5000

/**
 * How long to wait before trying again to watch a folder that is not there.
 *
 * A vault folder can be missing when the watch is first set up: an account
 * whose folder is made a moment after `--add-account`, a server started before
 * an external drive is plugged in, a folder that happened to be away when its
 * owner's first request came in. Without a retry the first failure was final —
 * that vault was read and written correctly for the rest of the run and never
 * announced a change again.
 */
const WATCH_RETRY_MS = 5000

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}

/**
 * The headers for an answer sent to a request whose body was not read to its
 * end — which is to say, one `readBody` gave up on.
 *
 * Those unread bytes are still queued on the connection, and a keep-alive
 * connection is where the next request is parsed from: leaving it open meant
 * the megabytes of a refused note were read as somebody's next call. Measured
 * as three unrelated tests failing right after this one, with ECONNRESET and
 * a timeout. Saying `close` is what ends it, and the leftovers go with it.
 *
 * @param {unknown} error
 */
function tornDown(error) {
  return /** @type {any} */ (error)?.status === 413 ? { connection: 'close' } : {}
}

/**
 * Buffer a request body, up to `limit` bytes.
 *
 * Over the limit it stops reading and rejects with a 413 the route turns into
 * an answer — but it does not destroy the connection, which is the whole point
 * of the change that put this comment here. Destroying it meant the 413 and
 * its message were written to a socket that was already gone, and the caller
 * saw a dropped connection instead: measured, a 40 MB note came back as
 * `fetch failed`, with "That file is too large to sync." never leaving the
 * building. Node closes a connection whose request body was not drained once
 * the response ends, so nothing is left half-read.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [limit]
 * @param {string} [tooLarge] what to tell the caller, in the caller's terms
 */
function readBody(request, limit = MAX_BODY_BYTES, tooLarge = 'That file is too large to sync.') {
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {Buffer[]} */
    const chunks = []
    let length = 0
    const onData = (chunk) => {
      length += chunk.length
      if (length > limit) {
        request.off('data', onData)
        request.pause()
        rejectPromise(Object.assign(new Error(tooLarge), { status: 413 }))
        return
      }
      chunks.push(chunk)
    }
    request.on('data', onData)
    request.on('end', () => resolvePromise(Buffer.concat(chunks)))
    request.on('error', rejectPromise)
  })
}

/**
 * The key an address is counted under, folded and bounded.
 *
 * The address comes from the request body, and the limiter holds ten thousand
 * keys — so its size is the caller's to choose. The sign-in body allows about
 * four thousand characters, and ten thousand of those measured 45 MB of heap,
 * spent by anyone on the network with no token and no account.
 *
 * Cut to the longest address an account can have, which `assertUsableEmail`
 * puts at 254: anything longer could never match one, so nothing is conflated
 * that was ever distinguishable. Nothing else about the answer changes — the
 * refusal is worded and timed the same, whatever was sent.
 *
 * @param {string} email
 */
function limiterKey(email) {
  return email.toLowerCase().slice(0, 254)
}

/**
 * Who a request came from, for rate-limiting purposes only.
 *
 * The socket's own address, never `x-forwarded-for`: that header is written by
 * whoever is talking, so a limiter that trusted it would hand an attacker a
 * fresh identity per request — worse than having no address key at all. The
 * cost is that everyone behind one tunnel shares a key, which is why that key
 * gets the wider budget.
 *
 * @param {import('node:http').IncomingMessage} request
 */
function clientAddress(request) {
  return request.socket?.remoteAddress ?? 'unknown'
}

/** @param {import('node:http').IncomingMessage} request */
function bearerToken(request) {
  const header = request.headers.authorization
  // The scheme is matched without regard to case, as RFC 7235 says it is. The
  // app always sends `Bearer`; a person at a terminal who types `bearer` was
  // told their token was not accepted, which sends them to copy it again when
  // it was fine all along.
  const match = typeof header === 'string' ? /^bearer\s+(.*)$/i.exec(header) : null
  return match ? match[1].trim() : ''
}

/** Addresses this machine can be reached on, for the startup banner. */
function localAddresses() {
  /** @type {string[]} */
  const found = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address)
    }
  }
  return found
}

/**
 * @param {{ vault: string, token: string, distDir?: string }} options
 */
/**
 * Everything that belongs to one folder of notes: the store, the devices
 * listening to it, and the watcher that tells them what changed.
 *
 * One per account. It has to be: the change stream and the echo window were a
 * single set and a single map when the server held a single vault, and left
 * that way one account would be told about another account's notes — by path,
 * with a hash of their contents.
 *
 * @param {string} root
 */
function createVault(root) {
  const store = new VaultStore(root)

  /** @type {Set<import('node:http').ServerResponse>} */
  const listeners = new Set()
  /** @type {Map<string, { hash: string, at: number }>} */
  const recentWrites = new Map()

  /** @param {{ type: string, path?: string, from?: string, to?: string, hash?: string, origin?: string }} event */
  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const listener of listeners) {
      /*
       * A listener the server has ended itself — a stream dropped because the
       * credential behind it stopped holding — stays in this set until its
       * connection's `close` fires, which is a later tick. Writing to it in
       * between does not fail where a caller could see it: `write()` returns
       * false and raises an `error` event with nothing listening, and that
       * ends the process. One reader losing its stream at the wrong moment
       * must not take everyone else's sync down with it.
       */
      if (listener.writableEnded || listener.destroyed) {
        listeners.delete(listener)
        continue
      }
      try {
        listener.write(payload)
      } catch {
        listeners.delete(listener)
      }
    }
  }

  /**
   * Remember what an API call just wrote, so the watcher's echo can be dropped.
   * @param {string} path
   * @param {string} hash
   */
  function noteOwnWrite(path, hash) {
    recentWrites.set(path, { hash, at: Date.now() })
    for (const [key, value] of recentWrites) {
      if (Date.now() - value.at > ECHO_WINDOW_MS) recentWrites.delete(key)
    }
  }

  /**
   * @param {string} path
   * @param {string} hash
   */
  function isOwnEcho(path, hash) {
    const recent = recentWrites.get(path)
    if (!recent) return false
    if (Date.now() - recent.at > ECHO_WINDOW_MS) {
      recentWrites.delete(path)
      return false
    }
    return recent.hash === hash
  }

  /** Tell every listening device what one changed file now looks like. */
  async function announceChange(filename) {
    if (!filename) return
    const relativePath = String(filename).split(/[\\/]/).join('/')
    // Dot-files are not part of the vault, and the scratch file an atomic
    // write moves into place must never be announced as a note.
    const leaf = relativePath.split('/').pop() ?? ''
    if (leaf.startsWith('.') || leaf.startsWith(TEMP_PREFIX)) return
    let entry
    try {
      entry = await store.resolveOnDisk(relativePath)
    } catch {
      return // hidden, inside a skipped directory, through a link, or otherwise not ours
    }
    const info = await stat(entry.absolute).catch(() => null)
    if (info && !info.isFile()) return // a folder appearing is not a note going away
    const body = info ? await readFile(entry.absolute).catch(() => null) : null
    if (body === null) {
      if (isOwnEcho(entry.relative, '')) return
      // The file is gone, and with it what was last written there: a file
      // that comes back with the same bytes is news, not an echo of that write.
      recentWrites.delete(entry.relative)
      broadcast({ type: 'remove', path: entry.relative })
      return
    }
    const hash = hashOf(body)
    if (isOwnEcho(entry.relative, hash)) return
    noteOwnWrite(entry.relative, hash)
    broadcast({ type: 'upsert', path: entry.relative, hash })
  }

  /**
   * Watch the folder so edits made outside the app reach every device.
   *
   * On macOS and Windows the operating system offers a recursive watch and
   * `fs.watch` uses it. Linux offers none, and Node emulates one in
   * JavaScript — an emulation that, once a file has been replaced by an
   * atomic save (which is every save this server makes), reports nothing
   * more about that file: its later deletion and return go unseen, and the
   * other devices are never told the note is gone, or back. So on Linux every
   * folder is watched on its own. inotify on a folder reports each entry that
   * appears, changes or goes, and a folder that appears is watched as it comes.
   *
   * Either way what comes back is one emitter with `change` (the event type
   * and a path relative to the vault) and `error` events, and a `close()`.
   * Its `error` listener matters: a folder deleted while it is being scanned
   * is reported by *emitting* ENOENT, and an emitter with no listener rethrows
   * what it is given — deleting a folder inside your vault at the wrong moment
   * used to take the server with it. A test puts an error through the emitter
   * to prove the listener is there; nothing else needs the return value.
   *
   * @param {AbortSignal} [signal]
   * @param {'folders' | 'recursive'} [mode]
   */
  function startWatching(signal, mode = process.platform === 'linux' ? 'folders' : 'recursive') {
    if (signal?.aborted) return null
    const watcher = new EventEmitter()
    let stop = () => {}

    watcher.on('error', (error) => {
      // A folder that went away mid-scan. There is nothing to do about it and
      // nothing is lost: the watch on the rest of the vault carries on.
      if (error?.code === 'ENOENT') return
      process.stderr.write(`SpaceLink: stopped watching the vault (${error?.message ?? error}).\n`)
      watcher.close()
    })

    // One at a time, in order: two events for the same file processed
    // together would race over `isOwnEcho`.
    let queue = Promise.resolve()
    watcher.on('change', (_eventType, filename) => {
      queue = queue.then(() => announceChange(filename)).catch((error) => {
        process.stderr.write(`SpaceLink: could not announce a change (${error?.message ?? error}).\n`)
      })
    })

    /** @type {ReturnType<typeof setTimeout> | null} */
    let retry = null
    watcher.close = () => {
      if (retry) clearTimeout(retry)
      retry = null
      stop()
    }

    /**
     * Take the watch, or arrange to take it later.
     *
     * A folder that is not there yet is the one failure worth waiting on, and
     * the only one that comes back by itself. Anything else — a permission, a
     * filesystem that cannot watch at all — would repeat forever without
     * getting anywhere, so it is reported once and left.
     *
     * What happened while the folder was away is not announced: there was no
     * watch to see it. A device's next listing is what reconciles that, which
     * is the same thing that reconciles a device that was simply offline.
     */
    const attach = () => {
      retry = null
      try {
        stop = mode === 'recursive' ? watchRecursively(store.root, watcher) : watchEachFolder(store.root, watcher, store)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          process.stderr.write(`SpaceLink: could not watch the vault (${error?.message ?? error}).\n`)
          return
        }
        retry = setTimeout(attach, WATCH_RETRY_MS)
        // Nothing should be kept alive by the wait: a server with nothing else
        // to do must still be able to exit.
        retry.unref?.()
      }
    }

    const first = store.root
    attach()
    if (retry) process.stderr.write(`SpaceLink: ${first} is not there yet; watching for it.\n`)

    signal?.addEventListener('abort', () => watcher.close(), { once: true })
    return watcher
  }

  return { root, store, listeners, broadcast, noteOwnWrite, isOwnEcho, announceChange, startWatching }
}

/**
 * @param {{ vault: string, token: string, distDir?: string, accountsFile?: string | null }} options
 */
export function createSyncServer({ vault, token, distDir = DIST, accountsFile = null }) {
  // The folder named on the command line. It is what the static token serves —
  // the macOS app, and every device paired before accounts existed — and it is
  // what an account gets when none was chosen for it.
  const primary = createVault(vault)

  /**
   * One context per *folder*, not per account, keyed by its resolved path.
   *
   * Two accounts can name the same folder — the guide's own "several people,
   * several vaults" section describes exactly that — and giving each its own
   * would put two watchers and two echo windows over one folder. The folder on
   * the command line is simply the first entry.
   */
  const byFolder = new Map([[resolve(vault), primary]])
  /** Held so a vault opened after the server started is watched too. */
  let watchSignal = null

  /** Password guessing is slowed per address; the token has never needed it. */
  // The email key uses the default budget; the address key a wider one, since
  // a tunnel puts a whole household behind a single address.
  const attempts = createAttemptLimiter({ freeAttempts: 5 })
  const byAddress = createAttemptLimiter({ freeAttempts: 25 })

  /**
   * The accounts file, re-read only when it has changed on disk.
   *
   * This is consulted on every authenticated request, and parsing a file that
   * many times would be a poor way to spend a save. Keyed on mtime rather than
   * a timer so an account added from the terminal is live at once.
   */
  let cachedAccounts = { mtimeMs: -1, store: null }
  async function accountsStore() {
    if (!accountsFile) return { accounts: [], sessions: [] }
    const info = await stat(accountsFile).catch(() => null)
    if (!info) return { accounts: [], sessions: [] }
    if (cachedAccounts.store && cachedAccounts.mtimeMs === info.mtimeMs) return cachedAccounts.store
    const loaded = await loadAccounts(accountsFile)
    cachedAccounts = { mtimeMs: info.mtimeMs, store: loaded }
    return loaded
  }
  /** After a write of our own, so the next request does not read a stale file. */
  const forgetAccounts = () => {
    cachedAccounts = { mtimeMs: -1, store: null }
  }

  /** The vault an account owns, opened and watched the first time it is asked for. */
  function vaultFor(account) {
    const root = resolve(account.vault)
    const existing = byFolder.get(root)
    // Whether that is the folder the server was started on or one another
    // account is already using: a folder is watched once and its changes are
    // announced once, to everyone reading it.
    if (existing) return existing
    const context = createVault(account.vault)
    byFolder.set(root, context)
    if (watchSignal && !watchSignal.aborted) context.startWatching(watchSignal)
    return context
  }

  /**
   * Who is asking, and which notes are theirs.
   *
   * Two credentials are accepted at the same door. The static token is the one
   * the server has always taken, and the macOS app still passes it on the
   * command line; a session token belongs to an account and is what a device
   * gets by signing in. Neither can be mistaken for the other: the static token
   * is compared in constant time, and a session is looked up by the hash of
   * itself.
   *
   * @returns {Promise<{ kind: 'token' | 'account', account?: any, context: ReturnType<typeof createVault> } | null>}
   */
  async function identify(presented) {
    if (tokensMatch(presented, token)) return { kind: 'token', context: primary }
    const store = await accountsStore()
    const account = accountForSession(store, presented)
    if (account) return { kind: 'account', account, context: vaultFor(account) }
    return null
  }

  /**
   * Every request, and no exception gets past here: the listener drops this
   * promise, so one that rejected would end the process — one badly spelled
   * address, from anyone on the network, no token needed.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function handle(request, response) {
    try {
      await route(request, response)
    } catch (error) {
      process.stderr.write(`SpaceLink: ${request.method} ${request.url} failed (${error?.message ?? error}).\n`)
      if (response.headersSent) response.destroy()
      else sendJson(response, 500, { error: 'Something went wrong.' })
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function route(request, response) {
    // `request.url` is a path, and a path is all it is — but `new URL(path,
    // base)` reads a leading `//` as the start of an authority. `GET //` threw
    // "Invalid URL" from here, and `GET //api/health` quietly became the host
    // `api` with the path `/health`, missing the API entirely. Prefixing the
    // origin keeps the whole path, whatever it begins with.
    const path = request.url?.startsWith('/') ? request.url : '/'
    const url = new URL(`http://localhost${path}`)
    const origin = request.headers.origin

    // The API is protected by a bearer token, never by a cookie, so a page on
    // another origin cannot make authenticated calls just by being open.
    if (typeof origin === 'string') {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
      response.setHeader(
        'access-control-allow-headers',
        'authorization, content-type, if-match, x-spacelink-client, x-spacelink-device',
      )
      response.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE, OPTIONS')
      response.setHeader('access-control-expose-headers', 'etag, x-spacelink-mtime, retry-after')
      response.setHeader('access-control-max-age', '600')
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(url.pathname, response, distDir)
      return
    }

    // Unauthenticated: just enough for a device to tell a SpaceLink server from
    // anything else at that address. It reveals nothing about the vault.
    if (url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, service: 'spacelink' })
      return
    }

    // EventSource cannot send an Authorization header, so the change stream —
    // and only the change stream — also accepts the token as a query parameter.
    // Keeping it off every other endpoint limits how often it can end up in a
    // proxy log.
    // Signing in happens before the door, because it is how you get a key.
    try {
      if (await handleAuth(request, response, url)) return
    } catch (error) {
      process.stderr.write(`SpaceLink: ${request.method} ${url.pathname} failed (${error?.message ?? error}).\n`)
      sendJson(response, 500, { error: 'Something went wrong.' })
      return
    }

    const presented =
      url.pathname === '/api/events' && url.searchParams.has('token')
        ? String(url.searchParams.get('token'))
        : bearerToken(request)

    const caller = await identify(presented)
    if (!caller) {
      sendJson(response, 401, { error: 'A valid access token is required.' })
      return
    }

    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      sendJson(response, 200, {
        signedIn: caller.kind === 'account',
        email: caller.account?.email ?? null,
        vault: caller.context.store.root.split(/[\\/]/).pop() || 'vault',
      })
      return
    }

    try {
      // The credential is handed along so an open change stream can ask again
      // later whether it is still one.
      await handleApi(request, response, url, caller.context, () => identify(presented).then(Boolean))
    } catch (error) {
      // Only an error raised on purpose carries a status and a message written
      // for the caller. Anything else is Node's own, and those name the file
      // on disk — the vault's whole path — which is nobody's business.
      const known = typeof error?.status === 'number' && error instanceof Error
      if (!known) process.stderr.write(`SpaceLink: ${request.method} ${url.pathname} failed (${error?.message ?? error}).\n`)
      if (response.headersSent) {
        // A streamed response that failed part-way. The status is already out
        // and cannot be revised; all that is left is to stop cleanly rather
        // than throw a second error on top of the first.
        process.stderr.write(`SpaceLink: ${request.method} ${url.pathname} stopped part-way (${error?.message ?? error}).\n`)
        response.end()
        return
      }
      const body = { error: known ? error.message : 'Something went wrong.' }
      if (error instanceof VaultConflictError) body.currentHash = error.currentHash
      sendJson(response, known ? error.status : 500, body, tornDown(error))
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {URL} url
   */
  async function handleApi(request, response, url, context, stillAllowed = null) {
    const path = url.searchParams.get('path') ?? ''
    const client = String(request.headers['x-spacelink-client'] ?? '')

    if (url.pathname === '/api/vault' && request.method === 'GET') {
      // The folder is checked, not just named. This is the call a device makes
      // to decide whether a pairing is worth keeping, and answering from the
      // path string alone said yes to a vault the server cannot read: the
      // device saved the pairing, opened, failed on its first listing, and
      // reconnected to the same unreadable vault on every launch afterwards.
      await context.store.realRootPath()
      sendJson(response, 200, { name: context.store.root.split(/[\\/]/).pop() || 'vault', writable: true })
      return
    }

    if (url.pathname === '/api/files' && request.method === 'GET') {
      sendJson(response, 200, { files: await context.store.list() })
      return
    }

    // Every note's text in one response, as newline-delimited JSON.
    //
    // This is what a device uses to open the vault. One request instead of one
    // per note matters more than it sounds: a browser will only hold six
    // connections open to an origin, so five thousand reads queue six deep and
    // the vault takes minutes to appear. It streams, so neither the server nor
    // the client ever holds the whole vault in memory as one string.
    if (url.pathname === '/api/bundle' && request.method === 'GET') {
      // Listed before a byte of the response goes out. Once the head is
      // written the status cannot be taken back, so a failure after it —
      // a vault whose folder is not there, a disk that stopped answering —
      // can only drop the connection, and the app is left with a socket error
      // where a sentence would have done.
      const files = await context.store.list()
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        // Nothing downstream should try to buffer this to add a length.
        'transfer-encoding': 'chunked',
      })
      // A device that goes away half-way through — a tab closed, a phone that
      // lost its signal — must release this handler: waiting on a `drain`
      // that a closed socket will never send would keep the vault's files
      // being read for nobody, once per such device, for as long as the
      // server runs.
      let gone = response.destroyed || response.writableEnded
      response.once('close', () => {
        gone = true
      })
      response.write(JSON.stringify({ type: 'head', files: files.length, notes: files.filter((f) => f.isMarkdown).length }) + '\n')
      for await (const note of context.store.readAllMarkdown()) {
        if (gone) return
        // Back-pressure: a fast disk must not outrun a slow connection into an
        // unbounded write buffer.
        if (!response.write(JSON.stringify({ type: 'note', ...note }) + '\n')) {
          await new Promise((resolve) => {
            response.once('drain', resolve)
            response.once('close', resolve)
          })
        }
      }
      if (gone) return
      for (const file of files) {
        if (file.isMarkdown) continue
        response.write(JSON.stringify({ type: 'attachment', ...file }) + '\n')
      }
      response.end(JSON.stringify({ type: 'end' }) + '\n')
      return
    }

    if (url.pathname === '/api/file') {
      if (request.method === 'GET') {
        const file = await context.store.read(path)
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
          'content-length': file.body.length,
          etag: `"${file.hash}"`,
          'x-spacelink-mtime': String(file.mtime),
          'cache-control': 'no-store',
        })
        response.end(file.body)
        return
      }

      if (request.method === 'PUT') {
        const body = await readBody(request)
        const ifMatch = request.headers['if-match']
        const expected = typeof ifMatch === 'string' ? ifMatch.replace(/^"|"$/g, '') : undefined
        const written = await context.store.write(path, body, expected)
        context.noteOwnWrite(path, written.hash)
        context.broadcast({ type: 'upsert', path, hash: written.hash, origin: client })
        sendJson(response, 200, { path, ...written }, { etag: `"${written.hash}"` })
        return
      }

      if (request.method === 'DELETE') {
        await context.store.remove(path)
        context.noteOwnWrite(path, '')
        context.broadcast({ type: 'remove', path, origin: client })
        sendJson(response, 200, { path, removed: true })
        return
      }
    }

    if (url.pathname === '/api/rename' && request.method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
      } catch {
        throw new VaultPathError('The request body is not valid JSON.')
      }
      const renamed = await context.store.rename(String(body.from ?? ''), String(body.to ?? ''))
      context.noteOwnWrite(String(body.from ?? ''), '')
      // The new name too: the watcher will see a file appear there, and
      // without this it would announce it as an anonymous write — which the
      // renaming device, whose note is still marked unsaved, takes for
      // somebody else's edit.
      context.noteOwnWrite(String(body.to ?? ''), renamed.hash)
      context.broadcast({ type: 'rename', from: String(body.from), to: String(body.to), origin: client })
      sendJson(response, 200, { from: body.from, to: body.to, renamed: true })
      return
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      response.write(': connected\n\n')
      context.listeners.add(response)
      // A comment every 25s keeps proxies and phone radios from closing an idle
      // stream, which would otherwise look like the server going away.
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000)

      /*
       * A stream is authorised when it opens, and it can stay open for days.
       * Without this it is never asked again: a device whose session has been
       * revoked — signed out, or its account's password changed, which is the
       * command that promises to sign every device out — kept receiving every
       * change to the vault, by path and by hash, for as long as the connection
       * happened to last. Measured: a note written *after* the password change
       * still arrived.
       *
       * So the credential is re-checked while the stream is open. Often enough
       * to matter, cheaply enough not to: the accounts file is read only when
       * its mtime has changed, so this is a `stat` a few times a minute.
       */
      let complained = false
      const recheck = stillAllowed
        ? setInterval(async () => {
            try {
              if (await stillAllowed()) return
              // Stop asking, and end it. Everything else — the keep-alive, the
              // listeners set — the connection's `close` handler below already
              // owns, and ending the response is what fires it.
              clearInterval(recheck)
              response.end()
            } catch (error) {
              /*
               * A check that could not be made is not an answer of "no". An
               * accounts file missing a brace, or a drive answering EIO, is the
               * same failure an ordinary request meets — and a request that
               * meets it gets a 500 and keeps its credential, rather than being
               * signed out. So the stream is kept, and the next tick decides
               * once the file can be read again.
               *
               * Unhandled, this was worse than either answer: the rejection
               * escaped the interval and ended the process, so one unreadable
               * file took down every device's sync rather than none. Said once
               * per stream — every five seconds would bury the reason.
               */
              if (complained) return
              complained = true
              process.stderr.write(`SpaceLink: could not re-check an open stream (${error?.message ?? error}).\n`)
            }
          }, REVOCATION_CHECK_MS)
        : null

      request.on('close', () => {
        clearInterval(keepAlive)
        if (recheck) clearInterval(recheck)
        context.listeners.delete(response)
      })
      return
    }

    sendJson(response, 404, { error: `No such endpoint: ${request.method} ${url.pathname}` })
  }

  /**
   * Signing in, signing out, and saying who is signed in.
   *
   * There is no way to *make* an account here. Accounts are made with a command
   * on the machine that holds the notes, which is the whole reason this server
   * has no sign-up form to attack.
   */
  async function handleAuth(request, response, url) {
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      if (!accountsFile) {
        sendJson(response, 404, { error: 'This server has no accounts. It is reached with an access token.' })
        return true
      }
      /** @type {Buffer} */
      let raw
      try {
        // A kilobyte, not the 32 MB a note may be. This is the one endpoint an
        // unauthenticated caller can reach, and buffering whatever they care to
        // send would make it a way to spend the server's memory for free.
        raw = await readBody(request, LOGIN_BODY_BYTES, 'That sign-in request is too large.')
      } catch (error) {
        // A body over the limit is not a syntax error, and calling it one
        // sends somebody hunting for a typo in a request that was only too big.
        const known = typeof error?.status === 'number' && error instanceof Error
        sendJson(
          response,
          known ? error.status : 400,
          { error: known ? error.message : 'The request body is not valid JSON.' },
          tornDown(error),
        )
        return true
      }
      /** @type {any} */
      let body
      try {
        body = JSON.parse(raw.toString('utf8') || '{}')
      } catch {
        sendJson(response, 400, { error: 'The request body is not valid JSON.' })
        return true
      }
      // Valid JSON is not the same as a JSON object. `null` parsed cleanly and
      // then threw on `.email`, which reached the caller as a 500 — and, being
      // thrown before the limiter counted anything, wrote a line to stderr per
      // request for anyone on the network, no token needed, at no cost.
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendJson(response, 400, { error: 'The request body must be a JSON object with an email and a password.' })
        return true
      }
      const email = String(body.email ?? '').trim()
      const password = String(body.password ?? '')
      // Two keys, and an attempt has to clear both.
      //
      // The address alone is not enough: it is the account being guessed at,
      // and someone may reach the server from anywhere. The email alone is not
      // enough either, and that is the less obvious half — every attempt names
      // its own email, so a caller who never repeats one is never counted,
      // while each miss still costs a deliberate 90ms and 32 MiB of scrypt.
      // Limiting only by email leaves the whole endpoint free to exhaust.
      //
      // Behind a tunnel every request shares one address, so that key is given
      // a wider budget than the email's: enough that a household mistyping
      // passwords is never locked out, small enough to bound the cost.
      /** @type {[ReturnType<typeof createAttemptLimiter>, string][]} */
      const limits = [
        [attempts, limiterKey(email)],
        [byAddress, clientAddress(request)],
      ]

      const wait = Math.max(...limits.map(([limiter, key]) => limiter.retryAfter(key)))
      if (wait > 0) {
        // A password can be guessed; the wait is what makes guessing it cost
        // something. Told in seconds so a person who mistyped theirs knows.
        sendJson(response, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` }, {
          'retry-after': String(Math.ceil(wait / 1000)),
        })
        return true
      }
      // Counted here, before the hash rather than after it. Checking and then
      // spending 90ms before recording anything lets a burst of concurrent
      // requests all pass the check together — measured, and it is not a
      // slower attack but an unlimited one. Nothing is awaited between the
      // check above and this, so the whole burst is counted in order.
      for (const [limiter, key] of limits) limiter.fail(key)

      const store = await accountsStore()
      // The same answer either way, and the same time either way: which
      // addresses have accounts is not something an unauthenticated caller
      // gets to learn, by reading the message or by timing it.
      const account = await verifyLogin(store.accounts, email, password)
      if (!account) {
        sendJson(response, 401, { error: 'That email and password do not match an account.' })
        return true
      }
      for (const [limiter, key] of limits) limiter.succeed(key)
      const device = String(request.headers['x-spacelink-device'] ?? body.device ?? 'a device')
      const { token: session } = await createSession({ file: accountsFile, account, device })
      forgetAccounts()
      sendJson(response, 200, {
        token: session,
        email: account.email,
        vault: account.vault.split(/[\\/]/).pop() || 'vault',
      })
      return true
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const presented = bearerToken(request)
      if (accountsFile && presented) {
        // Checked against the store already in memory before the file is
        // touched at all. This endpoint takes no credentials — it cannot, since
        // its whole job is to retire one — so a token nobody has ever held must
        // cost nothing beyond this lookup.
        const store = await accountsStore()
        if (accountForSession(store, presented)) {
          await revokeSession({ file: accountsFile, token: presented })
          forgetAccounts()
        }
      }
      // Always the same answer: whether that token was a session is not news
      // an unauthenticated caller needs.
      sendJson(response, 200, { ok: true })
      return true
    }

    return false
  }

  function startWatching(signal, mode) {
    watchSignal = signal ?? null
    const watcher = primary.startWatching(signal, mode)
    for (const context of byFolder.values()) {
      if (context !== primary) context.startWatching(signal, mode)
    }
    return watcher
  }

  return { store: primary.store, handle, startWatching, listeners: primary.listeners, identify }
}

/**
 * The operating system's own recursive watch, relayed. Returns what stops it.
 * @param {string} root
 * @param {EventEmitter} facade
 */
function watchRecursively(root, facade) {
  const native = watchDirectory(root, { recursive: true })
  native.on('error', (error) => facade.emit('error', error))
  native.on('change', (type, name) => facade.emit('change', type, name))
  return () => native.close()
}

/**
 * One plain watch per folder, folders that appear included. Returns what
 * stops them all.
 *
 * A folder that goes takes its notes with it, and inotify says nothing about
 * those: the ones the store has seen are announced as gone from here, one by
 * one. A folder that appears whole — moved in from elsewhere — has its notes
 * announced the same way, since no watch was there to see them arrive.
 *
 * @param {string} root
 * @param {EventEmitter} facade
 * @param {VaultStore} store
 */
function watchEachFolder(root, facade, store) {
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map()
  let closed = false

  /** @param {string} name */
  const skipped = (name) => name.startsWith('.') || SKIP_DIRECTORIES.has(name)

  /** Stop watching `folder` and everything under it. @param {string} folder */
  const forget = (folder) => {
    for (const [watched, native] of watchers) {
      if (watched === folder || watched.startsWith(`${folder}${sep}`)) {
        native.close()
        watchers.delete(watched)
      }
    }
  }

  /**
   * Start watching one folder. False when it is already watched, or when the
   * system has run out of watches — that folder is then reported and skipped
   * rather than costing the rest of the vault its watch.
   * @param {string} folder
   */
  const watchFolder = (folder) => {
    if (closed || watchers.has(folder)) return false
    let native
    try {
      native = watchDirectory(folder)
    } catch (error) {
      if (error?.code === 'ENOSPC') {
        process.stderr.write(
          `SpaceLink: too many folders to watch; changes under ${folder} will not be noticed (raise fs.inotify.max_user_watches).\n`,
        )
        return false
      }
      throw error
    }
    native.on('error', (error) => {
      // The folder itself went away: its watch is done, the others carry on.
      if (error?.code === 'ENOENT') forget(folder)
      else facade.emit('error', error)
    })
    native.on('change', (type, name) => {
      if (name) void onEntry(folder, type, String(name))
    })
    watchers.set(folder, native)
    return true
  }

  /**
   * Watch `folder` and every folder below it; with `announce`, report every
   * file found as well.
   * @param {string} folder
   * @param {boolean} announce
   */
  const walk = async (folder, announce) => {
    // The root is watched before the walk starts; everything below it is
    // watched here, and a folder the system cannot watch is not walked.
    if (!watchers.has(folder) && !watchFolder(folder)) return
    /** @type {import('node:fs').Dirent[]} */
    let entries = []
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return // gone again already
    }
    for (const entry of entries) {
      if (skipped(entry.name)) continue
      const child = join(folder, entry.name)
      if (entry.isDirectory()) await walk(child, announce)
      else if (announce && entry.isFile()) facade.emit('change', 'rename', relative(root, child))
    }
  }

  /**
   * @param {string} folder
   * @param {string} type
   * @param {string} name
   */
  const onEntry = async (folder, type, name) => {
    const absolute = join(folder, name)
    if (!skipped(name)) {
      const info = await stat(absolute).catch(() => null)
      if (info?.isDirectory()) {
        if (!watchers.has(absolute)) await walk(absolute, true)
        return
      }
      if (!info && watchers.has(absolute)) {
        forget(absolute)
        for (const known of store.hashes.keys()) {
          if (known.startsWith(`${absolute}${sep}`)) facade.emit('change', 'rename', relative(root, known))
        }
        return
      }
    }
    facade.emit('change', type, relative(root, absolute))
  }

  // The root is watched now, so a failure there is a failure to start; the
  // rest of the tree follows as fast as it can be read.
  watchFolder(root)
  void walk(root, false).catch((error) => facade.emit('error', error))
  return () => {
    closed = true
    for (const native of watchers.values()) native.close()
    watchers.clear()
  }
}

/**
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} response
 * @param {string} distDir
 */
async function serveStatic(pathname, response, distDir) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // `/%ZZ` is not an address, and it is not a reason to stop serving.
    sendJson(response, 400, { error: 'That address is not valid.' })
    return
  }
  const candidate = resolve(distDir, `.${decoded}`)
  const inside = candidate === distDir || candidate.startsWith(`${distDir}/`) || candidate.startsWith(`${distDir}\\`)
  const target = inside && decoded !== '/' ? candidate : join(distDir, 'index.html')

  let body = await readFile(target).catch(() => null)
  if (body === null) {
    // Unknown path: hand back the app shell so client-side routing still works.
    body = await readFile(join(distDir, 'index.html')).catch(() => null)
    if (body === null) {
      sendJson(response, 404, {
        error: 'The app has not been built yet. Run `npm run build`, then start the server again.',
      })
      return
    }
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    // The bundle is content-hashed; index.html must never be held onto.
    'cache-control': target.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  response.end(body)
}

/**
 * Ask for a password without printing it.
 *
 * A password typed into a terminal that echoes it is a password on someone's
 * screen and in their scrollback. Where the input is not a terminal — a pipe,
 * a script — it is read as an ordinary line, because there is nothing to hide
 * it from.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
/**
 * Fold one chunk of raw-mode keystrokes into what has been typed so far.
 *
 * A chunk is not a keystroke. Typing delivers one character at a time, but a
 * paste delivers the whole clipboard in one chunk — and a password manager's
 * clipboard ends in a newline. Read as a single "character", that chunk went
 * straight into the password, newline and all, and the prompt then sat
 * waiting for an Enter that had already been pasted. Measured at a real
 * terminal: the account was made with a password ending in `\n`, the reader
 * typed it into the app without one, and was refused with nothing said.
 * "Again:" agreed, because it was pasted the same way.
 *
 * So the chunk is walked key by key, and the entry ends at the first Enter in
 * it; whatever follows the Enter is dropped, not carried into the next prompt.
 * Backspace removes a code point, not a code unit, so a password containing an
 * emoji is not left holding half of one.
 *
 * Pure, and exported for the test that types at it.
 *
 * @param {string} typed
 * @param {string} chunk
 * @returns {{ typed: string, done: boolean, interrupted: boolean }}
 */
export function takeKeys(typed, chunk) {
  for (const key of chunk) {
    switch (key) {
      case '\n':
      case '\r':
      case '\u0004': // Ctrl-D
        return { typed, done: true, interrupted: false }
      case '\u0003': // Ctrl-C
        return { typed, done: true, interrupted: true }
      case '\u007f': // backspace
      case '\b':
        typed = [...typed].slice(0, -1).join('')
        break
      default:
        typed += key
    }
  }
  return { typed, done: false, interrupted: false }
}

/**
 * Everything a pipe had to say, read once and handed out a line at a time.
 *
 * Two prompts, one pipe. The first prompt used to read stdin to its end and
 * take the first line; the second then listened for an `end` that had already
 * happened, on a stream with nothing left to keep the process alive — so Node
 * exited, code 0, with the account unmade and not a word said. To a script that
 * is success. Now the pipe is read once, each prompt takes the next line, and a
 * prompt the pipe has no line for fails out loud.
 *
 * @type {Promise<string[]> | null}
 */
let pipedLines = null

/** @param {string} prompt */
function askPassword(prompt) {
  const input = process.stdin
  process.stdout.write(prompt)

  if (!input.isTTY) {
    pipedLines ??= new Promise((done, fail) => {
      let buffered = ''
      input.setEncoding('utf8')
      input.on('data', (chunk) => {
        buffered += chunk
      })
      input.on('end', () => done(buffered.split(/\r?\n/)))
      input.on('error', fail)
    })
    return pipedLines.then((lines) => {
      process.stdout.write('\n')
      const line = lines.shift()
      if (line === undefined || (line === '' && lines.length === 0)) {
        throw new Error(
          'The input ended before the password was confirmed. Pipe it in twice, once per prompt, or pass --password.',
        )
      }
      return line
    })
  }

  return new Promise((done) => {
    let typed = ''
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    const onData = (chunk) => {
      const next = takeKeys(typed, chunk)
      typed = next.typed
      if (!next.done) return
      input.setRawMode(false)
      input.pause()
      input.removeListener('data', onData)
      process.stdout.write('\n')
      if (next.interrupted) process.exit(130)
      done(typed)
    }
    input.on('data', onData)
  })
}

/**
 * The account commands, which run instead of a server.
 *
 * Making an account needs the machine that holds the notes, which is the
 * reason this server has no sign-up form for anyone to find.
 * @param {ReturnType<typeof parseArgs>} options
 * @param {string} accountsFile
 * @returns {Promise<boolean>} whether a command ran
 */
async function runAccountCommand(options, accountsFile) {
  if (options.listAccounts) {
    const store = await loadAccounts(accountsFile)
    if (store.accounts.length === 0) {
      process.stdout.write(`\n  No accounts yet. Make one:\n\n    npm run server -- --vault <folder> --add-account you@example.com\n\n`)
      return true
    }
    const now = Date.now()
    process.stdout.write(`\n  Accounts in ${accountsFile}\n\n`)
    for (const account of store.accounts) {
      const devices = store.sessions.filter((session) => session.accountId === account.id && session.expiresAt > now)
      // Printed through `plainText` even though what is written now is clean:
      // this file can be older than that rule, or edited by hand.
      process.stdout.write(`    ${plainText(account.email)}\n      notes  ${plainText(account.vault)}\n`)
      // Looked at, not just printed. This is the one place an owner would
      // catch a folder mistyped in --add-account, or a drive that is not
      // mounted — and a path that is not there used to be listed exactly like
      // one that is, while every device on that account got 503.
      const there = await stat(account.vault).then((info) => info.isDirectory()).catch(() => false)
      if (!there) process.stdout.write('             not there — moved, renamed, unmounted, or mistyped in --add-account\n')
      if (devices.length === 0) process.stdout.write('      no device signed in\n')
      // Each device by what it said it was and when, so it is obvious whether
      // the list holds one you no longer recognise.
      for (const device of devices.sort((a, b) => a.createdAt - b.createdAt)) {
        process.stdout.write(
          `      signed in  ${plainText(device.device)} — ${new Date(device.createdAt).toISOString().slice(0, 10)}\n`,
        )
      }
      process.stdout.write('\n')
    }
    return true
  }

  if (options.addAccount) {
    if (!options.vaultChosen) throw new Error('--add-account needs --vault, so the account has a folder of notes.')
    // A folder that does not exist yet is fine — the server makes it. A path
    // that exists and is not one is not: the account was made cheerfully, and
    // the device that signed in to it got a 503 on everything. This is the
    // moment to say so, with the person standing right here.
    const chosen = await stat(options.vault).catch(() => null)
    if (chosen && !chosen.isDirectory()) {
      throw new Error(`${options.vault} is not a folder, so it cannot hold an account's notes.`)
    }
    const password = options.password ?? (await askPassword(`  Password for ${options.addAccount}: `))
    const again = options.password ?? (await askPassword('  Again: '))
    if (password !== again) throw new Error('Those did not match.')
    const account = await addAccount({ file: accountsFile, email: options.addAccount, password, vault: options.vault })
    process.stdout.write(`\n  Made an account for ${account.email}\n    notes  ${account.vault}\n\n  Sign in from any device with that email and password.\n\n`)
    return true
  }

  if (options.setPassword) {
    const password = options.password ?? (await askPassword(`  New password for ${options.setPassword}: `))
    const again = options.password ?? (await askPassword('  Again: '))
    if (password !== again) throw new Error('Those did not match.')
    await setPassword({ file: accountsFile, email: options.setPassword, password })
    process.stdout.write(`\n  Changed the password for ${options.setPassword}.\n  Every device that was signed in has been signed out.\n\n`)
    return true
  }

  return false
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    process.exit(1)
    return
  }
  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  const accountsFile = options.accounts ?? ACCOUNTS_FILE
  try {
    if (await runAccountCommand(options, accountsFile)) return
  } catch (error) {
    process.stderr.write(`\n  ${error.message}\n\n`)
    process.exit(1)
    return
  }

  const stored = options.token ? { token: options.token, created: false, file: '(passed on the command line)' } : await loadOrCreateToken()
  const server = createSyncServer({ vault: options.vault, token: stored.token, accountsFile })
  await server.store.ensureRoot()

  const controller = new AbortController()
  void server.startWatching(controller.signal)

  const listener =
    options.tlsCert && options.tlsKey
      ? createHttpsServer(
          { cert: await readFile(options.tlsCert), key: await readFile(options.tlsKey) },
          (request, response) => void server.handle(request, response),
        )
      : createHttpServer((request, response) => void server.handle(request, response))

  listener.listen(options.port, options.host, () => {
    const scheme = options.tlsCert ? 'https' : 'http'
    // Never `options.port`: with `--port 0` the operating system chose one, and
    // the number the caller asked for is not the number anyone can connect to.
    const address = listener.address()
    const port = typeof address === 'object' && address ? address.port : options.port

    // One line of JSON, before the banner, for a program that launched this
    // server and needs to know where it ended up. Printed only when asked, so
    // the token never appears in a log nobody meant to hold one.
    if (options.printReady) {
      process.stdout.write(
        `${JSON.stringify({
          spacelink: 'ready',
          url: `${scheme}://127.0.0.1:${port}/`,
          port,
          token: stored.token,
          vault: server.store.root,
        })}\n`,
      )
    }

    const lines = [
      '',
      '  SpaceLink sync server',
      `  vault    ${server.store.root}`,
      `  token    ${stored.file}`,
      '',
      `  this Mac       ${scheme}://localhost:${port}/`,
    ]
    if (options.host === '0.0.0.0' || options.host === '::') {
      for (const networkAddress of localAddresses()) {
        lines.push(`  same network   ${scheme}://${networkAddress}:${port}/`)
      }
    } else {
      lines.push('  (bound to loopback — pass --host 0.0.0.0 to reach it from other devices)')
    }
    lines.push('', '  Connect a device: open the address above, choose "Connect to a server",', '  and paste this token:', '', `    ${stored.token}`, '')
    if (stored.created) lines.push('  (a new token was generated and saved; it will be reused next time)', '')
    lines.push('  Reaching it from outside your network: see docs/SERVER.md', '')
    process.stdout.write(`${lines.join('\n')}\n`)
  })

  const shutdown = () => {
    controller.abort()
    listener.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // A server started by another program outlives it if that program crashes,
  // and then sits on a port and a file watcher with nobody to stop it. So when
  // we were launched by one — which `--print-ready` says — the parent's end of
  // stdin becomes the leash: the moment it closes, we go too.
  if (options.printReady) {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
    process.stdin.resume()
  }
}

// Run as a program, not when imported by a test. Compared as paths: a file URL
// percent-encodes a space or a non-ASCII letter (`My%20Apps`) while argv[1] is
// the raw path, so building a URL by hand matched only paths that happened to
// contain nothing worth encoding — and inside an app bundle under such a path
// the server loaded, did nothing, and exited without a word.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
