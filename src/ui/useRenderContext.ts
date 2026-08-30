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
 * The cache is module-level on purpose — it is keyed by vault *and* path, so
 * two panes showing the same image share one object URL, switching tabs does
 * not re-read the file, and `img/logo.png` in one vault is never served for
 * `img/logo.png` in the next one. It is bounded; the URL of an evicted entry —
 * or of a vault that is no longer open — is revoked so the blob can be
 * collected.
 */
import { useEffect, useMemo, useReducer } from 'react'

import type { Note, NotePath, VaultAdapter, VaultFile, VaultIndex } from '../types'
import type { RenderContext } from '../core/markdown/render'
import { onMathReady } from '../core/markdown/render'
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

/** `<vault id>\0<path>` -> `blob:`/`data:` URL. Insertion ordered, so the first key is the oldest. */
const assetCache = new Map<string, string>()
/** Reads in progress, so a re-render does not queue the same file twice. */
const inFlight = new Set<string>()
/** Files the adapter could not hand us. Never retried — `resolveAsset` runs on every render. */
const unavailable = new Set<string>()
/** Mounted hooks waiting to be told that the cache changed. */
const listeners = new Set<() => void>()

/**
 * One id per adapter *instance*, so a different vault — and reopening the same
 * folder, which `reloadVault` does — gets its own keyspace instead of inheriting
 * whatever the previous vault cached under the same path.
 */
const vaultIds = new WeakMap<VaultAdapter, number>()
let nextVaultId = 0
/** Key prefix of the vault currently on screen. `\0` alone means "no vault". */
let activePrefix = '\u0000'

function vaultPrefix(adapter: VaultAdapter | null): string {
  if (!adapter) return '\u0000'
  let id = vaultIds.get(adapter)
  if (id === undefined) {
    nextVaultId += 1
    id = nextVaultId
    vaultIds.set(adapter, id)
  }
  return `${id}\u0000`
}

/**
 * Point the cache at `adapter` and throw away what the vault before it left
 * behind, revoking its object URLs. Idempotent, so every mounted hook can call
 * it while its context is being rebuilt.
 */
function activateVault(adapter: VaultAdapter | null): string {
  const prefix = vaultPrefix(adapter)
  if (prefix === activePrefix) return prefix
  activePrefix = prefix
  for (const [key, url] of [...assetCache]) {
    if (key.startsWith(prefix)) continue
    assetCache.delete(key)
    revokeAsset(url)
  }
  for (const key of [...unavailable]) {
    if (!key.startsWith(prefix)) unavailable.delete(key)
  }
  return prefix
}

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

function cacheAsset(key: string, url: string): void {
  const previous = assetCache.get(key)
  if (previous && previous !== url) revokeAsset(previous)
  assetCache.set(key, url)
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
function loadAsset(adapter: VaultAdapter, key: string, path: NotePath): void {
  if (assetCache.has(key) || inFlight.has(key) || unavailable.has(key)) return
  inFlight.add(key)
  void (async () => {
    try {
      const blob = await adapter.readBinary(path)
      const url = await blobToUrl(blob, path)
      // The vault can be swapped while the read is in flight; that URL now
      // belongs to a vault nobody is looking at, so it is revoked, not kept.
      if (key.startsWith(activePrefix)) cacheAsset(key, url)
      else revokeAsset(url)
    } catch {
      unavailable.add(key)
    } finally {
      inFlight.delete(key)
      notifyAssetListeners()
    }
  })()
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

/** Deepest `![[Note]]` nesting the renderer follows. Mirrors `MAX_EMBED_DEPTH` in render.ts. */
const MAX_EMBED_DEPTH = 3

/**
 * The text of every note this one transcludes, transitively. `getEmbedContent`
 * is the only thing the context reads out of the notes map, so *this* — not the
 * map's identity, which `setNoteContent` replaces on every keystroke anywhere
 * in the vault — is what the context has to be memoised on. Typing in an
 * unrelated note leaves it byte for byte the same, and the previews of notes
 * that did not change are not re-rendered.
 */
function embedSignature(
  currentPath: NotePath,
  notes: Map<NotePath, Note>,
  index: VaultIndex,
): string {
  const parts: string[] = []
  const seen = new Set<NotePath>([currentPath])
  let frontier: NotePath[] = [currentPath]
  for (let depth = 0; depth < MAX_EMBED_DEPTH && frontier.length > 0; depth += 1) {
    const next: NotePath[] = []
    for (const from of frontier) {
      const source = notes.get(from)
      if (!source) continue
      for (const link of source.parsed.links) {
        // An `![[image.png]]` embed resolves to no note, so it drops out here.
        if (!link.embed || !link.target) continue
        const target = resolveLinkTarget(link.target, from, index)
        if (!target || seen.has(target)) continue
        seen.add(target)
        const embedded = notes.get(target)
        if (!embedded) continue
        parts.push(target, embedded.content)
        next.push(target)
      }
    }
    frontier = next
  }
  return parts.join('\u0000')
}

/**
 * The `RenderContext` for a note, memoised on everything the renderer can
 * observe: the note being rendered, the link index, the text of the notes it
 * transcludes, the attachment list and the asset cache generation. A new object
 * identity is exactly the signal a consumer needs to re-render.
 */
export function useRenderContext(currentPath: NotePath): RenderContext {
  const index = useAppStore((state) => state.index)
  const attachments = useAppStore((state) => state.attachments)
  const adapter = useAppStore((state) => state.adapter)
  const embeds = useAppStore((state) => embedSignature(currentPath, state.notes, state.index))

  // Bumped when a pending asset read finishes, which re-runs the memo below
  // and hands the consumer a fresh context that now resolves the asset.
  const [assetTick, bumpAssetTick] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    listeners.add(bumpAssetTick)
    return () => {
      listeners.delete(bumpAssetTick)
    }
  }, [])

  // The same idea for mathematics: KaTeX is fetched the first time a note
  // actually contains a `$…$`, and its arrival has to reach the preview that
  // rendered the TeX as text a moment ago.
  useEffect(() => onMathReady(bumpAssetTick), [])

  const attachmentIndex = useMemo(() => buildAttachmentIndex(attachments), [attachments])

  return useMemo<RenderContext>(() => {
    // `assetTick` and `embeds` are never read here: they exist so that a
    // finished asset read, or an edit to a transcluded note, produces a brand
    // new context object, which is what makes the consumer re-render and ask
    // again.
    void assetTick
    void embeds
    const prefix = activateVault(adapter)
    return {
      currentPath,
      resolveLink: (target, fromPath) => resolveLinkTarget(target, fromPath, index),
      // Read live rather than closing over the map: `embeds` above already
      // decides when a transclusion has actually changed.
      getEmbedContent: (path) => useAppStore.getState().notes.get(path)?.content ?? null,
      resolveAsset: (target, fromPath) => {
        const raw = target.trim()
        if (!raw) return null
        // Already a URL (remote image, inline data URI): hand it straight over.
        if (HAS_SCHEME.test(raw)) return raw

        const path = resolveAttachment(raw, fromPath, attachmentIndex)
        if (!path) return null

        const key = `${prefix}${path}`
        const cached = assetCache.get(key)
        if (cached) return cached
        if (adapter) loadAsset(adapter, key, path)
        return null
      },
      depth: 0,
    }
  }, [currentPath, index, embeds, attachmentIndex, adapter, assetTick])
}
