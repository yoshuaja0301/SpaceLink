/**
 * The commands are plain functions of (state -> transaction), so the tests run
 * against a two-line stand-in for `EditorView`: a `state` getter and a
 * `dispatch` that folds the transaction back in. No DOM, no layout, no timers.
 */
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

import {
  cycleHeading,
  duplicateLine,
  getActiveEditor,
  insertCodeBlock,
  insertLink,
  insertTable,
  insertWikiLink,
  moveLineDown,
  moveLineUp,
  registerEditor,
  toggleBlockquote,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
  toggleTaskCheckbox,
} from './markdownCommands'

interface Harness {
  view: EditorView
  doc: () => string
  sel: () => { from: number; to: number }
  run: (command: Command) => boolean
}

/** `anchor`/`head` default to a collapsed cursor at the end of the document. */
function harness(doc: string, anchor?: number, head?: number): Harness {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor ?? doc.length, head ?? anchor ?? doc.length),
  })
  const view = {
    get state() {
      return state
    },
    dispatch(...specs: Array<TransactionSpec | Transaction>) {
      for (const spec of specs) {
        state = spec instanceof Transaction ? spec.state : state.update(spec).state
      }
    },
  } as unknown as EditorView

  return {
    view,
    doc: () => state.doc.toString(),
    sel: () => ({ from: state.selection.main.from, to: state.selection.main.to }),
    run: (command) => command(view),
  }
}

/** Run `command` twice and assert the document came back unchanged. */
function expectRoundTrip(command: Command, doc: string, anchor: number, head?: number): string {
  const h = harness(doc, anchor, head)
  h.run(command)
  const once = h.doc()
  h.run(command)
  expect(h.doc()).toBe(doc)
  return once
}

describe('inline toggles', () => {
  const cases: Array<[string, Command, string]> = [
    ['bold', toggleBold, '**'],
    ['italic', toggleItalic, '*'],
    ['strikethrough', toggleStrikethrough, '~~'],
    ['inline code', toggleInlineCode, '`'],
    ['highlight', toggleHighlight, '=='],
  ]

  for (const [name, command, marker] of cases) {
    it(`wraps the word under a collapsed cursor for ${name}`, () => {
      // Cursor sits inside "world".
      const wrapped = expectRoundTrip(command, 'hello world here', 8)
      expect(wrapped).toBe(`hello ${marker}world${marker} here`)
    })

    it(`wraps an explicit selection for ${name}`, () => {
      const wrapped = expectRoundTrip(command, 'hello world here', 0, 11)
      expect(wrapped).toBe(`${marker}hello world${marker} here`)
    })

    it(`leaves the selection on the content for ${name}`, () => {
      const h = harness('alpha', 0, 5)
      h.run(command)
      expect(h.doc()).toBe(`${marker}alpha${marker}`)
      expect(h.sel()).toEqual({ from: marker.length, to: marker.length + 5 })
    })

    it(`unwraps when the selection already contains the markers for ${name}`, () => {
      const doc = `${marker}alpha${marker}`
      const h = harness(doc, 0, doc.length)
      h.run(command)
      expect(h.doc()).toBe('alpha')
    })
  }

  it('inserts an empty pair when there is no word under the cursor', () => {
    const h = harness('a  b', 2)
    h.run(toggleBold)
    expect(h.doc()).toBe('a **** b')
    // Caret between the two pairs, ready to type.
    expect(h.sel()).toEqual({ from: 4, to: 4 })
  })

  it('does not let italic eat one asterisk of a bold pair', () => {
    // Selection covers "alpha" inside **alpha**.
    const h = harness('**alpha**', 2, 7)
    h.run(toggleItalic)
    expect(h.doc()).toBe('***alpha***')
  })

  it('toggles each range of a multi-range selection', () => {
    let state = EditorState.create({
      doc: 'one two',
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    })
    const view = {
      get state() {
        return state
      },
      dispatch(spec: TransactionSpec) {
        state = state.update(spec).state
      },
    } as unknown as EditorView
    toggleBold(view)
    expect(state.doc.toString()).toBe('**one** **two**')
  })
})

describe('toggleBlockquote', () => {
  it('quotes and unquotes a single line', () => {
    const once = expectRoundTrip(toggleBlockquote, 'a thought', 3)
    expect(once).toBe('> a thought')
  })

  it('quotes every selected line when only some are quoted', () => {
    const h = harness('> one\ntwo\nthree', 0, 15)
    h.run(toggleBlockquote)
    expect(h.doc()).toBe('> one\n> two\n> three')
    h.run(toggleBlockquote)
    expect(h.doc()).toBe('one\ntwo\nthree')
  })

  it('leaves untouched lines alone', () => {
    const h = harness('one\ntwo', 0, 3)
    h.run(toggleBlockquote)
    expect(h.doc()).toBe('> one\ntwo')
  })
})

