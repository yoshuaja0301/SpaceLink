/**
 * The table view, driven as somebody would drive it.
 *
 * The core decisions — columns, ordering, comparison — are tested without a DOM
 * next to the code that makes them. These are about the parts only the
 * component owns: that a cell writes to the right note's frontmatter and to no
 * other, that sorting a column is reachable from a header, and that opening a
 * row opens the note.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { emptyIndex } from '../core/graph/index'
import type { AppState } from '../state/store'
import { makeNote, useAppStore } from '../state/store'
import type { Note, NotePath } from '../types'
import { TableView } from './TableView'

const PANE_ID = 'pane-a'
const PRISTINE = useAppStore.getState() as AppState

const VAULT: Record<string, string> = {
  'Projects/Alpha.md': '---\nstatus: doing\nowner: me\ndue: 3\n---\n# Alpha\n',
  'Projects/Beta.md': '---\nstatus: done\nowner: you\n---\n# Beta\n',
  'Projects/Deep/Gamma.md': '---\nstatus: doing\n---\n# Gamma\n',
  'Elsewhere/Other.md': '---\nstatus: doing\n---\n# Other\n',
}

beforeEach(() => {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(VAULT)) {
    notes.set(path as NotePath, makeNote(path as NotePath, content, 0))
  }
  useAppStore.setState(
    {
      ...PRISTINE,
      notes,
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      toasts: [],
      panes: [{ id: PANE_ID, tabs: [], activeTabId: null }],
      activePaneId: PANE_ID,
    },
    true,
  )
})

afterEach(cleanup)

function show(folder = 'Projects'): void {
  render(<TableView folder={folder} paneId={PANE_ID} />)
}

/** The note's text as the store now holds it. */
function text(path: string): string {
  return useAppStore.getState().notes.get(path as NotePath)?.content ?? ''
}

/** Row names, in the order the table shows them. */
function rowNames(): string[] {
  return [...document.querySelectorAll('tbody tr th button')].map((cell) => cell.textContent ?? '')
}

describe('a folder as a table', () => {
  it('shows the notes under the folder and a column for each property', () => {
    show()
    expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    const headers = [...document.querySelectorAll('thead th')].map((cell) => cell.textContent ?? '')
    expect(headers).toEqual(['Name', 'status', 'owner', 'due'])
    // A note in a different folder is not in this table.
    expect(rowNames()).not.toContain('Other')
  })

  it('writes an edited cell into that note, and into no other', () => {
    // Deliberately not the first note in the vault: a cell that wrote to
    // whichever note came first would pass a test that edited that one.
    show()
    const alpha = text('Projects/Alpha.md')
    const gamma = text('Projects/Deep/Gamma.md')
    act(() => {
      fireEvent.change(screen.getByLabelText('status of Beta'), { target: { value: 'doing' } })
      fireEvent.blur(screen.getByLabelText('status of Beta'))
    })
    expect(text('Projects/Beta.md')).toBe('---\nstatus: doing\nowner: you\n---\n# Beta\n')
    expect(text('Projects/Alpha.md'), 'another note was written').toBe(alpha)
    expect(text('Projects/Deep/Gamma.md'), 'another note was written').toBe(gamma)
  })

  it('keeps the kind of value the property already had', () => {
    show()
    act(() => {
      fireEvent.change(screen.getByLabelText('due of Alpha'), { target: { value: '10' } })
      fireEvent.blur(screen.getByLabelText('due of Alpha'))
    })
    // A number, not the string "10" — which would sort after "9".
    expect(text('Projects/Alpha.md')).toContain('due: 10\n')
  })

  it('adds a property to a note that did not have it', () => {
    // Gamma has no owner. The column exists because its neighbours do, and
    // filling the cell has to create the property rather than do nothing.
    show()
    act(() => {
      fireEvent.change(screen.getByLabelText('owner of Gamma'), { target: { value: 'them' } })
      fireEvent.blur(screen.getByLabelText('owner of Gamma'))
    })
    expect(text('Projects/Deep/Gamma.md')).toBe('---\nstatus: doing\nowner: them\n---\n# Gamma\n')
  })

  it('leaves the note alone when a cell is left as it was', () => {
    // Not merely "writes the same bytes": going through the writer at all
    // would tidy the block — `status:    doing` becomes `status: doing` — so a
    // note somebody only looked at would come back reformatted. The note here
    // is spelled awkwardly on purpose.
    const path = 'Projects/Alpha.md' as NotePath
    const awkward = '---\nstatus:    doing\nowner: me\ndue: 3\n---\n# Alpha\n'
    act(() => {
      useAppStore.setState({
        notes: new Map(useAppStore.getState().notes).set(path, makeNote(path, awkward, 0)),
      })
    })
    show()
    act(() => {
      fireEvent.blur(screen.getByLabelText('status of Alpha'))
    })
    expect(text('Projects/Alpha.md')).toBe(awkward)
  })

  it('sorts by a column, and turns the sort around on a second click', () => {
    show()
    const owner = screen.getByRole('button', { name: /^owner/ })
    act(() => {
      fireEvent.click(owner)
    })
    expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^owner/ }))
    })
    // Reversed among the notes that have an owner; Gamma has none, so it stays
    // last either way.
    expect(rowNames()).toEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('says which way a column is sorted, for anyone not looking at the arrow', () => {
    show()
    const header = () => screen.getByRole('columnheader', { name: /status/ })
    expect(header().getAttribute('aria-sort')).toBe('none')
    act(() => {
      fireEvent.click(within(header()).getByRole('button'))
    })
    expect(header().getAttribute('aria-sort')).toBe('ascending')
    act(() => {
      fireEvent.click(within(header()).getByRole('button'))
    })
    expect(header().getAttribute('aria-sort')).toBe('descending')
  })

  it('filters on the name and on any value, and says how many are left', () => {
    show()
    const filter = screen.getByLabelText('Filter the table')
    act(() => {
      fireEvent.change(filter, { target: { value: 'done' } })
    })
    expect(rowNames()).toEqual(['Beta'])
    expect(screen.getByText('1 of 3 notes')).toBeTruthy()

    act(() => {
      fireEvent.change(filter, { target: { value: 'zzz' } })
    })
    expect(rowNames()).toEqual([])
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()
  })

  it('opens the note when its name is clicked', () => {
    show()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    })
    const pane = useAppStore.getState().panes.find((one) => one.id === PANE_ID)!
    expect(pane.tabs.map((tab) => tab.path)).toContain('Projects/Beta.md')
  })

  it('says so for a folder with nothing in it', () => {
    show('Empty')
    expect(screen.getByText('No notes in this folder yet.')).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
  })

  it('takes the whole vault for the root', () => {
    show('')
    expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Other'])
    expect(screen.getByText('All notes')).toBeTruthy()
  })

  it('drops a sort whose column has gone', () => {
    // The last note using a property loses it, the column disappears, and a
    // table still sorted by it would be ordered by something not on screen.
    show()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^due/ }))
    })
    expect(screen.getByRole('columnheader', { name: /due/ }).getAttribute('aria-sort')).toBe('ascending')

    act(() => {
      useAppStore.getState().setNoteContent(
        'Projects/Alpha.md' as NotePath,
        '---\nstatus: doing\nowner: me\n---\n# Alpha\n',
      )
    })
    expect(screen.queryByRole('columnheader', { name: /due/ })).toBeNull()
    expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    // And the table says what it *is* sorted by. Left pointing at a column
    // nobody can see, no header claims the sort at all — and the property
    // coming back, on an undo, would silently re-sort the table.
    expect(screen.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('ascending')
  })
})
