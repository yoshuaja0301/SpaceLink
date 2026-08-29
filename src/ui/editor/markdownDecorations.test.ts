/**
 * `computeDecorationRanges` is the whole decoration story minus CodeMirror, so
 * these tests run it directly on strings — no view, no viewport, no layout.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import type { DecorationKind, DecorationRange, SelectionSpan } from './markdownDecorations'
import {
  computeDecorationRanges,
  flashLine,
  flashLineHighlight,
  markdownDecorations,
  refreshDecorations,
} from './markdownDecorations'

/** Pretend every target except the ones listed is missing from the vault. */
function vault(...existing: string[]) {
  const set = new Set(existing.map((t) => t.toLowerCase()))
  return (target: string): string | null => (set.has(target.toLowerCase()) ? `${target}.md` : null)
}

const nothingExists = (): string | null => null
const everythingExists = (target: string): string => `${target}.md`

function run(
  text: string,
  options: {
    from?: number
    selection?: SelectionSpan[]
    resolve?: (target: string) => string | null
    hideSyntax?: boolean
    openFence?: string | null
  } = {},
): DecorationRange[] {
  return computeDecorationRanges(
    text,
    options.from ?? 0,
    options.selection ?? [],
    options.resolve ?? everythingExists,
    options.hideSyntax ?? false,
    options.openFence ?? null,
  )
}

function of(ranges: DecorationRange[], kind: DecorationKind): DecorationRange[] {
  return ranges.filter((r) => r.kind === kind)
}

/** The exact substrings a set of ranges covers, for readable assertions. */
function slices(text: string, ranges: DecorationRange[], from = 0): string[] {
  return ranges.map((r) => text.slice(r.from - from, r.to - from))
}

describe('wiki links', () => {
  it('finds a plain link and records its target', () => {
    const text = 'see [[Zettelkasten]] for more'
    const links = of(run(text), 'wikilink')
    expect(links).toHaveLength(1)
    expect(slices(text, links)).toEqual(['[[Zettelkasten]]'])
    expect(links[0]!.value).toBe('Zettelkasten')
    expect(links[0]!.unresolved).toBe(false)
  })

  it('flags a link the vault cannot resolve', () => {
    const links = of(run('[[Real]] and [[Missing]]', { resolve: vault('Real') }), 'wikilink')
    expect(links.map((l) => [l.value, l.unresolved])).toEqual([
      ['Real', false],
      ['Missing', true],
    ])
  })

  it('strips the heading, block id and alias from the target', () => {
    const links = of(run('[[Note#Section|display text]] [[Note^abc]]'), 'wikilink')
    expect(links.map((l) => l.value)).toEqual(['Note', 'Note'])
  })

  it('treats a same-note [[#Heading]] link as resolved', () => {
    const links = of(run('[[#Overview]]', { resolve: nothingExists }), 'wikilink')
    expect(links[0]!.unresolved).toBe(false)
  })

  it('covers the `!` of an embed', () => {
    const text = 'before ![[diagram.png]]'
    const links = of(run(text), 'wikilink')
    expect(slices(text, links)).toEqual(['![[diagram.png]]'])
  })

  it('offsets everything by `from`', () => {
    const text = 'x [[A]]'
    const links = of(run(text, { from: 100 }), 'wikilink')
    expect(links[0]!.from).toBe(102)
    expect(links[0]!.to).toBe(107)
  })
})

describe('tags', () => {
  it('finds tags after whitespace and at the start of a line', () => {
    const text = '#alpha then #beta/gamma'
    const tags = of(run(text), 'tag')
    expect(slices(text, tags)).toEqual(['#alpha', '#beta/gamma'])
    expect(tags.map((t) => t.value)).toEqual(['alpha', 'beta/gamma'])
  })

  it('ignores a `#` glued to a word, a bare `#`, and an all-digit tag', () => {
    expect(of(run('issue#42 and # and #1 and #2024'), 'tag')).toHaveLength(0)
  })

  it('drops a dangling slash', () => {
    expect(of(run('#work/'), 'tag')[0]!.value).toBe('work')
  })

  it('does not treat a heading marker as a tag', () => {
    const tags = of(run('# Heading'), 'tag')
    expect(tags).toHaveLength(0)
  })

  it('finds a tag inside a heading', () => {
    const tags = of(run('## Notes #idea'), 'tag')
    expect(tags.map((t) => t.value)).toEqual(['idea'])
  })
})

