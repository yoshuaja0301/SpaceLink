import { afterEach, beforeEach } from 'vitest'

import type { VaultAdapter } from '../../types'
import {
  createDirectoryVault,
  forgetVaultHandle,
  isDirectoryVaultSupported,
  pickDirectoryVault,
  rememberVaultHandle,
  restoreVaultHandle,
} from './directoryVault'

/* ------------------------------------------------------------------ *
 * A hand-written File System Access API.
 *
 * jsdom implements none of it, so the adapter is driven against these fakes:
 * they model the parts the adapter uses — async `entries()`, `getFileHandle` /
 * `getDirectoryHandle` with `create`, `removeEntry`, and a writable stream that
 * truncates on open and only commits on `close()`.
 * ------------------------------------------------------------------ */

let clock = 1_700_000_000_000
const nextMtime = (): number => (clock += 1)

function fsError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

class FakeFileHandle {
  readonly kind = 'file' as const
  data: Blob
  lastModified: number

  constructor(readonly name: string, contents: Blob | string) {
    this.data = contents instanceof Blob ? contents : new Blob([contents])
    this.lastModified = nextMtime()
  }

  async getFile(): Promise<File> {
    return new File([this.data], this.name, { lastModified: this.lastModified })
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this
  }

  async createWritable(): Promise<{
    write: (chunk: Blob | string) => Promise<void>
    close: () => Promise<void>
    abort: () => Promise<void>
  }> {
    const handle = this
    const chunks: (Blob | string)[] = []
    let aborted = false
    return {
      async write(chunk: Blob | string): Promise<void> {
        if (aborted) throw fsError('InvalidStateError', 'The stream is closed')
        chunks.push(chunk)
      },
      async close(): Promise<void> {
        if (aborted) return
        // Opening a writable truncates: the file becomes exactly what was written.
        handle.data = new Blob(chunks)
        handle.lastModified = nextMtime()
      },
      async abort(): Promise<void> {
        aborted = true
      },
    }
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const
  readonly children = new Map<string, FakeFileHandle | FakeDirectoryHandle>()
  /** Current permission state, as `queryPermission` would report it. */
  permission: PermissionState = 'granted'
  /** What `requestPermission` will answer. */
  promptResult: PermissionState = 'granted'
  queryCalls = 0
  requestCalls = 0
  /** Set to make `getDirectoryHandle(..., { create: true })` fail. */
  failCreate: string | null = null
  /**
   * Model a volume that does not tell `Home.md` from `home.md` — APFS and NTFS
   * as shipped. Opening either name opens the one file that is there.
   */
  caseInsensitive = false

  constructor(readonly name: string) {}

  /** The child `name` opens: the exact one, or on a case-insensitive volume any that matches. */
  private lookup(name: string): FakeFileHandle | FakeDirectoryHandle | undefined {
    const exact = this.children.get(name)
    if (exact || !this.caseInsensitive) return exact
    for (const [key, value] of this.children) if (key.toLowerCase() === name.toLowerCase()) return value
    return undefined
  }

  /** The key `name` is stored under, if a child already answers to it. */
  private keyFor(name: string): string {
    if (!this.caseInsensitive) return name
    for (const key of this.children.keys()) if (key.toLowerCase() === name.toLowerCase()) return key
    return name
  }

  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirectoryHandle]> {
    // Snapshot: the adapter may mutate the folder while a walk is in flight.
    for (const entry of [...this.children.entries()]) yield entry
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    const existing = this.lookup(name)
    if (existing) {
      if (existing.kind !== 'directory') throw fsError('TypeMismatchError', `"${name}" is a file`)
      return existing
    }
    if (!options?.create) throw fsError('NotFoundError', `No directory named "${name}"`)
    if (this.failCreate) throw fsError('NotAllowedError', this.failCreate)
    const created = new FakeDirectoryHandle(name)
    created.failCreate = this.failCreate
    created.caseInsensitive = this.caseInsensitive
    this.children.set(name, created)
    return created
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this.lookup(name)
    if (existing) {
      if (existing.kind !== 'file') throw fsError('TypeMismatchError', `"${name}" is a directory`)
      return existing
    }
    if (!options?.create) throw fsError('NotFoundError', `No file named "${name}"`)
    const created = new FakeFileHandle(name, '')
    this.children.set(name, created)
    return created
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const key = this.keyFor(name)
    const existing = this.children.get(key)
    if (!existing) throw fsError('NotFoundError', `No entry named "${name}"`)
    if (existing.kind === 'directory' && existing.children.size > 0 && !options?.recursive) {
      throw fsError('InvalidModificationError', `"${name}" is not empty`)
    }
    this.children.delete(key)
  }

