/**
 * What the two sidebars do on a screen too narrow to hold them.
 *
 * The end-to-end suite covers this on real phone metrics in two engines, but it
 * needs Firefox and WebKit installed and most checkouts will not have them.
 * These run everywhere and keep the rule itself honest: at most one drawer
 * open, and choosing a note closes it.
 */
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AppState } from '../state/store'
import { useAppStore } from '../state/store'
import { isNarrowViewport, useNarrowLayout } from './useNarrowLayout'

const PRISTINE = useAppStore.getState()

/** A `matchMedia` that answers `matches` and can announce a change. */
function stubMatchMedia(matches: boolean): { setMatches: (next: boolean) => void } {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  let current = matches
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return current
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: () => false,
    }),
  })
  return {
    setMatches(next) {
      current = next
      for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent)
    },
  }
}

/** The panes shape the hook reads the active note out of. */
function panesShowing(path: string | null): Partial<AppState> {
  return {
    panes: [
      {
        id: 'pane-a',
        tabs: [{ id: 't1', kind: 'note', path, mode: 'edit', pinned: false }],
        activeTabId: 't1',
      },
    ],
    activePaneId: 'pane-a',
  }
}

beforeEach(() => {
  useAppStore.setState(
    { ...PRISTINE, sidebarPanel: 'files', rightSidebarOpen: true, ...panesShowing(null) },
    true,
  )
})

afterEach(() => {
  useAppStore.setState({ ...PRISTINE }, true)
})

describe('isNarrowViewport', () => {
  it('reports what the media query says', () => {
    stubMatchMedia(true)
    expect(isNarrowViewport()).toBe(true)
    stubMatchMedia(false)
    expect(isNarrowViewport()).toBe(false)
  })

  it('says no rather than throwing where matchMedia is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined })
    expect(isNarrowViewport()).toBe(false)
    if (original) Object.defineProperty(window, 'matchMedia', original)
  })
})

describe('useNarrowLayout, on a narrow screen', () => {
  it('opens onto the note rather than onto two panels', () => {
    stubMatchMedia(true)
    renderHook(() => useNarrowLayout())

    expect(useAppStore.getState().sidebarPanel).toBeNull()
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  })

  it('closes the other drawer when one is opened', () => {
    stubMatchMedia(true)
    renderHook(() => useNarrowLayout())

    act(() => useAppStore.getState().setSidebarPanel('files'))
    expect(useAppStore.getState().sidebarPanel).toBe('files')
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)

    // Opening the other one puts the first away, because they are stacked.
    act(() => useAppStore.getState().toggleRightSidebar(true))
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
    expect(useAppStore.getState().sidebarPanel).toBeNull()
  })

  it('gets out of the way once a note has been chosen', () => {
    stubMatchMedia(true)
    renderHook(() => useNarrowLayout())
    act(() => useAppStore.getState().setSidebarPanel('files'))
    expect(useAppStore.getState().sidebarPanel).toBe('files')

    // Picking something from the drawer is the end of what it is for. Leaving
    // it open means looking at the list instead of the note you just chose.
    act(() => useAppStore.setState(panesShowing('Notes/Chosen.md')))
    expect(useAppStore.getState().sidebarPanel).toBeNull()
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  })

  it('leaves a drawer alone when the same note is merely re-rendered', () => {
    stubMatchMedia(true)
    renderHook(() => useNarrowLayout())
    act(() => useAppStore.setState(panesShowing('Notes/Same.md')))
    act(() => useAppStore.getState().setSidebarPanel('files'))

    act(() => useAppStore.setState({ ...panesShowing('Notes/Same.md'), revision: 7 }))
    expect(useAppStore.getState().sidebarPanel).toBe('files')
  })
})

describe('useNarrowLayout, on a wide screen', () => {
  it('leaves both sidebars exactly as the reader left them', () => {
    stubMatchMedia(false)
    renderHook(() => useNarrowLayout())

    expect(useAppStore.getState().sidebarPanel).toBe('files')
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)

    // Both open at once is the ordinary desktop layout, and must stay possible.
    act(() => useAppStore.getState().setSidebarPanel('search'))
    expect(useAppStore.getState().sidebarPanel).toBe('search')
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)

    // …and choosing a note changes nothing about the panels.
    act(() => useAppStore.setState(panesShowing('Notes/Chosen.md')))
    expect(useAppStore.getState().sidebarPanel).toBe('search')
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
  })

  it('tidies up when the window becomes narrow', () => {
    const media = stubMatchMedia(false)
    renderHook(() => useNarrowLayout())
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)

    act(() => media.setMatches(true))
    expect(useAppStore.getState().sidebarPanel).toBeNull()
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  })
})
