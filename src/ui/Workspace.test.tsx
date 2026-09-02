import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AppState } from '../state/store'
import type { Note, NotePath, Pane, Tab } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { Ribbon } from './Ribbon'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TabBar, dropSlotFor, isReopenable, tabTitle } from './TabBar'
import { Workspace, MIN_PANE_WIDTH, PANE_KEY_STEP, PANE_SIZES_KEY, loadPaneSizes, resizePanes } from './Workspace'
import { canReopen, reset as resetHistory } from './paneHistory'

/*
 * The heavy leaves are stubbed: CodeMirror, the markdown renderer and the
 * graph canvas each have their own suites, and what matters here is that the
 * workspace hands the right props to the right one.
 */
vi.mock('./Editor', () => ({
  Editor: ({ path, paneId }: { path: string; paneId: string }) => (
    <div data-testid="editor" data-path={path} data-pane={paneId} />
  ),
}))
vi.mock('./Preview', () => ({
  Preview: ({ path, paneId, scrollSync }: { path: string; paneId: string; scrollSync?: boolean }) => (
    <div data-testid="preview" data-path={path} data-pane={paneId} data-scroll-sync={String(scrollSync === true)} />
  ),
}))
vi.mock('./GraphView', () => ({ GraphView: () => <div data-testid="graph" /> }))
vi.mock('./SearchPanel', () => ({
  SearchPanel: ({ variant }: { variant?: string }) => <div data-testid="search" data-variant={variant ?? 'sidebar'} />,
}))

/** The store as the module defined it, actions included — restored per test. */
const PRISTINE = useAppStore.getState()

const PANE_A = 'pane-a'
const PANE_B = 'pane-b'

type AnyFn = (...args: never[]) => unknown

/** Replace a store action with a spy and hand the spy back. */
function stubAction(key: keyof AppState, impl?: AnyFn) {
  const fn = vi.fn(impl as unknown as (...args: unknown[]) => unknown)
  useAppStore.setState({ [key]: fn } as unknown as Partial<AppState>)
  return fn
}

function seedNotes(files: Record<NotePath, string>): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes) })
}

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return { id, kind: 'note', path: null, mode: 'edit', pinned: false, ...patch }
}

function pane(id: string, tabs: Tab[], activeTabId = tabs[0]?.id ?? null): Pane {
  return { id, tabs, activeTabId }
}

function setPanes(panes: Pane[], activePaneId = panes[0]!.id): void {
  useAppStore.setState({ panes, activePaneId })
}

function panesNow(): Pane[] {
  return useAppStore.getState().panes
}

function tabEl(tabId: string): HTMLElement {
  const element = document.querySelector(`[data-tab-id="${tabId}"]`)
  if (!element) throw new Error(`no tab ${tabId}`)
  return element as HTMLElement
}

function tabTitles(container: ParentNode = document): string[] {
  return [...container.querySelectorAll('.tab-title')].map((element) => element.textContent ?? '')
}

function paneEl(paneId: string): HTMLElement {
  const element = document.querySelector(`[data-pane-id="${paneId}"]`)
  if (!element) throw new Error(`no pane ${paneId}`)
  return element as HTMLElement
}

/** jsdom has no DataTransfer; this is the slice of it the handlers touch. */
function dataTransfer(): Record<string, unknown> {
  const store = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (key: string, value: string) => void store.set(key, value),
    getData: (key: string) => store.get(key) ?? '',
  }
}

/** Give every element a real rect so midpoint / width maths has something to chew on. */
function stubRects(widthFor: (element: HTMLElement) => number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = widthFor(this)
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 0,
      width,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect
  })
}

beforeEach(() => {
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      vaultName: 'Test Vault',
      dirty: new Set(),
      saving: new Set(),
      starred: [],
      recent: [],
      toasts: [],
      sidebarPanel: 'files',
      sidebarWidth: 260,
      hoveredPath: null,
      revision: 0,
      panes: [pane(PANE_A, [tab('t1')])],
      activePaneId: PANE_A,
    },
    true,
  )
  localStorage.clear()
  resetHistory()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetHistory()
})

/* ================================================================== *
 * Pane sizing
 * ================================================================== */