  async queryPermission(): Promise<PermissionState> {
    this.queryCalls += 1
    return this.permission
  }

  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1
    this.permission = this.promptResult
    return this.promptResult
  }
}

/** Build a folder tree from `path -> contents`. */
function buildDirectory(name: string, files: Record<string, string>, caseInsensitive = false): FakeDirectoryHandle {
  const root = new FakeDirectoryHandle(name)
  root.caseInsensitive = caseInsensitive
  for (const [path, contents] of Object.entries(files)) {
    const segments = path.split('/')
    const fileName = segments.pop() as string
    let directory = root
    for (const segment of segments) {
      let next = directory.children.get(segment)
      if (!next) {
        next = new FakeDirectoryHandle(segment)
        ;(next as FakeDirectoryHandle).caseInsensitive = caseInsensitive
        directory.children.set(segment, next)
      }
      directory = next as FakeDirectoryHandle
    }
    directory.children.set(fileName, new FakeFileHandle(fileName, contents))
  }
  return root
}

const asHandle = (directory: FakeDirectoryHandle): FileSystemDirectoryHandle =>
  directory as unknown as FileSystemDirectoryHandle

/** Look a path up directly in the fake tree, bypassing the adapter. */
function findNode(root: FakeDirectoryHandle, path: string): FakeFileHandle | FakeDirectoryHandle | undefined {
  let node: FakeFileHandle | FakeDirectoryHandle | undefined = root
  for (const segment of path.split('/')) {
    if (!node || node.kind !== 'directory') return undefined
    node = node.children.get(segment)
  }
  return node
}

/* ------------------------------------------------------------------ *
 * Minimal IndexedDB stand-in for the remembered-handle tests.
 * (Mirrors the fake in `idb.test.ts`, trimmed to the meta-store operations
 * this module performs; the vault module owns no shared test-helper file.)
 * ------------------------------------------------------------------ */

