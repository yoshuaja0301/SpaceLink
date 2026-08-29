import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AppState } from '../state/store'
import type { Note, NotePath, SearchHit } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { DEFAULT_SETTINGS, makeNote, useAppStore } from '../state/store'
import {
  DEBOUNCE_MS,
  SearchPanel,
  appendOperator,
  buildRows,
  loadRecentSearches,
  noteNameFromQuery,
} from './SearchPanel'

/** The store as it was at import time — actions included, so spies are undone. */
const PRISTINE = useAppStore.getState()

const VAULT: Record<NotePath, string> = {
  'Zettelkasten.md': [
    '# Zettelkasten',
    '',
    'A zettel is an atomic note.',
    'Linking zettel notes together is the whole method.',
    '',
    '#method #project/alpha',
    '',
  ].join('\n'),
  'Daily/2024-01-02.md': ['# Tuesday', '', 'Read about the zettel method today.', ''].join('\n'),
  'Recipes/Bread.md': ['# Bread', '', 'Flour, water, salt.', ''].join('\n'),
}

function seed(files: Record<NotePath, string> = VAULT, patch: Partial<AppState> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

function input(): HTMLInputElement {
  return screen.getByLabelText('Search notes') as HTMLInputElement
}

/** Every note-title row currently rendered, in visual order. */
function titleRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('.search-result-title')] as HTMLElement[]
}

function matchRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('.search-match')] as HTMLElement[]
}

function selectedRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[aria-current="true"]')
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
      sidebarPanel: 'search',
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
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('appendOperator', () => {
  it('adds a separating space only when one is missing', () => {
    expect(appendOperator('', 'tag:')).toBe('tag:')
    expect(appendOperator('zettel', 'tag:')).toBe('zettel tag:')
    expect(appendOperator('zettel ', 'tag:')).toBe('zettel tag:')
  })

  it('appends the operator verbatim, quotes and dashes included', () => {
    expect(appendOperator('note', '-')).toBe('note -')
    expect(appendOperator('note', '"')).toBe('note "')
  })
})

describe('noteNameFromQuery', () => {
  it('strips every operator the parser understands, keeping the user’s capitals', () => {
    expect(noteNameFromQuery('tag:project Zettel Notes -draft')).toBe('Zettel Notes')
    expect(noteNameFromQuery('path:daily/ file:index Weekly Review')).toBe('Weekly Review')
    expect(noteNameFromQuery('#method "Exact Phrase"')).toBe('Exact Phrase')
    expect(noteNameFromQuery('/^#{1,2}\\s/i Headings')).toBe('Headings')
  })

  it('falls back to the raw query when nothing but operators was typed', () => {
    expect(noteNameFromQuery('tag:project')).toBe('tag:project')
    expect(noteNameFromQuery('  ')).toBe('')
  })
})

describe('buildRows', () => {
  const hit = (path: NotePath, lines: number[]): SearchHit => ({
    path,
    title: path,
    score: 1,
    total: lines.length,
    matches: lines.map((line) => ({ line, text: `line ${line}`, ranges: [[0, 4]] as [number, number][] })),
  })

  it('emits one row per note followed by its match rows', () => {
    const rows = buildRows([hit('a.md', [1, 2]), hit('b.md', [7])], new Set())
    expect(rows.map((row) => row.kind)).toEqual(['note', 'match', 'match', 'note', 'match'])
    expect(rows[1]!.match?.line).toBe(1)
    expect(rows.map((row) => row.key)).toEqual(['a.md', 'a.md:1', 'a.md:2', 'b.md', 'b.md:7'])
  })

  it('drops the match rows of a collapsed note', () => {
    const rows = buildRows([hit('a.md', [1, 2]), hit('b.md', [7])], new Set(['a.md']))
    expect(rows.map((row) => row.key)).toEqual(['a.md', 'b.md', 'b.md:7'])
  })

  it('never shows more than five line matches for one note', () => {
    const rows = buildRows([hit('a.md', [1, 2, 3, 4, 5, 6, 7])], new Set())
    expect(rows.filter((row) => row.kind === 'match')).toHaveLength(5)
  })
})

