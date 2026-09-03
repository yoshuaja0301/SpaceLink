/**
 * Real-folder vault, backed by the File System Access API.
 *
 * This is the "local-first" backend: the user points at a folder on disk and
 * SpaceFore reads and writes plain markdown files in it, exactly like Obsidian.
 * Only Chromium browsers implement the API, so every entry point here is
 * feature-detected and the app falls back to `browserVault` elsewhere.
 *
 * Walking a directory tree is expensive, so the handle tree is cached between
 * calls and invalidated whenever this adapter changes the folder.
 */
import type { NotePath, VaultAdapter, VaultFile } from '../../types'
import { META_STORE, idbAvailable, idbDelete, idbGet, idbSet, openDB } from './idb'
import { baseName, comparePaths, normalizePath, pathSegments, toVaultFile } from './paths'

/** Key under which the picked folder handle is remembered in the `meta` store. */
const HANDLE_KEY = 'directory-vault-handle'

/** Folders and files never shown in the vault. */
const SKIPPED_NAMES = new Set(['node_modules'])

interface DirectoryPickerGlobal {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>
}

/** The walked folder: path -> file handle, plus the `VaultFile` list for `list()`. */
interface HandleTree {
  files: Map<NotePath, FileSystemFileHandle>
  entries: VaultFile[]
}

function getPicker(): DirectoryPickerGlobal['showDirectoryPicker'] {
  const picker = (globalThis as unknown as DirectoryPickerGlobal).showDirectoryPicker
  return typeof picker === 'function' ? picker : undefined
}

export function isDirectoryVaultSupported(): boolean {
  return 'showDirectoryPicker' in globalThis && getPicker() !== undefined
}

