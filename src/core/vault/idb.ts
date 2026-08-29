/**
 * A very small promise wrapper over IndexedDB.
 *
 * The database has two object stores, both with out-of-line keys:
 *
 * - `files` — one record per vault file, keyed by its normalised path.
 * - `meta`  — small odds and ends (the remembered directory handle, …).
 *
 * Two rules keep this safe: every request is wrapped into a promise that
 * settles from that request's own `onsuccess`/`onerror`, and a transaction is
 * always created *inside* the promise executor and consumed before the promise
 * resolves — no transaction is ever left dangling across an `await`, which is
 * what silently auto-closes transactions in real browsers.
 */

/** Default database name; `openDB()` accepts an override so vaults can be namespaced. */
export const DEFAULT_DB_NAME = 'spacefore'
/** Object store holding one record per file, keyed by path. */
export const FILES_STORE = 'files'
/** Object store holding small pieces of app metadata. */
export const META_STORE = 'meta'

const DB_VERSION = 1
const STORES = [FILES_STORE, META_STORE] as const

/** `globalThis.indexedDB` if this environment has it (jsdom and some private modes do not). */
function getFactory(): IDBFactory | undefined {
  try {
    const factory: IDBFactory | undefined = globalThis.indexedDB
    if (!factory || typeof factory.open !== 'function') return undefined
    return factory
  } catch {
    // Accessing `indexedDB` can itself throw in a sandboxed / blocked context.
    return undefined
  }
}

/** Feature detection — callers fall back to in-memory storage when this is false. */
export function idbAvailable(): boolean {
  return getFactory() !== undefined
}

/** Turn a single IDBRequest into a promise that rejects with the request's error. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(toError(request.error, 'The IndexedDB request failed.'))
  })
}

/** IndexedDB reports `DOMException`s; normalise anything into a throwable Error. */
function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  const message = (error as { message?: unknown } | null)?.message
  return new Error(typeof message === 'string' && message !== '' ? message : fallback)
}

/**
 * Open (and, on first use, create) the SpaceFore database.
 * Rejects with a readable error when IndexedDB is unavailable or blocked.
 */
export function openDB(name: string = DEFAULT_DB_NAME): Promise<IDBDatabase> {
  const factory = getFactory()
  if (!factory) {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'))
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrading the schema must not be blocked by this connection.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(toError(request.error, `Could not open the "${name}" database.`))
    request.onblocked = () =>
      reject(new Error(`The "${name}" database is blocked by another open tab. Close it and try again.`))
  })
}

/** Read one value. Resolves `undefined` when the key is absent. */
export function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    // `db.transaction` throws synchronously for an unknown store; the executor
    // turns that into a rejection rather than an uncaught throw.
    const transaction = db.transaction(store, 'readonly')
    transaction.onerror = () => reject(toError(transaction.error, `Reading "${key}" from "${store}" failed.`))
    requestToPromise<T | undefined>(transaction.objectStore(store).get(key)).then(resolve, reject)
  })
}

/** Read every value in a store, in key order. */
export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const transaction = db.transaction(store, 'readonly')
    transaction.onerror = () => reject(toError(transaction.error, `Reading "${store}" failed.`))
    requestToPromise<T[]>(transaction.objectStore(store).getAll()).then(resolve, reject)
  })
}

/** Write one value, resolving only once the transaction has committed. */
export function idbSet(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return writeTransaction(db, store, `Writing "${key}" to "${store}" failed.`, (objectStore) =>
    objectStore.put(value, key),
  )
}

/** Delete one key. Deleting a missing key is not an error in IndexedDB. */
export function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return writeTransaction(db, store, `Deleting "${key}" from "${store}" failed.`, (objectStore) =>
    objectStore.delete(key),
  )
}

/** Remove every record from a store. */
export function idbClear(db: IDBDatabase, store: string): Promise<void> {
  return writeTransaction(db, store, `Clearing "${store}" failed.`, (objectStore) => objectStore.clear())
}

/**
 * Run a mutating request and resolve on `oncomplete`, so callers can rely on
 * the data actually being durable once the promise settles.
 */
function writeTransaction(
  db: IDBDatabase,
  store: string,
  failureMessage: string,
  run: (objectStore: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    let requestError: Error | null = null
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(requestError ?? toError(transaction.error, failureMessage))
    transaction.onerror = () => reject(requestError ?? toError(transaction.error, failureMessage))
    const request = run(transaction.objectStore(store))
    // Remember the precise request error; a transaction only reports that
    // *something* in it went wrong.
    request.onerror = () => {
      requestError = toError(request.error, failureMessage)
    }
  })
}