describe('loadRecentSearches', () => {
  it('survives junk in localStorage', () => {
    localStorage.setItem('spacefore.recentSearches', 'not json')
    expect(loadRecentSearches()).toEqual([])
    localStorage.setItem('spacefore.recentSearches', '{"a":1}')
    expect(loadRecentSearches()).toEqual([])
    localStorage.setItem('spacefore.recentSearches', '["a", 3, "", "b"]')
    expect(loadRecentSearches()).toEqual(['a', 'b'])
  })
})

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

describe('SearchPanel results', () => {
  it('renders a group per matching note with its path, match count and highlights', () => {
    seed(VAULT, { searchQuery: 'zettel' })
    const { container } = render(<SearchPanel />)

    const titles = titleRows(container)
    expect(titles).toHaveLength(2)
    expect(titles.map((row) => row.querySelector('.search-result-name')?.textContent)).toEqual([
      'Zettelkasten',
      'Tuesday',
    ])
    expect(titles[0]!.querySelector('.search-result-path')?.textContent).toBe('Zettelkasten.md')
    // Three occurrences of "zettel" in the note body plus the title/path hits.
    expect(Number(titles[0]!.querySelector('.nav-file-count')?.textContent)).toBeGreaterThanOrEqual(2)

    const marks = container.querySelectorAll('.search-match mark')
    expect(marks.length).toBeGreaterThan(0)
    expect([...marks].every((mark) => mark.textContent?.toLowerCase() === 'zettel')).toBe(true)
  })

  it('escapes the surrounding line rather than injecting it as markup', () => {
    seed({ 'Html.md': '# Html\n\nA <script>alert(1)</script> zettel line.\n' }, { searchQuery: 'zettel' })
    const { container } = render(<SearchPanel />)

    const match = matchRows(container)[0]!
    expect(match.querySelector('script')).toBeNull()
    expect(match.textContent).toContain('<script>alert(1)</script>')
  })

  it('reports the result count and how long the search took', () => {
    seed(VAULT, { searchQuery: 'zettel' })
    const { container } = render(<SearchPanel />)

    const summary = container.querySelector('.search-summary')!
    expect(summary.textContent).toMatch(/^2 notes · \d+ matches · \d+\.\d ms$/)
  })

  it('collapses and expands a note group', () => {
    seed(VAULT, { searchQuery: 'zettel' })
    const { container } = render(<SearchPanel />)
    const before = matchRows(container).length
    expect(before).toBeGreaterThan(0)

    fireEvent.click(screen.getByLabelText('Collapse matches in Zettelkasten'))
    expect(matchRows(container).length).toBeLessThan(before)

    fireEvent.click(screen.getByLabelText('Expand matches in Zettelkasten'))
    expect(matchRows(container).length).toBe(before)
  })

  it('debounces typing by 120ms before touching the vault', () => {
    vi.useFakeTimers()
    seed(VAULT)
    const { container } = render(<SearchPanel />)

    fireEvent.change(input(), { target: { value: 'zettel' } })
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    })
    expect(titleRows(container)).toHaveLength(0)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(titleRows(container)).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ *
 * Opening
 * ------------------------------------------------------------------ */

describe('SearchPanel opening', () => {
  it('opens the note when a result title is clicked', () => {
    const openPath = vi.fn()
    seed(VAULT, { searchQuery: 'zettel', openPath })
    const { container } = render(<SearchPanel />)

    fireEvent.click(titleRows(container)[0]!)
    expect(openPath).toHaveBeenCalledWith('Zettelkasten.md', { newTab: false })
  })

  it('opens in a new tab on Cmd/Ctrl+click', () => {
    const openPath = vi.fn()
    seed(VAULT, { searchQuery: 'zettel', openPath })
    const { container } = render(<SearchPanel />)

    fireEvent.click(titleRows(container)[0]!, { ctrlKey: true })
    expect(openPath).toHaveBeenCalledWith('Zettelkasten.md', { newTab: true })

    fireEvent.click(titleRows(container)[0]!, { metaKey: true })
    expect(openPath).toHaveBeenLastCalledWith('Zettelkasten.md', { newTab: true })
  })

  it('asks the editor to reveal the line a match sits on', () => {
    const openPath = vi.fn()
    seed(VAULT, { searchQuery: 'zettel', openPath })
    const { container } = render(<SearchPanel />)

    const seen: { path: string; line: number }[] = []
    const listen = (event: Event): void => {
      seen.push((event as CustomEvent<{ path: string; line: number }>).detail)
    }
    window.addEventListener('spacefore:reveal-line', listen)
    try {
      // Line 1 is the `# Zettelkasten` heading; line 3 is the first body hit.
      fireEvent.click(matchRows(container)[0]!)
      fireEvent.click(matchRows(container)[1]!)
    } finally {
      window.removeEventListener('spacefore:reveal-line', listen)
    }

    expect(openPath).toHaveBeenCalledWith('Zettelkasten.md', { newTab: false })
    expect(seen[0]).toEqual({ path: 'Zettelkasten.md', line: 1 })
    expect(seen.some((detail) => detail.line === 3)).toBe(true)
  })

  it('does not reveal a line when the note row itself is clicked', () => {
    seed(VAULT, { searchQuery: 'zettel', openPath: vi.fn() })
    const { container } = render(<SearchPanel />)

    const listen = vi.fn()
    window.addEventListener('spacefore:reveal-line', listen)
    try {
      fireEvent.click(titleRows(container)[0]!)
    } finally {
      window.removeEventListener('spacefore:reveal-line', listen)
    }
    expect(listen).not.toHaveBeenCalled()
  })

  it('remembers the query once a result has been opened', () => {
    seed(VAULT, { searchQuery: 'zettel', openPath: vi.fn() })
    const { container } = render(<SearchPanel />)

    fireEvent.click(titleRows(container)[0]!)
    expect(loadRecentSearches()).toEqual(['zettel'])
  })
})

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

describe('SearchPanel keyboard', () => {
  it('walks the rows with the arrow keys and opens the selection with Enter', () => {
    const openPath = vi.fn()
    seed(VAULT, { searchQuery: 'zettel', openPath })
    const { container } = render(<SearchPanel />)

    // The first note row starts selected.
    expect(selectedRow(container)?.classList.contains('search-result-title')).toBe(true)

    // Two rows down is the note's second match — line 3, past the heading.
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selectedRow(container)?.classList.contains('search-match')).toBe(true)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })

    const seen: { path: string; line: number }[] = []
    const listen = (event: Event): void => {
      seen.push((event as CustomEvent<{ path: string; line: number }>).detail)
    }
    window.addEventListener('spacefore:reveal-line', listen)
    try {
      fireEvent.keyDown(input(), { key: 'Enter' })
    } finally {
      window.removeEventListener('spacefore:reveal-line', listen)
    }

    expect(openPath).toHaveBeenCalledWith('Zettelkasten.md', { newTab: false })
    expect(seen[0]?.line).toBe(3)
  })

  it('clamps the selection at both ends of the list', () => {
    seed(VAULT, { searchQuery: 'zettel' })
    const { container } = render(<SearchPanel />)
    const rows = [...container.querySelectorAll('.search-result-title, .search-match')]

    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(selectedRow(container)).toBe(rows[0])

    for (let i = 0; i < rows.length + 3; i += 1) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selectedRow(container)).toBe(rows[rows.length - 1])
  })

  it('clears the query on Escape', () => {
    seed(VAULT, { searchQuery: 'zettel' })
    render(<SearchPanel />)

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(useAppStore.getState().searchQuery).toBe('')
  })

  it('leaves Enter on a focused button to the button itself', () => {
    const openPath = vi.fn()
    seed(VAULT, { searchQuery: 'zettel', openPath })
    const { container } = render(<SearchPanel />)

    // Enter fired at a result button must not also open the panel selection.
    fireEvent.keyDown(matchRows(container)[0]!, { key: 'Enter' })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('focuses the input when search becomes the visible sidebar panel', () => {
    seed(VAULT, { sidebarPanel: 'files' })
    render(<SearchPanel />)
    expect(document.activeElement).not.toBe(input())

    act(() => {
      useAppStore.setState({ sidebarPanel: 'search' })
    })
    expect(document.activeElement).toBe(input())
  })
})