describe('resizePanes', () => {
  it('moves the boundary and keeps the pair total constant', () => {
    expect(resizePanes([600, 400], 0, -120)).toEqual([480, 520])
    expect(resizePanes([600, 400], 0, 120)).toEqual([720, 280])
  })

  it('never lets either side fall below the minimum', () => {
    expect(resizePanes([600, 400], 0, -1000)).toEqual([MIN_PANE_WIDTH, 1000 - MIN_PANE_WIDTH])
    expect(resizePanes([600, 400], 0, 1000)).toEqual([1000 - MIN_PANE_WIDTH, MIN_PANE_WIDTH])
  })

  it('leaves the pair alone when there is no room for two minimums', () => {
    expect(resizePanes([200, 200], 0, -50)).toEqual([200, 200])
  })

  it('leaves panes outside the dragged pair untouched', () => {
    expect(resizePanes([400, 400, 400], 1, 100)).toEqual([400, 500, 300])
  })

  it('ignores an index without a neighbour', () => {
    expect(resizePanes([400, 400], 1, 100)).toEqual([400, 400])
    expect(resizePanes([400, 400], -1, 100)).toEqual([400, 400])
  })
})

describe('loadPaneSizes', () => {
  it('reads back a persisted layout of the right length', () => {
    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify([400, 600]))

    expect(loadPaneSizes(2)).toEqual([400, 600])
    expect(loadPaneSizes(3)).toEqual([])
  })

  it('rejects junk, undersized and non-numeric entries', () => {
    localStorage.setItem(PANE_SIZES_KEY, 'not json')
    expect(loadPaneSizes(2)).toEqual([])

    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify([10, 990]))
    expect(loadPaneSizes(2)).toEqual([])

    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify(['400', 600]))
    expect(loadPaneSizes(2)).toEqual([])
  })
})

/* ================================================================== *
 * Workspace — routing
 * ================================================================== */

describe('Workspace routing', () => {
  beforeEach(() => {
    seedNotes({ 'a.md': '# A\n\nalpha', 'b.md': '# B\n\n[[a]]' })
  })

  it('renders the editor for a note tab in edit mode', async () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md', mode: 'edit' })])])
    render(<Workspace />)

    // The editor is a separate chunk now, so it arrives a tick after the pane.
    const editor = await screen.findByTestId('editor')
    expect(editor.getAttribute('data-path')).toBe('a.md')
    expect(editor.getAttribute('data-pane')).toBe(PANE_A)
    expect(screen.queryByTestId('preview')).toBeNull()
  })

  it('renders the preview for a note tab in preview mode', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md', mode: 'preview' })])])
    render(<Workspace />)

    expect(screen.getByTestId('preview').getAttribute('data-path')).toBe('a.md')
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('renders both sides with scroll sync in split mode', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md', mode: 'split' })])])
    const { container } = render(<Workspace />)

    const split = container.querySelector('.split-view')
    expect(split).not.toBeNull()
    expect(split?.querySelector('.split-editor [data-testid="editor"]')).not.toBeNull()
    expect(split?.querySelector('.split-preview [data-testid="preview"]')).not.toBeNull()
    expect(screen.getByTestId('preview').getAttribute('data-scroll-sync')).toBe('true')
  })

  it('routes graph and search tabs to their views', async () => {
    setPanes([pane(PANE_A, [tab('g', { kind: 'graph' }), tab('s', { kind: 'search' })], 'g')])
    const { rerender } = render(<Workspace />)

    expect(await screen.findByTestId('graph')).not.toBeNull()

    act(() => useAppStore.getState().setActiveTab(PANE_A, 's'))
    rerender(<Workspace />)

    expect(screen.queryByTestId('graph')).toBeNull()
    expect(screen.getByTestId('search').getAttribute('data-variant')).toBe('tab')
  })

  it('offers the empty state when the tab has no note', () => {
    setPanes([pane(PANE_A, [tab('t1')])])
    const createNote = stubAction('createNoteFromTitle', (async () => 'Untitled.md') as unknown as AnyFn)
    const openView = stubAction('openView')
    const setPalette = stubAction('setPalette')
    render(<Workspace />)

    fireEvent.click(screen.getByRole('button', { name: 'Create new note' }))
    expect(createNote).toHaveBeenCalledWith('Untitled')

    fireEvent.click(screen.getByRole('button', { name: /quick switcher/i }))
    expect(setPalette).toHaveBeenCalledWith('quickswitch')

    fireEvent.click(screen.getByRole('button', { name: 'Open the graph' }))
    expect(openView).toHaveBeenCalledWith('graph', { paneId: PANE_A })
  })
})

