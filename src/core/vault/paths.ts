/**
 * Shared path helpers for the vault adapters.
 *
 * Vault paths are always POSIX, always relative to the vault root and never
 * contain `.`/`..` segments — every adapter funnels user input through
 * `normalizePath` before touching storage so that a path can never escape the
 * vault, and so that `notes/A.md`, `./notes/A.md` and `/notes//A.md` all address
 * the same file.
 */
import type { NotePath, VaultFile } from '../../types'

/** The one extension SpaceFore treats as a note. Everything else is an attachment. */
const MARKDOWN_EXTENSION = 'md'

/** Best-effort content types, used when handing a stored file back as a `Blob`. */
const MIME_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
}

/**
 * Normalise an arbitrary path to the canonical vault form.
 *
 * - `\` is treated as a separator (paths pasted from Windows).
 * - Leading `/`, leading `./`, repeated `//` and inner `.` segments are dropped.
 * - A `..` segment throws: adapters must never be able to walk out of the vault.
 * - An empty path throws — every adapter call needs a real file to act on.
 */
export function normalizePath(path: string): NotePath {
  if (typeof path !== 'string') {
    throw new Error('Invalid path: expected a string')
  }
  const segments: string[] = []
  for (const segment of path.replace(/\\/g, '/').trim().split('/')) {
    // Empty segments come from a leading `/`, a trailing `/` or a `//` run.
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new Error(`Invalid path "${path}": ".." segments are not allowed`)
    }
    segments.push(segment)
  }
  if (segments.length === 0) {
    throw new Error(`Invalid path "${path}": the path is empty`)
  }
  return segments.join('/')
}

/** True when `path` fails `normalizePath` (traversal, empty, non-string). */
export function isValidPath(path: string): boolean {
  try {
    normalizePath(path)
    return true
  } catch {
    return false
  }
}

/** Last segment of the path, extension included: `a/b/note.md` -> `note.md`. */
export function baseName(path: string): string {
  const posix = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return posix.slice(posix.lastIndexOf('/') + 1)
}

/** Everything before the last segment: `a/b/note.md` -> `a/b`, `note.md` -> `''`. */
export function dirName(path: string): string {
  const posix = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = posix.lastIndexOf('/')
  return slash === -1 ? '' : posix.slice(0, slash)
}

/**
 * Lowercased extension without the dot; `''` when there is none.
 * A leading dot does not make an extension, so `.gitignore` has none.
 */
export function extensionOf(path: string): string {
  const base = baseName(path)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** Last segment without its extension: `a/b/note.md` -> `note`. */
export function stemOf(path: string): string {
  const base = baseName(path)
  const extension = extensionOf(path)
  return extension === '' ? base : base.slice(0, base.length - extension.length - 1)
}

/** True for `.md` files (case-insensitive). Attachments are everything else. */
export function isMarkdown(path: string): boolean {
  return extensionOf(path) === MARKDOWN_EXTENSION
}

/**
 * `VaultFile.name`: notes drop the `.md`, attachments keep their extension.
 */
export function displayName(path: string): string {
  return isMarkdown(path) ? stemOf(path) : baseName(path)
}

/** Join and normalise. Empty parts are ignored; no parts at all yields `''`. */
export function joinPath(...parts: string[]): NotePath {
  const joined = parts.filter((part) => typeof part === 'string' && part !== '').join('/')
  return joined === '' ? '' : normalizePath(joined)
}

/** The folder segments a path lives in: `a/b/note.md` -> `['a', 'b']`. */
export function pathSegments(path: string): string[] {
  const dir = dirName(normalizePath(path))
  return dir === '' ? [] : dir.split('/')
}

/**
 * Deterministic path ordering.
 *
 * Deliberately a plain code-unit comparison rather than `localeCompare`, so the
 * order a vault lists in never depends on the host's ICU data.
 */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Content type for a path, used when adapters synthesise a `Blob`. */
export function mimeTypeOf(path: string): string {
  return MIME_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/** Build the `VaultFile` an adapter's `list()` reports for a stored file. */
export function toVaultFile(path: NotePath, size: number, mtime: number): VaultFile {
  const normalized = normalizePath(path)
  return {
    path: normalized,
    name: displayName(normalized),
    extension: extensionOf(normalized),
    isMarkdown: isMarkdown(normalized),
    size,
    mtime,
  }
}
