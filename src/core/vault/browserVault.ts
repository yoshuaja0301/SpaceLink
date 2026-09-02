/**
 * IndexedDB-backed vault: the "just start typing" storage that survives a
 * reload without asking the user for filesystem permission.
 *
 * Every file is one record in the `files` store, keyed by its normalised path.
 * Reads and writes go through a small in-memory cache that is filled once (on
 * the first operation, which in practice is `list()`), so rendering a note does
 * not hit IndexedDB again.
 *
 * When IndexedDB is missing — jsdom, private modes, blocked storage — the
 * factory transparently hands back an in-memory vault reporting
 * `kind: 'browser'`, so the rest of the app keeps working and simply does not
 * persist.
 */
import type { NotePath, VaultAdapter, VaultFile } from '../../types'
import { FILES_STORE, idbAvailable, idbDelete, idbGet, idbGetAll, idbSet, openDB } from './idb'
import { createMemoryVault } from './memoryVault'
import { comparePaths, mimeTypeOf, normalizePath, toVaultFile } from './paths'

/** Default vault (and IndexedDB database) name. */
const DEFAULT_VAULT_NAME = 'SpaceFore'

const encoder = new TextEncoder()

/** Shape of one record in the `files` store. */
interface StoredFile {
  path: NotePath
  content: string
  mtime: number
  binary?: Blob
}

/** Memory vault wearing the browser vault's identity, used when IDB is out. */
function memoryFallback(name: string): VaultAdapter {
  // The memory adapter's methods are closures, not `this`-dependent, so
  // re-labelling it by spreading is safe.
  return { ...createMemoryVault({}, { name }), kind: 'browser' }
}

export async function createBrowserVault(name: string = DEFAULT_VAULT_NAME): Promise<VaultAdapter> {
  if (!idbAvailable()) return memoryFallback(name)

  let db: IDBDatabase
  try {
    db = await openDB(name)
  } catch {
    // Storage denied or blocked by another tab: stay usable rather than dying.
    return memoryFallback(name)
  }

  const cache = new Map<NotePath, StoredFile>()
  let loading: Promise<void> | null = null

  /** Fill the cache from IndexedDB exactly once. */
  function ensureLoaded(): Promise<void> {
    if (!loading) {
      loading = idbGetAll<StoredFile>(db, FILES_STORE)
        .then((records) => {
          for (const record of records) {
            if (record && typeof record.path === 'string') cache.set(record.path, record)
          }
        })
        .catch((error: unknown) => {
          // Allow a later call to retry instead of caching the failure forever.
          loading = null
          throw error
        })
    }
    return loading
  }

  /**
   * The record at `normalized`: from the cache, or failing that from the
   * database itself. Another tab or window of the app shares the database but
   * not this cache, and a note it created is in IndexedDB and nowhere else —
   * "not in the cache" is not "does not exist", and createNote writing over a
   * note the other tab just made is what that difference costs.
   */
  async function lookup(normalized: NotePath): Promise<StoredFile | undefined> {
    await ensureLoaded()
    const cached = cache.get(normalized)
    if (cached) return cached
    const stored = await idbGet<StoredFile>(db, FILES_STORE, normalized).catch(() => undefined)
    if (stored && typeof stored.path === 'string') cache.set(normalized, stored)
    return stored
  }

  async function mustGet(path: NotePath): Promise<{ path: NotePath; record: StoredFile }> {
    const normalized = normalizePath(path)
    const record = await lookup(normalized)
    if (!record) throw new Error(`File not found: ${normalized}`)
    return { path: normalized, record }
  }

  function sizeOf(record: StoredFile): number {
    return record.binary ? record.binary.size : encoder.encode(record.content).length
  }

  /** Write through to IndexedDB first, then update the cache. */
  async function put(record: StoredFile): Promise<void> {
    await idbSet(db, FILES_STORE, record.path, record)
    cache.set(record.path, record)
  }

  return {
    kind: 'browser',
    name,
    writable: true,

    async list(): Promise<VaultFile[]> {
      await ensureLoaded()
      const out: VaultFile[] = []
      for (const record of cache.values()) out.push(toVaultFile(record.path, sizeOf(record), record.mtime))
      return out.sort((a, b) => comparePaths(a.path, b.path))
    },

    async read(path: NotePath): Promise<string> {
      const { record } = await mustGet(path)
      return record.binary ? await record.binary.text() : record.content
    },

    async readBinary(path: NotePath): Promise<Blob> {
      const { path: normalized, record } = await mustGet(path)
      return record.binary ?? new Blob([record.content], { type: mimeTypeOf(normalized) })
    },

    async write(path: NotePath, content: string): Promise<void> {
      const normalized = normalizePath(path)
      await ensureLoaded()
      // Folders are implied by the key, so intermediate folders need no creating.
      await put({ path: normalized, content, mtime: Date.now() })
    },

    async writeBinary(path: NotePath, data: Blob): Promise<void> {
      const normalized = normalizePath(path)
      await ensureLoaded()
      await put({ path: normalized, content: '', mtime: Date.now(), binary: data })
    },

    async remove(path: NotePath): Promise<void> {
      const { path: normalized } = await mustGet(path)
      await idbDelete(db, FILES_STORE, normalized)
      cache.delete(normalized)
    },

    async rename(from: NotePath, to: NotePath): Promise<void> {
      const { path: source, record } = await mustGet(from)
      const target = normalizePath(to)
      if (target === source) return
      if (await lookup(target)) throw new Error(`Cannot rename to ${target}: that file already exists.`)
      // Write the new key before dropping the old one, so an interrupted rename
      // duplicates a file rather than losing it.
      await put({ ...record, path: target, mtime: Date.now() })
      await idbDelete(db, FILES_STORE, source)
      cache.delete(source)
    },

    async exists(path: NotePath): Promise<boolean> {
      try {
        return (await lookup(normalizePath(path))) !== undefined
      } catch {
        return false
      }
    },
  }
}

/** True when this browser already holds a persisted vault with at least one file. */
export async function hasStoredVault(name: string = DEFAULT_VAULT_NAME): Promise<boolean> {
  if (!idbAvailable()) return false
  let db: IDBDatabase | null = null
  try {
    db = await openDB(name)
    const records = await idbGetAll<StoredFile>(db, FILES_STORE)
    return records.length > 0
  } catch {
    return false
  } finally {
    db?.close()
  }
}

/**
 * Write `files` into `adapter`, skipping any path that already exists — seeding
 * must never clobber something the user has edited.
 */
export async function seedVault(adapter: VaultAdapter, files: Record<NotePath, string>): Promise<void> {
  if (!adapter.writable) throw new Error(`The "${adapter.name}" vault is read-only and cannot be seeded.`)
  // Sequential on purpose: writes are ordered, and mtimes stay predictable.
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalizePath(rawPath)
    if (await adapter.exists(path)) continue
    await adapter.write(path, content)
  }
}
