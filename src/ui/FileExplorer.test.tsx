import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { JSX } from 'react'

import type { AppState } from '../state/store'
import type { Note, NotePath, VaultFile } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import type { ExplorerEntry } from './FileExplorer'
import { FileExplorer, buildFileTree } from './FileExplorer'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem } from './useContextMenu'
import { useContextMenu } from './useContextMenu'

/** The store as the module defined it, actions included — restored per test. */
const PRISTINE = useAppStore.getState()

const PANE_ID = 'pane-a'

function seed(files: Record<NotePath, string>, mtimes: Record<NotePath, number> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) {
    notes.set(path, makeNote(path, content, mtimes[path] ?? 1))
  }
  useAppStore.setState({ notes, index: buildIndex(notes) })
}

type AnyFn = (...args: never[]) => unknown

/** Replace a store action with a spy and hand the spy back. */
function stubAction(key: keyof AppState, impl?: AnyFn) {
  const fn = vi.fn(impl as unknown as (...args: unknown[]) => unknown)
  useAppStore.setState({ [key]: fn } as unknown as Partial<AppState>)
  return fn
}

function row(path: string): HTMLElement {
  const element = document.querySelector(`[data-path="${path}"]`)
  if (!element) throw new Error(`no row for ${path}`)
  return element as HTMLElement
}

function queryRow(path: string): HTMLElement | null {
  return document.querySelector(`[data-path="${path}"]`)
}

function tree(): HTMLElement {
  const element = document.querySelector('[role="tree"]')
  if (!element) throw new Error('tree missing')
  return element as HTMLElement
}

function paths(kind: 'file' | 'folder'): string[] {
  return [...document.querySelectorAll(`[data-kind="${kind}"]`)].map((el) => el.getAttribute('data-path') ?? '')
}

/** jsdom has no DataTransfer; this is the slice of it drag handlers touch. */
function dataTransfer(): Record<string, unknown> {
  const store = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (key: string, value: string) => void store.set(key, value),
    getData: (key: string) => store.get(key) ?? '',
  }
}

function attachment(path: NotePath, extension: string): VaultFile {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), extension, isMarkdown: false, size: 10, mtime: 1 }
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
      hoveredPath: null,
      revision: 0,
      panes: [{ id: PANE_ID, tabs: [], activeTabId: null }],
      activePaneId: PANE_ID,
    },
    true,
  )
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ================================================================== *
 * Tree building
 * ================================================================== */

function entry(path: string, time = 0): ExplorerEntry {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const isMarkdown = base.toLowerCase().endsWith('.md')
  return { path, name: isMarkdown ? base.slice(0, -3) : base, isMarkdown, time }
}

describe('buildFileTree', () => {
  it('creates every intermediate folder for a deeply nested path', () => {
    const root = buildFileTree([entry('a/b/c/d/deep.md'), entry('top.md')])

    expect(root.path).toBe('')
    expect(root.children.map((n) => n.name)).toEqual(['a', 'top'])

    const a = root.children[0]
    if (a?.kind !== 'folder') throw new Error('expected folder a')
    const b = a.children[0]
    if (b?.kind !== 'folder') throw new Error('expected folder b')
    const c = b.children[0]
    if (c?.kind !== 'folder') throw new Error('expected folder c')
    const d = c.children[0]
    if (d?.kind !== 'folder') throw new Error('expected folder d')
    expect([a.path, b.path, c.path, d.path]).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d'])
    expect(d.children.map((n) => n.name)).toEqual(['deep'])
  })

  it('shares one folder node between siblings instead of duplicating it', () => {
    const root = buildFileTree([entry('notes/one.md'), entry('notes/two.md'), entry('notes/sub/three.md')])

    expect(root.children).toHaveLength(1)
    const notes = root.children[0]
    if (notes?.kind !== 'folder') throw new Error('expected folder')
    expect(notes.children.map((n) => `${n.kind}:${n.name}`)).toEqual(['folder:sub', 'file:one', 'file:two'])
  })

  it('sorts folders before files, case-insensitively', () => {
    const root = buildFileTree([
      entry('Zebra.md'),
      entry('apple.md'),
      entry('zeta/x.md'),
      entry('Beta/y.md'),
      entry('_underscore.md'),
    ])

    expect(root.children.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'folder:Beta',
      'folder:zeta',
      'file:_underscore',
      'file:apple',
      'file:Zebra',
    ])
  })

  it('sorts by time (newest first) when the sort mode is not "name"', () => {
    const root = buildFileTree(
      [entry('old.md', 100), entry('new.md', 900), entry('folderA/x.md', 200), entry('folderB/y.md', 800)],
      'modified',
    )

    // Folders still lead, ordered by their newest descendant.
    expect(root.children.map((n) => n.name)).toEqual(['folderB', 'folderA', 'new', 'old'])
  })

  it('falls back to names when two entries share a timestamp', () => {
    const root = buildFileTree([entry('b.md', 5), entry('a.md', 5)], 'modified')
    expect(root.children.map((n) => n.name)).toEqual(['a', 'b'])
  })

  it('seeds folders that hold no file yet', () => {
    const root = buildFileTree([entry('a.md')], 'name', ['Empty/Nested'])
    const empty = root.children[0]
    if (empty?.kind !== 'folder') throw new Error('expected folder')
    expect(empty.path).toBe('Empty')
    expect(empty.children.map((n) => n.path)).toEqual(['Empty/Nested'])
  })

  it('handles an empty vault', () => {
    expect(buildFileTree([]).children).toEqual([])
  })
})

