/**
 * SpaceFore — the bridge between the store and the markdown renderer.
 *
 * `renderMarkdown` is a pure, *synchronous* function: it asks the
 * `RenderContext` for a link target, an embedded note's text or an asset URL
 * and expects an answer immediately. The store can answer the first two from
 * memory, but an attachment lives behind the async `VaultAdapter`, so this
 * module keeps a small module-level cache of object URLs:
 *
 *   - a hit returns the URL synchronously,
 *   - a miss returns `null`, kicks off the read and, when it lands, notifies
 *     every mounted hook so the component re-renders and asks again.
 *
 * The cache is module-level on purpose — it is keyed by vault path, so two
 * panes showing the same image share one object URL, and switching tabs does
 * not re-read the file. It is bounded; the URL of an evicted entry is revoked
 * so the blob can be collected.
 */
import { useEffect, useMemo, useReducer } from 'react'

import type { NotePath, VaultAdapter, VaultFile } from '../types'
import type { RenderContext } from '../core/markdown/render'
import { resolveLinkTarget } from '../core/graph/index'
import { useAppStore } from '../state/store'

/* ------------------------------------------------------------------ *
 * Path helpers
 * ------------------------------------------------------------------ */

/** Anything with an explicit scheme (`https:`, `data:`, `blob:`) or `//host`. */
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** Collapse `.`/`..` segments and duplicate slashes into a clean POSIX path. */
function normalizePath(path: string): string {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function fileOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function extensionOf(path: string): string {
  const name = fileOf(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Attachment lookup
 * ------------------------------------------------------------------ */

interface AttachmentIndex {
  /** lowercased full path -> real path. */
  byPath: Map<string, NotePath>
  /** lowercased file name (extension included) -> real paths. */
  byName: Map<string, NotePath[]>
}

function buildAttachmentIndex(files: VaultFile[]): AttachmentIndex {
  const byPath = new Map<string, NotePath>()
  const byName = new Map<string, NotePath[]>()
  for (const file of files) {
    const path = normalizePath(file.path)
    byPath.set(path.toLowerCase(), file.path)
    const name = fileOf(path).toLowerCase()
    const bucket = byName.get(name)
    if (bucket) bucket.push(file.path)
    else byName.set(name, [file.path])
  }
  return { byPath, byName }
}

/**
 * Obsidian-style attachment resolution: exact vault path, then the path read
 * relative to the linking note, then a plain file-name match anywhere in the
 * vault (nearest folder wins, ties broken on the shortest path).
 */
function resolveAttachment(
  target: string,
  fromPath: NotePath,
  attachments: AttachmentIndex,
): NotePath | null {
  const clean = normalizePath(target.trim().replace(/\\/g, '/'))
  if (!clean) return null

  const exact = attachments.byPath.get(clean.toLowerCase())
  if (exact) return exact

  const relative = attachments.byPath.get(normalizePath(`${dirOf(fromPath)}/${clean}`).toLowerCase())
  if (relative) return relative

  const candidates = attachments.byName.get(fileOf(clean).toLowerCase())
  if (!candidates || candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!

  const suffix = `/${clean.toLowerCase()}`
  const home = dirOf(fromPath).toLowerCase()
  const ranked = [...candidates].sort((a, b) => {
    // A candidate whose tail matches what was written beats a bare name match.
    const tail = Number(b.toLowerCase().endsWith(suffix)) - Number(a.toLowerCase().endsWith(suffix))
    if (tail !== 0) return tail
    const near = Number(dirOf(b).toLowerCase() === home) - Number(dirOf(a).toLowerCase() === home)
    if (near !== 0) return near
    return a.length - b.length || a.localeCompare(b)
  })
  return ranked[0]!
}

/* ------------------------------------------------------------------ *
 * Asset cache
 * ------------------------------------------------------------------ */

/** Plenty for any realistic note, small enough to bound blob memory. */
const MAX_CACHED_ASSETS = 64

/** vault path -> `blob:`/`data:` URL. Insertion ordered, so the first key is the oldest. */
const assetCache = new Map<NotePath, string>()
/** Reads in progress, so a re-render does not queue the same file twice. */
const inFlight = new Set<NotePath>()
/** Files the adapter could not hand us. Never retried — `resolveAsset` runs on every render. */
const unavailable = new Set<NotePath>()
/** Mounted hooks waiting to be told that the cache changed. */
const listeners = new Set<() => void>()

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

function canCreateObjectURL(): boolean {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
}

function revokeAsset(url: string): void {
  // Only object URLs hold a reference; `data:` URLs are plain strings.
  if (!url.startsWith('blob:')) return
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url)
  }
}

function cacheAsset(path: NotePath, url: string): void {
  const previous = assetCache.get(path)
  if (previous && previous !== url) revokeAsset(previous)
  assetCache.set(path, url)
  while (assetCache.size > MAX_CACHED_ASSETS) {
    const oldest = assetCache.keys().next()
    if (oldest.done) break
    const evicted = assetCache.get(oldest.value)
    assetCache.delete(oldest.value)
    if (evicted) revokeAsset(evicted)
  }
}

/**
 * Turn a blob into something usable in `<img src>`. Object URLs are preferred;
 * environments without them (jsdom, older embedded webviews) fall back to an
 * inline data URL, which DOMPurify allows for image MIME types.
 */
async function blobToUrl(blob: Blob, path: NotePath): Promise<string> {
  if (canCreateObjectURL()) return URL.createObjectURL(blob)
  if (typeof FileReader !== 'function') throw new Error('no way to address a blob here')

  // A typeless blob would encode as `application/octet-stream`, which the
  // sanitizer strips — recover the MIME type from the file extension.
  const guessed = MIME_BY_EXTENSION[extensionOf(path)] ?? ''
  const source = blob.type || !guessed ? blob : new Blob([blob], { type: guessed })
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('could not read attachment'))
    reader.readAsDataURL(source)
  })
}

