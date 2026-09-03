import { afterEach, describe, expect, it } from 'vitest'
import { CompletionContext, acceptCompletion, autocompletion, completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete'
import type { CompletionResult } from '@codemirror/autocomplete'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { buildIndex } from '../../core/graph/index'
import { makeNote, useAppStore } from '../../state/store'
import type { NotePath } from '../../types'
import { wikilinkCompletion } from './wikilinkComplete'

function seed(files: Record<string, string>, recent: NotePath[] = []): void {
  const notes = new Map<NotePath, ReturnType<typeof makeNote>>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, recent, index: buildIndex(notes) })
}

/** A minimal view: enough for a completion's `apply` to dispatch against. */
function editor(doc: string, cursor: number): { view: EditorView; doc: () => string; head: () => number } {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const view = {
    get state() {
      return state
    },
    dispatch(...specs: Array<TransactionSpec | Transaction>) {
      for (const spec of specs) state = spec instanceof Transaction ? spec.state : state.update(spec).state
    },
  } as unknown as EditorView
  return { view, doc: () => state.doc.toString(), head: () => state.selection.main.head }
}

function complete(doc: string, cursor: number, explicit = false): CompletionResult | null {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const result = wikilinkCompletion()(new CompletionContext(state, cursor, explicit))
  return result instanceof Promise ? null : result
}

/** Accept the option labelled `label` in a document with the caret at `cursor`. */
function accept(doc: string, cursor: number, label: string): { doc: string; head: number } {
  const result = complete(doc, cursor)
  const option = result?.options.find((candidate) => candidate.label === label)
  if (!result || !option || typeof option.apply !== 'function') throw new Error(`no completion "${label}" for ${JSON.stringify(doc)}`)
  const e = editor(doc, cursor)
  option.apply(e.view, option, result.from, cursor)
  return { doc: e.doc(), head: e.head() }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('accepting a note completion', () => {
  it('replaces the whole link body when the caret is in the middle of it', () => {
    seed({ 'New Note.md': 'n' })
    // "[[Old Note]]" with "Old" selected and "New" typed over it: the caret
    // sits before " Note]]", which must not survive as a tail.
    expect(accept('[[New Note]]', 5, 'New Note')).toEqual({ doc: '[[New Note]]', head: 12 })
    expect(accept('[[Ne]]', 3, 'New Note')).toEqual({ doc: '[[New Note]]', head: 12 })
  })

  it('keeps an alias, a heading or a block id that follows the name', () => {
    seed({ 'Zettelkasten.md': 'z' })
    expect(accept('[[Zet|My alias]]', 5, 'Zettelkasten')).toEqual({ doc: '[[Zettelkasten|My alias]]', head: 14 })
    expect(accept('[[Zet#Intro]]', 5, 'Zettelkasten')).toEqual({ doc: '[[Zettelkasten#Intro]]', head: 14 })
  })

  it('closes the link once, whatever closeBrackets already produced', () => {
    seed({ 'Zettelkasten.md': 'z' })
    expect(accept('[[Zet]]', 5, 'Zettelkasten')).toEqual({ doc: '[[Zettelkasten]]', head: 16 })
    expect(accept('[[Zet]', 5, 'Zettelkasten')).toEqual({ doc: '[[Zettelkasten]]', head: 16 })
    expect(accept('[[Zet', 5, 'Zettelkasten')).toEqual({ doc: '[[Zettelkasten]]', head: 16 })
  })
})

describe('what is offered', () => {
  it('does not offer tags for the heading part of [[#Heading', () => {
    seed({ 'a.md': 'text #overview here' })
    expect(useAppStore.getState().index.tags.has('overview')).toBe(true)
    expect(complete('[[#Over', 7)).toBeNull()
    // …while a tag outside a link is still offered.
    expect(complete('see #Over', 9)?.options.map((option) => option.label)).toEqual(['#overview'])
  })

  it('offers a note by its frontmatter alias, and asks the list not to filter that away', () => {
    seed({ 'Zettelkasten.md': '---\naliases:\n  - second brain\n---\n# Z' })
    const result = complete('[[brain', 7)
    expect(result?.options.map((option) => option.label)).toEqual(['Zettelkasten'])
    // The label does not resemble what was typed; the list's own filter would drop it.
    expect(result?.filter).toBe(false)
  })

  it('lists recent notes first when nothing has been typed', () => {
    seed({ 'Apple.md': 'a', 'Banana.md': 'b', 'Cherry.md': 'c' }, ['Cherry.md', 'Banana.md'])
    expect(complete('[[', 2)?.options.map((option) => option.label)).toEqual(['Cherry', 'Banana', 'Apple'])
  })

  it('reaches the reader that way through a real completion list', async () => {
    seed({ 'Zettelkasten.md': '---\naliases:\n  - second brain\n---\n# Z', 'Apple.md': 'a', 'Cherry.md': 'c' }, ['Cherry.md'])
    const mount = (doc: string): EditorView => {
      const view = new EditorView({
        state: EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [autocompletion({ override: [wikilinkCompletion()], activateOnTyping: true, icons: false })],
        }),
      })
      document.body.appendChild(view.dom)
      return view
    }
    const labels = async (view: EditorView): Promise<string[]> => {
      startCompletion(view)
      // The list opens asynchronously, and accepting is refused for a short
      // interaction delay after it does; wait for both rather than a fixed time.
      const started = Date.now()
      while (completionStatus(view.state) !== 'active' && Date.now() - started < 4_000) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
      return currentCompletions(view.state).map((completion) => completion.label)
    }
    const byAlias = mount('[[brain')
    expect(await labels(byAlias)).toEqual(['Zettelkasten'])
    acceptCompletion(byAlias)
    expect(byAlias.state.doc.toString()).toBe('[[Zettelkasten]]')
    byAlias.destroy()

    const byRecency = mount('[[')
    expect((await labels(byRecency))[0]).toBe('Cherry')
    byRecency.destroy()
  })
})
