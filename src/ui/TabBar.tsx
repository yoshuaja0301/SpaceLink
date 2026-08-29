/**
 * SpaceFore — the tab strip at the top of a pane.
 *
 * One instance per pane. It owns the tab affordances people expect from an
 * editor: horizontal overflow, middle-click close, drag to reorder (or to move
 * a tab into the other pane), a right-click menu, and the per-pane navigation
 * arrows backed by `paneHistory`.
 *
 * Store reads go through selectors so the strip re-renders when the workspace
 * changes; store *writes* go through `useAppStore.getState()` at call time so a
 * handler never closes over a stale action.
 */
import type { DragEvent as ReactDragEvent, JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useState, useSyncExternalStore } from 'react'

import type { Note, NotePath, Pane, Tab, ViewMode } from '../types'
import { basename, useAppStore } from '../state/store'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'
import type { ContextMenuItem } from './useContextMenu'
import { useContextMenu } from './useContextMenu'
import {
  back,
  canBack,
  canForward,
  canReopen,
  forward,
  getVersion,
  popClosed,
  pushClosed,
  subscribe,
} from './paneHistory'

/** The tab being dragged right now, shared by every pane's strip. */
interface TabDrag {
  paneId: string
  tabId: string
}

/**
 * Drag state lives at module scope because the drop target needs it during
 * `dragover`, where the browser deliberately makes `dataTransfer.getData`
 * return an empty string. The DataTransfer payload is still set, so dragging a
 * tab into another application yields the note path.
 */
let activeDrag: TabDrag | null = null

let blankSeq = 0

/** Human-readable label for a tab. */
export function tabTitle(tab: Tab, notes: Map<NotePath, Note>): string {
  if (tab.kind === 'graph') return 'Graph'
  if (tab.kind === 'search') return 'Search'
  if (!tab.path) return 'New tab'
  return notes.get(tab.path)?.parsed.title || basename(tab.path)
}

/**
 * Append an empty note tab to a pane and focus it.
 *
 * The store has no "new blank tab" action — the only blank tab it creates is
 * the placeholder left behind when the last tab of the last pane closes — so
 * the tab is built here in exactly the shape the store uses. Workspace routes
 * a pathless note tab to its empty state, which is what the user sees.
 */
export function openBlankTab(paneId: string): void {
  const tab: Tab = {
    id: `tab-new-${(blankSeq += 1).toString(36)}-${Date.now().toString(36)}`,
    kind: 'note',
    path: null,
    mode: 'edit',
    pinned: false,
  }
  useAppStore.setState((state) => ({
    activePaneId: paneId,
    panes: state.panes.map((pane) =>
      pane.id === paneId ? { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id } : pane,
    ),
  }))
}

const MODES: { mode: ViewMode; icon: 'edit' | 'columns' | 'eye'; label: string }[] = [
  { mode: 'edit', icon: 'edit', label: 'Edit' },
  { mode: 'split', icon: 'columns', label: 'Split' },
  { mode: 'preview', icon: 'eye', label: 'Preview' },
]

/**
 * Which slot a drop lands in: before this tab (`index`) or after it
 * (`index + 1`). Past the midpoint means "after". An unmeasurable tab — a
 * zero-width rect, or a pointer position the browser did not report, both of
 * which happen in jsdom — falls back to "before".
 */
export function dropSlotFor(index: number, clientX: number, rect: { left: number; width: number } | null): number {
  if (!rect || rect.width <= 0 || !Number.isFinite(clientX)) return index
  return clientX - rect.left > rect.width / 2 ? index + 1 : index
}

function dropSlot(event: ReactDragEvent<HTMLElement>, index: number): number {
  return dropSlotFor(index, event.clientX, event.currentTarget.getBoundingClientRect())
}

