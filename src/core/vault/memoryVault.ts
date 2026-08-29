/**
 * In-memory vault adapter.
 *
 * Used for the demo vault, for tests, and as the graceful fallback when a
 * persistent backend is unavailable. Everything is synchronous under the hood;
 * the promises are resolved immediately.
 */
import type { NotePath, VaultAdapter, VaultFile } from '../../types'
import { comparePaths, mimeTypeOf, normalizePath, toVaultFile } from './paths'

export interface MemoryVaultOptions {
  name?: string
  writable?: boolean
}

/**
 * Fixed epoch for seeded files. Deliberately not `Date.now()` — seeded mtimes
 * must be identical on every run so tests (and snapshotted sort orders) are
 * deterministic.
 */
const BASE_MTIME = 1_700_000_000_000

const encoder = new TextEncoder()

interface MemoryEntry {
  /** Text payload. Empty when the entry was written through `writeBinary`. */
  content: string
  /** Set only for binary entries. */
  blob: Blob | null
  mtime: number
  size: number
}

export function createMemoryVault(seed: Record<NotePath, string>, options: MemoryVaultOptions = {}): VaultAdapter {
  const name = options.name ?? 'In-memory vault'
  const writable = options.writable !== false
  const files = new Map<NotePath, MemoryEntry>()

  // Seed entry `i` gets mtime BASE + i; every later write bumps the clock by 1,
  // so mtimes stay strictly increasing without ever reading the wall clock.
  let clock = BASE_MTIME - 1
  for (const [rawPath, content] of Object.entries(seed)) {
    clock += 1
    files.set(normalizePath(rawPath), {
      content,
      blob: null,
      mtime: clock,
      size: encoder.encode(content).length,
    })
  }
  const nextMtime = (): number => (clock += 1)

  function assertWritable(): void {
    if (!writable) throw new Error(`The "${name}" vault is read-only.`)
  }

  function mustGet(path: NotePath): { path: NotePath; entry: MemoryEntry } {
    const normalized = normalizePath(path)
    const entry = files.get(normalized)
    if (!entry) throw new Error(`File not found: ${normalized}`)
    return { path: normalized, entry }
  }

  return {
    kind: 'demo',
    name,
    writable,

    async list(): Promise<VaultFile[]> {
      const out: VaultFile[] = []
      for (const [path, entry] of files) out.push(toVaultFile(path, entry.size, entry.mtime))
      return out.sort((a, b) => comparePaths(a.path, b.path))
    },

    async read(path: NotePath): Promise<string> {
      const { entry } = mustGet(path)
      return entry.blob ? await entry.blob.text() : entry.content
    },

    async readBinary(path: NotePath): Promise<Blob> {
      const { path: normalized, entry } = mustGet(path)
      return entry.blob ?? new Blob([entry.content], { type: mimeTypeOf(normalized) })
    },

    async write(path: NotePath, content: string): Promise<void> {
      assertWritable()
      // There are no real folders in memory, so intermediate folders in `path`
      // need no creating — the normalised path *is* the key.
      files.set(normalizePath(path), {
        content,
        blob: null,
        mtime: nextMtime(),
        size: encoder.encode(content).length,
      })
    },

    async writeBinary(path: NotePath, data: Blob): Promise<void> {
      assertWritable()
      files.set(normalizePath(path), { content: '', blob: data, mtime: nextMtime(), size: data.size })
    },

    async remove(path: NotePath): Promise<void> {
      assertWritable()
      const { path: normalized } = mustGet(path)
      files.delete(normalized)
    },

    async rename(from: NotePath, to: NotePath): Promise<void> {
      assertWritable()
      const { path: source, entry } = mustGet(from)
      const target = normalizePath(to)
      if (target === source) return
      if (files.has(target)) throw new Error(`Cannot rename to ${target}: that file already exists.`)
      files.delete(source)
      files.set(target, { ...entry, mtime: nextMtime() })
    },

    async exists(path: NotePath): Promise<boolean> {
      try {
        return files.has(normalizePath(path))
      } catch {
        // An invalid path simply does not exist; `exists` never throws.
        return false
      }
    },
  }
}