/** `.obsidian`, `.git`, `.DS_Store`, `node_modules`, … are not part of the vault. */
function isSkipped(name: string): boolean {
  return name.startsWith('.') || SKIPPED_NAMES.has(name)
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The picker rejects with `AbortError` when the user closes it without choosing. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Make sure we may read *and* write the folder. A handle restored from
 * IndexedDB starts out in the `prompt` state on every reload, so the permission
 * has to be re-queried (and, when possible, re-requested) before use.
 */
async function ensurePermission(handle: FileSystemHandle): Promise<boolean> {
  const descriptor: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
  try {
    // A browser that implements the API without the permission methods cannot
    // be interrogated — assume the handle is usable and let a real operation fail.
    if (typeof handle.queryPermission !== 'function') return true
    if ((await handle.queryPermission(descriptor)) === 'granted') return true
    if (typeof handle.requestPermission !== 'function') return false
    return (await handle.requestPermission(descriptor)) === 'granted'
  } catch {
    // `requestPermission` throws outside a user gesture; treat that as "no".
    return false
  }
}

/**
 * Show the folder picker and build a vault from the chosen folder.
 * Resolves `null` when the user cancels; anything else is rethrown.
 */
export async function pickDirectoryVault(): Promise<VaultAdapter | null> {
  const picker = getPicker()
  if (!picker) {
    throw new Error('This browser cannot open a local folder. Use a Chromium browser, or the in-browser vault.')
  }

  let handle: FileSystemDirectoryHandle
  try {
    handle = await picker.call(globalThis, { mode: 'readwrite' })
  } catch (error) {
    if (isAbortError(error)) return null
    throw error
  }

  if (!(await ensurePermission(handle))) {
    throw new Error(`Permission to read and write "${handle.name}" was not granted.`)
  }
  await rememberVaultHandle(handle)
  return createDirectoryVault(handle)
}

export function createDirectoryVault(handle: FileSystemDirectoryHandle, name: string = handle.name): VaultAdapter {
  let tree: Promise<HandleTree> | null = null

  /** Drop the cached tree; the next read walks the folder again. */
  function invalidate(): void {
    tree = null
  }

  function ensureTree(): Promise<HandleTree> {
    if (!tree) {
      tree = walkDirectory(handle).catch((error: unknown) => {
        tree = null // let the next call retry instead of caching the failure
        throw new Error(`Could not read the "${name}" folder: ${describe(error)}`)
      })
    }
    return tree
  }

  /** Walk down to the folder holding `path`, optionally creating it. */
  async function directoryFor(path: NotePath, create: boolean): Promise<FileSystemDirectoryHandle> {
    let directory = handle
    for (const segment of pathSegments(path)) {
      directory = await directory.getDirectoryHandle(segment, { create })
    }
    return directory
  }

  /**
   * Look `normalized` up on disk rather than in the cached tree. The tree was
   * walked once; a file another program has created since is not in it, and
   * `exists` answering "no" for such a file is exactly how createNote would
   * write over it. Skipped folders stay off limits either way.
   */
  async function probeFile(normalized: NotePath): Promise<FileSystemFileHandle | null> {
    if (pathSegments(normalized).some(isSkipped) || isSkipped(baseName(normalized))) return null
    try {
      const directory = await directoryFor(normalized, false)
      return await directory.getFileHandle(baseName(normalized))
    } catch {
      return null
    }
  }

  async function fileHandleFor(path: NotePath): Promise<FileSystemFileHandle> {
    const normalized = normalizePath(path)
    const { files } = await ensureTree()
    const cached = files.get(normalized)
    if (cached) return cached
    const found = await probeFile(normalized)
    if (!found) throw new Error(`File not found: ${normalized}`)
    invalidate() // the folder has changed under the cache; the next listing walks it again
    return found
  }

  /** Create intermediate folders as needed, then replace the file's contents. */
  async function writeFile(path: NotePath, data: string | Blob): Promise<void> {
    try {
      // A file already listed under this path is written through its own
      // handle: its name on disk may not be the path's spelling (a trailing
      // space, a backslash), and opening by name would create a second file.
      const listed = tree ? (await tree).files.get(path) : undefined
      const file = listed ?? (await (await directoryFor(path, true)).getFileHandle(baseName(path), { create: true }))
      const writable = await file.createWritable()
      try {
        await writable.write(data)
        await writable.close()
      } catch (error) {
        // Never leave a writable stream dangling on a failed write.
        await writable.abort().catch(() => undefined)
        throw error
      }
    } catch (error) {
      throw new Error(`Could not write ${path}: ${describe(error)}`)
    } finally {
      invalidate()
    }
  }

  async function removeFile(path: NotePath): Promise<void> {
    try {
      const directory = await directoryFor(path, false)
      await directory.removeEntry(baseName(path))
    } catch (error) {
      throw new Error(`Could not delete ${path}: ${describe(error)}`)
    } finally {
      invalidate()
    }
  }

  return {
    kind: 'directory',
    name,
    writable: true,

    async list(): Promise<VaultFile[]> {
      return [...(await ensureTree()).entries]
    },

    async read(path: NotePath): Promise<string> {
      const file = await fileHandleFor(path)
      return (await file.getFile()).text()
    },

    async readBinary(path: NotePath): Promise<Blob> {
      const file = await fileHandleFor(path)
      return file.getFile()
    },

    async write(path: NotePath, content: string): Promise<void> {
      await writeFile(normalizePath(path), content)
    },

    async writeBinary(path: NotePath, data: Blob): Promise<void> {
      await writeFile(normalizePath(path), data)
    },

    async remove(path: NotePath): Promise<void> {
      const normalized = normalizePath(path)
      const { files } = await ensureTree()
      if (!files.has(normalized)) throw new Error(`File not found: ${normalized}`)
      await removeFile(normalized)
    },

    async rename(from: NotePath, to: NotePath): Promise<void> {
      const source = normalizePath(from)
      const target = normalizePath(to)
      if (source === target) return

      const { files } = await ensureTree()
      const sourceHandle = files.get(source) ?? (await probeFile(source))
      if (!sourceHandle) throw new Error(`File not found: ${source}`)
      if (files.has(target)) throw new Error(`Cannot rename to ${target}: that file already exists.`)

      // Copy as a blob so attachments survive the round trip untouched, and
      // only unlink the original once the copy is on disk.
      const contents = await sourceHandle.getFile()
      const clash = await probeFile(target)
      if (clash) {
        if (!(await sameEntry(clash, sourceHandle, source, target))) {
          throw new Error(`Cannot rename to ${target}: that file already exists.`)
        }
        // Only the letter case changes, on a volume that does not tell the two
        // apart (APFS and NTFS by default): opening `home.md` opened Home.md
        // itself, so the copy below would write the file onto itself and the
        // delete would then remove the only copy. Go through a third name.
        const temporary = `${target}.spacefore-renaming`
        await writeFile(temporary, contents)
        await removeFile(source)
        await writeFile(target, contents)
        await removeFile(temporary)
        return
      }
      await writeFile(target, contents)
      await removeFile(source)
    },

    async exists(path: NotePath): Promise<boolean> {
      try {
        const normalized = normalizePath(path)
        const { files } = await ensureTree()
        if (files.has(normalized)) return true
        const onDisk = (await probeFile(normalized)) !== null
        if (onDisk) invalidate()
        return onDisk
      } catch {
        return false
      }
    },
  }
}

/**
 * Are `a` and `b` the same file on disk? Asked when a rename's target opens a
 * file: on a case-insensitive volume that file may be the source itself.
 */
async function sameEntry(a: FileSystemHandle, b: FileSystemHandle, aPath: NotePath, bPath: NotePath): Promise<boolean> {
  if (typeof a.isSameEntry === 'function') return a.isSameEntry(b).catch(() => false)
  // No `isSameEntry`: the same folder and a name that differs only in case is
  // the only way one path can open the other's file.
  const folderOf = (path: NotePath): string => pathSegments(path).join('/')
  return folderOf(aPath) === folderOf(bPath) && baseName(aPath).toLowerCase() === baseName(bPath).toLowerCase()
}

/** Recursively collect every file below `root`, skipping dot- and vendor folders. */
async function walkDirectory(root: FileSystemDirectoryHandle): Promise<HandleTree> {
  const files = new Map<NotePath, FileSystemFileHandle>()
  const entries: VaultFile[] = []

  async function walk(directory: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [entryName, child] of directory.entries()) {
      if (isSkipped(entryName)) continue
      const path = prefix === '' ? entryName : `${prefix}/${entryName}`
      if (child.kind === 'directory') {
        await walk(child, path)
      } else {
        // Filed under the path the entry reports, which is the name normalised
        // (a trailing space trimmed, a backslash made a slash): every lookup
        // normalises the caller's path first, so the two have to agree or the
        // note shows in the tree and cannot be opened. A name the vault cannot
        // address at all, or a second name normalising to a listed one, is
        // left out rather than listed twice.
        let key: NotePath
        try {
          key = normalizePath(path)
        } catch {
          continue
        }
        if (files.has(key)) continue
        const file = await child.getFile()
        files.set(key, child)
        entries.push(toVaultFile(key, file.size, file.lastModified))
      }
    }
  }

  await walk(root, '')
  entries.sort((a, b) => comparePaths(a.path, b.path))
  return { files, entries }
}

