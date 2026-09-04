/**
 * The `/` block menu, driven through the real completion machinery.
 *
 * These build an actual `EditorView` and ask the source what it would offer at
 * a cursor, then apply the option and read the document back. Asserting on the
 * resulting *text* rather than on the option list is the point: the menu's job
 * is what ends up in the file.
 */
import { CompletionContext, autocompletion, currentCompletions, startCompletion } from '@codemirror/autocomplete'
import type { Completion } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { slashCompletion } from './slashMenu'

const source = slashCompletion()
const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

/** An editor holding `doc`, with the cursor where `|` was. */
function editor(doc: string): EditorView {
  const at = doc.indexOf('|')
  const text = doc.replace('|', '')
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [markdown()],
      selection: { anchor: at === -1 ? text.length : at },
    }),
  })
  views.push(view)
  return view
}

/** What the menu offers at the cursor, by label. */
function offered(doc: string): string[] | null {
  const view = editor(doc)
  const result = source(new CompletionContext(view.state, view.state.selection.main.head, true))
  if (!result || result instanceof Promise) return null
  return result.options.map((option) => option.label)
}

/** Pick `label` from the menu and return the document it leaves behind. */
function pick(doc: string, label: string): { text: string; cursor: number } {
  const view = editor(doc)
  const at = view.state.selection.main.head
  const result = source(new CompletionContext(view.state, at, true))
  if (!result || result instanceof Promise) throw new Error('the menu offered nothing')
  const option = result.options.find((candidate) => candidate.label === label)
  if (!option) throw new Error(`no option called ${label}; got ${result.options.map((o) => o.label).join(', ')}`)
  const apply = (option as Completion).apply
  if (typeof apply !== 'function') throw new Error(`${label} has no apply`)
  apply(view, option, result.from, at)
  return { text: view.state.doc.toString(), cursor: view.state.selection.main.head }
}

describe('the / block menu', () => {
  it('opens on a bare slash at the start of a line and offers every block', () => {
    const labels = offered('/|')
    expect(labels).not.toBeNull()
    expect(labels).toContain('Heading 1')
    expect(labels).toContain('To-do list')
    expect(labels).toContain('Table')
    // With nothing typed the order is the menu's own, not alphabetical: it is
    // what somebody scanning the list expects to see first.
    expect(labels![0]).toBe('Heading 1')
  })

  it('writes the markup a person would have had to remember', () => {
    expect(pick('/|', 'Heading 2').text).toBe('## ')
    expect(pick('/|', 'To-do list').text).toBe('- [ ] ')
    expect(pick('/|', 'Bulleted list').text).toBe('- ')
    expect(pick('/|', 'Quote').text).toBe('> ')
    expect(pick('/|', 'Callout').text).toBe('> [!note] ')
    // The toggle callout is the one that actually folds, which is why it is
    // offered separately rather than left to be typed by hand.
    expect(pick('/|', 'Toggle callout').text).toBe('> [!note]- ')
  })

  it('leaves the caret where the writing goes', () => {
    const { text, cursor } = pick('/|', 'Heading 1')
    expect(text).toBe('# ')
    expect(cursor).toBe(2)
  })

  it('takes the slash away before running a block that is more than a line lead', () => {
    // Both of these read the line they are on to decide whether to break onto
    // a new one. With the `/table` still sitting there they would push the
    // table onto the line below and leave the slash behind.
    const table = pick('/|', 'Table')
    expect(table.text.startsWith('| Column 1 |'), table.text).toBe(true)
    expect(table.text).not.toContain('/')

    const code = pick('/|', 'Code block')
    expect(code.text).toBe('```\n\n```')
  })

  it('finds a block by a word its label does not contain', () => {
    // "todo" is nowhere in "To-do list", and CodeMirror's own filter would
    // drop it — which is why the source does its own ranking and turns the
    // filter off.
    expect(offered('/todo|')).toEqual(['To-do list'])
    expect(offered('/fold|')).toContain('Toggle callout')
    expect(offered('/hr|')).toContain('Divider')
  })

  it('ranks the closest match first, not the one that comes first in the list', () => {
    // `/list` matches three, and the best of them is sixth in the menu. Asking
    // with a query whose winner is already first would prove nothing.
    expect(offered('/list|')).toEqual(['To-do list', 'Bulleted list', 'Numbered list'])
    expect(offered('/head|')?.[0]).toBe('Heading 1')
  })

  it('survives CodeMirror\'s own filter, which would leave nothing at all', async () => {
    // The menu's `from` is the `/` itself, because applying has to take the
    // `/query` away. That means the text CodeMirror would filter against
    // starts with a `/`, and no block is called `/anything` — so left to
    // filter, the list empties out the moment somebody types. Measured
    // through the real pipeline: `filter: true` shows nothing for `/todo`.
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      state: EditorState.create({
        doc: '/todo',
        extensions: [markdown(), autocompletion({ override: [source] })],
        selection: { anchor: 5 },
      }),
      parent,
    })
    views.push(view)
    try {
      startCompletion(view)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(currentCompletions(view.state).map((option) => option.label)).toEqual(['To-do list'])
    } finally {
      parent.remove()
    }
  })

  it('stays out of prose, which is where a menu is an interruption', () => {
    // Every one of these is a slash somebody meant to type.
    expect(offered('see https:/|')).toBeNull()
    expect(offered('and/|')).toBeNull()
    expect(offered('a note about and/or| things')).toBeNull()
  })

  it('opens wherever the block is still empty — a list, a quote, a to-do', () => {
    // Indentation, a blockquote marker, a list marker and a checkbox are all
    // lead, not writing, so the block has not been started yet.
    expect(offered('- /|')).not.toBeNull()
    expect(offered('1. /|')).not.toBeNull()
    expect(offered('> /|')).not.toBeNull()
    expect(offered('  - [ ] /|')).not.toBeNull()
    expect(offered('> - /|')).not.toBeNull()
  })

  it('closes once there is writing in the block', () => {
    // The other half of the same rule, and the one that keeps it quiet.
    expect(offered('- a word /|')).toBeNull()
    expect(offered('> quoting something /|')).toBeNull()
  })

  it('closes once the query stops looking like one', () => {
    // A space ends it: the person moved on to writing.
    expect(offered('/head |')).toBeNull()
    // And a query that matches nothing offers nothing rather than everything.
    expect(offered('/zzzz|')).toBeNull()
  })

  it('offers a wiki link, since that is a block people reach for by name', () => {
    expect(pick('/|', 'Link to a note').text).toBe('[[')
  })
})
