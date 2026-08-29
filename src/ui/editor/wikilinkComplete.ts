/**
 * SpaceFore — autocompletion for `[[wiki links]]` and `#tags`.
 *
 * The source is deliberately a *single* `CompletionSource`: `[[` and `#` never
 * apply at the same cursor position, and one source means one pass over the
 * vault per keystroke.
 *
 * Ranking is `fuzzyMatch` from the search core, so the editor, the quick
 * switcher and the search panel all agree on what "good match" means.
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

import { fuzzyMatch } from '../../core/search/fuzzy'
import { basename, dirname, useAppStore } from '../../state/store'
import type { NotePath } from '../../types'

/** Never show more than this many options — the list is scrolled, not read. */
const MAX_OPTIONS = 20

/** Everything typed since `[[`, up to the cursor. */
const WIKI_CONTEXT = /\[\[[^[\]\n]*$/
/** A `#` plus the tag characters typed after it. */
const TAG_CONTEXT = /#[\p{L}\p{N}_/-]*$/u
/** The completion stays valid while the text still looks like a link body. */
const WIKI_VALID = /^[^[\]\n]*$/
const TAG_VALID = /^#[\p{L}\p{N}_/-]*$/u
/** A tag may only follow the start of a line, whitespace, or an opening bracket. */
const TAG_PREFIX = /[\s([{]/

/**
 * Insert `target` and make sure the link ends with exactly one `]]`.
 *
 * `closeBrackets` has usually already produced the closer (typing `[[` yields
 * `[[]]`), so blindly appending would leave `]]]]`. A partial `]` — from a
 * half-finished edit — is completed rather than duplicated.
 */
function applyWikiLink(view: EditorView, from: number, to: number, target: string): void {
  const doc = view.state.doc
  const after = doc.sliceString(to, Math.min(doc.length, to + 2))
  const closing = after.startsWith(']]') ? '' : after.startsWith(']') ? ']' : ']]'
  view.dispatch({
    changes: { from, to, insert: target + closing },
    // Land just past the closing brackets, ready to keep typing.
    selection: { anchor: from + target.length + 2 },
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
}

interface Scored {
  option: Completion
  score: number
}

/** Best fuzzy score of `query` against any of `candidates`, or null. */
function bestScore(query: string, candidates: readonly string[]): number | null {
  let best: number | null = null
  for (const candidate of candidates) {
    const match = fuzzyMatch(query, candidate)
    if (match && (best === null || match.score > best)) best = match.score
  }
  return best
}

function noteCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(WIKI_CONTEXT)
  if (!match) return null
  const typed = match.text.slice(2)
  // After a `|` the user is writing the display alias, not the target.
  if (typed.includes('|')) return null

  const from = match.from + 2
  const { notes, recent } = useAppStore.getState()

  // Two notes can share a basename. When they do, the label has to carry the
  // folder or the completion would insert an ambiguous link.
  const nameCounts = new Map<string, number>()
  for (const path of notes.keys()) {
    const name = basename(path).toLowerCase()
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }

  const recency = new Map<NotePath, number>()
  recent.forEach((path, i) => recency.set(path, recent.length - i))

  const scored: Scored[] = []
  for (const [path, note] of notes) {
    const name = basename(path)
    const aliases = note.parsed.frontmatter.aliases ?? []
    const ambiguous = (nameCounts.get(name.toLowerCase()) ?? 0) > 1
    const label = ambiguous ? path.replace(/\.md$/i, '') : name

    let score: number
    if (typed === '') {
      // No query yet: recent notes first, then alphabetical.
      score = recency.get(path) ?? 0
    } else {
      const best = bestScore(typed, [name, label, ...aliases])
      if (best === null) continue
      score = best
    }

    const folder = dirname(path)
    scored.push({
      score,
      option: {
        label,
        detail: folder === '' ? undefined : folder,
        type: 'text',
        apply: (view, _completion, applyFrom, applyTo) => applyWikiLink(view, applyFrom, applyTo, label),
      },
    })
  }

  if (scored.length === 0 && !context.explicit) return null

  // Ties go to the shorter label, so a root note beats a deeply nested one
  // with the same basename.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.option.label.length - b.option.label.length ||
      a.option.label.localeCompare(b.option.label),
  )
  return {
    from,
    options: scored.slice(0, MAX_OPTIONS).map((s) => s.option),
    validFor: WIKI_VALID,
  }
}

function tagCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(TAG_CONTEXT)
  if (!match) return null

  const state = context.state
  const before = match.from === 0 ? '' : state.doc.sliceString(match.from - 1, match.from)
  // `word#notatag` is not a tag, and neither is the `#` inside `[[#Heading]]`.
  if (before !== '' && !TAG_PREFIX.test(before)) return null

  const line = state.doc.lineAt(match.from)
  const typed = match.text.slice(1)
  // A bare `#` at the head of a line is someone starting a heading.
  if (typed === '' && line.text.slice(0, match.from - line.from).trim() === '') return null

  const tags = useAppStore.getState().index.tags
  const scored: Scored[] = []
  for (const [name, paths] of tags) {
    const score = typed === '' ? paths.length : (fuzzyMatch(typed, name)?.score ?? null)
    if (score === null) continue
    scored.push({
      score,
      option: {
        label: `#${name}`,
        detail: `${paths.length} note${paths.length === 1 ? '' : 's'}`,
        type: 'keyword',
      },
    })
  }

  if (scored.length === 0) return null

  scored.sort((a, b) => b.score - a.score || a.option.label.localeCompare(b.option.label))
  return {
    from: match.from,
    options: scored.slice(0, MAX_OPTIONS).map((s) => s.option),
    validFor: TAG_VALID,
  }
}

/**
 * Completion source for the markdown editor: note names after `[[`, tag names
 * after `#`. Reads the vault straight off the store so it always sees the
 * current notes without the editor having to be rebuilt.
 */
export function wikilinkCompletion(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => noteCompletions(context) ?? tagCompletions(context)
}
