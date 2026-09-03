/**
 * SpaceLink — the left sidebar shell.
 *
 * Picks the panel the ribbon asked for and adds the drag handle that sets its
 * width. The surrounding `.sidebar` element (owned by `App`) supplies the
 * width and the positioning context the handle anchors to.
 */
import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '../state/store'
import { FileExplorer } from './FileExplorer'
import { SearchPanel } from './SearchPanel'
import { StarredPanel } from './StarredPanel'
import { TagPanel } from './TagPanel'

/** Matches the clamp in `setSidebarWidth`, so the handle reports honest bounds. */
const MIN_WIDTH = 180
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 260
/** Width change per arrow-key press. */
const KEY_STEP = 16

interface Drag {
  startX: number
  startWidth: number
}

export function Sidebar(): JSX.Element {
  const panel = useAppStore((s) => s.sidebarPanel)
  const width = useAppStore((s) => s.sidebarWidth)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<Drag | null>(null)

  // The listeners live on the window so the pointer may leave the 7px handle
  // (it always does) without the drag stopping.
  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      useAppStore.getState().setSidebarWidth(drag.startWidth + (event.clientX - drag.startX))
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const setWidth = useAppStore.getState().setSidebarWidth
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setWidth(width - KEY_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setWidth(width + KEY_STEP)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setWidth(MIN_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setWidth(MAX_WIDTH)
    }
  }

  return (
    <>
      {panel === 'files' && <FileExplorer />}
      {panel === 'search' && <SearchPanel variant="sidebar" />}
      {panel === 'tags' && <TagPanel />}
      {panel === 'starred' && <StarredPanel />}

      <div
        className={dragging ? 'sidebar-resizer is-dragging' : 'sidebar-resizer'}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onMouseDown={startDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => useAppStore.getState().setSidebarWidth(DEFAULT_WIDTH)}
      />
    </>
  )
}

export default Sidebar
