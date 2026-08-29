/**
 * SpaceFore — the right sidebar shell.
 *
 * Three views of the note the workspace is currently showing — its backlinks,
 * its outline, its properties — behind one tab strip, plus the drag handle that
 * sets the sidebar width and the button that folds it away.
 *
 * The shell follows the *active* pane rather than taking a path prop: the user
 * moves between panes constantly and the sidebar should always describe what
 * they are looking at. When that is nothing (a graph tab, an empty pane) the
 * body says so instead of rendering an empty panel.
 *
 * `App` owns the `.right-sidebar` element and its width; this component owns
 * everything inside it.
 */
import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAppStore } from '../state/store'
import { BacklinksPanel } from './BacklinksPanel'
import { Icon } from './Icon'
import { NoteInfo } from './NoteInfo'
import { OutlinePanel } from './OutlinePanel'

/** Matches the clamp in `setRightSidebarWidth`, so the handle reports honest bounds. */
const MIN_WIDTH = 220
const MAX_WIDTH = 560
const DEFAULT_WIDTH = 300
/** Width change per arrow-key press. */
const KEY_STEP = 16

const TAB_KEY = 'spacefore.rightSidebarTab'

export type RightSidebarTab = 'backlinks' | 'outline' | 'info'

const TABS: readonly { id: RightSidebarTab; label: string }[] = [
  { id: 'backlinks', label: 'Backlinks' },
  { id: 'outline', label: 'Outline' },
  { id: 'info', label: 'Info' },
]

export function loadRightSidebarTab(): RightSidebarTab {
  try {
    const stored = localStorage.getItem(TAB_KEY)
    if (TABS.some((tab) => tab.id === stored)) return stored as RightSidebarTab
  } catch {
    /* private mode / storage disabled — start on backlinks */
  }
  return 'backlinks'
}

function saveRightSidebarTab(tab: RightSidebarTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    /* private mode / quota — the choice just does not survive the reload */
  }
}

interface Drag {
  startX: number
  startWidth: number
}

export function RightSidebar(): JSX.Element {
  const panes = useAppStore((state) => state.panes)
  const activePaneId = useAppStore((state) => state.activePaneId)
  const width = useAppStore((state) => state.rightSidebarWidth)
  const toggleRightSidebar = useAppStore((state) => state.toggleRightSidebar)

  const [tab, setTab] = useState<RightSidebarTab>(loadRightSidebarTab)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<Drag | null>(null)

  // The listeners live on the window so the pointer may leave the thin handle
  // (it always does) without the drag stopping.
  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      // The handle sits on the sidebar's left edge: dragging left widens it.
      useAppStore.getState().setRightSidebarWidth(drag.startWidth - (event.clientX - drag.startX))
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  const startDrag = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width }
    setDragging(true)
  }

  const onResizerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const setWidth = useAppStore.getState().setRightSidebarWidth
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setWidth(width + KEY_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setWidth(width - KEY_STEP)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setWidth(MAX_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setWidth(MIN_WIDTH)
    }
  }

  const selectTab = useCallback((next: RightSidebarTab): void => {
    setTab(next)
    saveRightSidebarTab(next)
  }, [])

  /** Left/Right arrows move between tabs, as a tablist is expected to. */
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, position: number): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = TABS[(position + step + TABS.length) % TABS.length]!
    selectTab(next.id)
  }

  const pane = panes.find((candidate) => candidate.id === activePaneId) ?? panes[0]
  const activeTab = pane?.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? null
  const path = activeTab && activeTab.kind === 'note' ? activeTab.path : null
  const label = TABS.find((candidate) => candidate.id === tab)?.label ?? 'Backlinks'

  return (
    <>
      <div className="sidebar-header right-sidebar-header">
        <div className="right-sidebar-tabs" role="tablist" aria-label="Note panels">
          {TABS.map((entry, position) => (
            <button
              type="button"
              role="tab"
              key={entry.id}
              className={entry.id === tab ? 'right-sidebar-tab is-active' : 'right-sidebar-tab'}
              aria-selected={entry.id === tab}
              tabIndex={entry.id === tab ? 0 : -1}
              onClick={() => selectTab(entry.id)}
              onKeyDown={(event) => onTabKeyDown(event, position)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="sidebar-actions">
          <button
            type="button"
            aria-label="Collapse right sidebar"
            title="Collapse right sidebar"
            onClick={() => toggleRightSidebar(false)}
          >
            <Icon name="arrow-right" size={16} />
          </button>
        </div>
      </div>

      <div className="right-sidebar-body sidebar-body" role="tabpanel" aria-label={label}>
        {path === null ? (
          <div className="empty-state">
            <p>No note open.</p>
            <p>Open a note to see its backlinks, outline and properties.</p>
          </div>
        ) : tab === 'backlinks' ? (
          <BacklinksPanel path={path} />
        ) : tab === 'outline' ? (
          <OutlinePanel path={path} />
        ) : (
          <NoteInfo path={path} />
        )}
      </div>

      <div
        className={dragging ? 'sidebar-resizer is-dragging' : 'sidebar-resizer'}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right sidebar"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onMouseDown={startDrag}
        onKeyDown={onResizerKeyDown}
        onDoubleClick={() => useAppStore.getState().setRightSidebarWidth(DEFAULT_WIDTH)}
      />
    </>
  )
}

export default RightSidebar
