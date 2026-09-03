import { afterEach, beforeEach } from 'vitest'

import {
  DEFAULT_DB_NAME,
  FILES_STORE,
  META_STORE,
  idbAvailable,
  idbClear,
  idbDelete,
  idbGet,
  idbGetAll,
  idbSet,
  openDB,
} from './idb'

/* ------------------------------------------------------------------ *
 * A minimal in-memory IndexedDB stand-in.
 *
 * jsdom ships no IndexedDB at all, so without a fake the persistent code
 * paths would go completely untested. It implements exactly the slice of the
 * API `idb.ts` uses: open/upgrade, readonly + readwrite transactions,
 * get/getAll/put/delete/clear and the success/error/complete/abort events.
 * (Kept local to the test file — the vault module owns no shared test helper.)
 * ------------------------------------------------------------------ */

type StoreData = Map<string, unknown>

interface FakeControls {
  /** database name -> store name -> key -> value */
  databases: Map<string, Map<string, StoreData>>
  /** Make the next store request (get/put/…) fail. */
  failNextRequest: (message: string) => void
  /** Make the next `open()` fail. */
  failNextOpen: (message: string) => void
  /** Make the next `open()` fire `onblocked`. */
  blockNextOpen: () => void
  restore: () => void
}

function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function installFakeIndexedDB(): FakeControls {
  const databases = new Map<string, Map<string, StoreData>>()
  const versions = new Map<string, number>()
  let nextRequestFailure: string | null = null
  let nextOpenFailure: string | null = null
  let nextOpenBlocked = false

  class FakeRequest {
    onsuccess: (() => void) | null = null
    onerror: (() => void) | null = null
    onupgradeneeded: (() => void) | null = null
    onblocked: (() => void) | null = null
    result: unknown = undefined
    error: Error | null = null
  }

  class FakeTransaction {
    oncomplete: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    error: Error | null = null
    private pending = 0
    private settled = false

    constructor(
      private readonly db: FakeDatabase,
      private readonly names: string[],
    ) {}

    objectStore(name: string): FakeObjectStore {
      if (!this.names.includes(name)) {
        throw namedError('NotFoundError', `"${name}" is not part of this transaction`)
      }
      const data = this.db.data.get(name)
      if (!data) throw namedError('NotFoundError', `No object store named "${name}"`)
      return new FakeObjectStore(this, data)
    }

    /** Queue a store operation the way IndexedDB does: asynchronously, per request. */
    run(exec: () => unknown): FakeRequest {
      const request = new FakeRequest()
      this.pending += 1
      queueMicrotask(() => {
        if (this.settled) return
        this.pending -= 1
        if (nextRequestFailure !== null) {
          const error = new Error(nextRequestFailure)
          nextRequestFailure = null
          request.error = error
          request.onerror?.()
          this.fail(error)
          return
        }
        request.result = exec()
        request.onsuccess?.()
        if (this.pending === 0) queueMicrotask(() => this.complete())
      })
      return request
    }

    private complete(): void {
      if (this.settled) return
      this.settled = true
      this.oncomplete?.()
    }

    private fail(error: Error): void {
      if (this.settled) return
      this.settled = true
      this.error = error
      this.onerror?.()
      this.onabort?.()
    }
  }

  class FakeObjectStore {
    constructor(
      private readonly transaction: FakeTransaction,
      private readonly data: StoreData,
    ) {}

    get(key: string): FakeRequest {
      return this.transaction.run(() => this.data.get(key))
    }

    getAll(): FakeRequest {
      // Real IndexedDB yields values in key order.
      return this.transaction.run(() => [...this.data.keys()].sort().map((key) => this.data.get(key)))
    }

    put(value: unknown, key: string): FakeRequest {
      return this.transaction.run(() => {
        this.data.set(key, value)
        return key
      })
    }

    delete(key: string): FakeRequest {
      return this.transaction.run(() => {
        this.data.delete(key)
        return undefined
      })
    }

    clear(): FakeRequest {
      return this.transaction.run(() => {
        this.data.clear()
        return undefined
      })
    }
  }

  class FakeDatabase {
    onversionchange: (() => void) | null = null
    private closed = false

    constructor(
      readonly name: string,
      readonly data: Map<string, StoreData>,
    ) {}

    get objectStoreNames(): { contains: (name: string) => boolean; length: number } {
      const names = [...this.data.keys()]
      return { contains: (name: string) => names.includes(name), length: names.length }
    }

    createObjectStore(name: string): { name: string } {
      if (!this.data.has(name)) this.data.set(name, new Map())
      return { name }
    }

    transaction(names: string | string[]): FakeTransaction {
      if (this.closed) throw namedError('InvalidStateError', 'The database connection is closing')
      const list = Array.isArray(names) ? names : [names]
      for (const name of list) {
        if (!this.data.has(name)) throw namedError('NotFoundError', `No object store named "${name}"`)
      }
      return new FakeTransaction(this, list)
    }

    close(): void {
      this.closed = true
    }
  }

  const factory = {
    open(name: string, version: number): FakeRequest {
      const request = new FakeRequest()
      queueMicrotask(() => {
        if (nextOpenFailure !== null) {
          request.error = new Error(nextOpenFailure)
          nextOpenFailure = null
          request.onerror?.()
          return
        }
        if (nextOpenBlocked) {
          nextOpenBlocked = false
          request.onblocked?.()
          return
        }
        let data = databases.get(name)
        if (!data) {
          data = new Map()
          databases.set(name, data)
        }
        request.result = new FakeDatabase(name, data)
        if ((versions.get(name) ?? 0) < version) {
          versions.set(name, version)
          request.onupgradeneeded?.()
        }
        request.onsuccess?.()
      })
      return request
    },
  }

  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true })

  return {
    databases,
    failNextRequest: (message: string) => {
      nextRequestFailure = message
    },
    failNextOpen: (message: string) => {
      nextOpenFailure = message
    },
    blockNextOpen: () => {
      nextOpenBlocked = true
    },
    restore: () => {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
    },
  }
}