describe('headings', () => {
  it('emits one zero-length line decoration per heading, carrying the level', () => {
    const text = '# One\n### Three\nbody\n####### Seven'
    const headings = of(run(text), 'heading')
    expect(headings.map((h) => h.level)).toEqual([1, 3])
    expect(headings.map((h) => h.from)).toEqual([0, 6])
    expect(headings.every((h) => h.from === h.to)).toBe(true)
  })

  it('marks the hashes and their trailing space as syntax', () => {
    const text = '## Title'
    const syntax = of(run(text), 'syntax')
    expect(slices(text, syntax)).toEqual(['## '])
  })
})

describe('inline formatting', () => {
  it('marks bold, italic, code, strike and highlight', () => {
    const text = 'a **b** c *d* e `f` g ~~h~~ i ==j=='
    const found = run(text)
    expect(slices(text, of(found, 'bold'))).toEqual(['**b**'])
    expect(slices(text, of(found, 'italic'))).toEqual(['*d*'])
    expect(slices(text, of(found, 'code'))).toEqual(['`f`'])
    expect(slices(text, of(found, 'strikethrough'))).toEqual(['~~h~~'])
    expect(slices(text, of(found, 'highlight'))).toEqual(['==j=='])
  })

  it('nests italic inside bold', () => {
    const text = '**bold *and italic* here**'
    const found = run(text)
    expect(slices(text, of(found, 'bold'))).toEqual([text])
    expect(slices(text, of(found, 'italic'))).toEqual(['*and italic*'])
  })

  it('leaves snake_case_words alone', () => {
    expect(of(run('a snake_case_word b'), 'italic')).toHaveLength(0)
  })

  it('does not decorate an unmatched delimiter', () => {
    expect(of(run('2 * 3 * 4 is not italic, but 5*6 = 30'), 'italic')).toHaveLength(0)
    expect(of(run('a `unclosed span'), 'code')).toHaveLength(0)
  })

  it('treats the contents of an inline code span as opaque', () => {
    const found = run('use `[[not a link]] #nottag **notbold**` here')
    expect(of(found, 'wikilink')).toHaveLength(0)
    expect(of(found, 'tag')).toHaveLength(0)
    expect(of(found, 'bold')).toHaveLength(0)
    expect(of(found, 'code')).toHaveLength(1)
  })

  it('marks quotes and list bullets', () => {
    const text = '> quoted\n- item'
    const found = run(text)
    expect(slices(text, of(found, 'quote'))).toEqual(['> quoted'])
    expect(slices(text, of(found, 'list-marker'))).toEqual(['-'])
  })
})

describe('task markers', () => {
  it('reports the marker range and its state', () => {
    const text = '- [ ] todo\n2. [x] done\n- [X] also done'
    const tasks = of(run(text), 'task')
    expect(slices(text, tasks)).toEqual(['[ ]', '[x]', '[X]'])
    expect(tasks.map((t) => t.checked)).toEqual([false, true, true])
  })

  it('ignores a checkbox that is not preceded by a list bullet', () => {
    expect(of(run('[ ] not a task'), 'task')).toHaveLength(0)
  })
})

describe('fenced code', () => {
  it('produces no decorations inside a fence', () => {
    const text = ['# Real heading', '```js', '// [[link]] #tag **bold**', '# not a heading', '```', '#realtag'].join('\n')
    const found = run(text)
    expect(of(found, 'wikilink')).toHaveLength(0)
    expect(of(found, 'bold')).toHaveLength(0)
    // Only the heading before the fence survives.
    expect(of(found, 'heading').map((h) => h.level)).toEqual([1])
    // And the tag after the closing fence is decorated again.
    expect(of(found, 'tag').map((t) => t.value)).toEqual(['realtag'])
  })

  it('honours tilde fences and ignores a shorter closer', () => {
    const text = ['~~~~', '[[inside]]', '~~~', '[[still inside]]', '~~~~', '[[outside]]'].join('\n')
    expect(of(run(text), 'wikilink').map((l) => l.value)).toEqual(['outside'])
  })

  it('starts inside a fence when the caller says so', () => {
    const text = '[[hidden]]\n```\n[[visible]]'
    expect(of(run(text, { openFence: '```' }), 'wikilink').map((l) => l.value)).toEqual(['visible'])
  })

  it('does not treat an info string as a closing fence', () => {
    const text = '```ts\n[[a]]\n```\n[[b]]'
    expect(of(run(text, { openFence: null }), 'wikilink').map((l) => l.value)).toEqual(['b'])
  })
})

