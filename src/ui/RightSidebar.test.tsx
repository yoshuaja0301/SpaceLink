import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { Note, NotePath, Pane, Tab } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { RightSidebar, openRightSidebarTab } from './RightSidebar'

/*
 * The panels themselves have their own suites; what matters here is the shell —
 * which tab is selected, where focus is, and which panel gets rendered.
 */
vi.mock('./BacklinksPanel', () => ({ BacklinksPanel: () => <div data-testid="backlinks" /> }))
vi.mock('./OutlinePanel', () => ({ OutlinePanel: () => <div data-testid="outline" /> }))
vi.mock('./NoteInfo', () => ({ NoteInfo: () => <div data-testid="info" /> }))
vi.mock('./GraphView', () => ({
  GraphView: ({ focusPath, local, compact }: { focusPath?: string | null; local?: boolean; compact?: boolean }) => (
    <div
      data-testid="graph"
      data-focus={focusPath ?? ''}
      data-local={String(local === true)}
      data-compact={String(compact === true)}
    />
  ),
}))

const PRISTINE = useAppStore.getState()
const PANE = 'pane-a'

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return { id, kind: 'note', path: null, mode: 'edit', pinned: false, ...patch }
}

function pane(id: string, tabs: Tab[], activeTabId = tabs[0]?.id ?? null): Pane {
  return { id, tabs, activeTabId }
}

function seed(files: Record<NotePath, string>): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes) })
}

function tabs(): HTMLElement[] {
  return screen.getAllByRole('tab')
}

/** `label:selected:tabindex` per tab — the whole roving-tabindex state at a glance. */
function tabState(): string[] {
  return tabs().map((button) => `${button.textContent}:${button.getAttribute('aria-selected')}:${button.tabIndex}`)
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      starred: [],
      recent: [],
      toasts: [],
      rightSidebarOpen: true,
      rightSidebarWidth: 300,
      panes: [pane(PANE, [tab('t1', { path: 'A.md' })])],
      activePaneId: PANE,
    },
    true,
  )
  seed({ 'A.md': '# Alpha\n\nbody\n' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RightSidebar tablist', () => {
  it('moves selection and focus together, so every tab is reachable', async () => {
    render(<RightSidebar />)
    expect(tabState()).toEqual([
      'Backlinks:true:0',
      'Outline:false:-1',
      'Local graph:false:-1',
      'Info:false:-1',
    ])

    const first = tabs()[0]!
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    // Focus used to stay behind on a tab that had just lost its tab stop, so
    // the next ArrowRight was computed from the same place and went nowhere.
    expect(document.activeElement).toBe(tabs()[1])
    expect(tabState()[1]).toBe('Outline:true:0')

    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowRight' })
    expect(tabState()[2]).toBe('Local graph:true:0')
    expect(document.activeElement).toBe(tabs()[2])
    // A separate chunk, so it lands a tick after the tab is selected.
    expect(await screen.findByTestId('graph')).not.toBeNull()

    fireEvent.keyDown(tabs()[2]!, { key: 'ArrowRight' })
    expect(tabState()[3]).toBe('Info:true:0')

    // ...and wraps back round to the first.
    fireEvent.keyDown(tabs()[3]!, { key: 'ArrowRight' })
    expect(tabState()[0]).toBe('Backlinks:true:0')
    expect(document.activeElement).toBe(tabs()[0])
  })

  it('walks backwards with ArrowLeft and jumps with Home / End', () => {
    render(<RightSidebar />)
    const first = tabs()[0]!
    first.focus()

    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(tabState()[3]).toBe('Info:true:0')
    expect(document.activeElement).toBe(tabs()[3])

    fireEvent.keyDown(tabs()[3]!, { key: 'Home' })
    expect(tabState()[0]).toBe('Backlinks:true:0')
    expect(document.activeElement).toBe(tabs()[0])

    fireEvent.keyDown(tabs()[0]!, { key: 'End' })
    expect(tabState()[3]).toBe('Info:true:0')
    expect(document.activeElement).toBe(tabs()[3])
  })

  it('leaves exactly one tab in the tab order', () => {
    render(<RightSidebar />)
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' })

    expect(tabs().filter((button) => button.tabIndex === 0)).toHaveLength(1)
    expect(tabs()[1]!.tabIndex).toBe(0)
  })
})

describe('RightSidebar local graph', () => {
  it('renders the local graph for the active note', async () => {
    render(<RightSidebar />)
    fireEvent.click(screen.getByRole('tab', { name: 'Local graph' }))

    const graph = await screen.findByTestId('graph')
    expect(graph.getAttribute('data-focus')).toBe('A.md')
    expect(graph.getAttribute('data-local')).toBe('true')
    expect(graph.getAttribute('data-compact')).toBe('true')
  })

  it('opens on the tab a command asked for, sidebar already on screen', async () => {
    render(<RightSidebar />)
    expect(screen.getByTestId('backlinks')).not.toBeNull()

    act(() => openRightSidebarTab('graph'))

    expect(screen.getByRole('tab', { name: 'Local graph' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('graph')).not.toBeNull()
  })

  it('opens the folded-away sidebar on that tab when it mounts', () => {
    useAppStore.setState({ rightSidebarOpen: false })
    // The sidebar is not mounted yet, exactly as `App` leaves it when folded.
    act(() => openRightSidebarTab('graph'))
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)

    render(<RightSidebar />)
    expect(screen.getByRole('tab', { name: 'Local graph' }).getAttribute('aria-selected')).toBe('true')
  })
})
