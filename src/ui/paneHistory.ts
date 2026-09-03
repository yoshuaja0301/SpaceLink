/**
 * SpaceLink — per-pane navigation history.
 *
 * A browser-style back/forward stack for every workspace pane, plus a single
 * global stack of recently closed tabs ("reopen closed tab").
 *
 * The state lives at module scope rather than in the zustand store on purpose:
 * history is a property of the *view*, not of the vault, it must survive a tab
 * being replaced in place, and nothing outside the workspace chrome cares
 * about it. Because it is not store state, React does not re-render when it
 * changes — so the module also exposes a tiny `subscribe`/`getVersion` pair
 * that components feed to `useSyncExternalStore` to keep the back/forward
 * buttons in step.
 *
 * Everything here is pure with respect to its inputs: no DOM, no store, no
 * timers.
 */
import type { NotePath, Tab } from '../types'

interface PaneHistory {
  /** Every path visited in this pane, oldest first. */
  entries: NotePath[]
  /** Index of the entry currently on screen; -1 when the pane is empty. */
  index: number
}

/** Entries kept per pane. Old entries fall off the front. */
const HISTORY_LIMIT = 100
/** Closed tabs kept for reopening. */
const CLOSED_LIMIT = 20

const histories = new Map<string, PaneHistory>()
const closed: Tab[] = []
const listeners = new Set<() => void>()
let version = 0

function bump(): void {
  version += 1
  // A listener that throws must not stop the others from being told.
  for (const listener of [...listeners]) listener()
}

/** Subscribe to any history mutation. Returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Monotonic counter, bumped on every mutation — the `useSyncExternalStore` snapshot. */
export function getVersion(): number {
  return version
}

function historyFor(paneId: string): PaneHistory {
  const existing = histories.get(paneId)
  if (existing) return existing
  const created: PaneHistory = { entries: [], index: -1 }
  histories.set(paneId, created)
  return created
}

/**
 * Record a visit. Re-visiting the entry already on screen is ignored (opening
 * the same note twice must not create a dead back step), and pushing after
 * going back truncates everything that was ahead — exactly like a browser.
 */
export function push(paneId: string, path: NotePath): void {
  if (!path) return
  const history = historyFor(paneId)
  if (history.entries[history.index] === path) return

  history.entries.length = history.index + 1
  history.entries.push(path)
  if (history.entries.length > HISTORY_LIMIT) {
    history.entries.splice(0, history.entries.length - HISTORY_LIMIT)
  }
  history.index = history.entries.length - 1
  bump()
}

/**
 * Nearest entry in `direction` that still passes `exists`, or null when the
 * stack runs out. Callers hand in the "does this note still exist" test so the
 * module stays free of the store: a deleted note is stepped over rather than
 * reopened as a blank tab.
 */
function findStep(history: PaneHistory, direction: -1 | 1, exists?: (path: NotePath) => boolean): number | null {
  for (let at = history.index + direction; at >= 0 && at < history.entries.length; at += direction) {
    const path = history.entries[at]
    if (path !== undefined && (!exists || exists(path))) return at
  }
  return null
}

/** Step back to the nearest live entry and return it, or null when there is none. */
export function back(paneId: string, exists?: (path: NotePath) => boolean): NotePath | null {
  const history = histories.get(paneId)
  if (!history) return null
  const at = findStep(history, -1, exists)
  if (at === null) return null
  history.index = at
  bump()
  return history.entries[at] ?? null
}

/** Step forward to the nearest live entry and return it, or null when there is none. */
export function forward(paneId: string, exists?: (path: NotePath) => boolean): NotePath | null {
  const history = histories.get(paneId)
  if (!history) return null
  const at = findStep(history, 1, exists)
  if (at === null) return null
  history.index = at
  bump()
  return history.entries[at] ?? null
}

export function canBack(paneId: string, exists?: (path: NotePath) => boolean): boolean {
  const history = histories.get(paneId)
  return history !== undefined && findStep(history, -1, exists) !== null
}

export function canForward(paneId: string, exists?: (path: NotePath) => boolean): boolean {
  const history = histories.get(paneId)
  return history !== undefined && findStep(history, 1, exists) !== null
}

/** The entry currently on screen for this pane, or null when it has no history. */
export function current(paneId: string): NotePath | null {
  const history = histories.get(paneId)
  if (!history) return null
  return history.entries[history.index] ?? null
}

/** Read-only view of a pane's stack — for tests and debugging. */
export function snapshot(paneId: string): { entries: NotePath[]; index: number } {
  const history = histories.get(paneId)
  return history ? { entries: [...history.entries], index: history.index } : { entries: [], index: -1 }
}

/**
 * A note was renamed: every entry that named it, in every pane and on the
 * closed-tab stack, now names it by its new path. Not a navigation — nothing
 * moves, nothing ahead is lost. A rename that makes two neighbouring entries
 * the same note folds them into one, so Back still goes somewhere.
 */
export function rename(from: NotePath, to: NotePath): void {
  if (!from || !to || from === to) return
  let changed = false
  for (const history of histories.values()) {
    if (!history.entries.includes(from)) continue
    changed = true
    const entries: NotePath[] = []
    let index = history.index
    history.entries.forEach((entry, at) => {
      const path = entry === from ? to : entry
      if (entries.length > 0 && entries[entries.length - 1] === path) {
        // Folded into the entry before it; an index past this point moves up.
        if (at <= history.index) index -= 1
        return
      }
      entries.push(path)
    })
    history.entries = entries
    history.index = Math.max(-1, Math.min(index, entries.length - 1))
  }
  for (const tab of closed) {
    if (tab.kind === 'note' && tab.path === from) {
      tab.path = to
      changed = true
    }
  }
  if (changed) bump()
}

/**
 * Forget a pane's history (the pane was closed), or — with no argument —
 * everything, closed tabs included.
 */
export function reset(paneId?: string): void {
  if (paneId === undefined) {
    histories.clear()
    closed.length = 0
  } else if (!histories.delete(paneId)) {
    return
  }
  bump()
}

/** Remember a closed tab so it can be reopened. The tab is copied, not aliased. */
export function pushClosed(tab: Tab): void {
  closed.push({ ...tab })
  if (closed.length > CLOSED_LIMIT) closed.splice(0, closed.length - CLOSED_LIMIT)
  bump()
}

/**
 * Take the most recently closed tab off the stack, or null when empty.
 *
 * Entries that no longer pass `reopenable` — a tab whose note has since been
 * deleted — are discarded on the way rather than handed back, so reopening can
 * never resurrect a note that is gone.
 */
export function popClosed(reopenable?: (tab: Tab) => boolean): Tab | null {
  let popped: Tab | undefined
  while ((popped = closed.pop()) !== undefined) {
    bump()
    if (!reopenable || reopenable(popped)) return popped
  }
  return null
}

export function canReopen(reopenable?: (tab: Tab) => boolean): boolean {
  return reopenable ? closed.some(reopenable) : closed.length > 0
}