function notifyAssetListeners(): void {
  // Copy first: a listener may unsubscribe while we iterate.
  for (const listener of [...listeners]) listener()
}

/** Fire-and-forget read. Safe to call during render — nothing happens synchronously. */
function loadAsset(adapter: VaultAdapter, path: NotePath): void {
  if (assetCache.has(path) || inFlight.has(path) || unavailable.has(path)) return
  inFlight.add(path)
  void (async () => {
    try {
      const blob = await adapter.readBinary(path)
      cacheAsset(path, await blobToUrl(blob, path))
    } catch {
      unavailable.add(path)
    } finally {
      inFlight.delete(path)
      notifyAssetListeners()
    }
  })()
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

/**
 * The `RenderContext` for a note, memoised on everything the renderer can
 * observe: the note being rendered, the link index, the note bodies (for
 * transclusion), the attachment list and the asset cache generation. A new
 * object identity is exactly the signal a consumer needs to re-render.
 */
export function useRenderContext(currentPath: NotePath): RenderContext {
  const notes = useAppStore((state) => state.notes)
  const index = useAppStore((state) => state.index)
  const attachments = useAppStore((state) => state.attachments)
  const adapter = useAppStore((state) => state.adapter)

  // Bumped when a pending asset read finishes, which re-runs the memo below
  // and hands the consumer a fresh context that now resolves the asset.
  const [assetTick, bumpAssetTick] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    listeners.add(bumpAssetTick)
    return () => {
      listeners.delete(bumpAssetTick)
    }
  }, [])

  const attachmentIndex = useMemo(() => buildAttachmentIndex(attachments), [attachments])

  return useMemo<RenderContext>(() => {
    // `assetTick` is never read: it exists so that a finished asset read
    // produces a brand new context object, which is what makes the consumer
    // re-render and ask `resolveAsset` again.
    void assetTick
    return {
      currentPath,
      resolveLink: (target, fromPath) => resolveLinkTarget(target, fromPath, index),
      getEmbedContent: (path) => notes.get(path)?.content ?? null,
      resolveAsset: (target, fromPath) => {
        const raw = target.trim()
        if (!raw) return null
        // Already a URL (remote image, inline data URI): hand it straight over.
        if (HAS_SCHEME.test(raw)) return raw

        const path = resolveAttachment(raw, fromPath, attachmentIndex)
        if (!path) return null

        const cached = assetCache.get(path)
        if (cached) return cached
        if (adapter) loadAsset(adapter, path)
        return null
      },
      depth: 0,
    }
  }, [currentPath, index, notes, attachmentIndex, adapter, assetTick])
}