/* ================================================================== *
 * Rendering
 * ================================================================== */

describe('FileExplorer — rendering', () => {
  it('renders the vault name and a row per top-level entry', () => {
    seed({ 'Notes/A.md': '# A', 'Root.md': '# Root' })
    render(<FileExplorer />)

    expect(screen.getByText('Test Vault')).toBeTruthy()
    expect(paths('folder')).toEqual(['Notes'])
    expect(paths('file')).toEqual(['Root'.concat('.md')])
    // Collapsed by default, so the child is not in the DOM at all.
    expect(queryRow('Notes/A.md')).toBeNull()
  })

  it('marks up the tree with tree/treeitem roles, levels and expansion state', () => {
    seed({ 'Notes/Sub/Deep.md': '# D', 'Root.md': '# R' })
    render(<FileExplorer />)

    expect(tree().getAttribute('aria-label')).toBe('Vault files')
    expect(row('Notes').getAttribute('role')).toBe('treeitem')
    expect(row('Notes').getAttribute('aria-expanded')).toBe('false')
    expect(row('Notes').getAttribute('aria-level')).toBe('1')
    // Files are leaves: no aria-expanded at all.
    expect(row('Root.md').hasAttribute('aria-expanded')).toBe(false)

    fireEvent.click(row('Notes'))
    expect(row('Notes').getAttribute('aria-expanded')).toBe('true')
    expect(row('Notes/Sub').getAttribute('aria-level')).toBe('2')
    fireEvent.click(row('Notes/Sub'))
    expect(row('Notes/Sub/Deep.md').getAttribute('aria-level')).toBe('3')
  })

  it('shows a star for starred notes and a dot for unsaved ones', () => {
    seed({ 'A.md': '# A', 'B.md': '# B' })
    useAppStore.setState({ starred: ['A.md'], dirty: new Set(['B.md']) })
    render(<FileExplorer />)

    expect(within(row('A.md')).getByLabelText('Starred')).toBeTruthy()
    expect(within(row('A.md')).queryByLabelText('Unsaved changes')).toBeNull()
    expect(within(row('B.md')).getByLabelText('Unsaved changes')).toBeTruthy()
  })

  it('highlights the active note and expands the folders above it', () => {
    seed({ 'Notes/Deep/A.md': '# A' })
    useAppStore.setState({
      panes: [{ id: PANE_ID, tabs: [{ id: 't1', kind: 'note', path: 'Notes/Deep/A.md', mode: 'edit', pinned: false }], activeTabId: 't1' }],
    })
    render(<FileExplorer />)

    expect(row('Notes/Deep/A.md').getAttribute('aria-current')).toBe('true')
    expect(row('Notes/Deep/A.md').className).toContain('is-active')
    expect(row('Notes').getAttribute('aria-expanded')).toBe('true')
  })

  it('lists attachments but does not open them', () => {
    seed({ 'A.md': '# A' })
    useAppStore.setState({ attachments: [attachment('img/pic.png', 'png')] })
    const openPath = stubAction('openPath')
    render(<FileExplorer />)

    fireEvent.click(row('img'))
    expect(row('img/pic.png').className).toContain('is-attachment')
    fireEvent.click(row('img/pic.png'))
    expect(openPath).not.toHaveBeenCalled()
  })

  it('offers a call to action when the vault is empty', async () => {
    const createNoteFromTitle = stubAction('createNoteFromTitle', (async () => 'Untitled.md') as AnyFn)
    render(<FileExplorer />)

    expect(document.querySelector('[role="tree"]')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create your first note' }))
    })
    expect(createNoteFromTitle).toHaveBeenCalledWith('Untitled')
  })
})

