/**
 * SpaceLink — the reading view.
 *
 * The note is rendered once into an HTML string (already sanitized by
 * `renderMarkdown`) and dropped into the DOM in one go. Everything
 * interactive — wiki links, tags, tasks, embeds, heading anchors — is handled
 * by a single delegated listener on the container rather than by wiring React
 * handlers into the generated markup. That keeps the render path a pure
 * string-in / string-out step, which is what makes it cheap enough to redo on
 * every keystroke in split view.
 */
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { NotePath } from '../types'
import { headingElementId, slugOfHeadingId, slugifyHeading } from '../core/markdown/parse'
import { renderMarkdown } from '../core/markdown/render'
import { useAppStore } from '../state/store'
import { useRenderContext } from './useRenderContext'

/** How long the pointer must rest on a link before its preview card appears. */
const HOVER_DELAY_MS = 400
/** Gap between the cursor and the hover card. */
const HOVER_GAP = 14
/** Keeps the card off the very edge of the viewport when it has to flip. */
const VIEWPORT_MARGIN = 8
const HOVER_MAX_WIDTH = 360

/**
 * Scroll offsets, keyed by pane + note, so switching tabs (which unmounts the
 * component) and coming back lands you where you left off. Module level on
 * purpose: the state has to outlive the component instance.
 */
const scrollPositions = new Map<string, number>()

function scrollKey(paneId: string, path: NotePath): string {
  return `${paneId}\u0000${path}`
}

/**
 * The checkbox marker of a task line: an optional blockquote prefix, the list
 * bullet, then `[ ]` / `[x]`. Captured in three parts so a toggle can rewrite
 * the single marker character and nothing else on the line.
 */
const TASK_MARKER = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** `event.target` narrowed to something we can call `closest()` on. */
function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === 'function' ? (target as Element) : null
}

/** Attribute selector rather than `#id`: heading slugs are not CSS identifiers. */
function idSelector(slug: string): string {
  return `[id="${headingElementId(slug).replace(/["\\]/g, '\\$&')}"]`
}

/** `CustomEvent.detail` narrowed to the loose record the window event contract describes. */
function detailOf(event: Event): Record<string, unknown> | null {
  const detail = (event as CustomEvent<unknown>).detail
  return detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null
}

/** Anchored headings, in document order. Only these can be reported to the outline. */
const HEADING_SELECTOR = 'h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'

/** Renderer-emitted elements that name the note their content came from. */
const OWNER_SELECTOR = '.task-checkbox[data-src],.embed[data-src]'

/** A heading this close to the top of the scroller counts as the one being read. */
const HEADING_TOP_SLACK = 4

function nextFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(handle)
  }
  const handle = setTimeout(callback, 0)
  return () => clearTimeout(handle)
}

/** Point the URL fragment at a heading without letting the browser navigate. */
function updateHash(slug: string): void {
  try {
    if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
      history.replaceState(null, '', `#${slug}`)
    } else if (typeof location !== 'undefined') {
      location.hash = slug
    }
  } catch {
    /* sandboxed frames refuse replaceState — the scroll below still happens */
  }
}

interface HoverCard {
  path: NotePath
  title: string
  excerpt: string
  /** Viewport coordinates of the pointer when the card was requested. */
  x: number
  y: number
}

export interface PreviewProps {
  path: NotePath
  paneId: string
  /** Follow `spacelink:editor-scroll` events from the editor in this pane. */
  scrollSync?: boolean
}

