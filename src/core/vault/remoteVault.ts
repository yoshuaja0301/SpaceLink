/**
 * A vault held by the sync server, so every device sees the same notes.
 *
 * The server owns the folder on disk; this adapter is a thin, careful client.
 * Two things make it more than a fetch wrapper:
 *
 *  - **Conditional writes.** Every save carries the hash the device believed it
 *    was editing. If the note changed elsewhere in the meantime the server
 *    refuses, and this adapter saves the device's version alongside as a
 *    conflict copy rather than overwriting anybody. Nothing is ever lost, and
 *    no save loops.
 *  - **Live changes.** `watch` streams the server's change feed, so a note
 *    edited on a phone appears on the laptop without a refresh. Events caused
 *    by this device are dropped — a device does not need telling about its own
 *    save.
 */
import type { NotePath, VaultAdapter, VaultChange, VaultFile } from '../../types'
import { comparePaths, dirName, extensionOf, joinPath, normalizePath, stemOf } from './paths'

export interface RemoteVaultOptions {
  /** Base address of the sync server, e.g. `https://notes.example.ts.net`. */
  url: string
  token: string
  /** Overrides the name the server reports. */
  name?: string
  /** Set when `token` came from signing in, so a refusal can say the right thing. */
  email?: string
}

/** What the server returns for one file. */
interface RemoteFile {
  path: string
  size: number
  mtime: number
  hash: string
  isMarkdown: boolean
}

const DEVICE_KEY = 'spacelink.device'
/** How long to wait before reconnecting a dropped change stream. */
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000

/**
 * How long a pairing call — the probe, signing in, signing out — waits for a
 * server before giving up on it.
 *
 * A fetch to an address nothing is listening at does not fail quickly; it
 * hangs until the connection times out, which on some stacks is minutes.
 * Measured: with a server that never answers, the probe and the sign-in were
 * both still pending after fifteen seconds, and the picker's Connect button
 * sat on "Opening…" for all of it. Ten seconds is longer than any server that
 * is actually there takes to say hello, and short enough that a mistyped
 * address is an error rather than a wait. Saving a note is not bounded by
 * this: a large note over a slow link is meant to take as long as it takes.
 */
const REACH_MS = 10_000

/** A signal that gives up after `REACH_MS`, where the runtime can make one. */
function withinReach(): { signal?: AbortSignal } {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  return typeof timeout === 'function' ? { signal: timeout.call(AbortSignal, REACH_MS) } : {}
}

/**
 * How many notes `readAll` hands over at a time. Large enough that the yield
 * itself is not the cost, small enough that the caller can paint between
 * batches instead of freezing until the last note lands.
 */
const READ_ALL_BATCH = 250

/**
 * A stable id for this browser, so the server can tag events with the device
 * that caused them and this one can ignore its own.
 */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY)
    if (stored) return stored
    const created = globalThis.crypto?.randomUUID?.() ?? `device-${Math.floor(Date.now()).toString(36)}`
    localStorage.setItem(DEVICE_KEY, created)
    return created
  } catch {
    // Private mode: a per-session id still stops self-echo within this tab.
    return `device-${Math.floor(Date.now()).toString(36)}`
  }
}

/** Trim a server address to its origin, tolerating what a person would type. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter the address of your server.')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`"${input}" is not a valid address.`)
  }
  return `${parsed.protocol}//${parsed.host}`
}

/** Which of the two credentials a call is carrying. */
export type Credential = 'token' | 'account'

/**
 * What to say when the server refuses a credential.
 *
 * The two are not interchangeable, and neither is the advice: a token was
 * rotated — the server prints a new one every launch — and has to be copied
 * again, while a sign-in expired or was signed out from another device and
 * needs the password. Telling someone to copy a token they never had is how a
 * working app feels broken.
 */
function refused(credential: Credential): string {
  return credential === 'account'
    ? 'That sign-in is no longer valid. Sign in again.'
    : 'That token was not accepted. Copy it again from the server window.'
}