export function TabBar({ pane }: { pane: Pane }): JSX.Element {
  const notes = useAppStore((s) => s.notes)
  const dirty = useAppStore((s) => s.dirty)
  const saving = useAppStore((s) => s.saving)
  const paneCount = useAppStore((s) => s.panes.length)
  const { menu, open, close } = useContextMenu()
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // Navigation history is module state, so React has to be told when it moves.
  useSyncExternalStore(subscribe, getVersion)

  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null

  /* ---- navigation ---------------------------------------------------- */

  const navigate = (path: NotePath | null): void => {
    if (path) useAppStore.getState().openPath(path, { paneId: pane.id })
  }

  /* ---- closing ------------------------------------------------------- */

  /** Close one tab, remembering it so it can be reopened. */
  const closeOne = (tab: Tab): void => {
    pushClosed(tab)
    useAppStore.getState().closeTab(pane.id, tab.id)
  }

  const closeOthers = (tab: Tab): void => {
    for (const other of pane.tabs) {
      if (other.id !== tab.id && !other.pinned) pushClosed(other)
    }
    useAppStore.getState().closeOtherTabs(pane.id, tab.id)
  }

  const closeToTheRight = (index: number): void => {
    for (const tab of pane.tabs.slice(index + 1)) {
      if (!tab.pinned) closeOne(tab)
    }
  }

  const reopenClosed = (): void => {
    const tab = popClosed()
    if (!tab) return
    const store = useAppStore.getState()
    if (tab.kind !== 'note') store.openView(tab.kind, { paneId: pane.id })
    else if (tab.path) store.openPath(tab.path, { paneId: pane.id, newTab: true, mode: tab.mode })
    else openBlankTab(pane.id)
  }

  /* ---- pane / view actions ------------------------------------------- */

  const applyMode = (mode: ViewMode): void => {
    const store = useAppStore.getState()
    // `setViewMode` targets the active pane, so claim it first.
    store.setActivePane(pane.id)
    store.setViewMode(mode)
  }

  const splitRight = (tabId?: string): void => {
    const store = useAppStore.getState()
    if (tabId) store.setActiveTab(pane.id, tabId)
    else store.setActivePane(pane.id)
    store.splitPane()
  }

  const copyPath = (path: NotePath | null): void => {
    if (!path) return
    const store = useAppStore.getState()
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      store.pushToast('Clipboard is not available in this browser', 'error')
      return
    }
    void clipboard.writeText(path).then(
      () => store.pushToast(`Copied ${path}`, 'success'),
      () => store.pushToast('Could not copy the path', 'error'),
    )
  }

  /* ---- drag and drop -------------------------------------------------- */

  const endDrag = (): void => {
    activeDrag = null
    setDraggingId(null)
    setDropIndex(null)
  }

  const onDragStart = (event: ReactDragEvent<HTMLElement>, tab: Tab): void => {
    activeDrag = { paneId: pane.id, tabId: tab.id }
    setDraggingId(tab.id)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', tab.path ?? tabTitle(tab, notes))
    }
  }

  const onDragOver = (event: ReactDragEvent<HTMLElement>, slot: number): void => {
    if (!activeDrag) return
    // Without preventDefault the browser refuses the drop entirely.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setDropIndex(slot)
  }

  const drop = (slot: number): void => {
    const drag = activeDrag
    if (!drag) return
    let target = slot
    if (drag.paneId === pane.id) {
      const from = pane.tabs.findIndex((tab) => tab.id === drag.tabId)
      if (from === -1) {
        endDrag()
        return
      }
      // `moveTab` removes the tab before inserting it, so every slot to the
      // right of the original position shifts down by one.
      if (from < target) target -= 1
      if (from === target) {
        endDrag()
        return
      }
    }
    useAppStore.getState().moveTab(drag.paneId, drag.tabId, pane.id, target)
    endDrag()
  }

  /* ---- menus ---------------------------------------------------------- */

  const tabMenuItems = (tab: Tab, index: number): ContextMenuItem[] => {
    const others = pane.tabs.filter((other) => other.id !== tab.id && !other.pinned)
    const toTheRight = pane.tabs.slice(index + 1).filter((other) => !other.pinned)
    return [
      { id: 'close', label: 'Close', icon: 'close', onSelect: () => closeOne(tab) },
      {
        id: 'close-others',
        label: 'Close others',
        disabled: others.length === 0,
        onSelect: () => closeOthers(tab),
      },
      {
        id: 'close-right',
        label: 'Close to the right',
        disabled: toTheRight.length === 0,
        onSelect: () => closeToTheRight(index),
      },
      { id: 'sep-close', label: '', separator: true },
      {
        id: 'pin',
        label: tab.pinned ? 'Unpin' : 'Pin',
        icon: 'pin',
        onSelect: () => useAppStore.getState().togglePinTab(pane.id, tab.id),
      },
      {
        id: 'split-right',
        label: 'Split right',
        icon: 'split',
        disabled: paneCount >= 3,
        onSelect: () => splitRight(tab.id),
      },
      { id: 'sep-copy', label: '', separator: true },
      {
        id: 'copy-path',
        label: 'Copy path',
        icon: 'copy',
        disabled: tab.path === null,
        onSelect: () => copyPath(tab.path),
      },
    ]
  }

  const moreMenuItems = (): ContextMenuItem[] => [
    { id: 'new-tab', label: 'New tab', icon: 'plus', onSelect: () => openBlankTab(pane.id) },
    {
      id: 'reopen',
      label: 'Reopen closed tab',
      icon: 'arrow-left',
      disabled: !canReopen(),
      onSelect: reopenClosed,
    },
    { id: 'sep-more', label: '', separator: true },
    {
      id: 'close-all',
      label: 'Close all tabs',
      icon: 'close',
      disabled: pane.tabs.every((tab) => tab.pinned),
      onSelect: () => {
        for (const tab of pane.tabs) {
          if (!tab.pinned) closeOne(tab)
        }
      },
    },
    { id: 'split-right', label: 'Split right', icon: 'split', disabled: paneCount >= 3, onSelect: () => splitRight() },
    {
      id: 'close-pane',
      label: 'Close this pane',
      icon: 'trash',
      danger: true,
      disabled: paneCount <= 1,
      onSelect: () => useAppStore.getState().closePane(pane.id),
    },
  ]

  const openMoreMenu = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    open({ clientX: rect.left, clientY: rect.bottom, preventDefault: () => event.preventDefault() }, moreMenuItems())
  }

  /* ---- render ---------------------------------------------------------- */

  return (
    <div className="tab-bar">
      {/* `sidebar-actions` supplies the 24px icon-button geometry. */}
      <div className="tab-nav sidebar-actions">
        <button
          type="button"
          aria-label="Navigate back"
          data-tooltip="Back"
          disabled={!canBack(pane.id)}
          onClick={() => navigate(back(pane.id))}
        >
          <Icon name="arrow-left" size={15} />
        </button>
        <button
          type="button"
          aria-label="Navigate forward"
          data-tooltip="Forward"
          disabled={!canForward(pane.id)}
          onClick={() => navigate(forward(pane.id))}
        >
          <Icon name="arrow-right" size={15} />
        </button>
      </div>

      <div
        className="tabs"
        role="tablist"
        aria-label="Open tabs"
        onDoubleClick={(event) => {
          // Only the strip itself — a double-click on a tab must not spawn one.
          if (event.target === event.currentTarget) openBlankTab(pane.id)
        }}
        onDragOver={(event) => onDragOver(event, pane.tabs.length)}
        onDragLeave={(event) => {
          // `dragleave` also fires when the pointer moves between tabs; only a
          // move out of the strip itself should clear the drop indicator.
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          setDropIndex(null)
        }}
        onDrop={(event) => {
          event.preventDefault()
          drop(pane.tabs.length)
        }}
      >
        {pane.tabs.map((tab, index) => {
          const title = tabTitle(tab, notes)
          const isActive = tab.id === pane.activeTabId
          const isDirty = tab.path !== null && (dirty.has(tab.path) || saving.has(tab.path))
          const className = [
            'tab',
            isActive ? 'is-active' : '',
            tab.pinned ? 'is-pinned' : '',
            draggingId === tab.id ? 'is-dragging' : '',
            dropIndex === index ? 'is-drop-before' : '',
            dropIndex === index + 1 ? 'is-drop-after' : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <div
              key={tab.id}
              className={className}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-tab-id={tab.id}
              data-path={tab.path ?? ''}
              title={tab.path ?? title}
              draggable
              onClick={() => useAppStore.getState().setActiveTab(pane.id, tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  useAppStore.getState().setActiveTab(pane.id, tab.id)
                }
              }}
              onMouseDown={(event) => {
                // Suppress the middle-click autoscroll cursor; the close itself
                // happens on `auxclick`, after the button is released.
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                closeOne(tab)
              }}
              onContextMenu={(event) => open(event, tabMenuItems(tab, index))}
              onDragStart={(event) => onDragStart(event, tab)}
              onDragEnd={endDrag}
              onDragOver={(event) => {
                event.stopPropagation()
                onDragOver(event, dropSlot(event, index))
              }}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                drop(dropSlot(event, index))
              }}
            >
              {tab.pinned && <Icon name="pin" size={12} className="tab-pin" />}
              <span className="tab-title">{title}</span>
              {isDirty && <span className="tab-dirty-dot" role="img" aria-label="Unsaved changes" />}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeOne(tab)
                }}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="tab-actions">
        {MODES.map(({ mode, icon, label }) => (
          <button
            key={mode}
            type="button"
            className={activeTab?.mode === mode ? 'is-active' : undefined}
            aria-label={`${label} view`}
            data-tooltip={`${label} view`}
            aria-pressed={activeTab?.mode === mode}
            disabled={activeTab?.kind !== 'note'}
            onClick={() => applyMode(mode)}
          >
            <Icon name={icon} size={15} />
          </button>
        ))}
        <button
          type="button"
          aria-label="Split right"
          data-tooltip="Split right"
          disabled={paneCount >= 3}
          onClick={() => splitRight()}
        >
          <Icon name="split" size={15} />
        </button>
        <button type="button" aria-label="More options" data-tooltip="More options" aria-haspopup="menu" onClick={openMoreMenu}>
          <Icon name="more" size={15} />
        </button>
      </div>

      <ContextMenu menu={menu} onClose={close} label="Tab menu" />
    </div>
  )
}

export default TabBar