/* ================================================================== *
 * Workspace — panes
 * ================================================================== */

describe('Workspace panes', () => {
  beforeEach(() => {
    seedNotes({ 'a.md': 'alpha', 'b.md': 'beta' })
  })

  it('marks only the active pane and switches on click', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })]), pane(PANE_B, [tab('t2', { path: 'b.md' })])], PANE_A)
    render(<Workspace />)

    expect(paneEl(PANE_A).className).toContain('is-active')
    expect(paneEl(PANE_B).className).not.toContain('is-active')

    fireEvent.mouseDown(paneEl(PANE_B))

    expect(useAppStore.getState().activePaneId).toBe(PANE_B)
    expect(paneEl(PANE_B).className).toContain('is-active')
    expect(paneEl(PANE_A).className).not.toContain('is-active')
  })

  it('drags the splitter, applies the widths and persists them', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })]), pane(PANE_B, [tab('t2', { path: 'b.md' })])])
    stubRects((element) =>
      element.classList.contains('workspace') ? 1000 : element.hasAttribute('data-pane-id') ? 500 : 0,
    )
    render(<Workspace />)

    const splitter = screen.getByRole('separator', { name: 'Resize panes' })
    fireEvent.mouseDown(splitter, { clientX: 500, button: 0 })
    fireEvent.mouseMove(window, { clientX: 400 })

    expect(paneEl(PANE_A).style.flex).toBe('0 1 400px')
    expect(paneEl(PANE_B).style.flex).toBe('0 1 600px')

    fireEvent.mouseUp(window)

    expect(JSON.parse(localStorage.getItem(PANE_SIZES_KEY) ?? 'null')).toEqual([400, 600])
  })

  it('clamps a splitter drag at the minimum pane width', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })]), pane(PANE_B, [tab('t2', { path: 'b.md' })])])
    stubRects((element) =>
      element.classList.contains('workspace') ? 1000 : element.hasAttribute('data-pane-id') ? 500 : 0,
    )
    render(<Workspace />)

    fireEvent.mouseDown(screen.getByRole('separator', { name: 'Resize panes' }), { clientX: 500, button: 0 })
    fireEvent.mouseMove(window, { clientX: 0 })
    fireEvent.mouseUp(window)

    expect(paneEl(PANE_A).style.flex).toBe(`0 1 ${MIN_PANE_WIDTH}px`)
    expect(paneEl(PANE_B).style.flex).toBe(`0 1 ${1000 - MIN_PANE_WIDTH}px`)
  })

  it('resizes the splitter from the keyboard and reports its position', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })]), pane(PANE_B, [tab('t2', { path: 'b.md' })])])
    stubRects((element) =>
      element.classList.contains('workspace') ? 1000 : element.hasAttribute('data-pane-id') ? 500 : 0,
    )
    render(<Workspace />)

    const splitter = screen.getByRole('separator', { name: 'Resize panes' })
    // Focusable, and it says where it sits — it used to be mouse-only.
    expect(splitter.tabIndex).toBe(0)
    expect(splitter.getAttribute('aria-valuenow')).toBe('50')
    expect(splitter.getAttribute('aria-valuemin')).toBe('0')
    expect(splitter.getAttribute('aria-valuemax')).toBe('100')

    fireEvent.keyDown(splitter, { key: 'ArrowRight' })
    expect(paneEl(PANE_A).style.flex).toBe(`0 1 ${500 + PANE_KEY_STEP}px`)
    expect(paneEl(PANE_B).style.flex).toBe(`0 1 ${500 - PANE_KEY_STEP}px`)

    fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' })
    expect(paneEl(PANE_A).style.flex).toBe(`0 1 ${500 - PANE_KEY_STEP}px`)
    expect(JSON.parse(localStorage.getItem(PANE_SIZES_KEY) ?? 'null')).toEqual([500 - PANE_KEY_STEP, 500 + PANE_KEY_STEP])
  })

  it('sends the splitter to either extreme with Home and End, within the minimums', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })]), pane(PANE_B, [tab('t2', { path: 'b.md' })])])
    stubRects((element) =>
      element.classList.contains('workspace') ? 1000 : element.hasAttribute('data-pane-id') ? 500 : 0,
    )
    render(<Workspace />)

    const splitter = screen.getByRole('separator', { name: 'Resize panes' })
    fireEvent.keyDown(splitter, { key: 'Home' })
    expect(paneEl(PANE_A).style.flex).toBe(`0 1 ${MIN_PANE_WIDTH}px`)

    fireEvent.keyDown(splitter, { key: 'End' })
    expect(paneEl(PANE_A).style.flex).toBe(`0 1 ${1000 - MIN_PANE_WIDTH}px`)
    expect(splitter.getAttribute('aria-valuenow')).toBe('76')
  })

  it('falls back to equal shares when the pane count no longer matches the saved layout', () => {
    localStorage.setItem(PANE_SIZES_KEY, JSON.stringify([400, 600]))
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })])])
    render(<Workspace />)

    expect(paneEl(PANE_A).style.flex).toBe('')
  })
})

