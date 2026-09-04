/**
 * The page header, driven the way somebody would drive it.
 *
 * Every assertion here is on the note's *text* after the interaction, because
 * that is what the panel is for: the file on disk is the only place a property
 * actually lives, and a panel that showed the right thing while writing the
 * wrong one would look perfect.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { emptyIndex } from '../core/graph/index'
import type { AppState } from '../state/store'
import { makeNote, useAppStore } from '../state/store'
import type { NotePath } from '../types'
import { PageHeader } from './PageHeader'

const PATH = 'Note.md' as NotePath
const PRISTINE = useAppStore.getState() as AppState

beforeEach(() => {
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      toasts: [],
      panes: [{ id: 'pane-a', tabs: [], activeTabId: null }],
      activePaneId: 'pane-a',
    },
    true,
  )
})

afterEach(cleanup)

/**
 * Put `content` in the store as the note under test and render the header.
 *
 * The properties are opened, because they are collapsed by default and every
 * test below is about them. The collapsing itself has its own test.
 */
function show(content: string): void {
  useAppStore.setState({ notes: new Map([[PATH, makeNote(PATH, content, 0)]]) })
  render(<PageHeader path={PATH} />)
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: /propert/i }))
  })
}

/** The note's text as the store now holds it. */
function text(): string {
  return useAppStore.getState().notes.get(PATH)?.content ?? ''
}

/** Type into a field and blur it, which is when the header commits. */
function type(field: HTMLElement, value: string): void {
  act(() => {
    fireEvent.change(field, { target: { value } })
    fireEvent.blur(field)
  })
}

