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
import { dirName, extensionOf, joinPath, normalizePath, stemOf } from './paths'

export interface RemoteVaultOptions {
  /** Base address of the sync server, e.g. `https://notes.example.ts.net`. */
  url: string
  token: string
  /** Overrides the name the server reports. */
  name?: string
}

/** What the server returns for one file. */
interface RemoteFile {
  path: string
  size: number
  mtime: number
  hash: string
  isMarkdown: boolean
}

const DEVICE_KEY = 'spacefore.device'
/** How long to wait before reconnecting a dropped change stream. */
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000

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

/** Check an address and token before committing to them. */
export async function probeServer(
  url: string,
  token: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  let origin: string
  try {
    origin = normalizeServerUrl(url)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  let health: Response
  try {
    health = await fetch(`${origin}/api/health`)
  } catch {
    return { ok: false, error: `Could not reach ${origin}. Is the server running, and is this device allowed to see it?` }
  }
  if (!health.ok) return { ok: false, error: `${origin} answered ${health.status}. That does not look like a SpaceFore server.` }
  const service = (await health.json().catch(() => null)) as { service?: string } | null
  if (service?.service !== 'spacefore') {
    return { ok: false, error: `Something is running at ${origin}, but it is not a SpaceFore server.` }
  }

  const vault = await fetch(`${origin}/api/vault`, { headers: { authorization: `Bearer ${token}` } })
  if (vault.status === 401) return { ok: false, error: 'That token was not accepted. Copy it again from the server window.' }
  if (!vault.ok) return { ok: false, error: `The server answered ${vault.status}.` }
  const info = (await vault.json().catch(() => null)) as { name?: string } | null
  return { ok: true, name: info?.name ?? 'Sync server' }
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
    'x-spacefore-client': device,
    ...extra,
  })

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await fetch(`${origin}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } })
    } catch {
      throw new Error(`Could not reach ${origin}. Your notes are safe; the change will be saved when it is back.`)
    }
    if (response.status === 401) throw new Error('The server rejected this device’s token. Connect to it again.')
    return response
  }

  const probe = await probeServer(origin, token)
  if (!probe.ok) throw new Error(probe.error)

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
      reconnectTimer = setTimeout(connect, reconnectDelay)
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
      return body.files.map((file) => {
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
      if (!response.ok && response.status !== 404) throw new Error(`Could not delete "${target}" (${response.status}).`)
      hashes.delete(target)
    },

    async rename(from: NotePath, to: NotePath): Promise<void> {
      const source = normalizePath(from)
      const target = normalizePath(to)
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
      if (!stream) connect()
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
