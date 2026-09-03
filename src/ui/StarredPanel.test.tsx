import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { Note, NotePath } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { StarredPanel, loadStarredOrder, moveStarred, orderStarred } from './StarredPanel'

const PRISTINE = useAppStore.getState()

function seed(files: Record<NotePath, string>, starred: NotePath[] = [], recent: NotePath[] = []): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), starred, recent })
}

function rows(container: HTMLElement, selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)]
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
      hoveredPath: null,
    },
    true,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('orderStarred / moveStarred', () => {
  it('applies the remembered order and leaves unranked paths at the end', () => {
    expect(orderStarred(['a.md', 'b.md', 'c.md'], ['c.md', 'a.md'])).toEqual(['c.md', 'a.md', 'b.md'])
  })

  it('moves an entry to the requested slot', () => {
    expect(moveStarred(['a.md', 'b.md', 'c.md'], 0, 2)).toEqual(['b.md', 'c.md', 'a.md'])
    expect(moveStarred(['a.md', 'b.md'], 5, 0)).toEqual(['a.md', 'b.md'])
  })
})

describe('StarredPanel keyboard', () => {
  it('gives every starred row a tab stop and opens it with Enter and Space', () => {
    const openPath = vi.fn()
    seed({ 'A.md': '# Alpha', 'B.md': '# Beta' }, ['A.md', 'B.md'])
    useAppStore.setState({ openPath })
    const { container } = render(<StarredPanel />)

    const starred = rows(container, '.starred-item')
    expect(starred).toHaveLength(2)
    // The rows used to be `role="listitem"` divs with nothing but an onClick.
    for (const row of starred) {
      expect(row.tabIndex).toBe(0)
      expect(row.getAttribute('role')).toBe('button')
    }

    fireEvent.keyDown(starred[0]!, { key: 'Enter' })
    expect(openPath).toHaveBeenCalledWith('A.md')

    fireEvent.keyDown(starred[1]!, { key: ' ' })
    expect(openPath).toHaveBeenLastCalledWith('B.md')
    expect(openPath).toHaveBeenCalledTimes(2)
  })

  it('opens a recent row from the keyboard too', () => {
    const openPath = vi.fn()
    seed({ 'A.md': '# Alpha' }, [], ['A.md'])
    useAppStore.setState({ openPath })
    const { container } = render(<StarredPanel />)

    const recent = rows(container, '.recent-item')
    expect(recent).toHaveLength(1)
    expect(recent[0]!.tabIndex).toBe(0)

    fireEvent.keyDown(recent[0]!, { key: 'Enter' })
    expect(openPath).toHaveBeenCalledWith('A.md')
  })

  it('leaves the star toggle to handle its own keys', () => {
    const openPath = vi.fn()
    const toggleStar = vi.fn()
    seed({ 'A.md': '# Alpha' }, ['A.md'])
    useAppStore.setState({ openPath, toggleStar })
    render(<StarredPanel />)

    const star = screen.getByRole('button', { name: 'Unstar Alpha' })
    // Enter on the nested button activates the button, not the row.
    fireEvent.keyDown(star, { key: 'Enter' })
    expect(openPath).not.toHaveBeenCalled()

    fireEvent.click(star)
    expect(toggleStar).toHaveBeenCalledWith('A.md')
    expect(openPath).not.toHaveBeenCalled()
  })

  it('does not open a starred note the vault no longer has', () => {
    const openPath = vi.fn()
    seed({ 'A.md': '# Alpha' }, ['Gone.md'])
    useAppStore.setState({ openPath })
    const { container } = render(<StarredPanel />)

    const row = rows(container, '.starred-item')[0]!
    expect(row.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.click(row)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('still reorders starred notes by dragging one onto another', () => {
    seed({ 'A.md': '# Alpha', 'B.md': '# Beta' }, ['A.md', 'B.md'])
    const { container } = render(<StarredPanel />)

    const starred = rows(container, '.starred-item')
    const transfer = dataTransfer()
    fireEvent.dragStart(starred[0]!, { dataTransfer: transfer })
    fireEvent.dragOver(starred[1]!, { dataTransfer: transfer })
    fireEvent.drop(starred[1]!, { dataTransfer: transfer })

    expect(loadStarredOrder()).toEqual(['B.md', 'A.md'])
    expect(rows(container, '.nav-item-title').map((title) => title.textContent)).toEqual(['Beta', 'Alpha'])
  })
})