/* ------------------------------------------------------------------ *
 * Empty and no-result states
 * ------------------------------------------------------------------ */

describe('SearchPanel empty states', () => {
  it('shows the hint and the recent searches while the query is empty', () => {
    localStorage.setItem('spacefore.recentSearches', JSON.stringify(['zettel', 'tag:method']))
    seed(VAULT)
    const { container } = render(<SearchPanel />)

    expect(container.querySelector('.search-idle')).not.toBeNull()
    expect(container.querySelector('.search-summary')).toBeNull()
    expect(screen.getByText('Recent searches')).toBeTruthy()

    fireEvent.click(screen.getByText('tag:method'))
    expect(useAppStore.getState().searchQuery).toBe('tag:method')
  })

  it('clears the recent search list on demand', () => {
    localStorage.setItem('spacefore.recentSearches', JSON.stringify(['zettel']))
    seed(VAULT)
    const { container } = render(<SearchPanel />)

    fireEvent.click(screen.getByText('Clear'))
    expect(container.querySelector('.search-recent')).toBeNull()
    expect(loadRecentSearches()).toEqual([])
  })

  it('offers to create a note when nothing matches', () => {
    const createNoteFromTitle = vi.fn(async () => 'Quantum Foam.md')
    seed(VAULT, { searchQuery: 'tag:physics Quantum Foam', createNoteFromTitle })
    const { container } = render(<SearchPanel />)

    expect(container.querySelector('.search-no-results')).not.toBeNull()
    expect(container.querySelector('.search-summary')?.textContent).toMatch(/^0 notes/)

    fireEvent.click(screen.getByText('Create note named “Quantum Foam”'))
    expect(createNoteFromTitle).toHaveBeenCalledWith('Quantum Foam')
  })
})

