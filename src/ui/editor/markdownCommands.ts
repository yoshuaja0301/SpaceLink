/**
 * SpaceFore — markdown editing commands.
 *
 * These are plain CodeMirror `Command`s so they can sit in a keymap, and they
 * are also what the command palette runs against `getActiveEditor()`.
 *
 * Two rules shape the implementations:
 *
 * - **Toggling is idempotent.** Running `toggleBold` twice must leave the
 *   document byte-identical. That is why every wrap command leaves the
 *   selection on the *inner* text: the second run sees the markers sitting
 *   just outside the selection and strips them.
 * - **A collapsed cursor means "the word I am on".** Wrapping nothing is
 *   almost never what the user meant; wrapping the word under the caret is.
 */
import type { ChangeSpec, EditorState, Line, SelectionRange } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import { copyLineDown, moveLineDown as cmMoveLineDown, moveLineUp as cmMoveLineUp } from '@codemirror/commands'
import type { Command, EditorView } from '@codemirror/view'

/* ------------------------------------------------------------------ *
 * The focused editor
 * ------------------------------------------------------------------ */

const editors = new Map<string, EditorView>()
let lastRegisteredPane: string | null = null

/**
 * Attach (or detach, with `null`) the editor belonging to a pane. `Editor.tsx`
 * calls this on mount, on focus and on unmount.
 */
export function registerEditor(paneId: string, view: EditorView | null): void {
  if (view === null) {
    editors.delete(paneId)
    if (lastRegisteredPane === paneId) lastRegisteredPane = null
    return
  }
  editors.set(paneId, view)
  lastRegisteredPane = paneId
}

/**
 * The editor a command should act on: whichever one has DOM focus, falling back
 * to the most recently registered/focused pane (the palette steals focus while
 * it is open, so "has focus" is usually false by the time a command runs).
 */
export function getActiveEditor(): EditorView | null {
  for (const view of editors.values()) {
    if (view.hasFocus) return view
  }
  if (lastRegisteredPane !== null) {
    const view = editors.get(lastRegisteredPane)
    if (view) return view
  }
  const first = editors.values().next()
  return first.done === true ? null : first.value
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Characters that count as "the word under the cursor". */
const WORD = /[\p{L}\p{N}_'-]/u

/** The word around `pos`, or the empty range at `pos` when there is none. */
function wordRangeAt(state: EditorState, pos: number): { from: number; to: number } {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let start = pos - line.from
  let end = start
  while (start > 0 && WORD.test(text[start - 1]!)) start -= 1
  while (end < text.length && WORD.test(text[end]!)) end += 1
  if (start === end) return { from: pos, to: pos }
  return { from: line.from + start, to: line.from + end }
}

/** Length of the run of `ch` ending just before `pos`. */
function runBefore(state: EditorState, pos: number, ch: string): number {
  let n = 0
  while (pos - n > 0 && state.doc.sliceString(pos - n - 1, pos - n) === ch) n += 1
  return n
}

/** Length of the run of `ch` starting at `pos`. */
function runAfter(state: EditorState, pos: number, ch: string): number {
  let n = 0
  const len = state.doc.length
  while (pos + n < len && state.doc.sliceString(pos + n, pos + n + 1) === ch) n += 1
  return n
}

/**
 * Build a wrap/unwrap command for a delimiter made of one repeated character
 * (`**`, `*`, `~~`, `==`, `` ` ``).
 *
 * The run-length checks are what stop `toggleItalic` from chewing a `*` off the
 * `**` of a bold span: the surrounding run has to be *exactly* as long as the
 * marker for it to count as ours.
 */
function wrapCommand(marker: string, userEvent: string): Command {
  const ch = marker[0]!
  const len = marker.length

  return (view) => {
    const state = view.state
    if (state.readOnly) return false

    view.dispatch({
      ...state.changeByRange((range) => {
        let { from, to } = range
        if (from === to) {
          const word = wordRangeAt(state, from)
          from = word.from
          to = word.to
        }

        // 1. Markers sit immediately outside the range -> unwrap them.
        if (runBefore(state, from, ch) === len && runAfter(state, to, ch) === len) {
          return {
            changes: [
              { from: from - len, to: from },
              { from: to, to: to + len },
            ],
            range: EditorSelection.range(from - len, to - len),
          }
        }

        // 2. The range itself is wrapped -> strip the markers from inside it.
        const inner = state.doc.sliceString(from, to)
        if (inner.length >= 2 * len && inner.startsWith(marker) && inner.endsWith(marker)) {
          return {
            changes: [
              { from, to: from + len },
              { from: to - len, to },
            ],
            range: EditorSelection.range(from, to - 2 * len),
          }
        }

        // 3. Otherwise wrap, leaving the selection on the content so a second
        //    run lands in case 1.
        return {
          changes: [
            { from, insert: marker },
            { from: to, insert: marker },
          ],
          range: EditorSelection.range(from + len, to + len),
        }
      }),
      scrollIntoView: true,
      userEvent,
    })
    return true
  }
}

/** Every line the selection touches, deduplicated across ranges. */
function selectedLines(state: EditorState): Line[] {
  const lines: Line[] = []
  let seen = -1
  for (const range of state.selection.ranges) {
    let pos = range.from
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos)
      if (line.number > seen) {
        lines.push(line)
        seen = line.number
      }
      if (line.to >= range.to) break
      pos = line.to + 1
    }
  }
  return lines
}