describe('live syntax hiding', () => {
  const text = 'a **bold** b'
  const markers = (opts: Parameters<typeof run>[1]): DecorationRange[] => of(run(text, opts), 'syntax')

  it('is off entirely when the setting is off', () => {
    expect(markers({ hideSyntax: false }).every((m) => m.hidden === false)).toBe(true)
  })

  it('hides delimiters the selection does not touch', () => {
    const hidden = markers({ hideSyntax: true, selection: [{ from: 0, to: 0 }] })
    expect(slices(text, hidden)).toEqual(['**', '**'])
    expect(hidden.every((m) => m.hidden === true)).toBe(true)
  })

  it('reveals delimiters once the cursor enters the construct', () => {
    // Cursor between the asterisks and "bold".
    const revealed = markers({ hideSyntax: true, selection: [{ from: 5, to: 5 }] })
    expect(revealed.every((m) => m.hidden === false)).toBe(true)
  })

  it('reveals when the cursor merely touches the edge of the construct', () => {
    expect(markers({ hideSyntax: true, selection: [{ from: 2, to: 2 }] }).every((m) => m.hidden === false)).toBe(true)
    expect(markers({ hideSyntax: true, selection: [{ from: 10, to: 10 }] }).every((m) => m.hidden === false)).toBe(true)
  })

  it('keeps hiding constructs the selection does not reach', () => {
    const multi = 'x **one** y\n\n**two**'
    const hidden = of(run(multi, { hideSyntax: true, selection: [{ from: 3, to: 3 }] }), 'syntax')
    // The first pair is revealed, the second is still folded away.
    expect(hidden.map((m) => m.hidden)).toEqual([false, false, true, true])
  })

  it('never hides while a selection spans more than one line', () => {
    const multi = '**one**\n**two**'
    const hidden = of(run(multi, { hideSyntax: true, selection: [{ from: 0, to: multi.length }] }), 'syntax')
    expect(hidden.every((m) => m.hidden === false)).toBe(true)
  })

  it('hides the target and pipe of an aliased link, leaving the alias', () => {
    const aliased = '[[Long Note Name|short]]'
    const hidden = of(run(aliased, { hideSyntax: true, selection: [{ from: 100, to: 100 }] }), 'syntax')
    expect(slices(aliased, hidden).sort()).toEqual(['Long Note Name|', '[[', ']]'])
  })

  it('works in absolute coordinates', () => {
    const hidden = of(run(text, { from: 50, hideSyntax: true, selection: [{ from: 55, to: 55 }] }), 'syntax')
    expect(hidden.every((m) => m.hidden === false)).toBe(true)
  })
})

describe('output shape', () => {
  it('returns ranges sorted by start offset', () => {
    const found = run('# Heading with [[link]] and #tag and **bold**\n- [ ] task `code`')
    const starts = found.map((r) => r.from)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
  })

  it('handles an empty document', () => {
    expect(run('')).toEqual([])
  })

  it('never emits a range outside the scanned text', () => {
    const text = '**a** [[b]] #c'
    for (const range of run(text, { hideSyntax: true })) {
      expect(range.from).toBeGreaterThanOrEqual(0)
      expect(range.to).toBeLessThanOrEqual(text.length)
      expect(range.to).toBeGreaterThanOrEqual(range.from)
    }
  })
})

/* ------------------------------------------------------------------ *
 * The plugin, in a live (jsdom) view
 * ------------------------------------------------------------------ */