export function Preview({ path, paneId, scrollSync = false }: PreviewProps): JSX.Element {
  const note = useAppStore((state) => state.notes.get(path))
  const revision = useAppStore((state) => state.revision)
  const readableLineLength = useAppStore((state) => state.settings.readableLineLength)
  const ctx = useRenderContext(path)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoveredLink = useRef<Element | null>(null)
  /** Last slug reported to the outline, so an unchanged position stays quiet. */
  const reportedSlug = useRef<string | null>(null)

  const [hover, setHover] = useState<HoverCard | null>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)

  const content = note?.content ?? ''

  /* ---- rendering --------------------------------------------------- */

  // `ctx` is memoised on the vault index, the text of the notes this one
  // transcludes and the asset cache generation, so this recomputes exactly when
  // the output could change: the note's own text, an edit to something it
  // embeds, a vault-wide refresh, or a link/asset resolving differently.
  const html = useMemo(() => {
    if (!note) return ''
    try {
      return renderMarkdown(content, ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `<p class="preview-error">This note could not be rendered: ${escapeHtml(message)}</p>`
    }
  }, [note, content, revision, ctx])

  // React 19 compares the `dangerouslySetInnerHTML` prop by object identity, and
  // then assigns `innerHTML` unconditionally. A fresh `{ __html }` literal on
  // every render therefore rebuilds the whole rendered note — which replaces the
  // element under the pointer (restarting the hover-card timer forever), drops
  // scroll anchoring, and throws away a 16 KB DOM tree for nothing. Memoising
  // the wrapper on `html` lets React skip the write when the markup is unchanged.
  const innerHtml = useMemo(() => ({ __html: html }), [html])

  // The renderer emits `disabled` checkboxes (a preview is not a form), and
  // browsers do not dispatch mouse events on disabled controls. Re-enable them
  // so they can be clicked; the click handler prevents the default toggle and
  // rewrites the markdown instead, keeping the file the single source of truth.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const boxes = host.querySelectorAll<HTMLInputElement>('.task-item input[type="checkbox"]')
    boxes.forEach((box) => {
      if (box.disabled) box.disabled = false
    })
  }, [html])

  /**
   * The note a piece of rendered markup came from. Inside a `![[Note]]`
   * transclusion that is the *embedded* note, not the one on screen: its tasks
   * live in its own file and its wiki links resolved from its own folder, so a
   * click has to act on it rather than on the host.
   *
   * The renderer stamps `data-src` wherever it already knows the answer (task
   * checkboxes; see the contract in core/markdown/render.ts). For everything
   * else the embed chain is walked outermost-first and re-resolved exactly the
   * way `renderNoteEmbed` resolved it, each level relative to the one above.
   * Only the renderer's own elements are trusted to carry `data-src`: a note may
   * contain raw HTML, and `data-*` attributes survive sanitization.
   */
  const ownerOf = useCallback(
    (element: Element | null): NotePath => {
      if (!element) return path
      const stamped = element.closest<HTMLElement>(OWNER_SELECTOR)?.dataset.src
      if (stamped) return stamped

      const chain: HTMLElement[] = []
      for (
        let embed = element.closest<HTMLElement>('.embed');
        embed;
        embed = embed.parentElement?.closest<HTMLElement>('.embed') ?? null
      ) {
        chain.unshift(embed)
      }

      let owner = path
      for (const embed of chain) {
        const href = embed.dataset.href ?? ''
        if (!href) continue
        let next: NotePath | null = null
        try {
          next = ctx.resolveLink(href, owner)
        } catch {
          next = null
        }
        if (next) owner = next
      }
      return owner
    },
    [ctx, path],
  )

  /* ---- hover preview ------------------------------------------------ */

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])

  const hideHover = useCallback(() => {
    cancelHoverTimer()
    hoveredLink.current = null
    setHover(null)
  }, [cancelHoverTimer])

  useEffect(() => cancelHoverTimer, [cancelHoverTimer])

  // Escape and any scroll anywhere in the page dismiss the card. The scroll
  // listener is in the capture phase so it also sees this pane's own scroller.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hideHover()
    }
    const onScroll = (): void => hideHover()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [hideHover])

  // Position the card next to the cursor, flipping it when it would overflow.
  // Runs after the card is in the DOM so its real size is known.
  useLayoutEffect(() => {
    if (!hover) {
      setPlacement(null)
      return
    }
    const rect = cardRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 0
    const height = rect?.height ?? 0
    const viewportWidth = window.innerWidth || 0
    const viewportHeight = window.innerHeight || 0

    let left = hover.x + HOVER_GAP
    let top = hover.y + HOVER_GAP
    if (width > 0 && viewportWidth > 0 && left + width + VIEWPORT_MARGIN > viewportWidth) {
      left = Math.max(VIEWPORT_MARGIN, hover.x - HOVER_GAP - width)
    }
    if (height > 0 && viewportHeight > 0 && top + height + VIEWPORT_MARGIN > viewportHeight) {
      top = Math.max(VIEWPORT_MARGIN, hover.y - HOVER_GAP - height)
    }
    setPlacement({ left, top })
  }, [hover])

  const handleMouseOver = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const link = asElement(event.target)?.closest('.internal-link') ?? null
      if (!link) {
        if (hoveredLink.current) hideHover()
        return
      }
      if (link === hoveredLink.current) return // already tracking this link

      cancelHoverTimer()
      setHover(null)
      hoveredLink.current = link
      // Nothing to preview for a link that points at a note which does not exist.
      if (link.classList.contains('is-unresolved')) return

      const href = (link as HTMLElement).dataset.href ?? ''
      if (!href) return
      // Resolve from the note the link was written in, which inside an embed is
      // not the note on screen — otherwise the card previews a different file
      // from the one the click will open.
      const from = ownerOf(link)
      const x = event.clientX
      const y = event.clientY
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null
        let target: NotePath | null = null
        try {
          target = ctx.resolveLink(href, from)
        } catch {
          target = null
        }
        const targetNote = target ? useAppStore.getState().notes.get(target) : undefined
        if (!targetNote) return
        setHover({
          path: targetNote.path,
          title: targetNote.parsed.title,
          excerpt: targetNote.parsed.excerpt,
          x,
          y,
        })
      }, HOVER_DELAY_MS)
    },
    [cancelHoverTimer, ctx, hideHover, ownerOf],
  )

  const handleMouseOut = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const link = hoveredLink.current
      const related = event.relatedTarget
      // Moving between two children of the same link is not a real mouse-out.
      if (link && related instanceof Node && link.contains(related)) return
      hideHover()
    },
    [hideHover],
  )

  /* ---- scrolling ---------------------------------------------------- */

  const key = scrollKey(paneId, path)

  // Restore on mount / when the note changes. The extra frame covers late
  // layout shifts (images, KaTeX, fonts). Nothing is written on the way out:
  // React swaps the next note's markup in *before* this cleanup runs, so by
  // then the browser has already clamped `scrollTop` against the new, possibly
  // much shorter content — writing that back would destroy the offset
  // `handleScroll` correctly recorded while the old note was on screen.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A note that has just appeared has not reported a reading position yet.
    reportedSlug.current = null
    const saved = scrollPositions.get(key) ?? 0
    if (saved > 0) host.scrollTop = saved
    return nextFrame(() => {
      if (saved > 0 && host.scrollTop !== saved) host.scrollTop = saved
    })
  }, [key])

  /** Tell the outline which heading the reader has reached, once per change. */
  const reportHeading = useCallback(() => {
    const host = hostRef.current
    if (!host) return
    if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return
    const top = host.getBoundingClientRect().top
    let slug = ''
    for (const heading of host.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
      // Headings of a transcluded note belong to that note, not to this one.
      if (heading.closest('.embed')) continue
      if (heading.getBoundingClientRect().top - top > HEADING_TOP_SLACK) break
      slug = slugOfHeadingId(heading.id)
    }
    if (slug === reportedSlug.current) return
    reportedSlug.current = slug
    window.dispatchEvent(new CustomEvent('spacelink:preview-scroll', { detail: { path, slug } }))
  }, [path])

  const handleScroll = useCallback(() => {
    const host = hostRef.current
    if (host) scrollPositions.set(key, host.scrollTop)
    reportHeading()
  }, [key, reportHeading])

  // Split view: mirror the editor's scroll ratio, ignoring other panes.
  useEffect(() => {
    if (!scrollSync) return
    const onEditorScroll = (event: Event): void => {
      const detail = detailOf(event)
      if (!detail) return
      if (detail.paneId !== paneId) return
      const ratio = detail.ratio
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return
      const host = hostRef.current
      if (!host) return
      const range = host.scrollHeight - host.clientHeight
      if (range <= 0) return
      host.scrollTop = Math.max(0, Math.min(1, ratio)) * range
    }
    window.addEventListener('spacelink:editor-scroll', onEditorScroll)
    return () => window.removeEventListener('spacelink:editor-scroll', onEditorScroll)
  }, [paneId, scrollSync])

  /** Bring a heading into view. The note may still be mounting, so retry once. */
  /** Scroll the first element `selector` finds into view — here, or in another pane's preview. */
  const scrollToSelector = useCallback((selector: string) => {
    const find = (): boolean => {
      const local = hostRef.current?.querySelector(selector) ?? null
      // Opening in another pane renders the heading in a different Preview.
      const element = local ?? document.querySelector(`.markdown-preview ${selector}`)
      if (!element) return false
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'start' })
      }
      return true
    }
    if (!find()) nextFrame(() => void find())
  }, [])

  const scrollToHeading = useCallback(
    (slug: string) => {
      if (slug) scrollToSelector(idSelector(slug))
    },
    [scrollToSelector],
  )

  /**
   * Reveal a source line. The reading view has no per-line anchors, so the
   * nearest thing to that line is the heading that owns it; a line above the
   * first heading reveals the top of the note.
   */
  const scrollToLine = useCallback(
    (line: number) => {
      const host = hostRef.current
      if (!host) return
      const headings = useAppStore.getState().notes.get(path)?.parsed.headings ?? []
      let slug = ''
      for (const heading of headings) {
        if (heading.line - 1 > line) break // `heading.line` is 1-based, the event is not
        slug = heading.slug
      }
      if (slug) scrollToHeading(slug)
      else host.scrollTop = 0
    },
    [path, scrollToHeading],
  )

  // Search hits, backlink context lines and the outline all point the reading
  // view at a place in a note. Events naming another note belong to another
  // Preview, so they are ignored here.
  useEffect(() => {
    const onRevealLine = (event: Event): void => {
      const detail = detailOf(event)
      if (!detail || detail.path !== path) return
      const line = detail.line
      if (typeof line !== 'number' || !Number.isFinite(line)) return
      scrollToLine(line)
    }
    const onRevealHeading = (event: Event): void => {
      const detail = detailOf(event)
      if (!detail || detail.path !== path) return
      const slug = detail.slug
      if (typeof slug === 'string' && slug) scrollToHeading(slug)
      else if (typeof detail.line === 'number') scrollToLine(detail.line)
    }
    window.addEventListener('spacelink:reveal-line', onRevealLine)
    window.addEventListener('spacelink:reveal-heading', onRevealHeading)
    return () => {
      window.removeEventListener('spacelink:reveal-line', onRevealLine)
      window.removeEventListener('spacelink:reveal-heading', onRevealHeading)
    }
  }, [path, scrollToHeading, scrollToLine])

  /* ---- interaction -------------------------------------------------- */

  /** Flip `[ ]` <-> `[x]` on exactly the source line the checkbox came from. */
  const toggleTask = useCallback(
    (checkbox: HTMLInputElement) => {
      const store = useAppStore.getState()
      // A checkbox inside a `![[Note]]` embed belongs to the embedded note:
      // toggling it has to rewrite that file, not the one being displayed.
      const owner = ownerOf(checkbox)
      const current = store.notes.get(owner)
      if (!current) return
      // `data-line` is a 0-based index into the ORIGINAL source of `owner`,
      // frontmatter included, so no offset maths is needed here.
      const line = Number(checkbox.dataset.line)
      if (!Number.isInteger(line) || line < 0) return

      const lines = current.content.split('\n')
      const source = lines[line]
      if (source === undefined) return
      const rewritten = source.replace(
        TASK_MARKER,
        (_match, prefix: string, mark: string, suffix: string) =>
          `${prefix}${mark === ' ' ? 'x' : ' '}${suffix}`,
      )
      if (rewritten === source) return // not a task line after all — leave it alone
      lines[line] = rewritten
      store.setNoteContent(owner, lines.join('\n'))
    },
    [ownerOf],
  )

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const store = useAppStore.getState()
      store.setActivePane(paneId) // clicking anywhere in the pane focuses it
      hideHover()

      const target = asElement(event.target)
      if (!target) return
      const newTab = event.metaKey || event.ctrlKey

      const checkbox = target.closest('.task-item input[type="checkbox"]')
      if (checkbox) {
        // The markdown decides what is checked, not the DOM.
        event.preventDefault()
        toggleTask(checkbox as HTMLInputElement)
        return
      }

      const tag = target.closest('.tag')
      if (tag) {
        event.preventDefault()
        const name = (tag as HTMLElement).dataset.tag ?? (tag.textContent ?? '').replace(/^#/, '')
        if (!name) return
        // `setSidebarPanel` toggles, so only call it when search is not showing.
        if (store.sidebarPanel !== 'search') store.setSidebarPanel('search')
        store.setSearchQuery(`tag:${name}`)
        return
      }

      const link = target.closest('.internal-link')
      if (link) {
        event.preventDefault()
        const anchor = link as HTMLElement
        const href = anchor.dataset.href ?? ''
        if (!href) return
        const heading = anchor.dataset.heading ?? ''
        // Navigate from the note the link was written in — the same origin the
        // renderer resolved it against — so a homonym cannot open one note in
        // the embed and a different one on click.
        const opened = store.openLink(href, ownerOf(anchor), { newTab })
        if (heading) {
          void Promise.resolve(opened).then(() => scrollToHeading(slugifyHeading(heading)))
        } else {
          void opened
        }
        return
      }

      const embedTitle = target.closest('.embed-title')
      if (embedTitle) {
        event.preventDefault()
        const embed = embedTitle.closest('.embed') as HTMLElement | null
        const href = embed?.dataset.href ?? ''
        // The `![[…]]` was written in whatever note *contains* this embed, so
        // the origin is the owner of its parent, not of the embed itself.
        if (href) void store.openLink(href, ownerOf(embed?.parentElement ?? null), { newTab })
        return
      }

      const anchor = target.closest('a') as HTMLAnchorElement | null
      if (!anchor) return
      // External links are plain anchors with target=_blank — let the browser go.
      if (anchor.classList.contains('external-link')) return

      const href = anchor.getAttribute('href') ?? ''
      if (href.startsWith('#')) {
        // Heading anchors and footnote refs: move the fragment and scroll, but
        // never let the SPA navigate.
        event.preventDefault()
        if (href.length > 1) {
          let slug = href.slice(1)
          try {
            slug = decodeURIComponent(slug)
          } catch {
            /* a malformed escape is used verbatim */
          }
          updateHash(slug)
          // A heading's `#` carries the bare slug and the heading's id is the
          // prefixed form of it; a footnote ref names its target's id as is.
          if (anchor.classList.contains('heading-anchor')) scrollToHeading(slug)
          else scrollToSelector(`[id="${slug.replace(/["\\]/g, '\\$&')}"]`)
        }
      }
    },
    [hideHover, ownerOf, paneId, scrollToHeading, scrollToSelector, toggleTask],
  )

  /* ---- output ------------------------------------------------------- */

  const hostClass = `preview-host${readableLineLength ? ' is-readable-width' : ''}`

  if (!note || content.trim() === '') {
    return (
      <div className={hostClass} ref={hostRef} data-pane={paneId} onClick={handleClick}>
        <div className="pane-empty empty-state">
          {note ? (
            <>
              <p className="pane-empty-title">This note is empty.</p>
              <p>Switch to editing to start writing.</p>
            </>
          ) : (
            <>
              <p className="pane-empty-title">Nothing to preview.</p>
              <p>{path ? `${path} is not in this vault.` : 'Open a note to see it rendered here.'}</p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={hostClass}
      ref={hostRef}
      data-pane={paneId}
      onClick={handleClick}
      onScroll={handleScroll}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
      onMouseLeave={hideHover}
    >
      <div className="markdown-preview" dangerouslySetInnerHTML={innerHtml} />
      {hover ? (
        <div
          className="hover-preview"
          ref={cardRef}
          role="tooltip"
          data-path={hover.path}
          // Computed geometry: the card tracks the pointer, so it cannot live
          // in the stylesheet. `fixed` keeps it out of the scroller's flow.
          style={{
            position: 'fixed',
            left: placement?.left ?? hover.x + HOVER_GAP,
            top: placement?.top ?? hover.y + HOVER_GAP,
            maxWidth: HOVER_MAX_WIDTH,
          }}
        >
          <div className="hover-preview-title">{hover.title}</div>
          {hover.excerpt ? <div className="hover-preview-excerpt">{hover.excerpt}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

export default Preview
