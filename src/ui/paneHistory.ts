/**
 * SpaceFore — per-pane navigation history.
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

/** Step back one entry and return it, or null when there is nothing behind. */
export function back(paneId: string): NotePath | null {
  const history = histories.get(paneId)
  if (!history || history.index <= 0) return null
  history.index -= 1
  bump()
  return history.entries[history.index] ?? null
}

/** Step forward one entry and return it, or null when there is nothing ahead. */
export function forward(paneId: string): NotePath | null {
  const history = histories.get(paneId)
  if (!history || history.index >= history.entries.length - 1) return null
  history.index += 1
  bump()
  return history.entries[history.index] ?? null
}

export function canBack(paneId: string): boolean {
  const history = histories.get(paneId)
  return history !== undefined && history.index > 0
}

export function canForward(paneId: string): boolean {
  const history = histories.get(paneId)
  return history !== undefined && history.index >= 0 && history.index < history.entries.length - 1
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

/** Take the most recently closed tab off the stack, or null when empty. */
export function popClosed(): Tab | null {
  const tab = closed.pop()
  if (!tab) return null
  bump()
  return tab
}

export function canReopen(): boolean {
  return closed.length > 0
}