function installFakeIndexedDB(): { restore: () => void } {
  const databases = new Map<string, Map<string, Map<string, unknown>>>()
  const versions = new Map<string, number>()

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

    constructor(private readonly data: Map<string, Map<string, unknown>>) {}

    objectStore(name: string): {
      get: (key: string) => FakeRequest
      put: (value: unknown, key: string) => FakeRequest
      delete: (key: string) => FakeRequest
      getAll: () => FakeRequest
      clear: () => FakeRequest
    } {
      const store = this.data.get(name)
      if (!store) throw fsError('NotFoundError', `No object store named "${name}"`)
      const run = (exec: () => unknown): FakeRequest => {
        const request = new FakeRequest()
        queueMicrotask(() => {
          request.result = exec()
          request.onsuccess?.()
          queueMicrotask(() => this.oncomplete?.())
        })
        return request
      }
      return {
        get: (key) => run(() => store.get(key)),
        put: (value, key) => run(() => store.set(key, value)),
        delete: (key) => run(() => store.delete(key)),
        getAll: () => run(() => [...store.keys()].sort().map((key) => store.get(key))),
        clear: () => run(() => store.clear()),
      }
    }
  }

  class FakeDatabase {
    onversionchange: (() => void) | null = null
    constructor(readonly data: Map<string, Map<string, unknown>>) {}
    get objectStoreNames(): { contains: (name: string) => boolean } {
      return { contains: (name: string) => this.data.has(name) }
    }
    createObjectStore(name: string): { name: string } {
      if (!this.data.has(name)) this.data.set(name, new Map())
      return { name }
    }
    transaction(names: string | string[]): FakeTransaction {
      const list = Array.isArray(names) ? names : [names]
      for (const name of list) {
        if (!this.data.has(name)) throw fsError('NotFoundError', `No object store named "${name}"`)
      }
      return new FakeTransaction(this.data)
    }
    close(): void {}
  }

  const factory = {
    open(name: string, version: number): FakeRequest {
      const request = new FakeRequest()
      queueMicrotask(() => {
        let data = databases.get(name)
        if (!data) {
          data = new Map()
          databases.set(name, data)
        }
        request.result = new FakeDatabase(data)
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
    restore: () => {
      Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
    },
  }
}

function installPicker(picker: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>): void {
  Object.defineProperty(globalThis, 'showDirectoryPicker', { value: picker, configurable: true, writable: true })
}

function uninstallPicker(): void {
  Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
}

/* ------------------------------------------------------------------ */

const VAULT_FILES = {
  'Welcome.md': '# Welcome\n\nSee [[Ideas]].',
  'notes/Ideas.md': '# Ideas',
  'notes/deep/Nested.md': '# Nested',
  'assets/diagram.png': 'pretend-png-bytes',
  'LICENSE': 'MIT',
  '.obsidian/app.json': '{}',
  '.hidden.md': 'secret',
  'node_modules/pkg/index.js': 'module.exports = 1',
  '.git/config': '[core]',
}

function makeVault(): { root: FakeDirectoryHandle; vault: VaultAdapter } {
  const root = buildDirectory('My Vault', VAULT_FILES)
  return { root, vault: createDirectoryVault(asHandle(root)) }
}

describe('isDirectoryVaultSupported', () => {
  afterEach(uninstallPicker)

  it('is false without the API (jsdom)', () => {
    expect(isDirectoryVaultSupported()).toBe(false)
  })

  it('is true once showDirectoryPicker exists', () => {
    installPicker(async () => asHandle(new FakeDirectoryHandle('x')))
    expect(isDirectoryVaultSupported()).toBe(true)
  })
})

describe('createDirectoryVault — identity', () => {
  it('takes its name from the folder, and can be overridden', () => {
    const { vault } = makeVault()
    expect(vault.kind).toBe('directory')
    expect(vault.name).toBe('My Vault')
    expect(vault.writable).toBe(true)
    expect(createDirectoryVault(asHandle(new FakeDirectoryHandle('folder')), 'Custom').name).toBe('Custom')
  })
})

describe('createDirectoryVault — list', () => {
  it('walks nested folders and sorts by path', async () => {
    const { vault } = makeVault()
    expect((await vault.list()).map((file) => file.path)).toEqual([
      'LICENSE',
      'Welcome.md',
      'assets/diagram.png',
      'notes/Ideas.md',
      'notes/deep/Nested.md',
    ])
  })

  it('skips dot-entries and node_modules', async () => {
    const paths = (await makeVault().vault.list()).map((file) => file.path)
    expect(paths.some((path) => path.startsWith('.'))).toBe(false)
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false)
  })

  it('flags markdown notes and attachments correctly', async () => {
    const files = await makeVault().vault.list()
    const byPath = new Map(files.map((file) => [file.path, file]))
    expect(byPath.get('notes/Ideas.md')).toMatchObject({ name: 'Ideas', extension: 'md', isMarkdown: true })
    expect(byPath.get('assets/diagram.png')).toMatchObject({
      name: 'diagram.png',
      extension: 'png',
      isMarkdown: false,
    })
    expect(byPath.get('LICENSE')).toMatchObject({ name: 'LICENSE', extension: '', isMarkdown: false })
  })

  it('reports the file size and mtime from disk', async () => {
    const { root, vault } = makeVault()
    const file = (await vault.list()).find((entry) => entry.path === 'notes/Ideas.md')
    const node = findNode(root, 'notes/Ideas.md') as FakeFileHandle
    expect(file?.size).toBe(7)
    expect(file?.mtime).toBe(node.lastModified)
  })

  it('returns an empty list for an empty folder', async () => {
    const vault = createDirectoryVault(asHandle(new FakeDirectoryHandle('Empty')))
    expect(await vault.list()).toEqual([])
  })

  it('hands back a copy, so callers cannot corrupt the cache', async () => {
    const { vault } = makeVault()
    const first = await vault.list()
    first.length = 0
    expect(await vault.list()).toHaveLength(5)
  })
})

describe('createDirectoryVault — read', () => {
  it('reads a nested file', async () => {
    expect(await makeVault().vault.read('notes/deep/Nested.md')).toBe('# Nested')
  })

  it('accepts non-canonical paths', async () => {
    const { vault } = makeVault()
    expect(await vault.read('./notes//Ideas.md')).toBe('# Ideas')
    expect(await vault.read('/notes/Ideas.md')).toBe('# Ideas')
  })

  it('throws a showable error for a missing file', async () => {
    await expect(makeVault().vault.read('nope.md')).rejects.toThrow('File not found: nope.md')
  })

  it('refuses to read a skipped file even though it is on disk', async () => {
    await expect(makeVault().vault.read('.obsidian/app.json')).rejects.toThrow('File not found: .obsidian/app.json')
  })

  it('rejects path traversal', async () => {
    await expect(makeVault().vault.read('../../etc/passwd')).rejects.toThrow(/".." segments are not allowed/)
  })

  it('reads attachments as blobs', async () => {
    const blob = await makeVault().vault.readBinary('assets/diagram.png')
    expect(await blob.text()).toBe('pretend-png-bytes')
  })
})

describe('createDirectoryVault — write', () => {
  it('creates intermediate folders', async () => {
    const { root, vault } = makeVault()
    await vault.write('journal/2026/08/Today.md', '# Today')
    const node = findNode(root, 'journal/2026/08/Today.md')
    expect(node?.kind).toBe('file')
    expect(await vault.read('journal/2026/08/Today.md')).toBe('# Today')
  })

  it('invalidates the cached tree so new files show up in list()', async () => {
    const { vault } = makeVault()
    await vault.list()
    await vault.write('New.md', '# New')
    expect((await vault.list()).map((file) => file.path)).toContain('New.md')
    expect(await vault.exists('New.md')).toBe(true)
  })

  it('truncates rather than appends when overwriting', async () => {
    const { root, vault } = makeVault()
    await vault.write('Welcome.md', 'short')
    expect(await vault.read('Welcome.md')).toBe('short')
    expect((findNode(root, 'Welcome.md') as FakeFileHandle).data.size).toBe(5)
  })

  it('round-trips binary payloads', async () => {
    const { vault } = makeVault()
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' })
    await vault.writeBinary('assets/logo.png', blob)
    const stored = await vault.readBinary('assets/logo.png')
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect((await vault.list()).find((file) => file.path === 'assets/logo.png')?.size).toBe(5)
  })

  it('rejects path traversal', async () => {
    await expect(makeVault().vault.write('../escape.md', 'x')).rejects.toThrow(/".." segments are not allowed/)
  })

  it('wraps a filesystem failure in a message the UI can show', async () => {
    const { root, vault } = makeVault()
    root.failCreate = 'permission denied by the OS'
    await expect(vault.write('newfolder/a.md', 'x')).rejects.toThrow(
      'Could not write newfolder/a.md: permission denied by the OS',
    )
  })
})

describe('createDirectoryVault — caching', () => {
  it('reuses the walked tree until something changes', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    // Change the folder behind the adapter's back: the cache still answers.
    root.children.set('Sneaky.md', new FakeFileHandle('Sneaky.md', 'hi'))
    expect((await vault.list()).map((file) => file.path)).not.toContain('Sneaky.md')

    // Any write invalidates the cache, so the next walk picks everything up.
    await vault.write('Trigger.md', 'x')
    const paths = (await vault.list()).map((file) => file.path)
    expect(paths).toContain('Sneaky.md')
    expect(paths).toContain('Trigger.md')
  })

  it('invalidates after remove and rename too', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    await vault.remove('LICENSE')
    root.children.set('AfterRemove.md', new FakeFileHandle('AfterRemove.md', 'x'))
    expect((await vault.list()).map((file) => file.path)).toContain('AfterRemove.md')

    await vault.rename('Welcome.md', 'Start.md')
    root.children.set('AfterRename.md', new FakeFileHandle('AfterRename.md', 'x'))
    expect((await vault.list()).map((file) => file.path)).toContain('AfterRename.md')
  })
})