describe('markdownDecorations plugin', () => {
  const doc = [
    '# Heading #tag',
    '',
    'A [[Link]], a [[Missing]], some **bold** and `code`.',
    '',
    '- [ ] a task',
    '- [x] done',
    '',
    '```js',
    'const x = "[[nope]] #nope"',
    '```',
  ].join('\n')

  function mount(hideSyntax: boolean | (() => boolean) = true): EditorView {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          markdownDecorations({
            resolve: (target) => (target === 'Link' ? 'Link.md' : null),
            hideSyntax: typeof hideSyntax === 'function' ? hideSyntax : () => hideSyntax,
          }),
        ],
      }),
    })
    document.body.appendChild(view.dom)
    return view
  }

  it('renders marks, line classes and the checkbox widget', () => {
    const view = mount()
    try {
      const links = [...view.dom.querySelectorAll('.cm-wikilink')]
      // The `[[nope]]` inside the fence is not a link.
      expect(links.map((el) => el.getAttribute('data-target'))).toEqual(['Link', 'Missing'])
      expect(view.dom.querySelectorAll('.cm-wikilink-unresolved')).toHaveLength(1)
      expect([...view.dom.querySelectorAll('.cm-tag')].map((el) => el.getAttribute('data-tag'))).toEqual(['tag'])
      expect(view.dom.querySelectorAll('.cm-heading-1')).toHaveLength(1)
      expect(view.dom.querySelectorAll('.cm-bold')).toHaveLength(1)
      expect(view.dom.querySelectorAll('.cm-code')).toHaveLength(1)
      expect(view.dom.querySelectorAll('.cm-hidden-syntax').length).toBeGreaterThan(0)

      const boxes = [...view.dom.querySelectorAll<HTMLInputElement>('.cm-task-checkbox')]
      expect(boxes.map((b) => b.checked)).toEqual([false, true])
    } finally {
      view.destroy()
    }
  })

  it('never hides syntax when the setting is off', () => {
    const view = mount(false)
    try {
      expect(view.dom.querySelectorAll('.cm-hidden-syntax')).toHaveLength(0)
      expect(view.dom.querySelectorAll('.cm-syntax-marker').length).toBeGreaterThan(0)
    } finally {
      view.destroy()
    }
  })

  it('toggles the document when the checkbox widget is clicked', () => {
    const view = mount()
    try {
      const box = view.dom.querySelector<HTMLInputElement>('.cm-task-checkbox')
      expect(box).not.toBeNull()
      box!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(view.state.doc.line(5).text).toBe('- [x] a task')

      // And back again, through the freshly rendered widget.
      const again = view.dom.querySelector<HTMLInputElement>('.cm-task-checkbox')
      again!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(view.state.doc.line(5).text).toBe('- [ ] a task')
    } finally {
      view.destroy()
    }
  })

  it('rebuilds when the selection moves, revealing only the construct under it', () => {
    const view = mount()
    const revealed = (): string[] => [...view.dom.querySelectorAll('.cm-syntax-marker')].map((el) => el.textContent ?? '')
    try {
      // Park the caret on a blank line: nothing is revealed.
      view.dispatch({ selection: { anchor: doc.indexOf('\n\n') + 1 } })
      expect(revealed()).toEqual([])
      const hiddenAtRest = view.dom.querySelectorAll('.cm-hidden-syntax').length
      expect(hiddenAtRest).toBeGreaterThan(0)

      // Move into `**bold**`: exactly its two markers come back.
      view.dispatch({ selection: { anchor: doc.indexOf('**bold**') + 3 } })
      expect(revealed()).toEqual(['**', '**'])
      expect(view.dom.querySelectorAll('.cm-hidden-syntax').length).toBe(hiddenAtRest - 2)
    } finally {
      view.destroy()
    }
  })

  it('rebuilds on an explicit refresh effect', () => {
    // Flipping `liveSyntaxHiding` changes neither the document nor the
    // selection, so the editor announces it with this effect instead.
    let hide = true
    const view = mount(() => hide)
    try {
      expect(view.dom.querySelectorAll('.cm-hidden-syntax').length).toBeGreaterThan(0)
      hide = false
      view.dispatch({ effects: refreshDecorations.of(null) })
      expect(view.dom.querySelectorAll('.cm-hidden-syntax')).toHaveLength(0)
      expect(view.dom.querySelectorAll('.cm-syntax-marker').length).toBeGreaterThan(0)
    } finally {
      view.destroy()
    }
  })
})

describe('flashLineHighlight', () => {
  function mountFlash(doc: string): EditorView {
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [flashLineHighlight] }) })
    document.body.appendChild(view.dom)
    return view
  }

  const lit = (view: EditorView): string[] =>
    [...view.dom.querySelectorAll('.cm-flash-line')].map((el) => el.textContent ?? '')

  it('lights the line holding the offset and clears again on null', () => {
    const view = mountFlash('one\ntwo\nthree')
    try {
      expect(lit(view)).toEqual([])
      // Mid-line, to prove the whole line is taken, not just the offset.
      view.dispatch({ effects: flashLine.of(view.state.doc.line(2).from + 1) })
      expect(lit(view)).toEqual(['two'])
      view.dispatch({ effects: flashLine.of(null) })
      expect(lit(view)).toEqual([])
    } finally {
      view.destroy()
    }
  })

  it('follows the text when an edit above it shifts the document', () => {
    const view = mountFlash('one\ntwo\nthree')
    try {
      view.dispatch({ effects: flashLine.of(view.state.doc.line(3).from) })
      expect(lit(view)).toEqual(['three'])
      view.dispatch({ changes: { from: 0, insert: 'zero\n' } })
      expect(lit(view)).toEqual(['three'])
    } finally {
      view.destroy()
    }
  })

  it('clamps an offset past the end of the document', () => {
    const view = mountFlash('one\ntwo')
    try {
      view.dispatch({ effects: flashLine.of(9999) })
      expect(lit(view)).toEqual(['two'])
    } finally {
      view.destroy()
    }
  })
})
