/**
 * SpaceLink — the `/` block menu.
 *
 * Type `/` where a block would start and pick what to write: a heading, a list,
 * a to-do, a quote, a callout, a table, a divider. It is the one interaction
 * people mean when they say a note-taking app "feels like Notion", and the
 * reason is that it removes the need to remember markup — the note on disk is
 * still `## Heading` and `- [ ] task`, exactly as if it had been typed.
 *
 * Built as a `CompletionSource`, the same shape as `[[wiki links]]` and `#tags`
 * next door, so it arrives with keyboard selection, filtering as you type and
 * dismissal already correct rather than as a bespoke popup that gets those
 * wrong. Ranking is `fuzzyMatch` from the search core, so "good match" means
 * the same thing here as in the quick switcher.
 *
 * ## Where it fires
 *
 * Only where the block is still empty: whitespace, blockquote markers, a list
 * marker and a task checkbox are lead, not writing, and anything past them is
 * somebody composing. This is the one place it deliberately parts company with
 * Notion, which opens the menu anywhere. In a Markdown editor "anywhere" means
 * every `https://`, every `and/or`, and every path in a code fence pops a menu
 * over what you are reading. A block menu that only offers blocks where a block
 * can go is the quieter trade.
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { Command } from '@codemirror/view'
import type { EditorView } from '@codemirror/view'

import { fuzzyMatch } from '../../core/search/fuzzy'
import { insertCodeBlock, insertTable } from './markdownCommands'

/** The `/` and the word typed after it. No spaces: a space ends the menu. */
const SLASH_CONTEXT = /\/[\p{L}\p{N}-]*$/u
/**
 * What may sit between the start of a line and a `/` that opens the menu.
 *
 * The rule is "the block is still empty": indentation, blockquote markers, a
 * list marker and a task checkbox are all *lead*, not writing. Once a word has
 * been typed the person is composing, and a menu over what they are reading is
 * an interruption.
 */
const BLOCK_LEAD = /^[\s>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?$/

/**
 * One entry in the menu.
 *
 * `prefix` covers everything Markdown says with a line lead — a heading, a
 * list, a quote. The few blocks that are more than a lead (a table, a fenced
 * block) hand the work to the command the palette already uses for them, so
 * there is one implementation of "insert a table" and not two.
 */
interface Block {
  label: string
  /** What it turns into, spelled the way somebody would recognise it. */
  detail: string
  /** Other words that should find it. "todo" has to find "To-do list". */
  also?: readonly string[]
  /** Text put at the head of the line. */
  prefix?: string
  /** Used instead of `prefix` when the block is more than a line lead. */
  command?: Command
}

const BLOCKS: readonly Block[] = [
  { label: 'Heading 1', detail: '#', prefix: '# ', also: ['h1', 'title'] },
  { label: 'Heading 2', detail: '##', prefix: '## ', also: ['h2'] },
  { label: 'Heading 3', detail: '###', prefix: '### ', also: ['h3'] },
  { label: 'Bulleted list', detail: '-', prefix: '- ', also: ['bullet', 'ul', 'unordered'] },
  { label: 'Numbered list', detail: '1.', prefix: '1. ', also: ['ol', 'ordered'] },
  { label: 'To-do list', detail: '- [ ]', prefix: '- [ ] ', also: ['todo', 'task', 'checkbox'] },
  { label: 'Quote', detail: '>', prefix: '> ', also: ['blockquote'] },
  { label: 'Callout', detail: '> [!note]', prefix: '> [!note] ', also: ['note', 'admonition', 'aside'] },
  { label: 'Toggle callout', detail: '> [!note]-', prefix: '> [!note]- ', also: ['fold', 'collapse', 'details'] },
  { label: 'Code block', detail: '```', command: insertCodeBlock, also: ['fence', 'snippet'] },
  { label: 'Table', detail: '| — |', command: insertTable, also: ['grid', 'columns'] },
  { label: 'Divider', detail: '---', prefix: '---\n', also: ['hr', 'rule', 'separator'] },
  { label: 'Link to a note', detail: '[[ ]]', prefix: '[[', also: ['wikilink', 'wiki', 'mention'] },
]

/**
 * Take the `/query` away, then write the block.
 *
 * In that order, and as two dispatches on purpose: the commands below are the
 * palette's own and they read the line they are on to decide whether to break
 * onto a new one. Left in place, the `/table` would still be sitting there and
 * they would push the table onto the line beneath it.
 */
function applyBlock(block: Block, view: EditorView, from: number, to: number): void {
  view.dispatch({
    changes: { from, to, insert: block.prefix ?? '' },
    selection: { anchor: from + (block.prefix?.length ?? 0) },
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  block.command?.(view)
}

/** The best fuzzy score for `query` across a block's names, or null. */
function score(query: string, block: Block): number | null {
  let best: number | null = null
  for (const candidate of [block.label, ...(block.also ?? [])]) {
    const match = fuzzyMatch(query, candidate)
    if (match && (best === null || match.score > best)) best = match.score
  }
  return best
}

/**
 * Completion source for the `/` block menu.
 */
export function slashCompletion(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(SLASH_CONTEXT)
    if (!match) return null

    // Everything before the `/` on this line has to be block lead, or this is
    // a slash in prose and not a menu.
    const line = context.state.doc.lineAt(match.from)
    if (!BLOCK_LEAD.test(line.text.slice(0, match.from - line.from))) return null

    const typed = match.text.slice(1)
    const options: Completion[] = []
    const ranked: { option: Completion; rank: number }[] = []
    for (const block of BLOCKS) {
      const rank = typed === '' ? 0 : score(typed, block)
      if (rank === null) continue
      ranked.push({
        rank,
        option: {
          label: block.label,
          detail: block.detail,
          type: 'keyword',
          apply: (view, _completion, from, to) => applyBlock(block, view, from, to),
        },
      })
    }
    if (ranked.length === 0) return null

    // With nothing typed the order is the list above — headings, then lists,
    // then the rest — which is the order somebody scanning the menu expects.
    // Once they type, it is the fuzzy score.
    if (typed !== '') ranked.sort((a, b) => b.rank - a.rank || a.option.label.localeCompare(b.option.label))
    options.push(...ranked.map((entry) => entry.option))

    return {
      from: match.from,
      options,
      // The ranking above *is* the order. Left to its own filter, CodeMirror
      // would drop "To-do list" for the query "todo" — it matches an alias the
      // label does not contain — and re-alphabetise the rest.
      filter: false,
    }
  }
}