/** Check an address and token before committing to them. */
export async function probeServer(
  url: string,
  token: string,
  credential: Credential = 'token',
): Promise<{ ok: true; name: string } | { ok: false; error: string; refused?: true }> {
  let origin: string
  try {
    origin = normalizeServerUrl(url)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  let health: Response
  try {
    health = await fetch(`${origin}/api/health`, withinReach())
  } catch {
    return { ok: false, error: `Could not reach ${origin}. Is the server running, and is this device allowed to see it?` }
  }
  if (!health.ok) return { ok: false, error: `${origin} answered ${health.status}. That does not look like a SpaceLink server.` }
  const service = (await health.json().catch(() => null)) as { service?: string } | null
  if (service?.service !== 'spacelink') {
    return { ok: false, error: `Something is running at ${origin}, but it is not a SpaceLink server.` }
  }

  const vault = await fetch(`${origin}/api/vault`, { headers: { authorization: `Bearer ${token}` }, ...withinReach() })
  if (vault.status === 401) return { ok: false, error: refused(credential), refused: true }
  const info = (await vault.json().catch(() => null)) as { name?: string; error?: string } | null
  // The server's own words when it has any: "the folder this vault lives in is
  // not there" tells the reader what to do about it, and a bare status code
  // does not.
  if (!vault.ok) return { ok: false, error: info?.error ?? `The server answered ${vault.status}.` }
  return { ok: true, name: info?.name ?? 'Sync server' }
}

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

/**
 * Roughly what this device is, for the account's own list of devices.
 *
 * Deliberately coarse. The point is that "an iPhone" and "a Mac" are
 * distinguishable in `--list-accounts` when someone is deciding which device to
 * sign out; nothing here identifies the device more precisely than the request
 * carrying it already does.
 */
export function describeDevice(agent = typeof navigator === 'object' ? navigator.userAgent : ''): string {
  if (/iPhone|iPad|iPod/.test(agent)) return 'an iPhone or iPad'
  if (/Android/.test(agent)) return 'an Android device'
  if (/Macintosh|Mac OS X/.test(agent)) return 'a Mac'
  if (/Windows/.test(agent)) return 'a Windows PC'
  if (/Linux|X11/.test(agent)) return 'a Linux machine'
  return 'a browser'
}

/**
 * Sign in to a server that has accounts, and come back with this device's own
 * session token.
 *
 * The password is sent once, over this one request, and is never stored: what
 * the device keeps afterwards is the session, which the account's owner can
 * end from any other device without changing the password.
 */
export async function signIn(
  url: string,
  email: string,
  password: string,
): Promise<{ ok: true; token: string; email: string; name: string } | { ok: false; error: string }> {
  let origin: string
  try {
    origin = normalizeServerUrl(url)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  let response: Response
  try {
    response = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-spacelink-device': describeDevice() },
      body: JSON.stringify({ email: email.trim(), password }),
      ...withinReach(),
    })
  } catch {
    return { ok: false, error: `Could not reach ${origin}. Is the server running, and is this device allowed to see it?` }
  }

  if (response.status === 404) {
    // Not a missing page: this server was started without an accounts file, so
    // there is no account to sign in to and the token is the way in.
    return { ok: false, error: 'This server does not use accounts. Paste its access token instead.' }
  }
  const body = (await response.json().catch(() => null)) as
    | { token?: string; email?: string; vault?: string; error?: string }
    | null
  if (!response.ok) {
    return { ok: false, error: body?.error ?? `The server answered ${response.status}.` }
  }
  if (typeof body?.token !== 'string' || body.token === '') {
    return { ok: false, error: 'The server accepted the password but sent nothing to sign in with.' }
  }
  return { ok: true, token: body.token, email: body.email ?? email.trim(), name: body.vault ?? 'Sync server' }
}

/**
 * End this device's session, best effort.
 *
 * Best effort on purpose: the device is being disconnected either way, and a
 * server that cannot be reached must not be able to keep someone signed in to
 * a vault they are trying to leave.
 */
