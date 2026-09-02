/**
 * Getting a file *into* the vault.
 *
 * The app could show `![[diagram.png]]` from a folder that already had one, but
 * there was no way to add a picture from inside it — no paste, no drop. In a
 * notes application that is most of what attachments are for: you take a
 * screenshot and put it in the note you are writing. A browser vault had no way
 * to acquire an image at all.
 *
 * This is only the naming, which is the part with the sharp edges. Writing is
 * the store's job.
 */
import type { NotePath } from '../../types'

import { extensionOf, normalizePath } from './paths'

/** Where attachments go when the settings say nothing else. */
export const DEFAULT_ATTACHMENT_FOLDER = 'attachments'

/** Extensions the preview renders inline as `![[…]]`. Mirrors the renderer. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'])

/** The generic names browsers give a pasted screenshot, which say nothing. */
const ANONYMOUS = new Set(['', 'image', 'image.png', 'blob', 'unknown', 'file'])

/** Whether the preview can show this inline. */
export function isImageAttachment(file: { name?: string; type?: string }): boolean {
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true
  return IMAGE_EXTENSIONS.has(extensionOf(file.name ?? ''))
}

/** `YYYYMMDDHHmmss`, the stamp Obsidian uses for a pasted image. */
function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  )
}

/** The extension a file should keep, from its name or failing that its type. */
function extensionFor(file: { name?: string; type?: string }): string {
  const fromName = extensionOf(file.name ?? '')
  if (fromName) return fromName
  const subtype = (file.type ?? '').split('/')[1] ?? ''
  // `image/svg+xml` and friends carry more than the extension.
  const cleaned = subtype.split('+')[0]!.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return cleaned === 'jpeg' ? 'jpg' : cleaned
}

/**
 * A file name for something being attached.
 *
 * A dropped file keeps the name it arrived with, because that is what the
 * person will look for later. A pasted screenshot does not have one — every
 * browser calls it `image.png` — so it gets a timestamp instead, which is both
 * unique and tells you when you took it.
 */
export function attachmentName(file: { name?: string; type?: string }, at: Date = new Date()): string {
  const given = (file.name ?? '').trim()
  const extension = extensionFor(file) || 'bin'
  if (given === '' || ANONYMOUS.has(given.toLowerCase())) {
    return `Pasted image ${stamp(at)}.${extension}`
  }

  // Strip anything a path could be built out of, then keep the extension the
  // file actually has rather than whatever the name claims after sanitising.
  const dot = given.lastIndexOf('.')
  const base = (dot > 0 ? given.slice(0, dot) : given)
    .replace(/[\\/:*?"<>|#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return `${base || 'Attachment'}.${extension}`
}

/**
 * A path for `name` in `folder` that collides with nothing.
 *
 * Uniqueness is over the whole vault's *file names*, not just this folder, and
 * that is deliberate: what gets written into the note is the bare name, and the
 * renderer resolves a bare name by looking anywhere in the vault. Two files
 * called `chart.png` in different folders would make that lookup a coin toss.
 */
export function uniqueAttachmentPath(folder: string, name: string, taken: Iterable<string>): NotePath {
  const names = new Set<string>()
  for (const path of taken) {
    const normalized = normalizePath(path)
    names.add(normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase())
  }

  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  // `normalizePath` refuses an empty path, and an empty folder is a legitimate
  // answer here: it means the vault root.
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '')
  const directory = trimmed === '' ? '' : normalizePath(trimmed)

  let candidate = name
  for (let suffix = 1; names.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${base} ${suffix}${extension}`
  }
  return normalizePath(directory ? `${directory}/${candidate}` : candidate)
}

/**
 * What to type into the note.
 *
 * The bare name, not the path: it is what the renderer resolves, what Obsidian
 * writes, and what stays correct if the file is later moved. `uniqueAttachmentPath`
 * is what makes a bare name safe.
 */
export function embedTextFor(path: NotePath, file: { name?: string; type?: string }): string {
  const name = normalizePath(path).slice(normalizePath(path).lastIndexOf('/') + 1)
  // Only an image renders inline; anything else would show as a missing embed,
  // so it goes in as an ordinary link instead.
  return isImageAttachment({ name, type: file.type }) ? `![[${name}]]` : `[[${name}]]`
}
