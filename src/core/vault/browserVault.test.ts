import { afterEach } from 'vitest'

import type { VaultAdapter } from '../../types'
import { createBrowserVault, hasStoredVault, seedVault } from './browserVault'
import { idbAvailable } from './idb'
import { createMemoryVault } from './memoryVault'

/* ------------------------------------------------------------------ *
 * Minimal in-memory IndexedDB stand-in.
 *
 * jsdom has no IndexedDB, so `createBrowserVault` would only ever exercise its
 * memory fallback here. Installing this fake lets the persistent path be tested
 * too. It mirrors the fake in `idb.test.ts`; the vault module owns no shared
 * test-helper file, so each test file carries its own copy.
 * ------------------------------------------------------------------ */

type StoreData = Map<string, unknown>

interface FakeControls {
  databases: Map<string, Map<string, StoreData>>
  failNextOpen: (message: string) => void
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
  let nextOpenFailure: string | null = null

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
      const data = this.names.includes(name) ? this.db.data.get(name) : undefined
      if (!data) throw namedError('NotFoundError', `No object store named "${name}"`)
      return new FakeObjectStore(this, data)
    }

    run(exec: () => unknown): FakeRequest {
      const request = new FakeRequest()
      this.pending += 1
      queueMicrotask(() => {
        if (this.settled) return
        this.pending -= 1
        request.result = exec()
        request.onsuccess?.()
        if (this.pending === 0) {
          queueMicrotask(() => {
            if (this.settled) return
            this.settled = true
            this.oncomplete?.()
          })
        }
      })
      return request
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

    get objectStoreNames(): { contains: (name: string) => boolean } {
      return { contains: (name: string) => this.data.has(name) }
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
    failNextOpen: (message: string) => {
      nextOpenFailure = message
    },
    restore: () => {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
    },
  }
}

/* ------------------------------------------------------------------ *
 * Fallback path — this is what jsdom (and a private-mode browser) gets.
 * ------------------------------------------------------------------ */

describe('createBrowserVault — fallback when IndexedDB is unavailable', () => {
  it('confirms the test environment really has no IndexedDB', () => {
    expect(idbAvailable()).toBe(false)
  })

  it('still reports itself as a browser vault', async () => {
    const vault = await createBrowserVault()
    expect(vault.kind).toBe('browser')
    expect(vault.name).toBe('SpaceFore')
    expect(vault.writable).toBe(true)
    expect(await vault.list()).toEqual([])
  })

  it('uses the requested vault name', async () => {
    expect((await createBrowserVault('Notebook')).name).toBe('Notebook')
  })

  it('supports the full CRUD surface', async () => {
    const vault = await createBrowserVault()
    await vault.write('notes/A.md', '# A')
    await vault.write('assets/pic.png', 'binary-ish')

    expect(await vault.read('notes/A.md')).toBe('# A')
    expect(await vault.exists('notes/A.md')).toBe(true)
    expect((await vault.list()).map((file) => file.path)).toEqual(['assets/pic.png', 'notes/A.md'])
    expect((await vault.list()).map((file) => file.isMarkdown)).toEqual([false, true])

    await vault.write('notes/A.md', '# A2')
    expect(await vault.read('notes/A.md')).toBe('# A2')

    await vault.rename('notes/A.md', 'notes/B.md')
    expect(await vault.exists('notes/A.md')).toBe(false)
    expect(await vault.read('notes/B.md')).toBe('# A2')

    await vault.remove('notes/B.md')
    expect(await vault.exists('notes/B.md')).toBe(false)
    expect(await vault.list()).toHaveLength(1)
  })

  it('reports missing files and traversal the same way as every other adapter', async () => {
    const vault = await createBrowserVault()
    await expect(vault.read('ghost.md')).rejects.toThrow('File not found: ghost.md')
    await expect(vault.rename('ghost.md', 'other.md')).rejects.toThrow('File not found: ghost.md')
    await expect(vault.remove('ghost.md')).rejects.toThrow('File not found: ghost.md')
    await expect(vault.write('../escape.md', 'x')).rejects.toThrow(/".." segments are not allowed/)
    expect(await vault.exists('../escape.md')).toBe(false)
  })

  it('does not persist across instances', async () => {
    const first = await createBrowserVault()
    await first.write('a.md', 'A')
    const second = await createBrowserVault()
    expect(await second.list()).toEqual([])
  })
})