describe('toggleTaskCheckbox', () => {
  it('round-trips checked and unchecked', () => {
    const once = expectRoundTrip(toggleTaskCheckbox, '- [ ] write tests', 8)
    expect(once).toBe('- [x] write tests')
  })

  it('flips a checked box back', () => {
    const h = harness('- [x] done', 8)
    h.run(toggleTaskCheckbox)
    expect(h.doc()).toBe('- [ ] done')
  })

  it('adds a checkbox to a bare list item', () => {
    const h = harness('- shopping', 5)
    h.run(toggleTaskCheckbox)
    expect(h.doc()).toBe('- [ ] shopping')
  })

  it('turns a plain line into a task, preserving indentation', () => {
    const h = harness('  buy milk', 5)
    h.run(toggleTaskCheckbox)
    expect(h.doc()).toBe('  - [ ] buy milk')
  })

  it('toggles every selected line', () => {
    const h = harness('- [ ] a\n- [ ] b', 0, 15)
    h.run(toggleTaskCheckbox)
    expect(h.doc()).toBe('- [x] a\n- [x] b')
  })
})

describe('cycleHeading', () => {
  it('cycles a plain line up through six levels and back', () => {
    const h = harness('Title', 2)
    const seen: string[] = []
    for (let i = 0; i < 7; i += 1) {
      h.run(cycleHeading)
      seen.push(h.doc())
    }
    expect(seen).toEqual([
      '# Title',
      '## Title',
      '### Title',
      '#### Title',
      '##### Title',
      '###### Title',
      'Title',
    ])
  })

  it('cycles every selected line', () => {
    const h = harness('# a\nb', 0, 5)
    h.run(cycleHeading)
    expect(h.doc()).toBe('## a\n# b')
  })

  it('ignores blank lines', () => {
    const h = harness('a\n\nb', 0, 4)
    h.run(cycleHeading)
    expect(h.doc()).toBe('# a\n\n# b')
  })
})

describe('insertions', () => {
  it('wraps a selection as the link label', () => {
    const h = harness('see the docs', 4, 12)
    h.run(insertLink)
    expect(h.doc()).toBe('see [the docs]()')
    // Caret inside the parentheses.
    expect(h.sel()).toEqual({ from: 15, to: 15 })
  })

  it('uses a selected URL as the destination', () => {
    const h = harness('https://example.com', 0, 19)
    h.run(insertLink)
    expect(h.doc()).toBe('[](https://example.com)')
    expect(h.sel()).toEqual({ from: 1, to: 1 })
  })

  it('creates an empty link at a collapsed cursor', () => {
    const h = harness('', 0)
    h.run(insertLink)
    expect(h.doc()).toBe('[]()')
    expect(h.sel()).toEqual({ from: 3, to: 3 })
  })

  it('wraps a selection in wiki brackets and keeps it selected', () => {
    const h = harness('Zettelkasten', 0, 12)
    h.run(insertWikiLink)
    expect(h.doc()).toBe('[[Zettelkasten]]')
    expect(h.sel()).toEqual({ from: 2, to: 14 })
  })

  it('inserts a table on its own lines and lands in the first body cell', () => {
    const h = harness('intro', 5)
    h.run(insertTable)
    expect(h.doc()).toBe('intro\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |')
    const { from, to } = h.sel()
    expect(from).toBe(to)
    expect(h.doc().slice(from - 2, from + 2)).toBe('|  |')
  })

  it('does not add a leading newline on an empty line', () => {
    const h = harness('', 0)
    h.run(insertTable)
    expect(h.doc().startsWith('| Column 1 ')).toBe(true)
  })

  it('fences a selection and keeps it selected', () => {
    const h = harness('const x = 1', 0, 11)
    h.run(insertCodeBlock)
    expect(h.doc()).toBe('```\nconst x = 1\n```')
    expect(h.sel()).toEqual({ from: 4, to: 15 })
  })

  it('fences an empty block with the caret inside', () => {
    const h = harness('', 0)
    h.run(insertCodeBlock)
    expect(h.doc()).toBe('```\n\n```')
    expect(h.sel()).toEqual({ from: 4, to: 4 })
  })
})

describe('line manipulation', () => {
  it('moves a line up', () => {
    const h = harness('one\ntwo\nthree', 4)
    h.run(moveLineUp)
    expect(h.doc()).toBe('two\none\nthree')
  })

  it('moves a line down', () => {
    const h = harness('one\ntwo\nthree', 0)
    h.run(moveLineDown)
    expect(h.doc()).toBe('two\none\nthree')
  })

  it('refuses to move the first line up', () => {
    const h = harness('one\ntwo', 0)
    expect(h.run(moveLineUp)).toBe(false)
    expect(h.doc()).toBe('one\ntwo')
  })

  it('duplicates the current line', () => {
    const h = harness('one\ntwo', 0)
    h.run(duplicateLine)
    expect(h.doc()).toBe('one\none\ntwo')
  })

  it('duplicates a multi-line selection as a block', () => {
    const h = harness('a\nb\nc', 0, 3)
    h.run(duplicateLine)
    expect(h.doc()).toBe('a\nb\na\nb\nc')
  })
})

describe('editor registry', () => {
  it('hands back the registered editor and forgets it on unregister', () => {
    const a = harness('a').view
    const b = harness('b').view
    // `hasFocus` is undefined on the stand-in views, so the registry falls back
    // to the most recently registered pane — which is what the palette wants.
    registerEditor('pane-a', a)
    expect(getActiveEditor()).toBe(a)
    registerEditor('pane-b', b)
    expect(getActiveEditor()).toBe(b)
    registerEditor('pane-b', null)
    expect(getActiveEditor()).toBe(a)
    registerEditor('pane-a', null)
    expect(getActiveEditor()).toBe(null)
  })
})