/* ================================================================== *
 * Workspace — navigation history
 * ================================================================== */

describe('Workspace navigation history', () => {
  beforeEach(() => {
    seedNotes({ 'a.md': 'alpha', 'b.md': 'beta', 'c.md': 'gamma' })
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })])])
  })

  function activePath(): NotePath | null {
    const current = panesNow()[0]!
    return current.tabs.find((candidate) => candidate.id === current.activeTabId)?.path ?? null
  }

  it('enables back once a second note has been opened, and walks the stack', () => {
    render(<Workspace />)

    const backButton = screen.getByRole('button', { name: 'Navigate back' }) as HTMLButtonElement
    const forwardButton = screen.getByRole('button', { name: 'Navigate forward' }) as HTMLButtonElement
    expect(backButton.disabled).toBe(true)
    expect(forwardButton.disabled).toBe(true)

    act(() => useAppStore.getState().openPath('b.md'))
    expect(activePath()).toBe('b.md')
    expect(backButton.disabled).toBe(false)

    fireEvent.click(backButton)
    expect(activePath()).toBe('a.md')
    expect(forwardButton.disabled).toBe(false)

    fireEvent.click(forwardButton)
    expect(activePath()).toBe('b.md')
    expect(forwardButton.disabled).toBe(true)
  })

  it('truncates the forward stack when a new note is opened after going back', () => {
    render(<Workspace />)

    act(() => useAppStore.getState().openPath('b.md'))
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }))
    act(() => useAppStore.getState().openPath('c.md'))

    expect((screen.getByRole('button', { name: 'Navigate forward' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }))
    expect(activePath()).toBe('a.md')
  })

  it('treats a rename of the note on screen as a rename, not as a step in the history', async () => {
    render(<Workspace />)
    act(() => useAppStore.getState().openPath('b.md'))
    act(() => useAppStore.getState().openPath('c.md'))
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' })) // on b.md, c.md ahead

    await act(() => useAppStore.getState().renameNote('b.md', 'b2.md'))

    expect(activePath()).toBe('b2.md')
    const forwardButton = screen.getByRole('button', { name: 'Navigate forward' }) as HTMLButtonElement
    expect(forwardButton.disabled).toBe(false)
    fireEvent.click(forwardButton)
    expect(activePath()).toBe('c.md')
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }))
    expect(activePath()).toBe('b2.md')
  })

  it('keeps a separate history per pane', () => {
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })]), pane(PANE_B, [tab('t2', { path: 'b.md' })])], PANE_A)
    render(<Workspace />)

    act(() => useAppStore.getState().openPath('c.md', { paneId: PANE_A }))

    const backButtons = screen.getAllByRole('button', { name: 'Navigate back' }) as HTMLButtonElement[]
    expect(backButtons[0]?.disabled).toBe(false)
    expect(backButtons[1]?.disabled).toBe(true)
  })
})

/* ================================================================== *
 * TabBar
 * ================================================================== */

