/**
 * The two sidebars, on a screen too narrow to hold them beside the note.
 *
 * Above 800px they are columns in a grid and being open costs the workspace
 * some width. Below it — see the media query in `app.css` — they become
 * overlays that float over the note, and that changes what "open" means:
 *
 *  * both open at once buries the note under the right-hand one, and on a
 *    phone that is the whole window. It is also unreachable: a tap lands on
 *    whichever overlay is on top.
 *  * so opening one closes the other, and arriving at a narrow width closes
 *    both, which is what a reader wants to see first — their note.
 *
 * Nothing here touches the desktop layout. The widths a reader dragged, and
 * which panel they had open, are left alone above the breakpoint.
 */
import { useEffect } from 'react'

import { useAppStore } from '../state/store'

/** Matches the `max-width` in `app.css`. Kept in one place on purpose. */
export const NARROW_QUERY = '(max-width: 800px)'

/** True when the sidebars are overlays rather than columns. */
export function isNarrowViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(NARROW_QUERY).matches
  } catch {
    return false
  }
}

/**
 * Keep at most one sidebar open while the viewport is narrow.
 *
 * Mounted once, at the top of the app.
 */
export function useNarrowLayout(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined

    let list: MediaQueryList
    try {
      list = window.matchMedia(NARROW_QUERY)
    } catch {
      return undefined
    }

    /** Arriving at a narrow width: get out of the reader's way. */
    const closeBoth = (): void => {
      const state = useAppStore.getState()
      if (state.sidebarPanel !== null) state.setSidebarPanel(state.sidebarPanel)
      if (state.rightSidebarOpen) state.toggleRightSidebar(false)
    }

    if (list.matches) closeBoth()

    const onChange = (event: MediaQueryListEvent): void => {
      if (event.matches) closeBoth()
    }
    if (typeof list.addEventListener === 'function') list.addEventListener('change', onChange)

    /** Which note the workspace is showing, or null. */
    const activePath = (state: ReturnType<typeof useAppStore.getState>): string | null => {
      const pane = state.panes.find((candidate) => candidate.id === state.activePaneId)
      const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeTabId)
      return tab && tab.kind === 'note' ? tab.path : null
    }

    // While narrow, the two overlays cannot both be useful, so opening either
    // closes the other. Done by watching the store rather than by teaching
    // every caller, because a sidebar is opened from the ribbon, the command
    // palette, a keyboard shortcut and a backlink — and each of those would
    // otherwise have to remember.
    let previousLeft = useAppStore.getState().sidebarPanel
    let previousRight = useAppStore.getState().rightSidebarOpen
    let previousPath = activePath(useAppStore.getState())
    let previousRename = useAppStore.getState().renamed?.seq ?? 0
    const unsubscribe = useAppStore.subscribe((state) => {
      const leftOpened = state.sidebarPanel !== null && previousLeft === null
      const rightOpened = state.rightSidebarOpen && !previousRight
      const path = activePath(state)
      // A rename changes the path without choosing anything: the reader is
      // still in the drawer, mid-rename.
      const renamedTo = state.renamed && state.renamed.seq !== previousRename ? state.renamed.to : null
      const noteChanged = path !== null && path !== previousPath && path !== renamedTo
      previousLeft = state.sidebarPanel
      previousRight = state.rightSidebarOpen
      previousPath = path
      previousRename = state.renamed?.seq ?? 0
      if (!list.matches) return

      // Choosing a note is the end of what a drawer is for. Leaving it open
      // means tapping a note and then still looking at the list of notes,
      // which is the whole screen on a phone.
      if (noteChanged) {
        if (state.sidebarPanel !== null) state.setSidebarPanel(state.sidebarPanel)
        if (state.rightSidebarOpen) state.toggleRightSidebar(false)
        return
      }

      if (leftOpened && state.rightSidebarOpen) state.toggleRightSidebar(false)
      else if (rightOpened && state.sidebarPanel !== null) state.setSidebarPanel(state.sidebarPanel)
    })

    return () => {
      if (typeof list.removeEventListener === 'function') list.removeEventListener('change', onChange)
      unsubscribe()
    }
  }, [])
}
