import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { TagTreeNode } from '../core/graph/index'
import type { AppState } from '../state/store'
import type { Note, NotePath } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { DEFAULT_SETTINGS, makeNote, useAppStore } from '../state/store'
import { TagPanel, countTagNodes, filterTagTree, flattenTagTree, tagQuery } from './TagPanel'
import { StarredPanel, moveStarred, orderStarred } from './StarredPanel'

/** The store as it was at import time — actions included, so spies are undone. */
const PRISTINE = useAppStore.getState()

const VAULT: Record<NotePath, string> = {
  'Alpha.md': '# Alpha\n\nWork on #project/alpha with the #method.\n',
  'Beta.md': '# Beta\n\nStarted #project/beta today.\n',
  'Plan.md': '# Plan\n\nOverview of the whole #project.\n',
}

function seed(files: Record<NotePath, string> = VAULT, patch: Partial<AppState> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

/** `[name, count, aria-level]` for every rendered tag row, in visual order. */
function tagRows(container: HTMLElement): [string, string, string][] {
  return [...container.querySelectorAll('.tag-tree-item')].map((row) => [
    row.querySelector('.tag-tree-name')?.textContent ?? '',
    row.querySelector('.tag-count')?.textContent ?? '',
    row.getAttribute('aria-level') ?? '',
  ])
}

/** A tag tree node, for the pure-function tests. */
function node(fullTag: string, totalCount: number, children: TagTreeNode[] = []): TagTreeNode {
  const name = fullTag.slice(fullTag.lastIndexOf('/') + 1)
  return { name, fullTag, count: totalCount, totalCount, children }
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
      settings: { ...DEFAULT_SETTINGS },
      searchQuery: '',
      sidebarPanel: 'tags',
      hoveredPath: null,
      toasts: [],
      recent: [],
      starred: [],
      panes: [{ id: 'pane-a', tabs: [], activeTabId: null }],
      activePaneId: 'pane-a',
    },
    true,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('filterTagTree', () => {
  const tree = [
    node('project', 3, [node('project/alpha', 1), node('project/beta', 1)]),
    node('method', 1),
  ]

  it('keeps the whole subtree of a node that matches', () => {
    const filtered = filterTagTree(tree, 'project')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.children.map((child) => child.fullTag)).toEqual(['project/alpha', 'project/beta'])
  })

  it('keeps the ancestors needed to reach a matching descendant', () => {
    const filtered = filterTagTree(tree, 'alpha')
    expect(filtered.map((entry) => entry.fullTag)).toEqual(['project'])
    expect(filtered[0]!.children.map((child) => child.fullTag)).toEqual(['project/alpha'])
  })

  it('matches on the full tag, case-insensitively, and returns nothing when it cannot', () => {
    expect(filterTagTree(tree, 'PROJECT/BETA')[0]!.children[0]!.fullTag).toBe('project/beta')
    expect(filterTagTree(tree, 'nope')).toEqual([])
  })

  it('returns every root for an empty filter without mutating the input', () => {
    const filtered = filterTagTree(tree, '   ')
    expect(filtered).toHaveLength(2)
    expect(filtered).not.toBe(tree)
  })
})

describe('countTagNodes / flattenTagTree', () => {
  const tree = [
    node('project', 3, [node('project/alpha', 1), node('project/beta', 1)]),
    node('method', 1),
  ]

  it('counts intermediate nodes as tags of their own', () => {
    expect(countTagNodes(tree)).toBe(4)
  })

  it('walks depth first and stops at collapsed nodes', () => {
    expect(flattenTagTree(tree, new Set()).map((row) => [row.node.fullTag, row.depth])).toEqual([
      ['project', 0],
      ['project/alpha', 1],
      ['project/beta', 1],
      ['method', 0],
    ])
    expect(flattenTagTree(tree, new Set(['project'])).map((row) => row.node.fullTag)).toEqual(['project', 'method'])
  })
})

describe('tagQuery', () => {
  it('writes the operator the search panel parses', () => {
    expect(tagQuery('project/alpha')).toBe('tag:project/alpha')
  })
})

/* ------------------------------------------------------------------ *
 * TagPanel
 * ------------------------------------------------------------------ */