/** Apply a per-line rewrite; the selection maps through the changes. */
function editLines(view: EditorView, userEvent: string, build: (lines: Line[]) => ChangeSpec[]): boolean {
  const state = view.state
  if (state.readOnly) return false
  const changes = build(selectedLines(state))
  if (changes.length === 0) return false
  view.dispatch({ changes, scrollIntoView: true, userEvent })
  return true
}

/** Replace each selection range with text built from the selected string. */
function replaceRanges(
  view: EditorView,
  userEvent: string,
  build: (selected: string, range: SelectionRange) => { insert: string; anchor: number; head?: number },
): boolean {
  const state = view.state
  if (state.readOnly) return false
  view.dispatch({
    ...state.changeByRange((range) => {
      const selected = state.doc.sliceString(range.from, range.to)
      const { insert, anchor, head } = build(selected, range)
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(range.from + anchor, range.from + (head ?? anchor)),
      }
    }),
    scrollIntoView: true,
    userEvent,
  })
  return true
}

/* ------------------------------------------------------------------ *
 * Inline formatting
 * ------------------------------------------------------------------ */

export const toggleBold: Command = wrapCommand('**', 'input.toggleBold')
export const toggleItalic: Command = wrapCommand('*', 'input.toggleItalic')
export const toggleStrikethrough: Command = wrapCommand('~~', 'input.toggleStrikethrough')
export const toggleInlineCode: Command = wrapCommand('`', 'input.toggleInlineCode')
export const toggleHighlight: Command = wrapCommand('==', 'input.toggleHighlight')

/* ------------------------------------------------------------------ *
 * Block formatting
 * ------------------------------------------------------------------ */

const QUOTED = /^(\s*)>\s?/

/**
 * Quote or unquote the selected lines. Unquotes only when *every* non-blank
 * line is already quoted, which is what makes a second run undo the first.
 */
export const toggleBlockquote: Command = (view) =>
  editLines(view, 'input.toggleBlockquote', (lines) => {
    const meaningful = lines.filter((line) => line.text.trim() !== '')
    const source = meaningful.length > 0 ? meaningful : lines
    const allQuoted = source.every((line) => QUOTED.test(line.text))
    const changes: ChangeSpec[] = []
    for (const line of lines) {
      const match = QUOTED.exec(line.text)
      if (allQuoted) {
        if (match) changes.push({ from: line.from + match[1]!.length, to: line.from + match[0].length })
      } else if (!match) {
        changes.push({ from: line.from, insert: '> ' })
      }
    }
    return changes
  })

const TASK_MARKER = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/
const LIST_MARKER = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)/

/**
 * Flip `[ ]` <-> `[x]` on the selected lines. A list item without a checkbox
 * gains one; a plain line becomes an unchecked task.
 */
export const toggleTaskCheckbox: Command = (view) =>
  editLines(view, 'input.toggleTask', (lines) => {
    const changes: ChangeSpec[] = []
    for (const line of lines) {
      const task = TASK_MARKER.exec(line.text)
      if (task) {
        const at = line.from + task[1]!.length + 1
        changes.push({ from: at, to: at + 1, insert: task[2] === ' ' ? 'x' : ' ' })
        continue
      }
      const list = LIST_MARKER.exec(line.text)
      if (list) {
        changes.push({ from: line.from + list[1]!.length, insert: '[ ] ' })
        continue
      }
      if (line.text.trim() === '') continue
      const indent = line.text.length - line.text.trimStart().length
      changes.push({ from: line.from + indent, insert: '- [ ] ' })
    }
    return changes
  })