describe('hasStoredVault without IndexedDB', () => {
  it('is false', async () => {
    await expect(hasStoredVault()).resolves.toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * seedVault — works against any adapter.
 * ------------------------------------------------------------------ */

describe('seedVault', () => {
  it('writes every file into an empty vault', async () => {
    const vault = await createBrowserVault()
    await seedVault(vault, { 'Welcome.md': '# Welcome', 'notes/Ideas.md': '# Ideas' })
    expect((await vault.list()).map((file) => file.path)).toEqual(['Welcome.md', 'notes/Ideas.md'])
    expect(await vault.read('Welcome.md')).toBe('# Welcome')
  })

  it('never clobbers a file that already exists', async () => {
    const vault = await createBrowserVault()
    await vault.write('Welcome.md', 'my own words')
    await seedVault(vault, { 'Welcome.md': '# Welcome', 'notes/Ideas.md': '# Ideas' })
    expect(await vault.read('Welcome.md')).toBe('my own words')
    expect(await vault.read('notes/Ideas.md')).toBe('# Ideas')
  })

  it('treats equivalent paths as existing', async () => {
    const vault = await createBrowserVault()
    await vault.write('notes/A.md', 'mine')
    await seedVault(vault, { './notes//A.md': 'seeded' })
    expect(await vault.read('notes/A.md')).toBe('mine')
    expect(await vault.list()).toHaveLength(1)
  })

  it('is a no-op for an empty seed', async () => {
    const vault = await createBrowserVault()
    await seedVault(vault, {})
    expect(await vault.list()).toEqual([])
  })

  it('refuses a read-only adapter with a showable message', async () => {
    const readOnly: VaultAdapter = createMemoryVault({}, { name: 'Docs', writable: false })
    await expect(seedVault(readOnly, { 'a.md': 'A' })).rejects.toThrow('The "Docs" vault is read-only')
  })
})

/* ------------------------------------------------------------------ *
 * IndexedDB path — driven through the fake factory.
 * ------------------------------------------------------------------ */

describe('createBrowserVault — IndexedDB path', () => {
  let fake: FakeControls

  const withIdb = async (name?: string): Promise<VaultAdapter> => {
    fake ??= installFakeIndexedDB()
    return createBrowserVault(name)
  }

  afterEach(() => {
    fake?.restore()
    fake = undefined as unknown as FakeControls
  })

  it('persists files across adapter instances', async () => {
    const first = await withIdb()
    await first.write('notes/A.md', '# A')
    await first.writeBinary('assets/logo.png', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))

    const second = await createBrowserVault()
    expect((await second.list()).map((file) => file.path)).toEqual(['assets/logo.png', 'notes/A.md'])
    expect(await second.read('notes/A.md')).toBe('# A')
    const blob = await second.readBinary('assets/logo.png')
    expect(blob.size).toBe(3)
    expect((await second.list()).find((file) => file.path === 'assets/logo.png')?.size).toBe(3)
  })

  it('sees a note another tab of the app wrote to the same database', async () => {
    // Two windows of the PWA share one IndexedDB and nothing else. "Not in my
    // cache" is not "does not exist", and createNote asks exactly that.
    const tab1 = await withIdb('Shared')
    const tab2 = await createBrowserVault('Shared')
    await tab1.list()
    await tab2.write('Ideas.md', '# written in tab 2\n')

    expect(await tab1.exists('Ideas.md')).toBe(true)
    expect(await tab1.read('Ideas.md')).toBe('# written in tab 2\n')
    if (!(await tab1.exists('Ideas.md'))) await tab1.write('Ideas.md', '')
    const stored = fake.databases.get('Shared')?.get('files')?.get('Ideas.md') as { content: string }
    expect(stored.content).toBe('# written in tab 2\n')
  })

  it('refuses to rename onto a note another tab created', async () => {
    const tab1 = await withIdb('Shared')
    const tab2 = await createBrowserVault('Shared')
    await tab1.write('A.md', 'a')
    await tab2.write('B.md', 'b')
    await expect(tab1.rename('A.md', 'B.md')).rejects.toThrow(/already exists/)
    expect(await tab2.read('B.md')).toBe('b')
  })

  it('stores one record per path under the files store', async () => {
    const vault = await withIdb()
    await vault.write('notes/A.md', '# A')
    const files = fake.databases.get('SpaceFore')?.get('files')
    expect([...(files?.keys() ?? [])]).toEqual(['notes/A.md'])
    expect(files?.get('notes/A.md')).toMatchObject({ path: 'notes/A.md', content: '# A' })
    expect(typeof (files?.get('notes/A.md') as { mtime: number }).mtime).toBe('number')
  })

  it('serves reads from the in-memory cache once loaded', async () => {
    const vault = await withIdb()
    await vault.write('notes/A.md', '# A')
    await vault.list()
    // Pull the record out from under the adapter: the cache must still answer.
    fake.databases.get('SpaceFore')?.get('files')?.delete('notes/A.md')
    expect(await vault.read('notes/A.md')).toBe('# A')
  })

  it('removes a file from the store as well as the cache', async () => {
    const vault = await withIdb()
    await vault.write('a.md', 'A')
    await vault.remove('a.md')
    expect(await vault.exists('a.md')).toBe(false)
    expect([...(fake.databases.get('SpaceFore')?.get('files')?.keys() ?? [])]).toEqual([])
  })

  it('renames by moving the record to the new key', async () => {
    const vault = await withIdb()
    await vault.write('a.md', 'A')
    await vault.rename('a.md', 'sub/b.md')
    expect([...(fake.databases.get('SpaceFore')?.get('files')?.keys() ?? [])]).toEqual(['sub/b.md'])
    expect(await vault.read('sub/b.md')).toBe('A')
    const reopened = await createBrowserVault()
    expect(await reopened.read('sub/b.md')).toBe('A')
  })

  it('refuses to rename onto an existing file', async () => {
    const vault = await withIdb()
    await vault.write('a.md', 'A')
    await vault.write('b.md', 'B')
    await expect(vault.rename('a.md', 'b.md')).rejects.toThrow(/already exists/)
    expect(await vault.read('b.md')).toBe('B')
  })

  it('keeps separate databases for separate vault names', async () => {
    const work = await withIdb('Work')
    await work.write('a.md', 'work')
    const personal = await createBrowserVault('Personal')
    expect(await personal.list()).toEqual([])
    expect([...fake.databases.keys()].sort()).toEqual(['Personal', 'Work'])
  })

  it('reports a stored vault only once it has content', async () => {
    fake = installFakeIndexedDB()
    expect(await hasStoredVault()).toBe(false)
    const vault = await createBrowserVault()
    expect(await hasStoredVault()).toBe(false)
    await vault.write('a.md', 'A')
    expect(await hasStoredVault()).toBe(true)
    expect(await hasStoredVault('Other')).toBe(false)
  })

  it('falls back to memory when opening the database fails', async () => {
    fake = installFakeIndexedDB()
    fake.failNextOpen('storage denied')
    const vault = await createBrowserVault()
    expect(vault.kind).toBe('browser')
    await vault.write('a.md', 'A')
    expect(await vault.read('a.md')).toBe('A')
    expect(fake.databases.size).toBe(0)
  })

  it('seeds a persistent vault without clobbering later edits', async () => {
    const vault = await withIdb()
    await seedVault(vault, { 'Welcome.md': '# Welcome' })
    await vault.write('Welcome.md', 'edited')

    const reopened = await createBrowserVault()
    await seedVault(reopened, { 'Welcome.md': '# Welcome', 'Ideas.md': '# Ideas' })
    expect(await reopened.read('Welcome.md')).toBe('edited')
    expect(await reopened.read('Ideas.md')).toBe('# Ideas')
  })
})