describe('TabBar', () => {
  beforeEach(() => {
    seedNotes({ 'a.md': '# Alpha\n\nbody', 'b.md': 'beta', 'notes/c.md': 'gamma' })
  })

  function renderBar(panes: Pane[], activePaneId = panes[0]!.id): void {
    setPanes(panes, activePaneId)
    const Harness = (): React.JSX.Element => {
      const live = useAppStore((s) => s.panes)
      return (
        <>
          {live.map((current) => (
            <TabBar key={current.id} pane={current} />
          ))}
        </>
      )
    }
    render(<Harness />)
  }

  it('shows note titles, view names and a dirty dot', () => {
    useAppStore.setState({ dirty: new Set<NotePath>(['b.md']) })
    renderBar([
      pane(PANE_A, [
        tab('t1', { path: 'a.md' }),
        tab('t2', { path: 'b.md' }),
        tab('t3', { kind: 'graph' }),
        tab('t4', { kind: 'search' }),
        tab('t5'),
      ]),
    ])

    // `a.md` has an H1, so the title comes from the note, not the file name.
    expect(tabTitles()).toEqual(['Alpha', 'b', 'Graph', 'Search', 'New tab'])
    expect(within(tabEl('t1')).queryByLabelText('Unsaved changes')).toBeNull()
    expect(within(tabEl('t2')).getByLabelText('Unsaved changes')).not.toBeNull()
  })

  it('activates a tab on click and closes it with the close button', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' })], 't1')])

    fireEvent.click(tabEl('t2'))
    expect(panesNow()[0]?.activeTabId).toBe('t2')

    fireEvent.click(within(tabEl('t1')).getByRole('button', { name: 'Close Alpha' }))

    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t2'])
    expect(tabTitles()).toEqual(['b'])
  })

  it('closes a tab on middle click', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' })], 't1')])

    // RTL has no `auxClick` helper, so the native event is dispatched directly.
    fireEvent(tabEl('t1'), new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))

    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t2'])
  })

  it('opens a new empty tab when the empty strip is double-clicked', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md' })])])
    const strip = screen.getByRole('tablist')

    fireEvent.doubleClick(strip)

    const tabs = panesNow()[0]!.tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[1]?.path).toBeNull()
    expect(panesNow()[0]?.activeTabId).toBe(tabs[1]?.id)

    // A double-click on a tab itself must not add another one.
    fireEvent.doubleClick(tabEl('t1'))
    expect(panesNow()[0]?.tabs).toHaveLength(2)
  })

  it('switches the view mode from the tab-bar actions', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md', mode: 'edit' })])])

    fireEvent.click(screen.getByRole('button', { name: 'Preview view' }))

    expect(panesNow()[0]?.tabs[0]?.mode).toBe('preview')
    expect(screen.getByRole('button', { name: 'Preview view' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Edit view' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('splits to a new pane from the tab-bar action', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md' })])])

    fireEvent.click(screen.getByRole('button', { name: 'Split right' }))

    expect(panesNow()).toHaveLength(2)
    expect(panesNow()[1]?.tabs[0]?.path).toBe('a.md')
  })

  it('runs the tab context menu actions', () => {
    renderBar([
      pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' }), tab('t3', { path: 'notes/c.md' })], 't1'),
    ])

    fireEvent.contextMenu(tabEl('t2'), { clientX: 20, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    expect(panesNow()[0]?.tabs[1]?.pinned).toBe(true)

    fireEvent.contextMenu(tabEl('t1'), { clientX: 20, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close to the right' }))
    // t2 is pinned, so only t3 goes.
    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])

    fireEvent.contextMenu(tabEl('t1'), { clientX: 20, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close others' }))
    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('copies the path of a tab through the context menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderBar([pane(PANE_A, [tab('t1', { path: 'notes/c.md' })])])

    fireEvent.contextMenu(tabEl('t1'), { clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))

    expect(writeText).toHaveBeenCalledWith('notes/c.md')
  })

  it('moves selection and focus through the strip with the arrow keys', () => {
    renderBar([
      pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' }), tab('t3', { path: 'notes/c.md' })], 't1'),
    ])

    tabEl('t1').focus()
    fireEvent.keyDown(tabEl('t1'), { key: 'ArrowRight' })
    expect(panesNow()[0]?.activeTabId).toBe('t2')
    // Focus follows selection, so the next arrow starts from the new tab.
    expect(document.activeElement).toBe(tabEl('t2'))

    fireEvent.keyDown(tabEl('t2'), { key: 'ArrowRight' })
    expect(panesNow()[0]?.activeTabId).toBe('t3')
    expect(document.activeElement).toBe(tabEl('t3'))

    // ...and wraps, as a tablist does.
    fireEvent.keyDown(tabEl('t3'), { key: 'ArrowRight' })
    expect(panesNow()[0]?.activeTabId).toBe('t1')

    fireEvent.keyDown(tabEl('t1'), { key: 'End' })
    expect(panesNow()[0]?.activeTabId).toBe('t3')
    fireEvent.keyDown(tabEl('t3'), { key: 'Home' })
    expect(panesNow()[0]?.activeTabId).toBe('t1')
    expect(document.activeElement).toBe(tabEl('t1'))
  })

  it('keeps one tab stop in the strip and reaches close from the tab itself', () => {
    renderBar([
      pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' }), tab('t3', { path: 'notes/c.md' })], 't1'),
    ])

    // Tabbing through a strip used to stop on every inactive tab's close button.
    const stops = [...screen.getByRole('tablist').querySelectorAll<HTMLElement>('[tabindex]')].filter(
      (element) => element.tabIndex >= 0,
    )
    expect(stops).toEqual([tabEl('t1')])
    for (const name of ['Close Alpha', 'Close b', 'Close c']) {
      expect(screen.getByRole('button', { name }).tabIndex).toBe(-1)
    }

    fireEvent.keyDown(tabEl('t1'), { key: 'Delete' })
    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t2', 't3'])
  })

  it('reopens the most recently closed tab from the more menu', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' })], 't1')])

    fireEvent.click(within(tabEl('t2')).getByRole('button', { name: 'Close b' }))
    expect(tabTitles()).toEqual(['Alpha'])

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen closed tab' }))

    expect(panesNow()[0]?.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])
  })

  it('reorders tabs by dropping one onto a later slot', () => {
    renderBar([
      pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' }), tab('t3', { path: 'notes/c.md' })], 't1'),
    ])

    // Dropping on the front half of t3 means "the slot before t3": t1 comes out
    // of position 0, so it lands between t2 and t3.
    const transfer = dataTransfer()
    fireEvent.dragStart(tabEl('t1'), { dataTransfer: transfer })
    fireEvent.dragOver(tabEl('t3'), { dataTransfer: transfer })
    fireEvent.drop(tabEl('t3'), { dataTransfer: transfer })

    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t2', 't1', 't3'])
    expect(transfer.effectAllowed).toBe('move')
    expect(tabTitles()).toEqual(['b', 'Alpha', 'c'])
  })

  it('does nothing when a tab is dropped on the slot it already occupies', () => {
    renderBar([pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' })], 't1')])

    const transfer = dataTransfer()
    fireEvent.dragStart(tabEl('t1'), { dataTransfer: transfer })
    fireEvent.drop(tabEl('t1'), { dataTransfer: transfer })

    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('moves a tab into the other pane when dropped on its strip', () => {
    renderBar(
      [pane(PANE_A, [tab('t1', { path: 'a.md' }), tab('t2', { path: 'b.md' })], 't1'), pane(PANE_B, [tab('t3', { path: 'notes/c.md' })])],
      PANE_A,
    )

    const strips = screen.getAllByRole('tablist')
    const transfer = dataTransfer()
    fireEvent.dragStart(tabEl('t1'), { dataTransfer: transfer })
    fireEvent.dragOver(strips[1]!, { dataTransfer: transfer })
    fireEvent.drop(strips[1]!, { dataTransfer: transfer })

    expect(panesNow()[0]?.tabs.map((t) => t.id)).toEqual(['t2'])
    expect(panesNow()[1]?.tabs.map((t) => t.id)).toEqual(['t3', 't1'])
    expect(useAppStore.getState().activePaneId).toBe(PANE_B)
  })
})

describe('dropSlotFor', () => {
  it('puts the drop before the tab in its front half and after it beyond the midpoint', () => {
    expect(dropSlotFor(2, 10, { left: 0, width: 100 })).toBe(2)
    expect(dropSlotFor(2, 51, { left: 0, width: 100 })).toBe(3)
    expect(dropSlotFor(2, 151, { left: 100, width: 100 })).toBe(3)
  })

  it('falls back to "before" when the tab or the pointer cannot be measured', () => {
    expect(dropSlotFor(2, 90, { left: 0, width: 0 })).toBe(2)
    expect(dropSlotFor(2, 90, null)).toBe(2)
    expect(dropSlotFor(2, Number.NaN, { left: 0, width: 100 })).toBe(2)
  })
})

describe('tabTitle', () => {
  it('prefers the parsed title, then the basename, and names the views', () => {
    const notes = new Map<NotePath, Note>([
      ['a.md', makeNote('a.md', '# Alpha', 1)],
      ['notes/b.md', makeNote('notes/b.md', 'no heading', 1)],
    ])

    expect(tabTitle(tab('x', { path: 'a.md' }), notes)).toBe('Alpha')
    expect(tabTitle(tab('x', { path: 'notes/b.md' }), notes)).toBe('b')
    expect(tabTitle(tab('x', { path: 'gone.md' }), notes)).toBe('gone')
    expect(tabTitle(tab('x', { kind: 'graph' }), notes)).toBe('Graph')
    expect(tabTitle(tab('x', { kind: 'search' }), notes)).toBe('Search')
    expect(tabTitle(tab('x'), notes)).toBe('New tab')
  })
})

/* ================================================================== *
 * Ribbon
 * ================================================================== */

describe('Ribbon', () => {
  it('toggles the sidebar panels and shows which one is open', () => {
    render(<Ribbon onOpenSettings={() => {}} />)

    const files = screen.getByRole('button', { name: 'Files' })
    const tags = screen.getByRole('button', { name: 'Tags' })
    expect(files.getAttribute('aria-pressed')).toBe('true')
    expect(files.className).toContain('is-active')

    fireEvent.click(tags)
    expect(useAppStore.getState().sidebarPanel).toBe('tags')
    expect(tags.getAttribute('aria-pressed')).toBe('true')
    expect(files.getAttribute('aria-pressed')).toBe('false')

    // Clicking the open panel closes the sidebar.
    fireEvent.click(tags)
    expect(useAppStore.getState().sidebarPanel).toBeNull()
    expect(tags.getAttribute('aria-pressed')).toBe('false')
  })

  it('wires the creation actions and settings', () => {
    const createNote = stubAction('createNoteFromTitle', (async () => 'Untitled.md') as unknown as AnyFn)
    const openDaily = stubAction('openDailyNote', (async () => undefined) as unknown as AnyFn)
    const openView = stubAction('openView')
    const onOpenSettings = vi.fn()
    render(<Ribbon onOpenSettings={onOpenSettings} />)

    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Daily note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Graph view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(createNote).toHaveBeenCalledWith('Untitled')
    expect(openDaily).toHaveBeenCalled()
    expect(openView).toHaveBeenCalledWith('graph')
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('flips the theme between light and dark', () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, theme: 'light' } })
    render(<Ribbon onOpenSettings={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(useAppStore.getState().settings.theme).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(useAppStore.getState().settings.theme).toBe('light')
  })
})

/* ================================================================== *
 * StatusBar
 * ================================================================== */

describe('StatusBar', () => {
  it('shows the vault, note count and nothing note-specific when nothing is open', () => {
    seedNotes({ 'a.md': 'alpha', 'b.md': 'beta' })
    setPanes([pane(PANE_A, [tab('t1')])])
    render(<StatusBar />)

    expect(screen.getByText('Test Vault')).not.toBeNull()
    expect(screen.getByText('2 notes')).not.toBeNull()
    expect(screen.queryByText(/word/)).toBeNull()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('counts words, characters and backlinks for the active note', () => {
    seedNotes({ 'a.md': 'one two three four five', 'b.md': '[[a]] and [[a]] again' })
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md', mode: 'split' })])])
    render(<StatusBar />)

    expect(screen.getByText('5 words')).not.toBeNull()
    expect(screen.getByText('23 characters')).not.toBeNull()
    expect(screen.getByText('2 backlinks')).not.toBeNull()
    expect(screen.getByText('Split')).not.toBeNull()
  })

  it('follows the save state of the active note', () => {
    seedNotes({ 'a.md': 'alpha' })
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md' })])])
    const { rerender } = render(<StatusBar />)

    expect(screen.getByRole('status').textContent).toContain('Saved')

    act(() => useAppStore.setState({ dirty: new Set<NotePath>(['a.md']) }))
    rerender(<StatusBar />)
    expect(screen.getByRole('status').textContent).toBe('Unsaved changes')

    act(() => useAppStore.setState({ saving: new Set<NotePath>(['a.md']) }))
    rerender(<StatusBar />)
    expect(screen.getByRole('status').textContent).toBe('Saving…')
  })

  it('asks the shell for the vault picker', () => {
    const listener = vi.fn()
    window.addEventListener('spacefore:open-vault-picker', listener)
    render(<StatusBar />)

    fireEvent.click(screen.getByRole('button', { name: /Open the vault picker/ }))

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('spacefore:open-vault-picker', listener)
  })
})

/* ================================================================== *
 * Sidebar
 * ================================================================== */

describe('Sidebar', () => {
  it('shows the panel the ribbon selected', () => {
    useAppStore.setState({ sidebarPanel: 'search' })
    const { rerender } = render(<Sidebar />)
    expect(screen.getByTestId('search').getAttribute('data-variant')).toBe('sidebar')

    act(() => useAppStore.setState({ sidebarPanel: 'tags' }))
    rerender(<Sidebar />)
    expect(screen.queryByTestId('search')).toBeNull()
    expect(document.querySelector('.tag-panel')).not.toBeNull()
  })

  it('resizes by dragging the handle and with the arrow keys', () => {
    useAppStore.setState({ sidebarPanel: 'search', sidebarWidth: 260 })
    render(<Sidebar />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.mouseDown(handle, { clientX: 260, button: 0 })
    fireEvent.mouseMove(window, { clientX: 320 })
    expect(useAppStore.getState().sidebarWidth).toBe(320)

    fireEvent.mouseUp(window)
    // The drag is over: further movement must not resize anything.
    fireEvent.mouseMove(window, { clientX: 500 })
    expect(useAppStore.getState().sidebarWidth).toBe(320)

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(useAppStore.getState().sidebarWidth).toBe(304)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useAppStore.getState().sidebarWidth).toBe(320)
  })

  it('clamps the width to the bounds the store enforces', () => {
    useAppStore.setState({ sidebarPanel: 'search', sidebarWidth: 260 })
    render(<Sidebar />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.mouseDown(handle, { clientX: 260, button: 0 })
    fireEvent.mouseMove(window, { clientX: 0 })
    expect(useAppStore.getState().sidebarWidth).toBe(180)

    fireEvent.mouseMove(window, { clientX: 2000 })
    expect(useAppStore.getState().sidebarWidth).toBe(520)
  })
})

describe('a pinned tab, against every way of closing it', () => {
  it('survives its close button and a middle click', () => {
    seedNotes({ 'a.md': '# a', 'b.md': '# b' })
    setPanes([pane(PANE_A, [tab('t1', { path: 'a.md', pinned: true }), tab('t2', { path: 'b.md' })])])
    render(<TabBar pane={panesNow()[0]!} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close a' }))
    expect(panesNow()[0]!.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])

    fireEvent(screen.getByRole('tab', { name: /^a\b/ }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(panesNow()[0]!.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])

    // The store itself is the guard, whatever the caller.
    useAppStore.getState().closeTab(PANE_A, 't1')
    expect(panesNow()[0]!.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])
    // And none of those attempts put the pinned tab on the reopen stack.
    expect(canReopen()).toBe(false)
  })

  it('never counts a blank placeholder as something to reopen', () => {
    const notes = new Map<NotePath, Note>([['a.md', makeNote('a.md', '# a', 1)]])
    expect(isReopenable(tab('blank', { path: null }), notes)).toBe(false)
    expect(isReopenable(tab('t1', { path: 'a.md' }), notes)).toBe(true)
    expect(isReopenable(tab('gone', { path: 'zzz.md' }), notes)).toBe(false)
    expect(isReopenable({ ...tab('graph'), kind: 'graph' } as Tab, notes)).toBe(true)
  })
})
