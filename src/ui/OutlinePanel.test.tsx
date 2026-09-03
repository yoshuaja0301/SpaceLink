import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AppState } from '../state/store'
import type { HeadingRef, Note, NotePath, Pane } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { DEFAULT_SETTINGS, makeNote, useAppStore } from '../state/store'
import { NoteInfo, createdFrom, formatRelativeTime, readingTime } from './NoteInfo'
import { OutlinePanel, filterHeadings } from './OutlinePanel'
import { RightSidebar, loadRightSidebarTab } from './RightSidebar'

/** The store as it was at import time — actions included, so spies are undone. */
const PRISTINE = useAppStore.getState()

const VAULT: Record<NotePath, string> = {
  'Guide.md': [
    '# Guide',
    '',
    'Intro text.',
    '',
    '## Setup',
    '',
    '### Details',
    '',
    '## Usage',
    '',
    '```md',
    '## Not a heading',
    '```',
    '',
  ].join('\n'),
  'Flat.md': ['Just prose, no headings at all.', ''].join('\n'),
}

function seed(files: Record<NotePath, string> = VAULT, patch: Partial<AppState> = {}, mtime = 1): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, mtime))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

function headingsOf(path: NotePath): HeadingRef[] {
  return useAppStore.getState().notes.get(path)!.parsed.headings
}

/** `[text, data-level]` for every rendered row, in visual order. */
function rows(container: HTMLElement): [string, string][] {
  return [...container.querySelectorAll('.outline-item')].map((item) => [
    item.textContent ?? '',
    item.getAttribute('data-level') ?? '',
  ])
}

