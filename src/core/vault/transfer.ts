/**
 * Taking a whole vault out, and putting one back.
 *
 * "Export the vault as JSON" wrote `state.notes` and nothing else, in two
 * separately maintained copies of the same object literal. A vault is not only
 * its notes: images and PDFs sit beside them and are what `![[diagram.png]]`
 * points at. Exporting a folder vault and importing it into a browser vault
 * therefore produced a vault of broken images, silently, from a button whose
 * whole purpose is to be a way of not losing anything.
 *
 * So attachments travel too, base64 inside the same file. That is about a third
 * larger than the bytes themselves, which is the price of one file you can hand
 * to anything; a vault with big images makes a big export, and it says so when
 * it finishes.
 *
 * Older exports have no `attachments` key at all and still read correctly —
 * they are just an export whose vault had none.
 */
import type { NotePath, VaultAdapter, VaultFile } from '../../types'

import { mimeTypeOf, normalizePath } from './paths'

/** The file the export button writes. */
export interface VaultExport {
  vault: string
  exportedAt: string
  /** Path → Markdown source. */
  notes: Record<string, string>
  /** Path → base64 of the file's bytes. Absent when the vault had none. */
  attachments?: Record<string, string>
}

/** What an import file turned out to hold. */
export interface ParsedImport {
  notes: [NotePath, string][]
  attachments: [NotePath, Blob][]
  /** Attachments that were in the file but could not be decoded. */
  unreadable: NotePath[]
}

/**
 * Base64 for a blob's bytes.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte into an
 * argument list, and a few hundred kilobytes of them overflows the call stack —
 * which would mean the export working for small images and throwing on exactly
 * the large ones people most want to keep.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** The blob a base64 string stands for, typed by the path's extension. */
export function base64ToBlob(data: string, path: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeTypeOf(path) })
}

/** What `buildExport` needs to know, which is less than the whole store. */
export interface ExportSource {
  vaultName: string
  notes: Map<NotePath, { content: string }>
  attachments: VaultFile[]
  adapter: VaultAdapter | null
}

/** The result, plus what could not be included. */
export interface BuiltExport {
  payload: VaultExport
  /** Attachments the adapter would not hand over; named so a person can check. */
  skipped: NotePath[]
}

/**
 * Assemble the export file.
 *
 * An attachment the adapter cannot read is skipped rather than thrown, because
 * losing the export of two hundred notes to one unreadable image is the worse
 * outcome — but it is named in `skipped` so nobody is told a complete backup
 * was made when it was not.
 */
export async function buildExport(source: ExportSource): Promise<BuiltExport> {
  const payload: VaultExport = {
    vault: source.vaultName || 'SpaceFore',
    exportedAt: new Date().toISOString(),
    notes: Object.fromEntries([...source.notes].map(([path, note]) => [path, note.content])),
  }

  const attachments: Record<string, string> = {}
  const skipped: NotePath[] = []
  for (const file of source.attachments) {
    if (!source.adapter) {
      skipped.push(file.path)
      continue
    }
    try {
      attachments[file.path] = await blobToBase64(await source.adapter.readBinary(file.path))
    } catch {
      skipped.push(file.path)
    }
  }
  // Left out entirely when there are none, so an export of a notes-only vault
  // is byte-for-byte the shape it has always been.
  if (Object.keys(attachments).length > 0) payload.attachments = attachments

  return { payload, skipped }
}

/**
 * Read an import file, in any of the shapes this app has ever written.
 *
 * Junk is skipped rather than thrown on: a file with one bad entry should still
 * restore the other nine hundred.
 */
export function parseImport(data: unknown): ParsedImport {
  const object = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null
  const source = object && 'notes' in object ? object.notes : data

  const notes: [NotePath, string][] = []
  const unreadable: NotePath[] = []
  const pushNote = (path: unknown, content: unknown): void => {
    if (typeof path !== 'string' || path.trim() === '') return
    if (typeof content !== 'string') return
    // The file may have been written by anything. A path the vault cannot
    // hold (`../outside.md`) would become a note that shows as unsaved and can
    // never be saved; it is named as lost instead, like an unreadable image.
    try {
      notes.push([normalizePath(path.trim()), content])
    } catch {
      unreadable.push(path.trim())
    }
  }

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as { path?: unknown; content?: unknown }
      pushNote(record.path, record.content)
    }
  } else if (source !== null && typeof source === 'object') {
    for (const [path, content] of Object.entries(source as Record<string, unknown>)) pushNote(path, content)
  }

  const attachments: [NotePath, Blob][] = []
  const raw = object?.attachments
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [path, encoded] of Object.entries(raw as Record<string, unknown>)) {
      const trimmed = typeof path === 'string' ? path.trim() : ''
      if (trimmed === '' || typeof encoded !== 'string') continue
      try {
        attachments.push([trimmed, base64ToBlob(encoded, trimmed)])
      } catch {
        // `atob` throws on anything that is not base64. Name it rather than
        // dropping it: a missing image is otherwise indistinguishable from one
        // the vault never had.
        unreadable.push(trimmed)
      }
    }
  }

  return { notes, attachments, unreadable }
}
