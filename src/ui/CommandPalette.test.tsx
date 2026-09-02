import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { headingElementId } from '../core/markdown/parse'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { EditorView } from '@codemirror/view'

import type { Note, NotePath } from '../types'
import { buildIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { registerEditor } from './editor/markdownCommands'
import { resetNavigationHistory } from './commands'
import { CommandPalette } from './CommandPalette'

const PRISTINE = useAppStore.getState()

function seed(files: Record<NotePath, string>): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes) })
}

function open(mode: 'commands' | 'quickswitch' | 'headings'): void {
  useAppStore.setState({ palette: mode })
}

function input(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement
}

function options(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

function titles(): string[] {
  return options().map((option) => option.querySelector('.palette-item-title')?.textContent ?? '')
}

function selectedTitle(): string {
  const option = document.querySelector('[aria-selected="true"] .palette-item-title')
  return option?.textContent ?? ''
}

/** Enough of an editor for `enabled()`; no editor command is run here. */
function withStubEditor(): void {
  registerEditor('palette-test-pane', {} as EditorView)
}

function emptyText(): string {
  return document.querySelector('.palette-empty')?.textContent ?? ''
}

function type(value: string): void {
  fireEvent.change(input(), { target: { value } })
}

function key(name: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(input(), { key: name, ...init })
}

beforeEach(() => {
  useAppStore.setState(PRISTINE, true)
  resetNavigationHistory()
})

afterEach(() => {
  cleanup()
  registerEditor('palette-test-pane', null)
  resetNavigationHistory()
  useAppStore.setState(PRISTINE, true)
  vi.restoreAllMocks()
})

describe('CommandPalette', () => {
  it('renders nothing while the palette is closed', () => {
    const { container } = render(<CommandPalette />)
    expect(container.firstChild).toBe(null)
  })

  it('opens as a focused, labelled dialog', () => {
    open('commands')
    render(<CommandPalette />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Command palette')
    expect(document.activeElement).toBe(input())
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('groups commands by section and shows their shortcuts', () => {
    open('commands')
    const first = render(<CommandPalette />)
    // Without an editor every Editor command is disabled, so the whole section
    // disappears rather than showing dead rows.
    expect([...document.querySelectorAll('li.palette-section')].map((el) => el.textContent)).toEqual([
      'File',
      'Navigation',
      'View',
    ])
    first.unmount()

    withStubEditor()
    open('commands')
    render(<CommandPalette />)
    const sections = [...document.querySelectorAll('li.palette-section')].map((el) => el.textContent)
    expect(sections).toEqual(['File', 'Navigation', 'Editor', 'View'])

    type('go to file')
    expect(titles()[0]).toBe('Go to file')
    expect(options()[0]?.querySelector('.palette-shortcut')?.textContent).toBe('Ctrl+P')
  })

  it('fuzzy-filters on "section: title"', () => {
    open('commands')
    render(<CommandPalette />)

    type('view theme')
    expect(titles()).toEqual(['Toggle theme (dark / light / system)'])

    type('zzzzz')
    expect(options()).toHaveLength(0)
    expect(emptyText()).toBe('No matching commands')
  })

  it('announces the result count', () => {
    open('commands')
    render(<CommandPalette />)

    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe(`${options().length} results`)

    type('go to file')
    expect(status.textContent).toBe('1 result')
  })

  it('hides commands that are unavailable right now', () => {
    open('commands')
    const first = render(<CommandPalette />)
    type('close pane')
    expect(titles()).not.toContain('Close pane')
    first.unmount()

    act(() => useAppStore.getState().splitPane())
    open('commands')
    render(<CommandPalette />)
    type('close pane')
    expect(titles()).toContain('Close pane')
  })

  it('navigates with the keyboard and tracks the active descendant', () => {
    open('commands')
    render(<CommandPalette />)
    const all = titles()

    expect(selectedTitle()).toBe(all[0])
    expect(input().getAttribute('aria-activedescendant')).toBe('palette-option-0')

    key('ArrowDown')
    expect(selectedTitle()).toBe(all[1])
    expect(input().getAttribute('aria-activedescendant')).toBe('palette-option-1')

    key('ArrowUp')
    key('ArrowUp')
    // Arrow keys wrap around the ends.
    expect(selectedTitle()).toBe(all[all.length - 1])

    key('Home')
    expect(selectedTitle()).toBe(all[0])
    key('End')
    expect(selectedTitle()).toBe(all[all.length - 1])

    key('PageUp')
    expect(selectedTitle()).toBe(all[all.length - 9])
    key('PageUp')
    key('PageUp')
    key('PageUp')
    key('PageUp')
    // PageUp clamps rather than wrapping.
    expect(selectedTitle()).toBe(all[0])
  })

  it('resets the selection when the query changes', () => {
    open('commands')
    render(<CommandPalette />)
    key('ArrowDown')
    key('ArrowDown')
    type('toggle')
    expect(selectedTitle()).toBe(titles()[0])
  })

  it('runs the selected command and closes', () => {
    open('commands')
    render(<CommandPalette />)

    type('toggle right sidebar')
    expect(selectedTitle()).toBe('Toggle right sidebar')
    expect(useAppStore.getState().rightSidebarOpen).toBe(true)

    key('Enter')
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
    expect(useAppStore.getState().palette).toBe(null)
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('runs a command on click', () => {
    open('commands')
    render(<CommandPalette />)
    type('toggle right sidebar')
    fireEvent.click(options()[0]!)
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
    expect(useAppStore.getState().palette).toBe(null)
  })

  it('closes on Escape and gives focus back', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    open('commands')
    render(<CommandPalette />)
    expect(document.activeElement).toBe(input())

    key('Escape')
    expect(useAppStore.getState().palette).toBe(null)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('closes when the backdrop is clicked but not the dialog', () => {
    open('commands')
    render(<CommandPalette />)

    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(useAppStore.getState().palette).toBe('commands')

    fireEvent.mouseDown(document.querySelector('.palette-backdrop')!)
    expect(useAppStore.getState().palette).toBe(null)
  })

  it('keeps focus inside the dialog when tabbing', () => {
    open('commands')
    render(<CommandPalette />)
    key('Tab')
    expect(document.activeElement).toBe(input())
    key('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(input())
  })
})

describe('CommandPalette — quick switcher', () => {
  beforeEach(() => {
    seed({ 'notes/Zettelkasten.md': '# Z', 'Daily/2024-01-01.md': '# Day', 'Root.md': '# Root' })
  })

  it('lists notes with their folder and highlights the match', () => {
    open('quickswitch')
    render(<CommandPalette />)

    type('zett')
    expect(titles()).toEqual(['Zettelkasten'])
    expect(options()[0]?.querySelector('.palette-item-subtitle')?.textContent).toBe('notes')
    expect(options()[0]?.querySelector('mark')?.textContent).toBe('Zett')
  })

  it('shows the vault root for top-level notes', () => {
    open('quickswitch')
    render(<CommandPalette />)
    type('root')
    expect(options()[0]?.querySelector('.palette-item-subtitle')?.textContent).toBe('Vault root')
  })

  it('offers to create a note nothing matches', () => {
    const createNoteFromTitle = vi.fn(async () => 'Brand New.md')
    useAppStore.setState({ createNoteFromTitle })
    open('quickswitch')
    render(<CommandPalette />)

    type('Brand New')
    expect(titles()).toEqual(['Brand New'])
    expect(options()[0]?.querySelector('.palette-item-subtitle')?.textContent).toBe('Create new note')

    key('Enter')
    expect(createNoteFromTitle).toHaveBeenCalledWith('Brand New')
    expect(useAppStore.getState().palette).toBe(null)
  })

  it('opens the selection, in a new tab or a split when asked', () => {
    const openPath = vi.fn()
    const splitPane = vi.fn()
    useAppStore.setState({ openPath, splitPane })

    open('quickswitch')
    const first = render(<CommandPalette />)
    type('zett')
    key('Enter')
    expect(openPath).toHaveBeenLastCalledWith('notes/Zettelkasten.md', { newTab: false })
    first.unmount()

    open('quickswitch')
    const second = render(<CommandPalette />)
    type('zett')
    key('Enter', { ctrlKey: true })
    expect(openPath).toHaveBeenLastCalledWith('notes/Zettelkasten.md', { newTab: true })
    second.unmount()

    open('quickswitch')
    render(<CommandPalette />)
    type('zett')
    key('Enter', { shiftKey: true })
    expect(splitPane).toHaveBeenCalledTimes(1)
    expect(openPath).toHaveBeenLastCalledWith('notes/Zettelkasten.md', {
      paneId: useAppStore.getState().activePaneId,
    })
  })
})

describe('CommandPalette — headings', () => {
  beforeEach(() => {
    seed({ 'Structure.md': '# Top\n\ntext\n\n## Middle bit\n\n### Deep one\n' })
    act(() => useAppStore.getState().openPath('Structure.md'))
  })

  it('lists the active note headings, indented by level', () => {
    open('headings')
    render(<CommandPalette />)

    expect(titles()).toEqual(['Top', 'Middle bit', 'Deep one'])
    expect(options()[0]?.style.paddingLeft).toBe('')
    expect(options()[1]?.style.paddingLeft).toContain('14px')
    expect(options()[2]?.style.paddingLeft).toContain('28px')
    expect(options()[2]?.querySelector('.palette-item-subtitle')?.textContent).toBe('H3')
  })

  it('filters headings and jumps to the chosen one', () => {
    const openPath = vi.fn()
    useAppStore.setState({ openPath })
    open('headings')
    render(<CommandPalette />)

    type('mid')
    expect(titles()).toEqual(['Middle bit'])
    // The reading view's heading carries the prefixed id; that is what the
    // palette has to scroll to.
    const rendered = document.createElement('h2')
    rendered.id = headingElementId('middle-bit')
    const scrollIntoView = vi.fn()
    Object.defineProperty(rendered, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    document.body.appendChild(rendered)
    try {
      key('Enter')
      expect(openPath).toHaveBeenCalledWith('Structure.md', { heading: 'middle-bit' })
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    } finally {
      rendered.remove()
    }
    expect(useAppStore.getState().palette).toBe(null)
  })

  it('says so when the note has no headings', () => {
    seed({ 'Flat.md': 'just prose' })
    act(() => useAppStore.getState().openPath('Flat.md'))
    open('headings')
    render(<CommandPalette />)
    expect(options()).toHaveLength(0)
    expect(emptyText()).toBe('This note has no headings')
  })
})