export async function signOut(url: string, token: string): Promise<void> {
  try {
    await fetch(`${normalizeServerUrl(url)}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      ...withinReach(),
    })
  } catch {
    /* the token is being forgotten locally regardless */
  }
}

/**
 * Sign in and open the vault, as one step.
 *
 * They have to be one step because the first half has a side effect on the
 * server: a session that lasts thirty days, whether or not the second half
 * works. When opening the vault fails — most often an account pointed at a
 * folder that is not there, which answers 503 — the device throws its token
 * away and walks off, and the server is left holding a signed-in device that
 * nobody has. Measured: three attempts left three "a Mac" entries in
 * `--list-accounts`, the one command whose job is to say who is signed in,
 * and the owner's only way to clear them was changing the password.
 *
 * So a failed open ends the session it was just given. Best effort, like every
 * other sign-out: a server that cannot be reached is not a reason to keep the
 * reader waiting, and the session expires on its own.
 *
 * Both halves fail by throwing, which is what the caller already did with
 * either one.
 */
export async function openWithAccount(
  url: string,
  email: string,
  password: string,
): Promise<{ adapter: VaultAdapter; token: string; email: string }> {
  const session = await signIn(url, email, password)
  if (!session.ok) throw new Error(session.error)
  try {
    const adapter = await createRemoteVault({ url, token: session.token, email: session.email })
    return { adapter, token: session.token, email: session.email }
  } catch (error) {
    await signOut(url, session.token)
    throw error
  }
}

/**
 * Thrown when the server refused the credential — not a server that is away.
 *
 * The two are told apart because the advice is opposite. A server that is
 * asleep or off the network comes back, and the pairing works again the moment
 * it does; a session that was revoked — signed out from elsewhere, or its
 * account's password changed — never will, however many times the reader
 * reloads. Both used to arrive as a plain `Error`, so a device signed out by
 * `--set-password` was told its server could not be reached and to reload once
 * it was back, while the server was up the whole time.
 */
export class RemoteRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteRefused'
  }
}

/** Thrown when a save was refused because the note changed on another device. */
export class RemoteConflict extends Error {
  readonly conflictPath: NotePath
  constructor(path: NotePath, conflictPath: NotePath) {
    super(
      `"${stemOf(path)}" was edited on another device. Your version was kept as "${stemOf(conflictPath)}".`,
    )
    this.name = 'RemoteConflict'
    this.conflictPath = conflictPath
  }
}

/** `Note (conflict from this device, 2026-08-30 14-05).md` */
function conflictPathFor(path: NotePath, when: Date): NotePath {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    ` ${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  const folder = dirName(path)
  const extension = extensionOf(path)
  // `stemOf`, not `baseName`: the latter keeps the extension, which would name
  // the copy "Home.md (conflict …).md".
  const suffix = ` (conflict ${stamp})${extension ? `.${extension}` : ''}`
  // A file name has a limit — 255 bytes on every common file system — and a
  // note named near it has no room for the suffix. The copy is the only place
  // this device's text goes, so the stem gives way rather than the copy.
  return joinPath(folder, `${fitStem(stemOf(path), MAX_FILE_NAME_BYTES - utf8Length(suffix))}${suffix}`)
}

const MAX_FILE_NAME_BYTES = 255
const utf8Length = (text: string): number => new TextEncoder().encode(text).length

/** `stem` cut to at most `bytes` of UTF-8, at a character boundary. */
function fitStem(stem: string, bytes: number): string {
  let out = stem
  while (out.length > 0 && utf8Length(out) > bytes) out = out.slice(0, -1)
  return out
}

export async function createRemoteVault(options: RemoteVaultOptions): Promise<VaultAdapter> {
  const origin = normalizeServerUrl(options.url)
  const token = options.token
  const device = deviceId()

  /** Hash of what this device last saw for each path, for conditional writes. */
  const hashes = new Map<NotePath, string>()

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    'x-spacelink-client': device,
    ...extra,
  })

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${origin}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } })
    } catch {
      throw new Error(`Could not reach ${origin}. Your notes are safe; the change will be saved when it is back.`)
    }
    if (response.status === 401) throw new RemoteRefused(refused(options.email ? 'account' : 'token'))
    return response
  }

  const probe = await probeServer(origin, token, options.email ? 'account' : 'token')
  if (!probe.ok) throw probe.refused ? new RemoteRefused(probe.error) : new Error(probe.error)

  /* ---- change stream ------------------------------------------------ */

  const listeners = new Set<(change: VaultChange) => void>()
  let stream: EventSource | null = null
  let reconnectDelay = RECONNECT_MIN_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function emit(change: VaultChange): void {
    for (const listener of listeners) listener(change)
  }

  function connect(): void {
    if (typeof EventSource !== 'function' || listeners.size === 0) return
    // Already connected, or already on the way back. Without this, a watcher
    // added between an error and the reconnect it scheduled opened a second
    // stream, and the pending reconnect then opened a third — leaving two live
    // connections announcing every change twice, and one of them held by
    // nothing: `stream` points at the newest, so disposing every watcher
    // closed one and left the other open for the life of the page, still
    // counted by the server as a device to write to.
    if (stream || reconnectTimer !== null) return
    // EventSource cannot carry an Authorization header, so the token rides in
    // the query string. It never leaves the connection to this server, and the
    // server treats both places the same.
    stream = new EventSource(`${origin}/api/events?token=${encodeURIComponent(token)}`)
    stream.onopen = () => {
      reconnectDelay = RECONNECT_MIN_MS
    }
    stream.onmessage = (event: MessageEvent<string>) => {
      let change: (VaultChange & { origin?: string; hash?: string }) | null = null
      try {
        change = JSON.parse(event.data)
      } catch {
        return
      }
      if (!change || change.origin === device) return // our own save
      if (change.type === 'upsert' && change.path && change.hash) hashes.set(change.path, change.hash)
      if (change.type === 'remove' && change.path) hashes.delete(change.path)
      // A rename done elsewhere: the bytes, and so the hash, travel with the
      // file. Left filed under the old name, the next save of the new one
      // would carry no If-Match and write over whatever that device did next.
      if (change.type === 'rename' && change.from && change.to) {
        const moved = hashes.get(change.from)
        hashes.delete(change.from)
        if (moved !== undefined) hashes.set(change.to, moved)
      }
      emit({ type: change.type, path: change.path, from: change.from, to: change.to })
    }
    stream.onerror = () => {
      stream?.close()
      stream = null
      if (listeners.size === 0) return
      // Back off, so a server that is down does not turn into a reconnect storm.
      reconnectTimer = setTimeout(() => {
        // Cleared before connecting, not after: it is what marks "on the way
        // back", and connect() refuses to run while it is set.
        reconnectTimer = null
        connect()
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    }
  }

  /* ---- the adapter --------------------------------------------------- */

  const adapter: VaultAdapter = {
    kind: 'remote',
    name: options.name ?? probe.name,
    writable: true,

    async list(): Promise<VaultFile[]> {
      const response = await request('/api/files')
      if (!response.ok) throw new Error(`The server could not list the vault (${response.status}).`)
      const body = (await response.json()) as { files: RemoteFile[] }
      hashes.clear()
      return body.files
        .map((file) => {
          const path = normalizePath(file.path)
          hashes.set(path, file.hash)
          return {
            path,
            name: file.isMarkdown ? stemOf(path) : path.slice(path.lastIndexOf('/') + 1),
            extension: extensionOf(path),
            isMarkdown: file.isMarkdown,
            size: file.size,
            mtime: file.mtime,
          }
        })
        // The order every other adapter lists in, not the server's.
        .sort((a, b) => comparePaths(a.path, b.path))
    },

    /**
     * The whole vault in one response, decoded as it arrives.
     *
     * The alternative — a request per note — is what made opening a five
     * thousand note vault take minutes rather than seconds: a browser holds
     * six connections open to an origin, so the reads queue six deep. This is
     * one connection, and the notes are handed over in batches so the caller
     * can show progress instead of a frozen splash.
     */
    async *readAll(): AsyncGenerator<ReadonlyMap<NotePath, string>> {
      const response = await request('/api/bundle')
      if (!response.ok || !response.body) {
        throw new Error(`The server could not send the vault (${response.status}).`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let batch = new Map<NotePath, string>()

      /** One NDJSON line. Unparseable lines are skipped rather than failing the load. */
      const take = (line: string): void => {
        if (!line) return
        let record: { type?: string; path?: string; text?: string; hash?: string }
        try {
          record = JSON.parse(line) as typeof record
        } catch {
          return
        }
        if (record.type !== 'note' || typeof record.path !== 'string' || typeof record.text !== 'string') return
        const path = normalizePath(record.path)
        if (record.hash) hashes.set(path, record.hash)
        batch.set(path, record.text)
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          take(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
          newline = pending.indexOf('\n')
        }
        if (batch.size >= READ_ALL_BATCH) {
          yield batch
          batch = new Map()
        }
      }
      take(pending + decoder.decode())
      if (batch.size > 0) yield batch
    },

    async read(path: NotePath): Promise<string> {
      const target = normalizePath(path)
      const response = await request(`/api/file?path=${encodeURIComponent(target)}`)
      if (response.status === 404) throw new Error(`"${target}" is not in the vault.`)
      if (!response.ok) throw new Error(`Could not read "${target}" (${response.status}).`)
      const text = await response.text()
      const etag = response.headers.get('etag')
      if (etag) hashes.set(target, etag.replace(/^"|"$/g, ''))
      return text
    },

    async readBinary(path: NotePath): Promise<Blob> {
      const target = normalizePath(path)
      const response = await request(`/api/file?path=${encodeURIComponent(target)}`)
      if (!response.ok) throw new Error(`Could not read "${target}" (${response.status}).`)
      return response.blob()
    },

    async write(path: NotePath, content: string): Promise<void> {
      const target = normalizePath(path)
      const known = hashes.get(target)
      const response = await request(`/api/file?path=${encodeURIComponent(target)}`, {
        method: 'PUT',
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          ...(known === undefined ? {} : { 'if-match': `"${known}"` }),
        },
        body: content,
      })

      if (response.status === 409) {
        // Somebody else got there first. Keep this device's version beside the
        // server's rather than choosing a winner, and let the change feed bring
        // the server's version down.
        const body = (await response.json().catch(() => ({}))) as { currentHash?: string }
        const conflictPath = conflictPathFor(target, new Date())
        const copy = await request(`/api/file?path=${encodeURIComponent(conflictPath)}`, {
          method: 'PUT',
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
          body: content,
        })
        if (!copy.ok) {
          // RemoteConflict means "your version was kept". When the copy could
          // not be written — a name too long, a full disk — that promise would
          // have the store clear the note's unsaved flag and load the server's
          // text over the only copy of this one. An ordinary failure keeps the
          // note marked, and the hash is left as it was so the next save is
          // refused again rather than writing over the other device's text.
          throw new Error(
            `Could not save "${target}": it changed on another device, and a copy of this version could not be written (${copy.status}).`,
          )
        }
        if (body.currentHash) hashes.set(target, body.currentHash)
        // Only the new copy is announced. Reloading the original is the store's
        // job, in the same step that clears the note's unsaved flag — announcing
        // it here would race that flag and leave the note dirty forever, saving
        // a fresh conflict copy on every retry.
        emit({ type: 'upsert', path: conflictPath })
        throw new RemoteConflict(target, conflictPath)
      }

      if (!response.ok) throw new Error(`Could not save "${target}" (${response.status}).`)
      const saved = (await response.json().catch(() => ({}))) as { hash?: string }
      if (saved.hash) hashes.set(target, saved.hash)
    },

    async writeBinary(path: NotePath, data: Blob): Promise<void> {
      const target = normalizePath(path)
      const response = await request(`/api/file?path=${encodeURIComponent(target)}`, {
        method: 'PUT',
        headers: { 'content-type': data.type || 'application/octet-stream' },
        body: data,
      })
      if (!response.ok) throw new Error(`Could not save "${target}" (${response.status}).`)
    },

    async remove(path: NotePath): Promise<void> {
      const target = normalizePath(path)
      const response = await request(`/api/file?path=${encodeURIComponent(target)}`, { method: 'DELETE' })
      // What every other adapter says for a file that is not there.
      if (response.status === 404) throw new Error(`File not found: ${target}`)
      if (!response.ok) throw new Error(`Could not delete "${target}" (${response.status}).`)
      hashes.delete(target)
    },

    async rename(from: NotePath, to: NotePath): Promise<void> {
      const source = normalizePath(from)
      const target = normalizePath(to)
      if (source === target) return // `./Home.md` is Home.md; nothing to do, as in every other adapter
      const response = await request('/api/rename', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: source, to: target }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Could not rename "${source}" (${response.status}).`)
      }
      const known = hashes.get(source)
      hashes.delete(source)
      if (known !== undefined) hashes.set(target, known)
    },

    async exists(path: NotePath): Promise<boolean> {
      // Asked of the listing, not of the file: fetching a file that is not
      // there is a 404 the browser logs as an error on the console, and the
      // usual reason to ask is exactly that it may not be there. The listing
      // is small and never 404s.
      try {
        const target = normalizePath(path)
        const response = await request('/api/files')
        if (!response.ok) return false
        const body = (await response.json()) as { files: RemoteFile[] }
        return body.files.some((file) => normalizePath(file.path) === target)
      } catch {
        return false
      }
    },

    watch(listener: (change: VaultChange) => void): () => void {
      listeners.add(listener)
      // connect() decides: it is a no-op when a stream is open or on its way.
      connect()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          if (reconnectTimer !== null) clearTimeout(reconnectTimer)
          reconnectTimer = null
          stream?.close()
          stream = null
        }
      }
    },
  }

  return adapter
}