describe('createDirectoryVault — rename', () => {
  it('moves a file into another folder', async () => {
    const { root, vault } = makeVault()
    await vault.rename('notes/Ideas.md', 'archive/Old Ideas.md')
    expect(await vault.read('archive/Old Ideas.md')).toBe('# Ideas')
    expect(await vault.exists('notes/Ideas.md')).toBe(false)
    expect(findNode(root, 'notes/Ideas.md')).toBeUndefined()
    expect(findNode(root, 'archive/Old Ideas.md')?.kind).toBe('file')
  })

  it('preserves binary contents', async () => {
    const { vault } = makeVault()
    await vault.writeBinary('a.bin', new Blob([new Uint8Array([7, 8, 9])]))
    await vault.rename('a.bin', 'sub/b.bin')
    expect(new Uint8Array(await (await vault.readBinary('sub/b.bin')).arrayBuffer())).toEqual(
      new Uint8Array([7, 8, 9]),
    )
  })

  it('throws when the source does not exist', async () => {
    await expect(makeVault().vault.rename('ghost.md', 'other.md')).rejects.toThrow('File not found: ghost.md')
  })

  it('throws when the target already exists and leaves both files alone', async () => {
    const { vault } = makeVault()
    await expect(vault.rename('Welcome.md', 'notes/Ideas.md')).rejects.toThrow(/already exists/)
    expect(await vault.read('notes/Ideas.md')).toBe('# Ideas')
    expect(await vault.exists('Welcome.md')).toBe(true)
  })

  it('is a no-op when the target normalises to the source', async () => {
    const { vault } = makeVault()
    await vault.rename('Welcome.md', './Welcome.md')
    expect(await vault.read('Welcome.md')).toBe(VAULT_FILES['Welcome.md'])
  })
})