/* ================================================================== *
 * Opening notes
 * ================================================================== */

describe('FileExplorer — opening', () => {
  it('opens a note in the current tab on click', () => {
    seed({ 'A.md': '# A' })
    const openPath = stubAction('openPath')
    render(<FileExplorer />)

    fireEvent.click(row('A.md'))
    expect(openPath.mock.calls).toEqual([['A.md', {}]])
  })

  it('opens in a new tab on Cmd/Ctrl+click', () => {
    seed({ 'A.md': '# A' })
    const openPath = stubAction('openPath')
    render(<FileExplorer />)

    fireEvent.click(row('A.md'), { metaKey: true })
    fireEvent.click(row('A.md'), { ctrlKey: true })
    expect(openPath.mock.calls).toEqual([
      ['A.md', { newTab: true }],
      ['A.md', { newTab: true }],
    ])
  })

  it('opens in a new tab on middle click', () => {
    seed({ 'A.md': '# A' })
    const openPath = stubAction('openPath')
    render(<FileExplorer />)

    fireEvent(row('A.md'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(openPath.mock.calls).toEqual([['A.md', { newTab: true }]])
  })

  it('ignores other auxiliary buttons', () => {
    seed({ 'A.md': '# A' })
    const openPath = stubAction('openPath')
    render(<FileExplorer />)

    fireEvent(row('A.md'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))
    expect(openPath).not.toHaveBeenCalled()
  })
})

/* ================================================================== *
 * Folders: expand, collapse, persistence
 * ================================================================== */

describe('FileExplorer — folders', () => {
  it('toggles a folder on click and remembers it across mounts', () => {
    seed({ 'Notes/A.md': '# A' })
    render(<FileExplorer />)

    fireEvent.click(row('Notes'))
    expect(queryRow('Notes/A.md')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('spacefore.explorer.open') ?? '[]')).toEqual(['Notes'])

    cleanup()
    render(<FileExplorer />)
    // Restored from localStorage without another click.
    expect(queryRow('Notes/A.md')).not.toBeNull()

    fireEvent.click(row('Notes'))
    expect(queryRow('Notes/A.md')).toBeNull()
    expect(JSON.parse(localStorage.getItem('spacefore.explorer.open') ?? '[]')).toEqual([])
  })

  it('survives corrupt persisted state', () => {
    localStorage.setItem('spacefore.explorer.open', '{not json')
    seed({ 'Notes/A.md': '# A' })
    render(<FileExplorer />)
    expect(queryRow('Notes/A.md')).toBeNull()
  })

  it('expands and collapses a whole subtree on Alt+click', () => {
    seed({ 'Notes/Sub/Deep/A.md': '# A' })
    render(<FileExplorer />)

    fireEvent.click(row('Notes'), { altKey: true })
    expect(queryRow('Notes/Sub/Deep/A.md')).not.toBeNull()

    fireEvent.click(row('Notes'), { altKey: true })
    expect(queryRow('Notes/Sub')).toBeNull()
    expect(JSON.parse(localStorage.getItem('spacefore.explorer.open') ?? '[]')).toEqual([])
  })

  it('collapses everything from the header button', () => {
    seed({ 'Notes/Sub/A.md': '# A', 'Other/B.md': '# B' })
    render(<FileExplorer />)

    fireEvent.click(row('Notes'), { altKey: true })
    fireEvent.click(row('Other'))
    expect(queryRow('Notes/Sub/A.md')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(queryRow('Notes/Sub')).toBeNull()
    expect(queryRow('Other/B.md')).toBeNull()
  })

  it('reorders the tree when the sort selector changes', () => {
    seed({ 'a.md': '# a', 'b.md': '# b' }, { 'a.md': 10, 'b.md': 500 })
    render(<FileExplorer />)

    expect(paths('file')).toEqual(['a.md', 'b.md'])
    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: 'modified' } })
    expect(paths('file')).toEqual(['b.md', 'a.md'])
  })

  it('sorts by the frontmatter creation date, not the mtime', () => {
    seed(
      {
        'old.md': '---\ncreated: 2001-01-01\n---\n\n# old',
        'new.md': '---\ncreated: 2030-01-01\n---\n\n# new',
      },
      { 'old.md': 9999, 'new.md': 1 },
    )
    render(<FileExplorer />)

    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: 'created' } })
    expect(paths('file')).toEqual(['new.md', 'old.md'])
  })
})