/* ------------------------------------------------------------------ */

describe('idbAvailable', () => {
  it('is false in an environment without IndexedDB (jsdom)', () => {
    expect(idbAvailable()).toBe(false)
  })

  it('is true once a factory is present', () => {
    const fake = installFakeIndexedDB()
    try {
      expect(idbAvailable()).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('is false when the global exists but is not a factory', () => {
    Object.defineProperty(globalThis, 'indexedDB', { value: {}, configurable: true, writable: true })
    try {
      expect(idbAvailable()).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
    }
  })
})

describe('openDB without IndexedDB', () => {
  it('rejects with a message the UI can show', async () => {
    await expect(openDB()).rejects.toThrow(/IndexedDB is not available/)
  })
})

describe('idb wrapper', () => {
  let fake: FakeControls

  beforeEach(() => {
    fake = installFakeIndexedDB()
  })

  afterEach(() => {
    fake.restore()
  })

  it('creates the files and meta stores at version 1', async () => {
    const db = await openDB()
    expect(db.objectStoreNames.contains(FILES_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(META_STORE)).toBe(true)
    expect([...(fake.databases.get(DEFAULT_DB_NAME)?.keys() ?? [])].sort()).toEqual(['files', 'meta'])
  })

  it('uses the requested database name', async () => {
    await openDB('other-vault')
    expect(fake.databases.has('other-vault')).toBe(true)
    expect(fake.databases.has(DEFAULT_DB_NAME)).toBe(false)
  })

  it('round-trips a value through set/get', async () => {
    const db = await openDB()
    await idbSet(db, FILES_STORE, 'notes/a.md', { path: 'notes/a.md', content: '# A' })
    expect(await idbGet(db, FILES_STORE, 'notes/a.md')).toEqual({ path: 'notes/a.md', content: '# A' })
  })

  it('resolves undefined for a missing key', async () => {
    const db = await openDB()
    expect(await idbGet(db, FILES_STORE, 'nope.md')).toBeUndefined()
  })

  it('only resolves a write once it is readable', async () => {
    const db = await openDB()
    await idbSet(db, META_STORE, 'k', 1)
    // No extra tick: the value must already be committed when the promise settles.
    expect(await idbGet(db, META_STORE, 'k')).toBe(1)
  })

  it('reads every record in key order', async () => {
    const db = await openDB()
    await idbSet(db, FILES_STORE, 'b.md', 'B')
    await idbSet(db, FILES_STORE, 'a.md', 'A')
    await idbSet(db, FILES_STORE, 'c/d.md', 'D')
    expect(await idbGetAll<string>(db, FILES_STORE)).toEqual(['A', 'B', 'D'])
  })

  it('returns an empty array for an empty store', async () => {
    const db = await openDB()
    expect(await idbGetAll(db, META_STORE)).toEqual([])
  })

  it('overwrites an existing key', async () => {
    const db = await openDB()
    await idbSet(db, META_STORE, 'k', 'first')
    await idbSet(db, META_STORE, 'k', 'second')
    expect(await idbGet(db, META_STORE, 'k')).toBe('second')
    expect(await idbGetAll(db, META_STORE)).toEqual(['second'])
  })

  it('deletes a key and tolerates deleting a missing one', async () => {
    const db = await openDB()
    await idbSet(db, FILES_STORE, 'a.md', 'A')
    await idbDelete(db, FILES_STORE, 'a.md')
    expect(await idbGet(db, FILES_STORE, 'a.md')).toBeUndefined()
    await expect(idbDelete(db, FILES_STORE, 'a.md')).resolves.toBeUndefined()
  })

  it('clears a single store without touching the other', async () => {
    const db = await openDB()
    await idbSet(db, FILES_STORE, 'a.md', 'A')
    await idbSet(db, META_STORE, 'k', 'kept')
    await idbClear(db, FILES_STORE)
    expect(await idbGetAll(db, FILES_STORE)).toEqual([])
    expect(await idbGet(db, META_STORE, 'k')).toBe('kept')
  })

  it('keeps data across connections (reopening the same database)', async () => {
    const first = await openDB()
    await idbSet(first, FILES_STORE, 'a.md', 'A')
    first.close()
    const second = await openDB()
    expect(await idbGet(second, FILES_STORE, 'a.md')).toBe('A')
  })

  it('rejects with the request error when a read fails', async () => {
    const db = await openDB()
    fake.failNextRequest('disk on fire')
    await expect(idbGet(db, FILES_STORE, 'a.md')).rejects.toThrow('disk on fire')
  })

  it('rejects with the request error when a write fails', async () => {
    const db = await openDB()
    fake.failNextRequest('quota exceeded')
    await expect(idbSet(db, FILES_STORE, 'a.md', 'A')).rejects.toThrow('quota exceeded')
  })

  it('rejects rather than throwing synchronously for an unknown store', async () => {
    const db = await openDB()
    await expect(idbGet(db, 'ghost', 'a')).rejects.toThrow(/ghost/)
    await expect(idbGetAll(db, 'ghost')).rejects.toThrow(/ghost/)
    await expect(idbSet(db, 'ghost', 'a', 1)).rejects.toThrow(/ghost/)
    await expect(idbDelete(db, 'ghost', 'a')).rejects.toThrow(/ghost/)
    await expect(idbClear(db, 'ghost')).rejects.toThrow(/ghost/)
  })

  it('rejects when opening fails', async () => {
    fake.failNextOpen('storage denied')
    await expect(openDB()).rejects.toThrow('storage denied')
  })

  it('rejects when another tab blocks the upgrade', async () => {
    fake.blockNextOpen()
    await expect(openDB()).rejects.toThrow(/blocked by another open tab/)
  })

  it('closes the connection when another tab needs a version change', async () => {
    const db = await openDB()
    const versionChange = (db as unknown as { onversionchange: (() => void) | null }).onversionchange
    expect(typeof versionChange).toBe('function')
    versionChange?.()
    // Once closed, further transactions are refused.
    await expect(idbGet(db, FILES_STORE, 'a.md')).rejects.toThrow(/closing/)
  })
})