const HEADING_MARKER = /^(\s*)(#{1,6})\s+/

/**
 * Cycle the selected lines through `#` … `######` and back to plain text.
 * Six runs plus one returns you to where you started.
 */
export const cycleHeading: Command = (view) =>
  editLines(view, 'input.cycleHeading', (lines) => {
    const changes: ChangeSpec[] = []
    for (const line of lines) {
      const match = HEADING_MARKER.exec(line.text)
      const indent = line.text.length - line.text.trimStart().length
      if (!match) {
        if (line.text.trim() === '') continue
        changes.push({ from: line.from + indent, insert: '# ' })
        continue
      }
      const level = match[2]!.length
      const start = line.from + match[1]!.length
      const end = line.from + match[0].length
      changes.push({ from: start, to: end, insert: level >= 6 ? '' : `${'#'.repeat(level + 1)} ` })
    }
    return changes
  })

/* ------------------------------------------------------------------ *
 * Insertions
 * ------------------------------------------------------------------ */

const URL_LIKE = /^(?:https?:\/\/|mailto:|[a-z][a-z0-9+.-]*:\/\/)\S+$/i

/**
 * `[text](url)`. A selected URL becomes the destination and the caret lands in
 * the label; anything else becomes the label and the caret lands in the URL.
 */
export const insertLink: Command = (view) =>
  replaceRanges(view, 'input.insertLink', (selected) => {
    if (URL_LIKE.test(selected.trim())) {
      const url = selected.trim()
      return { insert: `[](${url})`, anchor: 1 }
    }
    return { insert: `[${selected}]()`, anchor: selected.length + 3 }
  })

/** `[[Target]]`, with the target selected so the user can type over it. */
export const insertWikiLink: Command = (view) =>
  replaceRanges(view, 'input.insertWikiLink', (selected) => ({
    insert: `[[${selected}]]`,
    anchor: 2,
    head: 2 + selected.length,
  }))

/** A 3x3 GitHub-flavoured table, placed on lines of its own. */
export const insertTable: Command = (view) => {
  const state = view.state
  if (state.readOnly) return false
  const table = ['| Column 1 | Column 2 | Column 3 |', '| --- | --- | --- |', '|  |  |  |', '|  |  |  |'].join('\n')
  view.dispatch({
    ...state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from)
      // Only break onto a new line when the current one already has content.
      const prefix = line.text.slice(0, range.from - line.from).trim() === '' ? '' : '\n'
      const suffix = line.text.slice(range.to - line.from).trim() === '' ? '' : '\n'
      const insert = prefix + table + suffix
      return {
        changes: { from: range.from, to: range.to, insert },
        // Land in the first body cell.
        range: EditorSelection.cursor(range.from + prefix.length + table.indexOf('\n|  |') + 3),
      }
    }),
    scrollIntoView: true,
    userEvent: 'input.insertTable',
  })
  return true
}

/** Fence the selection (or an empty block) in ```` ``` ````. */
export const insertCodeBlock: Command = (view) => {
  const state = view.state
  if (state.readOnly) return false
  view.dispatch({
    ...state.changeByRange((range) => {
      const selected = state.doc.sliceString(range.from, range.to)
      const line = state.doc.lineAt(range.from)
      const prefix = line.text.slice(0, range.from - line.from).trim() === '' ? '' : '\n'
      const insert = `${prefix}\`\`\`\n${selected}\n\`\`\``
      const bodyStart = range.from + prefix.length + 4
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(bodyStart, bodyStart + selected.length),
      }
    }),
    scrollIntoView: true,
    userEvent: 'input.insertCodeBlock',
  })
  return true
}

/* ------------------------------------------------------------------ *
 * Line manipulation
 *
 * CodeMirror already ships correct, selection-preserving implementations of
 * these three; re-exporting them under the names the palette uses beats
 * reimplementing the edge cases (multi-range selections, document ends).
 * ------------------------------------------------------------------ */

export const moveLineUp: Command = cmMoveLineUp
export const moveLineDown: Command = cmMoveLineDown
export const duplicateLine: Command = copyLineDown