describe('createDirectoryVault — a file that appeared after the first walk', () => {
  // Obsidian, git pull, Finder: none of them tell the app. The tree was walked
  // once, and "not in the tree" must not be taken for "not on disk".
  it('is seen by exists() and read(), and by the next list()', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    root.children.set('Ideas.md', new FakeFileHandle('Ideas.md', '# Ideas written elsewhere\n'))

    expect(await vault.exists('Ideas.md')).toBe(true)
    expect(await vault.read('Ideas.md')).toBe('# Ideas written elsewhere\n')
    expect((await vault.list()).map((file) => file.path)).toContain('Ideas.md')
  })

  it('can be read straight away, without anything else having looked first', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    root.children.set('Ideas.md', new FakeFileHandle('Ideas.md', '# Ideas written elsewhere\n'))
    expect(await vault.read('Ideas.md')).toBe('# Ideas written elsewhere\n')
  })

  it('is not written over by a createNote-style "exists, then write"', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    root.children.set('Ideas.md', new FakeFileHandle('Ideas.md', '# Ideas written elsewhere\n'))

    if (!(await vault.exists('Ideas.md'))) await vault.write('Ideas.md', '')

    expect(await (findNode(root, 'Ideas.md') as FakeFileHandle).getFile().then((file) => file.text())).toBe(
      '# Ideas written elsewhere\n',
    )
  })

  it('still keeps out of a skipped folder, which the disk probe must not reach into', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    const git = new FakeDirectoryHandle('.git')
    git.children.set('HEAD.md', new FakeFileHandle('HEAD.md', 'ref'))
    root.children.set('.git', git)

    expect(await vault.exists('.git/HEAD.md')).toBe(false)
    await expect(vault.read('.git/HEAD.md')).rejects.toThrow('File not found')
  })
})

