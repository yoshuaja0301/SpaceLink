/**
 * SpaceFore — starred notes and recent files.
 *
 * The store owns *which* notes are starred (`starred`, persisted with the rest
 * of the app state); it has no action for re-ordering them, so the order the
 * user drags into lives here, in its own localStorage key. Keeping it separate
 * means a note starred from anywhere else in the app still shows up — it simply
 * lands at the end of the list until it is dragged somewhere.
 *
 * Underneath sits the recently-opened list, which is pure store state and needs
 * no persistence of its own.
 */
import type { DragEvent as ReactDragEvent, JSX } from 'react'
import { useCallback, useMemo, useState } from 'react'

import type { NotePath } from '../types'
import { basename, useAppStore } from '../state/store'
import { Icon } from './Icon'

const ORDER_KEY = 'spacefore.starredOrder'
/** How many entries the "Recent files" section shows. */
export const RECENT_LIMIT = 15

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

export function loadStarredOrder(): NotePath[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}

function saveStarredOrder(order: readonly NotePath[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order))
  } catch {
    /* private mode / quota — the order just does not survive the reload */
  }
}

/**
 * Apply the remembered order to the store's starred list.
 *
 * Paths the user has never dragged have no rank and keep their store order at
 * the end of the list; ranks for notes that are no longer starred are ignored.
 * `Array.prototype.sort` is stable, so equal ranks preserve that order exactly.
 */
export function orderStarred(starred: readonly NotePath[], order: readonly NotePath[]): NotePath[] {
  const rank = new Map<NotePath, number>()
  order.forEach((path, at) => {
    if (!rank.has(path)) rank.set(path, at)
  })
  return [...starred].sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra === undefined && rb === undefined) return 0
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}

/** Move `from` to sit at index `to`, the way a drag-and-drop reorder reads. */
export function moveStarred(list: readonly NotePath[], from: number, to: number): NotePath[] {
  const next = [...list]
  if (from < 0 || from >= next.length) return next
  const moved = next.splice(from, 1)[0]
  if (moved === undefined) return next
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
  return next
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function StarredPanel(): JSX.Element {
  const notes = useAppStore((s) => s.notes)
  const starred = useAppStore((s) => s.starred)
  const recent = useAppStore((s) => s.recent)
  const openPath = useAppStore((s) => s.openPath)
  const toggleStar = useAppStore((s) => s.toggleStar)
  const setHoveredPath = useAppStore((s) => s.setHoveredPath)

  const [order, setOrder] = useState<NotePath[]>(loadStarredOrder)
  const [dragPath, setDragPath] = useState<NotePath | null>(null)
  const [dropTarget, setDropTarget] = useState<NotePath | null>(null)

  const ordered = useMemo(() => orderStarred(starred, order), [starred, order])
  const recentPaths = useMemo(() => recent.slice(0, RECENT_LIMIT), [recent])

  /** Title as the note itself calls it, falling back to the file name. */
  const titleOf = useCallback(
    (path: NotePath): string => notes.get(path)?.parsed.title || basename(path),
    [notes],
  )

  /* -- reordering ---------------------------------------------------- */

  const commitOrder = useCallback((next: NotePath[]): void => {
    setOrder(next)
    saveStarredOrder(next)
  }, [])

  const handleDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>, path: NotePath): void => {
    event.dataTransfer?.setData('text/plain', path)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    setDragPath(path)
  }, [])

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, path: NotePath): void => {
      if (!dragPath || dragPath === path) return
      // Only a prevented dragover marks a valid drop zone.
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      setDropTarget(path)
    },
    [dragPath],
  )

  const handleDragEnd = useCallback((): void => {
    setDragPath(null)
    setDropTarget(null)
  }, [])

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, path: NotePath): void => {
      event.preventDefault()
      event.stopPropagation()
      const source = dragPath ?? event.dataTransfer?.getData('text/plain') ?? null
      setDragPath(null)
      setDropTarget(null)
      if (!source || source === path) return
      const from = ordered.indexOf(source)
      const to = ordered.indexOf(path)
      if (from === -1 || to === -1) return
      commitOrder(moveStarred(ordered, from, to))
    },
    [commitOrder, dragPath, ordered],
  )

  /* -- render -------------------------------------------------------- */

  const renderStarred = (path: NotePath): JSX.Element => {
    const exists = notes.has(path)
    return (
      <div
        key={path}
        className={classes(
          'nav-item',
          'starred-item',
          !exists && 'is-missing',
          dragPath === path && 'is-dragging',
          dropTarget === path && 'is-drop-target',
        )}
        role="listitem"
        draggable
        title={exists ? path : `${path} — missing from this vault`}
        onClick={() => {
          if (exists) openPath(path)
        }}
        onMouseEnter={() => setHoveredPath(path)}
        onMouseLeave={() => setHoveredPath(null)}
        onDragStart={(event) => handleDragStart(event, path)}
        onDragEnd={handleDragEnd}
        onDragOver={(event) => handleDragOver(event, path)}
        onDrop={(event) => handleDrop(event, path)}
      >
        <Icon name="file" size={14} />
        <span className="nav-item-title">{titleOf(path)}</span>
        <button
          type="button"
          className="starred-toggle"
          aria-label={`Unstar ${titleOf(path)}`}
          title="Unstar"
          onClick={(event) => {
            event.stopPropagation()
            toggleStar(path)
          }}
        >
          <Icon name="star" size={14} />
        </button>
      </div>
    )
  }

  const renderRecent = (path: NotePath): JSX.Element => {
    const isStarred = starred.includes(path)
    return (
      <div
        key={path}
        className={classes('nav-item', 'recent-item', !notes.has(path) && 'is-missing')}
        role="listitem"
        title={path}
        onClick={() => {
          if (notes.has(path)) openPath(path)
        }}
        onMouseEnter={() => setHoveredPath(path)}
        onMouseLeave={() => setHoveredPath(null)}
      >
        <Icon name="file" size={14} />
        <span className="nav-item-title">{titleOf(path)}</span>
        <button
          type="button"
          className={classes('starred-toggle', isStarred && 'is-starred')}
          aria-label={isStarred ? `Unstar ${titleOf(path)}` : `Star ${titleOf(path)}`}
          title={isStarred ? 'Unstar' : 'Star'}
          onClick={(event) => {
            event.stopPropagation()
            toggleStar(path)
          }}
        >
          <Icon name="star" size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="starred-panel">
      <div className="sidebar-header">
        <div className="sidebar-title">Starred</div>
        <span className="nav-file-count">{ordered.length}</span>
      </div>

      <div className="sidebar-body">
        {ordered.length === 0 ? (
          <div className="empty-state">
            <p>Nothing starred yet.</p>
            <p>
              Right-click a file in the explorer and choose <strong>Star</strong>, or press <kbd>Ctrl</kbd>+
              <kbd>Shift</kbd>+<kbd>S</kbd> while a note is open.
            </p>
          </div>
        ) : (
          <div className="starred-list" role="list" aria-label="Starred notes">
            {ordered.map(renderStarred)}
          </div>
        )}

        <div className="panel starred-recent">
          <div className="panel-header">
            <span>Recent files</span>
            <span className="nav-file-count">{recentPaths.length}</span>
          </div>
          <div className="panel-body">
            {recentPaths.length === 0 ? (
              <div className="empty-state">
                <p>Notes you open show up here.</p>
              </div>
            ) : (
              <div className="recent-list" role="list" aria-label="Recent files">
                {recentPaths.map(renderRecent)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default StarredPanel