/* ------------------------------------------------------------------ *
 * Chips, syntax help and variants
 * ------------------------------------------------------------------ */

describe('SearchPanel chrome', () => {
  it('appends the operator a quick-filter chip stands for', () => {
    seed(VAULT, { searchQuery: 'zettel' })
    render(<SearchPanel />)

    fireEvent.click(screen.getByTitle('Only notes carrying a tag'))
    expect(useAppStore.getState().searchQuery).toBe('zettel tag:')

    fireEvent.click(screen.getByTitle('Exclude notes containing a term'))
    expect(useAppStore.getState().searchQuery).toBe('zettel tag: -')
  })

  it('documents every operator the parser understands', () => {
    seed(VAULT)
    const { container } = render(<SearchPanel />)

    const examples = [...container.querySelectorAll('.search-help-entry code')].map((node) => node.textContent)
    expect(examples).toContain('tag:project')
    expect(examples).toContain('path:daily/')
    expect(examples).toContain('file:index')
    expect(examples).toContain('"exact phrase"')
    expect(examples).toContain('-draft')
    expect(examples).toContain('#project')
    expect(examples).toContain('tag:"my tag"')
  })

  it('marks the wide tab layout and drops the sidebar header', () => {
    seed(VAULT, { sidebarPanel: null })
    const { container } = render(<SearchPanel variant="tab" />)

    expect(container.querySelector('.search-panel')?.classList.contains('is-tab')).toBe(true)
    expect(container.querySelector('.sidebar-header')).toBeNull()
    // A full tab owns its pane, so it takes the caret without being asked.
    expect(document.activeElement).toBe(input())
  })
})