/* ================================================================== *
 * Keyboard navigation
 * ================================================================== */

describe('FileExplorer — keyboard navigation', () => {
  function setup(): void {
    seed({ 'Notes/A.md': '# A', 'Notes/B.md': '# B', 'Root.md': '# R' })
    render(<FileExplorer />)
  }

  const focusedPath = (): string | null => document.activeElement?.getAttribute('data-path') ?? null

  it('moves down and up the visible rows', () => {
    setup()
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedPath()).toBe('Notes')
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedPath()).toBe('Root.md')
    // Nothing below the last row.
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedPath()).toBe('Root.md')
    fireEvent.keyDown(tree(), { key: 'ArrowUp' })
    expect(focusedPath()).toBe('Notes')
  })

  it('expands with ArrowRight, steps into the folder, and collapses with ArrowLeft', () => {
    setup()
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    expect(focusedPath()).toBe('Notes')

    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    expect(row('Notes').getAttribute('aria-expanded')).toBe('true')
    expect(queryRow('Notes/A.md')).not.toBeNull()

    // A second ArrowRight walks into the first child.
    fireEvent.keyDown(tree(), { key: 'ArrowRight' })
    expect(focusedPath()).toBe('Notes/A.md')

    // ArrowLeft on a file goes back to its parent folder…
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    expect(focusedPath()).toBe('Notes')
    // …and then collapses it.
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' })
    expect(row('Notes').getAttribute('aria-expanded')).toBe('false')
  })

  it('jumps to the first and last visible rows', () => {
    setup()
    fireEvent.keyDown(tree(), { key: 'End' })
    expect(focusedPath()).toBe('Root.md')
    fireEvent.keyDown(tree(), { key: 'Home' })
    expect(focusedPath()).toBe('Notes')
  })

  it('opens the focused note with Enter and toggles the focused folder', () => {
    const openPath = stubAction('openPath')
    setup()

    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    fireEvent.keyDown(tree(), { key: 'Enter' })
    expect(row('Notes').getAttribute('aria-expanded')).toBe('true')
    expect(openPath).not.toHaveBeenCalled()

    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    fireEvent.keyDown(tree(), { key: 'Enter' })
    expect(openPath.mock.calls).toEqual([['Notes/A.md', {}]])
  })

  it('keeps exactly one row in the tab order', () => {
    setup()
    const tabbable = [...document.querySelectorAll('[role="treeitem"]')].filter(
      (el) => el.getAttribute('tabindex') === '0',
    )
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.getAttribute('data-path')).toBe('Notes')
  })
})

/* ================================================================== *
 * Rename
 * ================================================================== */

