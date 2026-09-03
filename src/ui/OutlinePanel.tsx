/**
 * SpaceLink — the outline pane.
 *
 * A flat list of the active note's headings, indented purely through
 * `data-level` so the rendered order is also the reading order. The heading
 * tree is already computed by the markdown layer; this component only decides
 * what is visible (the filter) and what is current.
 *
 * "Current" is not something the outline can know on its own — it depends on
 * where the reader is in the note — so it listens for `spacelink:preview-scroll`
 * events carrying `{ path, slug }`. Until one arrives (or when it names another
 * note) nothing is highlighted, which is the honest answer.
 *
 * Clicking a heading fires `spacelink:reveal-heading` for the editor/preview to
 * act on, and brings the pane showing that note back to the front so the
 * keyboard lands where the reader is now looking.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { HeadingRef, NotePath } from '../types'
import { useAppStore } from '../state/store'

/** Stable identity for "this note has no headings", so memos do not churn. */
const NO_HEADINGS: readonly HeadingRef[] = []

/** Case-insensitive substring match on the heading text. */
export function filterHeadings(headings: readonly HeadingRef[], filter: string): HeadingRef[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return [...headings]
  return headings.filter((heading) => heading.text.toLowerCase().includes(needle))
}

/**
 * Move DOM focus into a pane after the outline sends it somewhere.
 *
 * The pane element itself is not focusable, so focus goes to whatever is
 * showing the note. Everything here is optional: a pane that is not mounted, or
 * a jsdom element without `focus`, simply does nothing.
 */
function focusPaneElement(paneId: string): void {
  if (typeof document === 'undefined' || !/^[\w-]+$/.test(paneId)) return
  const pane = document.querySelector(`[data-pane-id="${paneId}"]`)
  const target = pane?.querySelector('.cm-content, .preview-host, .pane-content') ?? null
  if (target instanceof HTMLElement && typeof target.focus === 'function') target.focus()
}

export interface OutlinePanelProps {
  path: NotePath
}

export function OutlinePanel({ path }: OutlinePanelProps): JSX.Element {
  const note = useAppStore((state) => state.notes.get(path))
  const [filter, setFilter] = useState('')
  const [activeSlug, setActiveSlug] = useState<string | null>(null)

  const headings = note?.parsed.headings ?? NO_HEADINGS
  const visible = useMemo(() => filterHeadings(headings, filter), [headings, filter])

  // Follow the reader. A new note starts with no highlight until the view that
  // is showing it reports a position, and events for other notes are ignored.
  useEffect(() => {
    setActiveSlug(null)
    if (typeof window === 'undefined') return undefined
    const onScroll = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail as
        | { path?: unknown; slug?: unknown }
        | null
        | undefined
      if (!detail || typeof detail !== 'object') return
      if (detail.path !== path) return
      setActiveSlug(typeof detail.slug === 'string' && detail.slug ? detail.slug : null)
    }
    window.addEventListener('spacelink:preview-scroll', onScroll)
    return () => window.removeEventListener('spacelink:preview-scroll', onScroll)
  }, [path])

  /** Bring the pane showing this note forward, so the reveal has somewhere to land. */
  const focusPane = useCallback((): void => {
    const state = useAppStore.getState()
    for (const pane of state.panes) {
      const tab = pane.tabs.find((candidate) => candidate.kind === 'note' && candidate.path === path)
      if (!tab) continue
      if (pane.activeTabId !== tab.id || state.activePaneId !== pane.id) state.setActiveTab(pane.id, tab.id)
      focusPaneElement(pane.id)
      return
    }
  }, [path])

  const reveal = useCallback(
    (heading: HeadingRef): void => {
      // Highlight immediately: the click is itself a statement about where the
      // reader is, and the scroll event that confirms it may never arrive.
      setActiveSlug(heading.slug)
      if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('spacelink:reveal-heading', {
            detail: { path, slug: heading.slug, line: heading.line },
          }),
        )
      }
      focusPane()
    },
    [focusPane, path],
  )

  const trimmed = filter.trim()

  return (
    <div className="outline-panel panel">
      <div className="panel-header">
        <span>Outline</span>
        <span className="tag-count" title={`${headings.length} heading${headings.length === 1 ? '' : 's'}`}>
          {trimmed ? `${visible.length}/${headings.length}` : headings.length}
        </span>
      </div>

      {headings.length > 0 && (
        <div className="search-toolbar">
          <input
            className="search-input"
            type="text"
            value={filter}
            spellCheck={false}
            autoComplete="off"
            placeholder="Filter headings…"
            aria-label="Filter headings"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      <div className="panel-body">
        {headings.length === 0 ? (
          <div className="empty-state">
            <p>No headings in this note.</p>
            <p>
              Start a line with <code>#</code> to add one.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <p>No headings match “{trimmed}”.</p>
          </div>
        ) : (
          <div className="outline-list">
            {visible.map((heading) => {
              const isActive = activeSlug !== null && heading.slug === activeSlug
              return (
                <button
                  type="button"
                  key={`${heading.line}:${heading.slug}`}
                  className={isActive ? 'outline-item is-active' : 'outline-item'}
                  data-level={heading.level}
                  data-slug={heading.slug}
                  aria-current={isActive ? 'true' : undefined}
                  title={heading.text}
                  onClick={() => reveal(heading)}
                >
                  {heading.text}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default OutlinePanel