describe('TagPanel', () => {
  it('nests tags, counts the notes under each and sorts by count', () => {
    seed()
    const { container } = render(<TagPanel />)

    // `project` covers all three notes; `method` only Alpha. Equal counts fall
    // back to name order, which puts alpha before beta.
    expect(tagRows(container)).toEqual([
      ['project', '3', '1'],
      ['alpha', '1', '2'],
      ['beta', '1', '2'],
      ['method', '1', '1'],
    ])
  })

  it('shows the total number of tags in the header', () => {
    seed()
    const { container } = render(<TagPanel />)
    expect(container.querySelector('.sidebar-header .tag-count')?.textContent).toBe('4')
  })

  it('searches for a tag and brings the search panel forward when one is clicked', () => {
    seed()
    const { container } = render(<TagPanel />)

    fireEvent.click([...container.querySelectorAll('.tag-tree-item')][1]!)

    expect(useAppStore.getState().searchQuery).toBe('tag:project/alpha')
    expect(useAppStore.getState().sidebarPanel).toBe('search')
  })

  it('marks the tag the current query belongs to', () => {
    seed(VAULT, { searchQuery: 'tag:project/beta' })
    const { container } = render(<TagPanel />)

    const active = [...container.querySelectorAll('.tag-tree-item.is-active')]
    expect(active).toHaveLength(1)
    expect(active[0]!.querySelector('.tag-tree-name')?.textContent).toBe('beta')
  })

  it('does not toggle the sidebar shut when search is already the open panel', () => {
    seed(VAULT, { sidebarPanel: 'search' })
    const { container } = render(<TagPanel />)

    fireEvent.click([...container.querySelectorAll('.tag-tree-item')][0]!)
    expect(useAppStore.getState().sidebarPanel).toBe('search')
  })

  it('collapses and expands a branch', () => {
    seed()
    const { container } = render(<TagPanel />)

    fireEvent.click(screen.getByLabelText('Collapse project'))
    expect(tagRows(container).map((row) => row[0])).toEqual(['project', 'method'])
    expect(useAppStore.getState().searchQuery).toBe('')

    fireEvent.click(screen.getByLabelText('Expand project'))
    expect(tagRows(container).map((row) => row[0])).toEqual(['project', 'alpha', 'beta', 'method'])
  })

  it('expands and collapses a branch from the keyboard', () => {
    seed()
    const { container } = render(<TagPanel />)
    const root = [...container.querySelectorAll('.tag-tree-item')][0]!

    fireEvent.keyDown(root, { key: 'ArrowLeft' })
    expect(tagRows(container).map((row) => row[0])).toEqual(['project', 'method'])

    fireEvent.keyDown(root, { key: 'ArrowRight' })
    expect(tagRows(container).map((row) => row[0])).toEqual(['project', 'alpha', 'beta', 'method'])
  })

  it('narrows the tree with the filter, ignoring the collapse state', () => {
    seed()
    const { container } = render(<TagPanel />)

    fireEvent.click(screen.getByLabelText('Collapse project'))
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'alpha' } })

    expect(tagRows(container).map((row) => row[0])).toEqual(['project', 'alpha'])
    expect(container.querySelector('.sidebar-header .tag-count')?.textContent).toBe('2/4')
  })

  it('says so when the filter matches nothing', () => {
    seed()
    render(<TagPanel />)
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'zzz' } })
    expect(screen.getByText('No tags match “zzz”.')).toBeTruthy()
  })

  it('explains how to make a tag when the vault has none', () => {
    seed({ 'Plain.md': '# Plain\n\nNo tags here.\n' })
    const { container } = render(<TagPanel />)

    expect(screen.getByText('No tags yet.')).toBeTruthy()
    expect(container.querySelectorAll('.tag-tree-item')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * StarredPanel
 *
 * The task assigned no StarredPanel.test.tsx, and its ordering logic is subtle
 * enough that shipping it untested would be worse than putting the cases here.
 * ------------------------------------------------------------------ */

describe('orderStarred / moveStarred', () => {
  it('applies the remembered order and parks unknown paths at the end', () => {
    expect(orderStarred(['a.md', 'b.md', 'c.md'], ['c.md', 'a.md'])).toEqual(['c.md', 'a.md', 'b.md'])
  })

  it('ignores ranks for notes that are no longer starred', () => {
    expect(orderStarred(['a.md', 'b.md'], ['gone.md', 'b.md', 'a.md'])).toEqual(['b.md', 'a.md'])
  })

  it('keeps the store order when nothing has ever been dragged', () => {
    expect(orderStarred(['a.md', 'b.md', 'c.md'], [])).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('moves an entry to the index it was dropped on, in both directions', () => {
    expect(moveStarred(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveStarred(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveStarred(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c'])
  })
})

describe('StarredPanel', () => {
  const STARRED_VAULT: Record<NotePath, string> = {
    'a.md': '# Apples\n',
    'b.md': '# Bananas\n',
    'c.md': '# Cherries\n',
  }

  function starredTitles(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.starred-item .nav-item-title')].map((node) => node.textContent ?? '')
  }

  it('explains how to star a note when nothing is starred', () => {
    seed(STARRED_VAULT)
    render(<StarredPanel />)
    expect(screen.getByText('Nothing starred yet.')).toBeTruthy()
  })

  it('lists starred notes by title and unstars one inline', () => {
    const toggleStar = vi.fn()
    seed(STARRED_VAULT, { starred: ['a.md', 'c.md'], toggleStar })
    const { container } = render(<StarredPanel />)

    expect(starredTitles(container)).toEqual(['Apples', 'Cherries'])

    fireEvent.click(screen.getByLabelText('Unstar Apples'))
    expect(toggleStar).toHaveBeenCalledWith('a.md')
  })

  it('opens a starred note when its row is clicked', () => {
    const openPath = vi.fn()
    seed(STARRED_VAULT, { starred: ['b.md'], openPath })
    const { container } = render(<StarredPanel />)

    fireEvent.click(container.querySelector('.starred-item')!)
    expect(openPath).toHaveBeenCalledWith('b.md')
  })

  it('reorders by drag and remembers the new order', () => {
    seed(STARRED_VAULT, { starred: ['a.md', 'b.md', 'c.md'] })
    const { container } = render(<StarredPanel />)

    const rows = () => [...container.querySelectorAll('.starred-item')] as HTMLElement[]
    fireEvent.dragStart(rows()[2]!)
    fireEvent.dragOver(rows()[0]!)
    fireEvent.drop(rows()[0]!)

    expect(starredTitles(container)).toEqual(['Cherries', 'Apples', 'Bananas'])
    expect(JSON.parse(localStorage.getItem('spacefore.starredOrder') ?? '[]')).toEqual(['c.md', 'a.md', 'b.md'])
  })

  it('restores a remembered order on mount, newly starred notes last', () => {
    localStorage.setItem('spacefore.starredOrder', JSON.stringify(['c.md', 'a.md']))
    seed(STARRED_VAULT, { starred: ['a.md', 'b.md', 'c.md'] })
    const { container } = render(<StarredPanel />)

    expect(starredTitles(container)).toEqual(['Cherries', 'Apples', 'Bananas'])
  })

  it('shows at most fifteen recent files underneath', () => {
    const files: Record<NotePath, string> = {}
    const recent: NotePath[] = []
    for (let i = 0; i < 20; i += 1) {
      files[`n${i}.md`] = `# Note ${i}\n`
      recent.push(`n${i}.md`)
    }
    seed(files, { recent })
    const { container } = render(<StarredPanel />)

    const rows = [...container.querySelectorAll('.recent-item .nav-item-title')]
    expect(rows).toHaveLength(15)
    expect(rows[0]!.textContent).toBe('Note 0')
    expect(rows[14]!.textContent).toBe('Note 14')
  })

  it('stars a note straight from the recent list', () => {
    const toggleStar = vi.fn()
    seed(STARRED_VAULT, { recent: ['b.md'], toggleStar })
    render(<StarredPanel />)

    fireEvent.click(screen.getByLabelText('Star Bananas'))
    expect(toggleStar).toHaveBeenCalledWith('b.md')
  })
})
