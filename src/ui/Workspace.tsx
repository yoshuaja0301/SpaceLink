/**
 * SpaceFore — the pane area.
 *
 * Renders every open pane side by side with a draggable splitter between them,
 * routes each pane's active tab to the view that can render it, and keeps the
 * per-pane navigation history in `paneHistory` up to date.
 *
 * Pane widths live in component state (not the store): they are a property of
 * this browser window, are persisted to `localStorage` under
 * `spacefore.paneSizes`, and change on every mouse move during a drag — which
 * is exactly the kind of churn the app store should be kept away from.
 */
import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'

import type { Pane, Tab } from '../types'
import { useAppStore } from '../state/store'
import { Editor } from './Editor'
import { GraphView } from './GraphView'
import { Preview } from './Preview'
import { SearchPanel } from './SearchPanel'
import { TabBar } from './TabBar'
import { push as pushHistory, reset as resetHistory } from './paneHistory'

export const PANE_SIZES_KEY = 'spacefore.paneSizes'
/** No pane may be squeezed below this, in px. */
export const MIN_PANE_WIDTH = 240
/** How far one arrow-key press moves a splitter, in px. */
export const PANE_KEY_STEP = 24

/**
 * Move the boundary between pane `index` and the one after it by `delta` px.
 * The pair's combined width never changes, so panes further along the row stay
 * exactly where they are, and neither side is allowed below `min`.
 */
export function resizePanes(
  sizes: readonly number[],
  index: number,
  delta: number,
  min: number = MIN_PANE_WIDTH,
): number[] {
  const next = [...sizes]
  const left = next[index]
  const right = next[index + 1]
  if (left === undefined || right === undefined) return next
  const total = left + right
  // Too little room for both minimums: leave the pair alone rather than
  // producing widths that violate the constraint anyway.
  if (total < min * 2) return next
  const width = Math.round(Math.min(Math.max(left + delta, min), total - min))
  next[index] = width
  next[index + 1] = total - width
  return next
}

/** Persisted widths, or `[]` when there is nothing usable for `count` panes. */
export function loadPaneSizes(count: number): number[] {
  try {
    const raw = localStorage.getItem(PANE_SIZES_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length !== count) return []
    const sizes = parsed.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0))
    return sizes.every((value) => value >= MIN_PANE_WIDTH) ? sizes : []
  } catch {
    return []
  }
}

function savePaneSizes(sizes: readonly number[]): void {
  try {
    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(sizes))
  } catch {
    /* private mode / quota — the layout simply does not persist */
  }
}

interface ResizeDrag {
  index: number
  startX: number
  sizes: number[]
}

/** What a pane shows when its tab has no note yet. */
function PaneEmptyState({ paneId }: { paneId: string }): JSX.Element {
  const focusPane = (): void => useAppStore.getState().setActivePane(paneId)
  return (
    <div className="pane-empty empty-state">
      <p className="pane-empty-title">No note open</p>
      <div className="pane-empty-actions">
        <button
          type="button"
          className="empty-state-action"
          onClick={() => {
            focusPane()
            void useAppStore.getState().createNoteFromTitle('Untitled')
          }}
        >
          Create new note
        </button>
        <button
          type="button"
          className="empty-state-action"
          onClick={() => {
            focusPane()
            useAppStore.getState().setPalette('quickswitch')
          }}
        >
          Open quick switcher (Ctrl+P)
        </button>
        <button
          type="button"
          className="empty-state-action"
          onClick={() => {
            focusPane()
            useAppStore.getState().openView('graph', { paneId })
          }}
        >
          Open the graph
        </button>
      </div>
    </div>
  )
}

/** Route one tab to the view that can render it. */
function TabContent({ tab, paneId }: { tab: Tab | null; paneId: string }): JSX.Element {
  if (!tab) return <PaneEmptyState paneId={paneId} />
  if (tab.kind === 'graph') return <GraphView />
  if (tab.kind === 'search') return <SearchPanel variant="tab" />
  if (tab.path === null) return <PaneEmptyState paneId={paneId} />

  if (tab.mode === 'preview') return <Preview path={tab.path} paneId={paneId} />
  if (tab.mode === 'split') {
    return (
      <div className="split-view">
        <div className="split-editor">
          <Editor path={tab.path} paneId={paneId} />
        </div>
        <div className="split-preview">
          <Preview path={tab.path} paneId={paneId} scrollSync />
        </div>
      </div>
    )
  }
  return <Editor path={tab.path} paneId={paneId} />
}