describe('createDirectoryVault — a rename that only changes letter case', () => {
  it('keeps the note on a volume that does not tell the two names apart', async () => {
    // Copy-then-delete would copy Home.md onto itself and then delete the only copy.
    const root = buildDirectory('vault', { 'Home.md': '# Home\n\nimportant text\n' }, true)
    const vault = createDirectoryVault(asHandle(root))
    await vault.list()

    await vault.rename('Home.md', 'home.md')

    expect([...root.children.keys()]).toEqual(['home.md'])
    expect(await vault.read('home.md')).toBe('# Home\n\nimportant text\n')
  })

  it('is an ordinary rename on a volume that does tell them apart', async () => {
    const root = buildDirectory('vault', { 'Home.md': '# Home\n' })
    const vault = createDirectoryVault(asHandle(root))
    await vault.rename('Home.md', 'home.md')
    expect([...root.children.keys()]).toEqual(['home.md'])
  })

  it('still refuses a target that is a different file, even one the tree has not seen yet', async () => {
    const { root, vault } = makeVault()
    await vault.list()
    root.children.set('Taken.md', new FakeFileHandle('Taken.md', 'taken'))
    await expect(vault.rename('Welcome.md', 'Taken.md')).rejects.toThrow(/already exists/)
    expect(await vault.read('Taken.md')).toBe('taken')
    expect(await vault.exists('Welcome.md')).toBe(true)
  })
})

describe('createDirectoryVault — names the vault spells differently from the disk', () => {
  it('lists a file with a trailing space under the path it can be read by, and writes to that same file', async () => {
    const root = buildDirectory('vault', { 'Draft.md ': '# Draft' })
    const vault = createDirectoryVault(asHandle(root))

    expect((await vault.list()).map((file) => file.path)).toEqual(['Draft.md'])
    expect(await vault.exists('Draft.md')).toBe(true)
    expect(await vault.read('Draft.md')).toBe('# Draft')

    await vault.write('Draft.md', '# Draft, edited')
    expect([...root.children.keys()]).toEqual(['Draft.md '])
    expect(await vault.read('Draft.md')).toBe('# Draft, edited')
  })

  it('lists a file whose name holds a backslash under the slashed path it reads by', async () => {
    const root = buildDirectory('vault', { 'a\\b.md': 'ab' })
    const vault = createDirectoryVault(asHandle(root))
    expect((await vault.list()).map((file) => file.path)).toEqual(['a/b.md'])
    expect(await vault.read('a/b.md')).toBe('ab')
  })
})

describe('createDirectoryVault — remove', () => {
  it('deletes a nested file but keeps its folder', async () => {
    const { root, vault } = makeVault()
    await vault.remove('notes/deep/Nested.md')
    expect(await vault.exists('notes/deep/Nested.md')).toBe(false)
    expect(findNode(root, 'notes/deep')?.kind).toBe('directory')
  })

  it('throws for a missing file', async () => {
    await expect(makeVault().vault.remove('ghost.md')).rejects.toThrow('File not found: ghost.md')
  })
})

describe('createDirectoryVault — exists', () => {
  it('never throws', async () => {
    const { vault } = makeVault()
    expect(await vault.exists('notes/Ideas.md')).toBe(true)
    expect(await vault.exists('./notes/Ideas.md')).toBe(true)
    expect(await vault.exists('ghost.md')).toBe(false)
    expect(await vault.exists('../escape.md')).toBe(false)
    expect(await vault.exists('')).toBe(false)
  })
})