describe('FileExplorer — rename', () => {
  function startRename(path: string): HTMLInputElement {
    fireEvent.keyDown(tree(), { key: 'ArrowDown' })
    // Focus the wanted row before pressing F2.
    while (document.activeElement?.getAttribute('data-path') !== path) {
      const before = document.activeElement?.getAttribute('data-path')
      fireEvent.keyDown(tree(), { key: 'ArrowDown' })
      if (document.activeElement?.getAttribute('data-path') === before) throw new Error(`cannot reach ${path}`)
    }
    fireEvent.keyDown(tree(), { key: 'F2' })
    return screen.getByLabelText('New name') as HTMLInputElement
  }

  it('turns the row into an input seeded with the current name', () => {
    seed({ 'Notes/A.md': '# A', 'Notes/B.md': '# B' })
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const input = startRename('Notes/A.md')
    expect(input.value).toBe('A')
  })

  it('rejects a duplicate name and refuses to commit', () => {
    seed({ 'Notes/A.md': '# A', 'Notes/B.md': '# B' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const input = startRename('Notes/A.md')
    fireEvent.change(input, { target: { value: 'B' } })
    expect(screen.getByRole('alert').textContent).toBe('A note with that name already exists')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameNote).not.toHaveBeenCalled()
    expect(screen.getByLabelText('New name')).toBeTruthy()
  })

  it('treats a duplicate case-insensitively but allows the unchanged name', () => {
    seed({ 'Notes/A.md': '# A', 'Notes/B.md': '# B' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const input = startRename('Notes/A.md')
    fireEvent.change(input, { target: { value: 'b' } })
    expect(screen.getByRole('alert').textContent).toBe('A note with that name already exists')

    // Its own name is never a duplicate — committing it is simply a no-op.
    fireEvent.change(input, { target: { value: 'A' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameNote).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('New name')).toBeNull()
  })

  it('rejects slashes and empty names', () => {
    seed({ 'A.md': '# A' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)

    const input = startRename('A.md')
    fireEvent.change(input, { target: { value: 'sub/B' } })
    expect(screen.getByRole('alert').textContent).toBe('Name cannot contain "/"')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameNote).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('alert').textContent).toBe('Name cannot be empty')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameNote).not.toHaveBeenCalled()
  })

  it('commits a valid name through renameNote, keeping the folder', () => {
    seed({ 'Notes/A.md': '# A' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const input = startRename('Notes/A.md')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameNote.mock.calls).toEqual([['Notes/A.md', 'Notes/Renamed.md']])
    expect(screen.queryByLabelText('New name')).toBeNull()
  })

  it('cancels on Escape', () => {
    seed({ 'A.md': '# A' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)

    const input = startRename('A.md')
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameNote).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('New name')).toBeNull()
    expect(row('A.md').textContent).toContain('A')
  })

  it('renames a folder by renaming every note beneath it', async () => {
    seed({ 'Notes/A.md': '# A', 'Notes/Sub/B.md': '# B', 'Other/C.md': '# C' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)

    const input = startRename('Notes')
    fireEvent.change(input, { target: { value: 'Archive' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(renameNote.mock.calls).toEqual([
      ['Notes/A.md', 'Archive/A.md'],
      ['Notes/Sub/B.md', 'Archive/Sub/B.md'],
    ])
  })

  it('rejects a folder name that collides with a sibling folder', () => {
    seed({ 'Notes/A.md': '# A', 'Archive/B.md': '# B' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)

    const input = startRename('Notes')
    fireEvent.change(input, { target: { value: 'Archive' } })
    expect(screen.getByRole('alert').textContent).toBe('A folder with that name already exists')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameNote).not.toHaveBeenCalled()
  })
})

/* ================================================================== *
 * Delete
 * ================================================================== */

describe('FileExplorer — delete', () => {
  function openMenuFor(path: string): void {
    fireEvent.contextMenu(row(path), { clientX: 20, clientY: 30 })
  }

  it('asks for confirmation before deleting a note', async () => {
    seed({ 'A.md': '# A' })
    const deleteNote = stubAction('deleteNote')
    render(<FileExplorer />)

    openMenuFor('A.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    const confirm = screen.getByRole('alertdialog', { name: 'Delete A?' })
    expect(deleteNote).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    })
    expect(deleteNote.mock.calls).toEqual([['A.md']])
  })

  it('cancels without deleting', () => {
    seed({ 'A.md': '# A' })
    const deleteNote = stubAction('deleteNote')
    render(<FileExplorer />)

    openMenuFor('A.md')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(deleteNote).not.toHaveBeenCalled()
  })

  it('deletes every note under a folder', async () => {
    seed({ 'Notes/A.md': '# A', 'Notes/Sub/B.md': '# B', 'Keep.md': '# K' })
    const deleteNote = stubAction('deleteNote')
    render(<FileExplorer />)

    openMenuFor('Notes')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    })

    expect(deleteNote.mock.calls).toEqual([['Notes/A.md'], ['Notes/Sub/B.md']])
  })
})

/* ================================================================== *
 * Drag and drop
 * ================================================================== */

describe('FileExplorer — drag and drop', () => {
  it('moves a note into the folder it is dropped on', async () => {
    seed({ 'A.md': '# A', 'Notes/B.md': '# B' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)

    const transfer = dataTransfer()
    fireEvent.dragStart(row('A.md'), { dataTransfer: transfer })
    fireEvent.dragOver(row('Notes'), { dataTransfer: transfer })
    expect(row('Notes').className).toContain('is-drop-target')

    await act(async () => {
      fireEvent.drop(row('Notes'), { dataTransfer: transfer })
    })
    expect(renameNote.mock.calls).toEqual([['A.md', 'Notes/A.md']])
    expect(row('Notes').className).not.toContain('is-drop-target')
  })

  it('does not offer a drop on the folder the note already lives in', () => {
    seed({ 'Notes/A.md': '# A' })
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const transfer = dataTransfer()
    fireEvent.dragStart(row('Notes/A.md'), { dataTransfer: transfer })
    fireEvent.dragOver(row('Notes'), { dataTransfer: transfer })
    expect(row('Notes').className).not.toContain('is-drop-target')
  })

  it('moves a note back to the vault root', async () => {
    seed({ 'Notes/A.md': '# A' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const container = document.querySelector('.nav-files-container') as HTMLElement
    const transfer = dataTransfer()
    fireEvent.dragStart(row('Notes/A.md'), { dataTransfer: transfer })
    fireEvent.dragOver(container, { dataTransfer: transfer })
    expect(container.className).toContain('is-drop-target')

    await act(async () => {
      fireEvent.drop(container, { dataTransfer: transfer })
    })
    expect(renameNote.mock.calls).toEqual([['Notes/A.md', 'A.md']])
  })

  it('refuses to drop a folder inside itself', async () => {
    seed({ 'Notes/Sub/A.md': '# A' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    const transfer = dataTransfer()
    fireEvent.dragStart(row('Notes'), { dataTransfer: transfer })
    fireEvent.dragOver(row('Notes/Sub'), { dataTransfer: transfer })
    expect(row('Notes/Sub').className).not.toContain('is-drop-target')

    await act(async () => {
      fireEvent.drop(row('Notes/Sub'), { dataTransfer: transfer })
    })
    expect(renameNote).not.toHaveBeenCalled()
  })

  it('moves a whole folder, note by note', async () => {
    seed({ 'Notes/A.md': '# A', 'Notes/Sub/B.md': '# B', 'Archive/C.md': '# C' })
    const renameNote = stubAction('renameNote')
    render(<FileExplorer />)

    const transfer = dataTransfer()
    fireEvent.dragStart(row('Notes'), { dataTransfer: transfer })
    fireEvent.dragOver(row('Archive'), { dataTransfer: transfer })
    await act(async () => {
      fireEvent.drop(row('Archive'), { dataTransfer: transfer })
    })

    expect(renameNote.mock.calls).toEqual([
      ['Notes/A.md', 'Archive/Notes/A.md'],
      ['Notes/Sub/B.md', 'Archive/Notes/Sub/B.md'],
    ])
  })

  it('refuses a drop that would collide with an existing note', async () => {
    seed({ 'A.md': '# A', 'Notes/A.md': '# other A' })
    const renameNote = stubAction('renameNote')
    const pushToast = stubAction('pushToast')
    render(<FileExplorer />)

    const transfer = dataTransfer()
    fireEvent.dragStart(row('A.md'), { dataTransfer: transfer })
    await act(async () => {
      fireEvent.drop(row('Notes'), { dataTransfer: transfer })
    })

    expect(renameNote).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('A note named A.md already exists there', 'error')
  })
})

/* ================================================================== *
 * Context menu — inside the explorer
 * ================================================================== */

describe('FileExplorer — context menu', () => {
  it('offers the file actions and fires the one that is chosen', () => {
    seed({ 'Notes/A.md': '# A' })
    const openPath = stubAction('openPath')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    fireEvent.contextMenu(row('Notes/A.md'), { clientX: 12, clientY: 24 })
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Open',
      'Open in new tab',
      'Open to the right',
      'Rename',
      'Delete',
      'Star',
      'Copy path',
      'Copy wiki link',
    ])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new tab' }))
    expect(openPath.mock.calls).toEqual([['Notes/A.md', { newTab: true }]])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('reflects the starred state and toggles it', () => {
    seed({ 'A.md': '# A' })
    useAppStore.setState({ starred: ['A.md'] })
    const toggleStar = stubAction('toggleStar')
    render(<FileExplorer />)

    fireEvent.contextMenu(row('A.md'), { clientX: 1, clientY: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from starred' }))
    expect(toggleStar.mock.calls).toEqual([['A.md']])
  })

  it('disables note-only actions for attachments', () => {
    seed({})
    useAppStore.setState({ attachments: [attachment('pic.png', 'png')] })
    render(<FileExplorer />)

    fireEvent.contextMenu(row('pic.png'), { clientX: 1, clientY: 1 })
    const disabled = screen
      .getAllByRole('menuitem')
      .filter((el) => (el as HTMLButtonElement).disabled)
      .map((el) => el.textContent)
    expect(disabled).toEqual(['Open', 'Open in new tab', 'Open to the right', 'Rename', 'Delete', 'Star', 'Copy wiki link'])
  })

  it('offers the folder actions and creates a note inside the folder', async () => {
    seed({ 'Notes/A.md': '# A' })
    const createNoteFromTitle = stubAction('createNoteFromTitle', (async () => 'Notes/Untitled.md') as AnyFn)
    render(<FileExplorer />)

    fireEvent.contextMenu(row('Notes'), { clientX: 5, clientY: 5 })
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'New note here',
      'New subfolder',
      'Rename',
      'Delete',
    ])

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New note here' }))
    })
    expect(createNoteFromTitle).toHaveBeenCalledWith('Untitled', 'Notes')
  })

  it('opens to the right by splitting when there is no second pane', () => {
    seed({ 'A.md': '# A' })
    const openPath = stubAction('openPath')
    const splitPane = stubAction('splitPane')
    render(<FileExplorer />)

    fireEvent.contextMenu(row('A.md'), { clientX: 1, clientY: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open to the right' }))

    expect(splitPane).toHaveBeenCalledTimes(1)
    expect(openPath.mock.calls).toEqual([['A.md']])
  })

  it('opens to the right in the existing neighbour pane', () => {
    seed({ 'A.md': '# A' })
    useAppStore.setState({
      panes: [
        { id: PANE_ID, tabs: [], activeTabId: null },
        { id: 'pane-b', tabs: [], activeTabId: null },
      ],
    })
    const openPath = stubAction('openPath')
    const splitPane = stubAction('splitPane')
    render(<FileExplorer />)

    fireEvent.contextMenu(row('A.md'), { clientX: 1, clientY: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open to the right' }))

    expect(splitPane).not.toHaveBeenCalled()
    expect(openPath.mock.calls).toEqual([['A.md', { paneId: 'pane-b', newTab: true }]])
  })

  it('copies the path and the wiki link through the clipboard', async () => {
    seed({ 'Notes/A.md': '# A' })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const pushToast = stubAction('pushToast')
    render(<FileExplorer />)
    fireEvent.click(row('Notes'))

    fireEvent.contextMenu(row('Notes/A.md'), { clientX: 1, clientY: 1 })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
    })
    expect(writeText).toHaveBeenCalledWith('Notes/A.md')

    fireEvent.contextMenu(row('Notes/A.md'), { clientX: 1, clientY: 1 })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy wiki link' }))
    })
    expect(writeText).toHaveBeenCalledWith('[[A]]')
    expect(pushToast.mock.calls).toEqual([
      ['Copied path', 'success'],
      ['Copied wiki link', 'success'],
    ])
  })

  it('creates an empty folder from the header button', () => {
    seed({ 'A.md': '# A' })
    render(<FileExplorer />)

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const input = screen.getByLabelText('New folder name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(queryRow('Fresh')).not.toBeNull()
    expect(paths('folder')).toEqual(['Fresh'])
  })

  it('rejects a new folder that already exists', () => {
    seed({ 'Notes/A.md': '# A' })
    render(<FileExplorer />)

    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const input = screen.getByLabelText('New folder name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Notes' } })
    expect(screen.getByRole('alert').textContent).toBe('A folder with that name already exists')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByLabelText('New folder name')).toBeTruthy()
  })
})

/* ================================================================== *
 * ContextMenu / useContextMenu in isolation
 * ================================================================== */

describe('ContextMenu', () => {
  function Harness({ items }: { items: ContextMenuItem[] }): JSX.Element {
    const { menu, open, close } = useContextMenu()
    return (
      <div>
        <button type="button" data-testid="target" onContextMenu={(event) => open(event, items)}>
          target
        </button>
        <div data-testid="outside">outside</div>
        <ContextMenu menu={menu} onClose={close} />
      </div>
    )
  }

  const onFirst = vi.fn()
  const onLast = vi.fn()
  const onDisabled = vi.fn()

  function items(): ContextMenuItem[] {
    return [
      { id: 'first', label: 'First', icon: 'file', onSelect: onFirst },
      { id: 'nope', label: 'Disabled', disabled: true, onSelect: onDisabled },
      { id: 'sep', label: '', separator: true },
      { id: 'last', label: 'Last', danger: true, onSelect: onLast },
    ]
  }

  function openAt(x = 10, y = 20): void {
    fireEvent.contextMenu(screen.getByTestId('target'), { clientX: x, clientY: y })
  }

  beforeEach(() => {
    onFirst.mockClear()
    onLast.mockClear()
    onDisabled.mockClear()
  })

  it('opens at the pointer with the given items', () => {
    render(<Harness items={items()} />)
    openAt(40, 60)

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['First', 'Disabled', 'Last'])
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    expect(screen.getByRole('menuitem', { name: 'Last' }).className).toContain('is-danger')
  })

  it('flips back inside the viewport near the edges', () => {
    render(<Harness items={items()} />)
    openAt(window.innerWidth - 4, window.innerHeight - 4)

    const menu = screen.getByRole('menu')
    expect(Number.parseInt(menu.style.left, 10)).toBeLessThan(window.innerWidth - 4)
    expect(Number.parseInt(menu.style.top, 10)).toBeLessThan(window.innerHeight - 4)
    expect(Number.parseInt(menu.style.left, 10)).toBeGreaterThanOrEqual(0)
    expect(Number.parseInt(menu.style.top, 10)).toBeGreaterThanOrEqual(0)
  })

  it('runs the item that is clicked and closes', () => {
    render(<Harness items={items()} />)
    openAt()

    fireEvent.click(screen.getByRole('menuitem', { name: 'First' }))
    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('never fires a disabled item', () => {
    render(<Harness items={items()} />)
    openAt()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Disabled' }))
    expect(onDisabled).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('walks the items with the arrow keys, skipping separators and disabled rows', () => {
    render(<Harness items={items()} />)
    openAt()
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(menu.getAttribute('aria-activedescendant')).toMatch(/first$/)

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(menu.getAttribute('aria-activedescendant')).toMatch(/last$/)
    expect(screen.getByRole('menuitem', { name: 'Last' }).className).toContain('is-selected')

    // Wraps back around to the first selectable row.
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(menu.getAttribute('aria-activedescendant')).toMatch(/first$/)

    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(menu.getAttribute('aria-activedescendant')).toMatch(/last$/)

    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onLast).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('selects the last row with End and the first with Home', () => {
    render(<Harness items={items()} />)
    openAt()
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(document, { key: 'End' })
    expect(menu.getAttribute('aria-activedescendant')).toMatch(/last$/)
    fireEvent.keyDown(document, { key: 'Home' })
    expect(menu.getAttribute('aria-activedescendant')).toMatch(/first$/)
  })

  it('closes on Escape, an outside click and a scroll', () => {
    render(<Harness items={items()} />)

    openAt()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    openAt()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('menu')).toBeNull()

    openAt()
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('stays open when the click lands inside the menu', () => {
    render(<Harness items={items()} />)
    openAt()

    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('reopens at the new pointer position on a second right-click', () => {
    render(<Harness items={items()} />)
    openAt(10, 10)
    openAt(120, 140)

    const menus = screen.getAllByRole('menu')
    expect(menus).toHaveLength(1)
    expect(menus[0]?.style.left).toBe('120px')
  })

  it('ignores an empty item list', () => {
    render(<Harness items={[]} />)
    openAt()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