export function Workspace(): JSX.Element {
  const panes = useAppStore((s) => s.panes)
  const activePaneId = useAppStore((s) => s.activePaneId)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [sizes, setSizes] = useState<number[]>(() => loadPaneSizes(useAppStore.getState().panes.length))
  const [drag, setDrag] = useState<ResizeDrag | null>(null)
  /** Latest widths, readable from the mouseup listener without re-subscribing. */
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  /* ---- navigation history --------------------------------------------- */

  const knownPanes = useRef<string[]>([])
  useEffect(() => {
    for (const pane of panes) {
      const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId)
      // `push` ignores a repeat of the entry already on screen, which is what
      // makes going back (which also changes the active path) a no-op here.
      if (tab && tab.kind === 'note' && tab.path) pushHistory(pane.id, tab.path)
    }
    const ids = panes.map((pane) => pane.id)
    for (const id of knownPanes.current) {
      if (!ids.includes(id)) resetHistory(id)
    }
    knownPanes.current = ids
  }, [panes])

  /* ---- splitter -------------------------------------------------------- */

  // Widths only apply while they describe the current row of panes; a split or
  // a closed pane falls back to equal shares until the user drags again.
  const widths = sizes.length === panes.length ? sizes : null

  useEffect(() => {
    setSizes((current) => (current.length === panes.length ? current : loadPaneSizes(panes.length)))
  }, [panes.length])

  useEffect(() => {
    if (!drag) return undefined
    const onMove = (event: MouseEvent): void => {
      setSizes(resizePanes(drag.sizes, drag.index, event.clientX - drag.startX))
    }
    const onUp = (): void => {
      setDrag(null)
      savePaneSizes(sizesRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag])

  /** Current pixel width of every pane, with sensible fallbacks when unlaid out. */
  const measure = (): number[] => {
    const container = containerRef.current
    const elements = container ? [...container.querySelectorAll<HTMLElement>('[data-pane-id]')] : []
    const containerWidth = container?.getBoundingClientRect().width ?? 0
    const share = panes.length > 0 && containerWidth > 0 ? containerWidth / panes.length : MIN_PANE_WIDTH * 2
    return panes.map((_, index) => {
      const measured = elements[index]?.getBoundingClientRect().width ?? 0
      return measured > 0 ? measured : (widths?.[index] ?? share)
    })
  }

  const startResize = (index: number, event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    // Stops the browser from starting a text selection under the cursor.
    event.preventDefault()
    setDrag({ index, startX: event.clientX, sizes: measure() })
  }

  const resetSizes = (): void => {
    setSizes([])
    savePaneSizes([])
  }

  /**
   * Move a boundary without a mouse. `delta` is unbounded on purpose:
   * `resizePanes` clamps to the pair's minimums, so ±Infinity is "as far as
   * this splitter goes", which is what Home/End mean.
   */
  const resizeByKey = (index: number, delta: number): void => {
    const next = resizePanes(widths ?? measure(), index, delta)
    setSizes(next)
    savePaneSizes(next)
  }

  const onResizerKeyDown = (index: number, event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const delta =
      event.key === 'ArrowLeft'
        ? -PANE_KEY_STEP
        : event.key === 'ArrowRight'
          ? PANE_KEY_STEP
          : event.key === 'Home'
            ? -Infinity
            : event.key === 'End'
              ? Infinity
              : null
    if (delta === null) return
    event.preventDefault()
    resizeByKey(index, delta)
  }

  return (
    <div className="workspace" ref={containerRef}>
      {panes.map((pane: Pane, index: number) => {
        const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? null
        const width = widths?.[index]
        // Where the boundary sits, as the left pane's share of the pair. A
        // percentage rather than pixels so the value is defined before anything
        // has been dragged, when the panes are simply equal shares.
        const pairTotal = (widths?.[index - 1] ?? 0) + (widths?.[index] ?? 0)
        const ratio = pairTotal > 0 ? Math.round(((widths?.[index - 1] ?? 0) / pairTotal) * 100) : 50
        return (
          <Fragment key={pane.id}>
            {index > 0 && (
              <div
                className={drag?.index === index - 1 ? 'pane-resizer is-dragging' : 'pane-resizer'}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panes"
                aria-valuenow={ratio}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={`${ratio}%`}
                tabIndex={0}
                // Computed geometry: the stylesheet has no rule for the pane
                // splitter, and the grab area has to exist for the drag to work.
                style={{ flex: '0 0 6px', cursor: 'col-resize' }}
                onMouseDown={(event) => startResize(index - 1, event)}
                onKeyDown={(event) => onResizerKeyDown(index - 1, event)}
                onDoubleClick={resetSizes}
              />
            )}
            <section
              className={pane.id === activePaneId ? 'pane is-active' : 'pane'}
              data-pane-id={pane.id}
              aria-label={`Pane ${index + 1}`}
              // Pointer-down rather than click: focusing a pane must happen
              // before the editor inside it handles the same gesture.
              onMouseDownCapture={() => {
                if (useAppStore.getState().activePaneId !== pane.id) useAppStore.getState().setActivePane(pane.id)
              }}
              onFocusCapture={() => {
                if (useAppStore.getState().activePaneId !== pane.id) useAppStore.getState().setActivePane(pane.id)
              }}
              style={width !== undefined ? { flex: `0 1 ${width}px` } : undefined}
            >
              <TabBar pane={pane} />
              {/* The panel the pane's tab strip controls; see `aria-controls`. */}
              <div
                className="pane-content"
                id={`pane-panel-${pane.id}`}
                role="tabpanel"
                aria-labelledby={tab ? `pane-tab-${tab.id}` : undefined}
              >
                <TabContent tab={tab} paneId={pane.id} />
              </div>
            </section>
          </Fragment>
        )
      })}
    </div>
  )
}

export default Workspace