describe('the page header', () => {
  it('shows the properties a note has, and no rows for a note with none', () => {
    show('---\nstatus: draft\nowner: me\n---\n\n# Body\n')
    expect((screen.getByLabelText('status') as HTMLInputElement).value).toBe('draft')
    expect((screen.getByLabelText('owner') as HTMLInputElement).value).toBe('me')

    cleanup()
    show('# Body\n')
    expect(screen.queryByLabelText('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a property' })).toBeTruthy()
  })

  it('writes an edited value back into the file', () => {
    show('---\nstatus: draft\n---\n\n# Body\n')
    type(screen.getByLabelText('status'), 'published')
    expect(text()).toBe('---\nstatus: published\n---\n\n# Body\n')
  })

  it('leaves the body exactly as it was', () => {
    // The whole risk of an editable panel: it must not be able to touch a
    // character of what somebody wrote.
    const body = '# Body\n\nA line with --- in it.\n\n```\n---\n```\n\nEnd.\n'
    show(`---\nstatus: draft\n---\n\n${body}`)
    type(screen.getByLabelText('status'), 'done')
    expect(text().endsWith(body)).toBe(true)
  })

  it('keeps the kind of value a property already had', () => {
    // A list stays a list, a number stays a number while it still reads as
    // one, and stops being one when it does not.
    show('---\ntags:\n  - a\ncount: 3\ndone: true\n---\n\nBody\n')
    type(screen.getByLabelText('tags'), 'a, b, c')
    expect(text()).toContain('tags:\n  - a\n  - b\n  - c\n')

    type(screen.getByLabelText('count'), '7')
    expect(text()).toContain('count: 7\n')

    type(screen.getByLabelText('done'), 'false')
    expect(text()).toContain('done: false\n')
  })

  it('turns a number into text rather than into zero when it is cleared', () => {
    // `Number('')` is 0, and a cleared field that silently became a zero would
    // be a value nobody typed.
    show('---\ncount: 3\n---\n\nBody\n')
    type(screen.getByLabelText('count'), '')
    expect(text()).toBe('---\ncount: ""\n---\n\nBody\n')
  })

  it('renames a property without moving it', () => {
    show('---\na: 1\nb: 2\nc: 3\n---\n\nBody\n')
    type(screen.getByLabelText('Name of the property b'), 'beta')
    expect(text()).toBe('---\na: 1\nbeta: 2\nc: 3\n---\n\nBody\n')
  })

  it('removes a property, and the block with it when it was the last one', () => {
    show('---\nonly: 1\n---\n\nBody\n')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove only' }))
    })
    expect(text()).toBe('Body\n')
  })

  it('adds a property, and makes tags a list because the parser reads it as one', () => {
    show('# Body\n')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a property' }))
    })
    type(screen.getByLabelText('Name of the new property'), 'tags')
    // Written as a list, not as text: the parser normalises `tags` into a
    // list, so text would be undone on the next read and the file would churn
    // on every save.
    expect(text()).toBe('---\ntags: []\n---\n\n# Body\n')
  })

  it('leaves the note alone for a name the file could not hold', () => {
    // No guard of its own: the serialiser refuses these, and the note comes
    // back unchanged. Asserted here because that is the behaviour somebody
    // meets, wherever it is enforced.
    show('# Body\n')
    for (const bad of ['has space', 'has:colon', '']) {
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Add a property' }))
      })
      type(screen.getByLabelText('Name of the new property'), bad)
      expect(text(), `"${bad}" was written`).toBe('# Body\n')
    }
  })

  it('does not empty a property by adding one that is already there', () => {
    // The one case the panel has to catch itself: `set(key, '')` on a name
    // that exists would wipe a value somebody can see, which reads as the
    // panel having deleted it.
    show('---\nstatus: draft\n---\n\nBody\n')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a property' }))
    })
    type(screen.getByLabelText('Name of the new property'), 'status')
    expect(text()).toBe('---\nstatus: draft\n---\n\nBody\n')
  })

  it('sets an icon as an ordinary property, so it travels with the file', () => {
    show('# Body\n')
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add an icon' }))
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '🚀' }))
    })
    expect(text()).toBe('---\nicon: 🚀\n---\n\n# Body\n')
    // And it is drawn as the header rather than listed as a row, because
    // showing it twice is noise.
    expect(screen.queryByLabelText('icon')).toBeNull()
    expect(screen.getByRole('button', { name: 'Change the icon' }).textContent).toBe('🚀')
  })

  it('says so when a cover cannot be found, instead of showing a broken image', () => {
    // The path is almost always a typo, and the reader is the only one who can
    // fix it — a broken image icon does not tell them what to fix.
    show('---\ncover: missing/beach.jpg\n---\n\nBody\n')
    expect(screen.getByText(/Cover not found: missing\/beach\.jpg/)).toBeTruthy()
  })

  it('shows the same title the tab does', () => {
    // `parsed.title` is the app's one answer to "what is this note called":
    // the frontmatter title, else the first heading, else the file name. The
    // header agreeing with the tab matters more than any of the three.
    show('---\ntitle: A Better Name\n---\n\n# Body\n')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A Better Name')
    cleanup()
    show('# From the heading\n')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('From the heading')
    cleanup()
    show('just text, no heading\n')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Note')
  })

  it('does not write to the file while a name is being typed', () => {
    // Committing per keystroke would rewrite the frontmatter once per
    // character and fill the undo history with half-typed keys.
    show('---\nstatus: draft\n---\n\nBody\n')
    const field = screen.getByLabelText('Name of the property status')
    act(() => {
      fireEvent.change(field, { target: { value: 'st' } })
      fireEvent.change(field, { target: { value: 'stat' } })
    })
    expect(text()).toBe('---\nstatus: draft\n---\n\nBody\n')
    act(() => {
      fireEvent.blur(field)
    })
    expect(text()).toBe('---\nstat: draft\n---\n\nBody\n')
  })

  it('puts a name back when the edit is abandoned', () => {
    show('---\nstatus: draft\n---\n\nBody\n')
    const field = screen.getByLabelText('Name of the property status') as HTMLInputElement
    act(() => {
      fireEvent.change(field, { target: { value: '' } })
      fireEvent.blur(field)
    })
    // An empty name is not a rename to nothing — that is what the × is for.
    expect(text()).toBe('---\nstatus: draft\n---\n\nBody\n')
    expect(field.value).toBe('status')
  })

  it('keeps the properties collapsed until they are asked for', () => {
    // Expanded by default, the header measured 257px on a note with five
    // properties — a quarter of the window spent on chrome above every note,
    // and enough to hide the top of a scrolled note behind it.
    useAppStore.setState({ notes: new Map([[PATH, makeNote(PATH, '---\na: 1\nb: 2\n---\n\nBody\n', 0)]]) })
    render(<PageHeader path={PATH} />)

    const toggle = screen.getByRole('button', { name: '2 properties' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Still in the DOM for the label lookup, but not shown.
    expect((screen.getByLabelText('a').closest('.page-properties') as HTMLElement).hidden).toBe(true)

    act(() => {
      fireEvent.click(toggle)
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByLabelText('a').closest('.page-properties') as HTMLElement).hidden).toBe(false)
  })

  it('counts the properties on the toggle, so the header says what it is hiding', () => {
    useAppStore.setState({ notes: new Map([[PATH, makeNote(PATH, '---\nonly: 1\n---\n\nBody\n', 0)]]) })
    render(<PageHeader path={PATH} />)
    expect(screen.getByRole('button', { name: '1 property' })).toBeTruthy()
    cleanup()
    useAppStore.setState({ notes: new Map([[PATH, makeNote(PATH, 'Body\n', 0)]]) })
    render(<PageHeader path={PATH} />)
    expect(screen.getByRole('button', { name: 'Properties' })).toBeTruthy()
  })
})