function paneWith(id: string, tabId: string, path: NotePath | null): Pane {
  return {
    id,
    tabs: [{ id: tabId, kind: 'note', path, mode: 'preview', pinned: false }],
    activeTabId: tabId,
  }
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
      sidebarPanel: 'files',
      hoveredPath: null,
      toasts: [],
      recent: [],
      starred: [],
      panes: [paneWith('pane-a', 'tab-a', 'Guide.md')],
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
 * Filtering
 * ------------------------------------------------------------------ */

describe('filterHeadings', () => {
  const headings: HeadingRef[] = [
    { level: 1, text: 'Guide', slug: 'guide', start: 0, line: 1 },
    { level: 2, text: 'Setup', slug: 'setup', start: 10, line: 5 },
  ]

  it('returns a copy when the filter is blank', () => {
    const all = filterHeadings(headings, '   ')
    expect(all).toEqual(headings)
    expect(all).not.toBe(headings)
  })

  it('matches case-insensitively on the heading text', () => {
    expect(filterHeadings(headings, 'SET').map((heading) => heading.text)).toEqual(['Setup'])
    expect(filterHeadings(headings, 'zzz')).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Tree
 * ------------------------------------------------------------------ */

describe('OutlinePanel', () => {
  it('renders the heading tree in order, indented by level', () => {
    seed()
    const { container } = render(<OutlinePanel path="Guide.md" />)

    expect(rows(container)).toEqual([
      ['Guide', '1'],
      ['Setup', '2'],
      ['Details', '3'],
      ['Usage', '2'],
    ])
  })

  it('counts the headings, and does not mistake fenced text for one', () => {
    seed()
    const { container } = render(<OutlinePanel path="Guide.md" />)
    expect(container.querySelector('.panel-header .tag-count')!.textContent).toBe('4')
    expect(rows(container).map(([text]) => text)).not.toContain('Not a heading')
  })

  it('narrows the list with the filter and reports how many are showing', () => {
    seed()
    const { container } = render(<OutlinePanel path="Guide.md" />)

    fireEvent.change(screen.getByLabelText('Filter headings'), { target: { value: 'et' } })
    expect(rows(container).map(([text]) => text)).toEqual(['Setup', 'Details'])
    expect(container.querySelector('.panel-header .tag-count')!.textContent).toBe('2/4')

    fireEvent.change(screen.getByLabelText('Filter headings'), { target: { value: 'nothing' } })
    expect(rows(container)).toEqual([])
    expect(container.querySelector('.empty-state')!.textContent).toContain('No headings match')
  })

  it('shows an empty state, and no filter, when the note has no headings', () => {
    seed()
    const { container } = render(<OutlinePanel path="Flat.md" />)

    expect(rows(container)).toEqual([])
    expect(container.querySelector('.empty-state')!.textContent).toContain('No headings in this note')
    expect(screen.queryByLabelText('Filter headings')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Reveal
 * ------------------------------------------------------------------ */

describe('OutlinePanel — reveal', () => {
  it('dispatches spacelink:reveal-heading with the slug and line', () => {
    seed()
    const listen = vi.fn()
    window.addEventListener('spacelink:reveal-heading', listen)

    const { container } = render(<OutlinePanel path="Guide.md" />)
    fireEvent.click([...container.querySelectorAll('.outline-item')][2]!)

    window.removeEventListener('spacelink:reveal-heading', listen)

    const details = headingsOf('Guide.md')[2]!
    expect((listen.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      path: 'Guide.md',
      slug: details.slug,
      line: details.line,
    })
    expect(details.text).toBe('Details')
  })

  it('marks the clicked heading as current', () => {
    seed()
    const { container } = render(<OutlinePanel path="Guide.md" />)
    const setup = [...container.querySelectorAll('.outline-item')][1]!

    expect(container.querySelector('.outline-item.is-active')).toBeNull()
    fireEvent.click(setup)
    expect(setup.className).toContain('is-active')
    expect(setup.getAttribute('aria-current')).toBe('true')
  })

  it('brings the pane showing the note forward', () => {
    seed(VAULT, {
      panes: [paneWith('pane-a', 'tab-a', null), paneWith('pane-b', 'tab-b', 'Guide.md')],
      activePaneId: 'pane-a',
    })
    const { container } = render(<OutlinePanel path="Guide.md" />)

    fireEvent.click([...container.querySelectorAll('.outline-item')][0]!)

    expect(useAppStore.getState().activePaneId).toBe('pane-b')
    expect(useAppStore.getState().panes[1]!.activeTabId).toBe('tab-b')
  })
})

/* ------------------------------------------------------------------ *
 * Following the reader
 * ------------------------------------------------------------------ */

describe('OutlinePanel — current heading', () => {
  const scroll = (detail: unknown): void => {
    act(() => {
      window.dispatchEvent(new CustomEvent('spacelink:preview-scroll', { detail }))
    })
  }

  it('highlights the heading named by spacelink:preview-scroll', () => {
    seed()
    const { container } = render(<OutlinePanel path="Guide.md" />)

    scroll({ path: 'Guide.md', slug: headingsOf('Guide.md')[3]!.slug })
    expect(container.querySelector('.outline-item.is-active')!.textContent).toBe('Usage')

    scroll({ path: 'Guide.md', slug: headingsOf('Guide.md')[1]!.slug })
    expect(container.querySelector('.outline-item.is-active')!.textContent).toBe('Setup')
  })

  it('ignores events for other notes and malformed payloads', () => {
    seed()
    const { container } = render(<OutlinePanel path="Guide.md" />)

    scroll({ path: 'Flat.md', slug: 'usage' })
    expect(container.querySelector('.outline-item.is-active')).toBeNull()

    scroll(null)
    scroll({ path: 'Guide.md' })
    expect(container.querySelector('.outline-item.is-active')).toBeNull()
  })

  it('drops the highlight when the panel switches note', () => {
    seed()
    const view = render(<OutlinePanel path="Guide.md" />)
    scroll({ path: 'Guide.md', slug: headingsOf('Guide.md')[1]!.slug })
    expect(view.container.querySelector('.outline-item.is-active')).not.toBeNull()

    view.rerender(<OutlinePanel path="Flat.md" />)
    view.rerender(<OutlinePanel path="Guide.md" />)
    expect(view.container.querySelector('.outline-item.is-active')).toBeNull()
  })

  it('stops listening when it unmounts', () => {
    seed()
    const remove = vi.spyOn(window, 'removeEventListener')
    render(<OutlinePanel path="Guide.md" />).unmount()

    expect(remove.mock.calls.some(([type]) => type === 'spacelink:preview-scroll')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * The shell around the outline.
 *
 * `RightSidebar` and `NoteInfo` have no test file of their own — this task
 * ships four components and two test files — so their behaviour is covered
 * here, next to the panel they wrap.
 * ------------------------------------------------------------------ */

const SHELL_VAULT: Record<NotePath, string> = {
  'Guide.md': [
    '---',
    'title: Guide',
    'aliases: [Handbook]',
    'tags: [docs, guide]',
    'status: draft',
    'created: 2024-01-02',
    '---',
    '# Guide',
    '',
    'Read [[Flat]] and [[Missing]] for more. #extra',
    '',
  ].join('\n'),
  'Flat.md': ['# Flat', '', 'Points back at [[Guide]].', ''].join('\n'),
}

/** `[key, value]` for every row of the frontmatter property table. */
function properties(container: HTMLElement): [string, string][] {
  return [...container.querySelectorAll('.note-info-properties tr')].map((row) => [
    row.querySelector('th')?.textContent ?? '',
    row.querySelector('td')?.textContent ?? '',
  ])
}

/** The `<dd>` following the `<dt>` with this label. */
function stat(container: HTMLElement, label: string): string {
  const row = [...container.querySelectorAll('.note-info-row')].find(
    (candidate) => candidate.querySelector('dt')?.textContent === label,
  )
  if (!row) throw new Error(`no "${label}" stat rendered`)
  return row.querySelector('dd')?.textContent ?? ''
}

describe('formatRelativeTime', () => {
  const now = Date.parse('2024-06-15T12:00:00Z')

  it('counts up through the units', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now')
    expect(formatRelativeTime(now - 60_000, now)).toBe('1 minute ago')
    expect(formatRelativeTime(now - 45 * 60_000, now)).toBe('45 minutes ago')
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2 hours ago')
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago')
    expect(formatRelativeTime(now - 70 * 86_400_000, now)).toBe('2 months ago')
    expect(formatRelativeTime(now - 800 * 86_400_000, now)).toBe('2 years ago')
  })

  it('does not report a negative age, or a missing one', () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe('just now')
    expect(formatRelativeTime(0, now)).toBe('unknown')
    expect(formatRelativeTime(Number.NaN, now)).toBe('unknown')
  })
})

describe('readingTime', () => {
  it('rounds up at 200 words per minute, never to zero', () => {
    expect(readingTime(0)).toBe('under a minute')
    expect(readingTime(1)).toBe('1 min read')
    expect(readingTime(200)).toBe('1 min read')
    expect(readingTime(201)).toBe('2 min read')
    expect(readingTime(1_000)).toBe('5 min read')
  })
})

describe('createdFrom', () => {
  it('reads the first usable date key, and nothing else', () => {
    expect(createdFrom({ created: '2024-01-02' })).toBe(Date.parse('2024-01-02'))
    expect(createdFrom({ date: 1_700_000_000_000 })).toBe(1_700_000_000_000)
    expect(createdFrom({ created: 'someday' })).toBeNull()
    expect(createdFrom({})).toBeNull()
  })
})

describe('NoteInfo', () => {
  it('reports the path, size and reading time', () => {
    seed(SHELL_VAULT, {}, Date.now() - 2 * 3_600_000)
    const { container } = render(<NoteInfo path="Guide.md" />)
    const note = useAppStore.getState().notes.get('Guide.md')!

    expect(container.querySelector('.note-info-path')!.textContent).toBe('Guide.md')
    expect(stat(container, 'Words')).toBe(String(note.parsed.wordCount))
    expect(stat(container, 'Characters')).toBe(note.content.length.toLocaleString())
    expect(stat(container, 'Reading time')).toBe('1 min read')
    expect(stat(container, 'Modified')).toBe('2 hours ago')
    expect(stat(container, 'Created')).toBe(formatRelativeTime(Date.parse('2024-01-02')))
  })

  it('counts resolved links, unresolved links and backlinks', () => {
    seed(SHELL_VAULT)
    const { container } = render(<NoteInfo path="Guide.md" />)

    expect(stat(container, 'Outgoing links')).toBe('1 · 1 unresolved')
    expect(stat(container, 'Backlinks')).toBe('1')
  })

  it('renders tags as chips that hand a query to the search panel', () => {
    seed(SHELL_VAULT)
    const { container } = render(<NoteInfo path="Guide.md" />)
    const chips = [...container.querySelectorAll('.tag')]

    // Inline tags come first, then the frontmatter list — `allTags` order.
    expect(chips.map((chip) => chip.textContent)).toEqual(['#extra', '#docs', '#guide'])
    fireEvent.click(chips[1]!)
    expect(useAppStore.getState().searchQuery).toBe('tag:docs')
    expect(useAppStore.getState().sidebarPanel).toBe('search')
  })

  it('renders frontmatter as a property table, arrays as chips', () => {
    seed(SHELL_VAULT)
    const { container } = render(<NoteInfo path="Guide.md" />)

    // `tags` is omitted: it already has its own section of chips above.
    expect(properties(container)).toEqual([
      ['title', 'Guide'],
      ['aliases', 'Handbook'],
      ['status', 'draft'],
      ['created', '2024-01-02'],
    ])
    expect(container.querySelectorAll('.note-info-chip')).toHaveLength(1)
  })

  it('degrades to an empty state when the note is gone', () => {
    seed(SHELL_VAULT)
    const { container } = render(<NoteInfo path="Deleted.md" />)
    expect(container.querySelector('.empty-state')!.textContent).toContain('no longer in the vault')
  })
})

describe('RightSidebar', () => {
  it('says so when no note is open', () => {
    seed(SHELL_VAULT, { panes: [paneWith('pane-a', 'tab-a', null)], activePaneId: 'pane-a' })
    const { container } = render(<RightSidebar />)

    expect(container.querySelector('.empty-state')!.textContent).toContain('No note open')
    expect(container.querySelector('.backlinks-panel')).toBeNull()
  })

  it('switches panels and remembers the choice', () => {
    seed(SHELL_VAULT)
    const first = render(<RightSidebar />)
    expect(first.container.querySelector('.backlinks-panel')).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Outline' }))
    expect(first.container.querySelector('.outline-panel')).not.toBeNull()
    expect(loadRightSidebarTab()).toBe('outline')
    cleanup()

    const second = render(<RightSidebar />)
    expect(second.container.querySelector('.outline-panel')).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Outline' }).getAttribute('aria-selected')).toBe('true')
  })

  it('moves between tabs with the arrow keys', () => {
    seed(SHELL_VAULT)
    const { container } = render(<RightSidebar />)

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Backlinks' }), { key: 'ArrowLeft' })
    expect(container.querySelector('.note-info')).not.toBeNull()
    expect(loadRightSidebarTab()).toBe('info')
  })

  it('collapses through the store', () => {
    seed(SHELL_VAULT, { rightSidebarOpen: true })
    render(<RightSidebar />)

    fireEvent.click(screen.getByLabelText('Collapse right sidebar'))
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  })

  it('widens as the handle is dragged left, and clamps', () => {
    seed(SHELL_VAULT, { rightSidebarWidth: 300 })
    const { container } = render(<RightSidebar />)
    const resizer = container.querySelector('.sidebar-resizer')!

    fireEvent.mouseDown(resizer, { button: 0, clientX: 800 })
    fireEvent.mouseMove(window, { clientX: 740 })
    expect(useAppStore.getState().rightSidebarWidth).toBe(360)

    fireEvent.mouseMove(window, { clientX: 100 })
    expect(useAppStore.getState().rightSidebarWidth).toBe(560)

    fireEvent.mouseUp(window)
    fireEvent.mouseMove(window, { clientX: 800 })
    expect(useAppStore.getState().rightSidebarWidth).toBe(560)
  })

  it('resizes from the keyboard, mirrored for a right-hand edge', () => {
    seed(SHELL_VAULT, { rightSidebarWidth: 300 })
    const { container } = render(<RightSidebar />)
    const resizer = container.querySelector('.sidebar-resizer')!

    fireEvent.keyDown(resizer, { key: 'ArrowLeft' })
    expect(useAppStore.getState().rightSidebarWidth).toBe(316)
    fireEvent.keyDown(resizer, { key: 'ArrowRight' })
    expect(useAppStore.getState().rightSidebarWidth).toBe(300)
  })
})