/* ------------------------------------------------------------------ *
 * Remembering the picked folder across reloads.
 *
 * Directory handles are structured-cloneable, so they can live in IndexedDB —
 * but the permission they carry does not survive, which is why
 * `restoreVaultHandle` always re-checks it.
 * ------------------------------------------------------------------ */

async function withMetaDB<T>(run: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
  if (!idbAvailable()) return fallback
  let db: IDBDatabase | null = null
  try {
    db = await openDB()
    return await run(db)
  } catch {
    // Remembering the folder is a convenience; never fail the app over it.
    return fallback
  } finally {
    db?.close()
  }
}

export async function rememberVaultHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withMetaDB(async (db) => {
    await idbSet(db, META_STORE, HANDLE_KEY, handle)
  }, undefined)
}

/** The remembered folder, or null when there is none or permission is refused. */
export async function restoreVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  const stored = await withMetaDB(
    (db) => idbGet<FileSystemDirectoryHandle>(db, META_STORE, HANDLE_KEY),
    undefined as FileSystemDirectoryHandle | undefined,
  )
  const candidate = stored as unknown as { kind?: unknown } | undefined
  if (!candidate || candidate.kind !== 'directory') return null
  const handle = stored as FileSystemDirectoryHandle
  return (await ensurePermission(handle)) ? handle : null
}

export async function forgetVaultHandle(): Promise<void> {
  await withMetaDB(async (db) => {
    await idbDelete(db, META_STORE, HANDLE_KEY)
  }, undefined)
}