describe('pickDirectoryVault', () => {
  afterEach(uninstallPicker)

  it('throws a showable error when the API is missing', async () => {
    await expect(pickDirectoryVault()).rejects.toThrow(/cannot open a local folder/)
  })

  it('returns a vault for the chosen folder and asks for readwrite access', async () => {
    const root = buildDirectory('Chosen', { 'a.md': '# A' })
    let seen: DirectoryPickerOptions | undefined
    installPicker(async (options) => {
      seen = options
      return asHandle(root)
    })

    const vault = await pickDirectoryVault()
    expect(seen).toEqual({ mode: 'readwrite' })
    expect(vault?.kind).toBe('directory')
    expect(vault?.name).toBe('Chosen')
    expect((await vault!.list()).map((file) => file.path)).toEqual(['a.md'])
  })

  it('resolves null when the user cancels the picker', async () => {
    installPicker(async () => {
      throw fsError('AbortError', 'The user aborted a request.')
    })
    await expect(pickDirectoryVault()).resolves.toBeNull()
  })

  it('rethrows any other picker failure', async () => {
    installPicker(async () => {
      throw fsError('SecurityError', 'Must be handling a user gesture')
    })
    await expect(pickDirectoryVault()).rejects.toThrow('Must be handling a user gesture')
  })

  it('throws when readwrite permission is refused', async () => {
    const root = buildDirectory('Chosen', {})
    root.permission = 'prompt'
    root.promptResult = 'denied'
    installPicker(async () => asHandle(root))
    await expect(pickDirectoryVault()).rejects.toThrow('Permission to read and write "Chosen" was not granted.')
  })

  it('prompts once when permission has not been granted yet', async () => {
    const root = buildDirectory('Chosen', {})
    root.permission = 'prompt'
    root.promptResult = 'granted'
    installPicker(async () => asHandle(root))
    await expect(pickDirectoryVault()).resolves.not.toBeNull()
    expect(root.queryCalls).toBe(1)
    expect(root.requestCalls).toBe(1)
  })
})

describe('remembering the picked folder — without IndexedDB', () => {
  it('degrades quietly', async () => {
    const root = buildDirectory('Vault', {})
    await expect(rememberVaultHandle(asHandle(root))).resolves.toBeUndefined()
    await expect(restoreVaultHandle()).resolves.toBeNull()
    await expect(forgetVaultHandle()).resolves.toBeUndefined()
  })
})

describe('remembering the picked folder — with IndexedDB', () => {
  let idb: { restore: () => void }

  beforeEach(() => {
    idb = installFakeIndexedDB()
  })

  afterEach(() => {
    idb.restore()
    uninstallPicker()
  })

  it('returns null when nothing was remembered', async () => {
    await expect(restoreVaultHandle()).resolves.toBeNull()
  })

  it('round-trips the handle when permission is still granted', async () => {
    const root = buildDirectory('Vault', { 'a.md': 'A' })
    await rememberVaultHandle(asHandle(root))

    const restored = await restoreVaultHandle()
    expect(restored).toBe(asHandle(root))
    expect(root.queryCalls).toBe(1)
    expect(root.requestCalls).toBe(0)

    const vault = createDirectoryVault(restored as FileSystemDirectoryHandle)
    expect((await vault.list()).map((file) => file.path)).toEqual(['a.md'])
  })

  it('re-requests permission when the handle comes back in the prompt state', async () => {
    const root = buildDirectory('Vault', {})
    root.permission = 'prompt'
    root.promptResult = 'granted'
    await rememberVaultHandle(asHandle(root))
    expect(await restoreVaultHandle()).toBe(asHandle(root))
    expect(root.requestCalls).toBe(1)
  })

  it('returns null when permission is refused', async () => {
    const root = buildDirectory('Vault', {})
    root.permission = 'prompt'
    root.promptResult = 'denied'
    await rememberVaultHandle(asHandle(root))
    expect(await restoreVaultHandle()).toBeNull()
  })

  it('returns null when requesting permission throws (no user gesture)', async () => {
    const root = buildDirectory('Vault', {})
    root.permission = 'prompt'
    root.requestPermission = async (): Promise<PermissionState> => {
      throw fsError('SecurityError', 'User activation is required')
    }
    await rememberVaultHandle(asHandle(root))
    expect(await restoreVaultHandle()).toBeNull()
  })

  it('accepts a handle from a browser without the permission API', async () => {
    const bare = { kind: 'directory', name: 'Bare' } as unknown as FileSystemDirectoryHandle
    await rememberVaultHandle(bare)
    expect(await restoreVaultHandle()).toBe(bare)
  })

  it('forgets the handle', async () => {
    const root = buildDirectory('Vault', {})
    await rememberVaultHandle(asHandle(root))
    await forgetVaultHandle()
    expect(await restoreVaultHandle()).toBeNull()
  })

  it('remembers the folder the user picked', async () => {
    const root = buildDirectory('Picked', {})
    installPicker(async () => asHandle(root))
    await pickDirectoryVault()
    expect(await restoreVaultHandle()).toBe(asHandle(root))
  })
})
