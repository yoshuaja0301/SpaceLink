/**
 * SpaceFore — live markdown decorations for the CodeMirror editor.
 *
 * The editor is a *source* editor, not a WYSIWYG one: the markdown stays in the
 * document and we paint it. Two pieces live here:
 *
 * 1. `computeDecorationRanges` — a pure scanner that turns a slab of text into
 *    a flat list of {kind, from, to} descriptors. It knows nothing about
 *    CodeMirror, which is what makes it testable (and cheap to reason about).
 * 2. `markdownDecorations` — the `ViewPlugin` that runs the scanner over
 *    `view.visibleRanges` and translates the descriptors into `Decoration`s.
 *
 * Why a hand-written scanner rather than the Lezer tree? Because the two things
 * we care about most — wiki links and `#tags` — are not markdown at all, the
 * "hide the syntax unless the cursor is inside" rule needs delimiter-level
 * ranges that the tree does not hand out directly, and a line scanner over the
 * viewport is comfortably fast enough (it only ever sees the ~50 lines on
 * screen).
 */
import type { EditorState, Extension, Range, Text } from '@codemirror/state'
import { StateEffect } from '@codemirror/state'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'

/* ------------------------------------------------------------------ *
 * The pure scanner
 * ------------------------------------------------------------------ */

export type DecorationKind =
  | 'wikilink'
  | 'tag'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'code'
  | 'quote'
  | 'strikethrough'
  | 'highlight'
  | 'list-marker'
  | 'task'
  /** A delimiter (`**`, `[[`, `#`, …). Rendered dimmed, or collapsed when `hidden`. */
  | 'syntax'

export interface DecorationRange {
  kind: DecorationKind
  /** Absolute document offset. */
  from: number
  /** Exclusive absolute document offset. Equal to `from` for `heading` (a line decoration). */
  to: number
  /** 1–6, only for `kind === 'heading'`. */
  level?: number
  /** Wiki-link target / tag name — becomes `data-target` / `data-tag`. */
  value?: string
  /** True when `resolve(target)` returned null (`kind === 'wikilink'`). */
  unresolved?: boolean
  /** Current state of a `[ ]` / `[x]` marker (`kind === 'task'`). */
  checked?: boolean
  /** True when this delimiter should collapse to zero width (`kind === 'syntax'`). */
  hidden?: boolean
}

/** A selection range, in absolute document offsets. */
export interface SelectionSpan {
  from: number
  to: number
}

/** Resolves a wiki-link target to a vault path, or null when it does not exist. */
export type ResolveTarget = (target: string) => string | null

/** ```` ```lang ```` / `~~~lang` — the opening line of a fenced code block. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** `# Heading` through `###### Heading`. */
const HEADING = /^ {0,3}(#{1,6})(\s|$)/
/** One or more `>` quote markers, with optional leading indent. */
const QUOTE = /^(\s*)((?:>\s?)+)/
/** `- `, `* `, `+ `, `1. `, `1) ` — a list bullet, with its trailing space. */
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/
/** `[ ]`, `[x]` or `[X]` immediately after a bullet. */
const TASK = /^\[([ xX])\]/
/** `[[Target]]`, `[[Target|Alias]]`, `![[Embed]]`. */
const WIKILINK = /^(!?)\[\[([^[\]\n]*)\]\]/
/** A tag body: unicode letters/digits plus `_ - /`. */
const TAG_BODY = /^[\p{L}\p{N}_/-]+/u
/** `#1` is a number, not a tag. */
const ALL_DIGITS = /^\p{N}+$/u
/** Characters a tag may follow. */
const TAG_PREFIX = /[\s([{]/

const MAX_NESTING = 4

interface ScanContext {
  out: DecorationRange[]
  resolve: ResolveTarget
  /** `liveSyntaxHiding` is on. */
  hideSyntax: boolean
  /** A selection spans more than one line — nothing is hidden while that is true. */
  frozen: boolean
  /** Does [from, to] touch (or contain) any selection range? */
  touches: (from: number, to: number) => boolean
}

/**
 * Record the delimiters of one construct. They collapse (`cm-hidden-syntax`)
 * only when live syntax hiding is on, no selection touches the construct, and
 * no selection spans multiple lines — so markers pop back into view the moment
 * the caret enters them, and a big drag-selection never reflows under the mouse.
 */
function pushSyntax(ctx: ScanContext, from: number, to: number, spans: Array<[number, number]>): void {
  const hidden = ctx.hideSyntax && !ctx.frozen && !ctx.touches(from, to)
  for (const [start, end] of spans) {
    if (end > start) ctx.out.push({ kind: 'syntax', from: start, to: end, hidden })
  }
}

/** Length of the run of `ch` starting at `i`. */
function runLength(text: string, i: number, ch: string): number {
  let n = 0
  while (i + n < text.length && text[i + n] === ch) n += 1
  return n
}

/** True when `ch` is a letter, digit or underscore — used to keep `snake_case` intact. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

/**
 * Find the closing delimiter for an emphasis-style construct opened at `open`.
 * `marker` is a run of one repeated character. The closer must not be preceded
 * by whitespace (`**bold **` is not bold) and must itself be a run of exactly
 * `marker.length` for single-character markers, so `*` never eats into a `**`.
 */
function findCloser(line: string, open: number, marker: string, end: number): number {
  const ch = marker[0]!
  const len = marker.length
  for (let j = open + len; j + len <= end; j += 1) {
    if (line[j] !== ch) continue
    if (line.slice(j, j + len) !== marker) continue
    // Whitespace directly before the closer means this is not a closer.
    if (/\s/.test(line[j - 1] ?? ' ')) {
      j += runLength(line, j, ch) - 1
      continue
    }
    if (len === 1 && line[j + 1] === ch) {
      // Part of a longer run (`**`), not our single-character closer.
      j += runLength(line, j, ch) - 1
      continue
    }
    if (j === open + len) continue // empty content
    return j
  }
  return -1
}

/**
 * Scan the inline span `[start, end)` of `line`. `base` is the absolute
 * document offset of `line[0]`. Recurses into emphasis so
 * `**bold *and italic***` decorates both.
 */
function scanInline(line: string, base: number, start: number, end: number, ctx: ScanContext, depth: number): void {
  let i = start
  while (i < end) {
    const ch = line[i]!

    /* ---- inline code: highest priority, contents are opaque ------------- */
    if (ch === '`') {
      const ticks = runLength(line, i, '`')
      const fence = '`'.repeat(ticks)
      let j = -1
      for (let k = i + ticks; k + ticks <= end; k += 1) {
        if (line[k] !== '`') continue
        if (runLength(line, k, '`') !== ticks) {
          k += runLength(line, k, '`') - 1
          continue
        }
        if (line.slice(k, k + ticks) === fence) {
          j = k
          break
        }
      }
      if (j !== -1) {
        const to = j + ticks
        ctx.out.push({ kind: 'code', from: base + i, to: base + to })
        pushSyntax(ctx, base + i, base + to, [
          [base + i, base + i + ticks],
          [base + j, base + to],
        ])
        i = to
        continue
      }
      i += ticks
      continue
    }

    /* ---- wiki links / embeds -------------------------------------------- */
    if (ch === '[' || (ch === '!' && line[i + 1] === '[')) {
      const m = WIKILINK.exec(line.slice(i, end))
      if (m) {
        const raw = m[0]
        const bang = m[1]!.length
        const inner = m[2]!
        const to = i + raw.length
        const pipe = inner.indexOf('|')
        const linkPart = pipe === -1 ? inner : inner.slice(0, pipe)
        const hash = linkPart.search(/[#^]/)
        const target = (hash === -1 ? linkPart : linkPart.slice(0, hash)).trim()
        // `[[#Heading]]` points at the current note, which always exists.
        const unresolved = target !== '' && ctx.resolve(target) === null
        ctx.out.push({
          kind: 'wikilink',
          from: base + i,
          to: base + to,
          value: target,
          unresolved,
        })
        const openEnd = i + bang + 2
        const markers: Array<[number, number]> = [
          [base + i, base + openEnd],
          [base + to - 2, base + to],
        ]
        // With an alias, `Target|` is scaffolding too — collapse it so the
        // line reads as the alias alone.
        if (pipe !== -1) markers.push([base + openEnd, base + openEnd + pipe + 1])
        pushSyntax(ctx, base + i, base + to, markers)
        i = to
        continue
      }
      i += 1
      continue
    }

    /* ---- #tags ----------------------------------------------------------- */
    if (ch === '#') {
      const prev = i === 0 ? undefined : line[i - 1]
      if (prev === undefined || TAG_PREFIX.test(prev)) {
        const m = TAG_BODY.exec(line.slice(i + 1, end))
        if (m) {
          // A trailing `/` is not part of the tag: `#work/` is `work`.
          const name = m[0].replace(/\/+$/, '')
          if (name !== '' && !ALL_DIGITS.test(name)) {
            const to = i + 1 + name.length
            ctx.out.push({ kind: 'tag', from: base + i, to: base + to, value: name })
            i = to
            continue
          }
        }
      }
      i += 1
      continue
    }

    /* ---- ==highlight== and ~~strike~~ ------------------------------------ */
    if ((ch === '=' || ch === '~') && line[i + 1] === ch) {
      const marker = ch + ch
      const close = findCloser(line, i, marker, end)
      if (close !== -1) {
        const to = close + 2
        ctx.out.push({ kind: ch === '=' ? 'highlight' : 'strikethrough', from: base + i, to: base + to })
        pushSyntax(ctx, base + i, base + to, [
          [base + i, base + i + 2],
          [base + close, base + to],
        ])
        if (depth < MAX_NESTING) scanInline(line, base, i + 2, close, ctx, depth + 1)
        i = to
        continue
      }
      i += 2
      continue
    }

    /* ---- **bold** / __bold__ and *italic* / _italic_ --------------------- */
    if (ch === '*' || ch === '_') {
      const run = runLength(line, i, ch)
      if (run >= 2) {
        const marker = ch + ch
        const close = findCloser(line, i, marker, end)
        if (close !== -1) {
          const to = close + 2
          ctx.out.push({ kind: 'bold', from: base + i, to: base + to })
          pushSyntax(ctx, base + i, base + to, [
            [base + i, base + i + 2],
            [base + close, base + to],
          ])
          if (depth < MAX_NESTING) scanInline(line, base, i + 2, close, ctx, depth + 1)
          i = to
          continue
        }
        i += run
        continue
      }
      // `snake_case_name` must not turn into emphasis.
      const wordInternal = ch === '_' && isWordChar(line[i - 1])
      if (!wordInternal && !/\s/.test(line[i + 1] ?? ' ')) {
        const close = findCloser(line, i, ch, end)
        if (close !== -1 && !(ch === '_' && isWordChar(line[close + 1]))) {
          const to = close + 1
          ctx.out.push({ kind: 'italic', from: base + i, to: base + to })
          pushSyntax(ctx, base + i, base + to, [
            [base + i, base + i + 1],
            [base + close, base + to],
          ])
          if (depth < MAX_NESTING) scanInline(line, base, i + 1, close, ctx, depth + 1)
          i = to
          continue
        }
      }
      i += 1
      continue
    }

    i += 1
  }
}

/**
 * Turn `text` into decoration descriptors.
 *
 * @param text            The slab to scan. Must start at a line boundary.
 * @param from            Absolute document offset of `text[0]`.
 * @param selectionRanges Current selection, in absolute offsets.
 * @param resolve         Wiki-link resolver; `null` marks the link unresolved.
 * @param hideSyntax      The `liveSyntaxHiding` setting.
 * @param openFence       The fence marker already open at `text[0]`, if any —
 *                        the plugin supplies it when the viewport starts inside
 *                        a code block. Defaults to "not in a fence".
 * @returns Descriptors sorted by `from`.
 */
export function computeDecorationRanges(
  text: string,
  from: number,
  selectionRanges: readonly SelectionSpan[],
  resolve: ResolveTarget,
  hideSyntax: boolean,
  openFence: string | null = null,
): DecorationRange[] {
  const out: DecorationRange[] = []

  // A selection that crosses a line break freezes syntax hiding: reflowing a
  // dozen lines while the user drags is jarring, and the markers they are
  // selecting need to be visible.
  let frozen = false
  for (const range of selectionRanges) {
    if (range.to <= range.from) continue
    const start = Math.max(range.from, from) - from
    const stop = Math.min(range.to, from + text.length) - from
    if (stop > start && text.slice(start, stop).includes('\n')) {
      frozen = true
      break
    }
  }

  const ctx: ScanContext = {
    out,
    resolve,
    hideSyntax,
    frozen,
    touches: (a, b) => selectionRanges.some((r) => r.from <= b && r.to >= a),
  }

  let fence = openFence
  let lineStart = 0
  for (;;) {
    let nl = text.indexOf('\n', lineStart)
    if (nl === -1) nl = text.length
    const line = text.slice(lineStart, nl)
    const base = from + lineStart

    scanLine(line, base, fence, ctx, (next) => {
      fence = next
    })

    if (nl === text.length) break
    lineStart = nl + 1
  }

  out.sort((a, b) => a.from - b.from || a.to - b.to)
  return out
}

/** Decorate a single line, updating the fenced-code state through `setFence`. */
function scanLine(
  line: string,
  base: number,
  fence: string | null,
  ctx: ScanContext,
  setFence: (next: string | null) => void,
): void {
  const fenceMatch = FENCE.exec(line)

  if (fence !== null) {
    // Inside a fence: only a matching closing fence is meaningful, and nothing
    // in here — links, tags, emphasis — is decorated.
    if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && fenceMatch[2]!.trim() === '') {
      setFence(null)
    }
    return
  }
  if (fenceMatch) {
    setFence(fenceMatch[1]!)
    return
  }

  let cursor = 0

  /* ---- headings -------------------------------------------------------- */
  const heading = HEADING.exec(line)
  if (heading) {
    const hashes = heading[1]!
    const indent = line.length - line.trimStart().length
    ctx.out.push({ kind: 'heading', from: base, to: base, level: hashes.length })
    // The marker plus its single trailing space is scaffolding.
    const markerEnd = indent + hashes.length + (heading[2] === '' ? 0 : 1)
    pushSyntax(ctx, base, base + line.length, [[base + indent, base + markerEnd]])
    cursor = markerEnd
  }

  /* ---- blockquotes ----------------------------------------------------- */
  if (cursor === 0) {
    const quote = QUOTE.exec(line)
    if (quote) {
      const markerEnd = quote[1]!.length + quote[2]!.length
      ctx.out.push({ kind: 'quote', from: base, to: base + line.length })
      pushSyntax(ctx, base, base + line.length, [[base + quote[1]!.length, base + markerEnd]])
      cursor = markerEnd
    }
  }

  /* ---- list bullets and task checkboxes -------------------------------- */
  const bullet = BULLET.exec(line.slice(cursor))
  if (bullet) {
    const markerStart = cursor + bullet[1]!.length
    const markerEnd = markerStart + bullet[2]!.length
    ctx.out.push({ kind: 'list-marker', from: base + markerStart, to: base + markerEnd })
    cursor = markerEnd + bullet[3]!.length

    const task = TASK.exec(line.slice(cursor))
    if (task) {
      ctx.out.push({
        kind: 'task',
        from: base + cursor,
        to: base + cursor + 3,
        checked: task[1] !== ' ',
      })
      cursor += 3
    }
  }

  scanInline(line, base, cursor, line.length, ctx, 0)
}

/* ------------------------------------------------------------------ *
 * The CodeMirror plugin
 * ------------------------------------------------------------------ */

/**
 * Force a decoration rebuild. Dispatched by the editor when a setting the
 * decorations depend on (`liveSyntaxHiding`) or the vault link index changes,
 * neither of which produces a document or selection change of its own.
 */
export const refreshDecorations = StateEffect.define<null>()

export interface MarkdownDecorationsConfig {
  /** Resolve a wiki-link target to a vault path; null renders it as unresolved. */
  resolve: ResolveTarget
  /** Live read of the `liveSyntaxHiding` setting. */
  hideSyntax: () => boolean
}

const TASK_LINE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/

/** The rendered `[ ]` / `[x]` marker: a real checkbox that writes back to the doc. */
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  eq(other: TaskWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Incomplete task')
    // mousedown, not click: preventDefault keeps CodeMirror from moving the
    // caret into the replaced range before we rewrite it.
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      toggleTaskAtWidget(view, box)
    })
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Flip the `[ ]` / `[x]` marker the widget stands for, through a transaction. */
function toggleTaskAtWidget(view: EditorView, dom: HTMLElement): void {
  let pos: number
  try {
    pos = view.posAtDOM(dom)
  } catch {
    return
  }
  const line = view.state.doc.lineAt(pos)
  const match = TASK_LINE.exec(line.text)
  if (!match) return
  const at = line.from + match[1]!.length + 1
  view.dispatch({
    changes: { from: at, to: at + 1, insert: match[2] === ' ' ? 'x' : ' ' },
    userEvent: 'input.toggleTask',
  })
}

const MARK_CLASSES: Partial<Record<DecorationKind, string>> = {
  bold: 'cm-bold',
  italic: 'cm-italic',
  code: 'cm-code',
  quote: 'cm-quote',
  strikethrough: 'cm-strikethrough',
  highlight: 'cm-highlight',
  'list-marker': 'cm-list-marker',
}

const HIDDEN_SYNTAX = Decoration.mark({ class: 'cm-hidden-syntax' })
const VISIBLE_SYNTAX = Decoration.mark({ class: 'cm-syntax-marker' })

/** Translate scanner output into a CodeMirror `DecorationSet`. */
function toDecorations(ranges: readonly DecorationRange[]): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  for (const range of ranges) {
    if (range.kind === 'heading') {
      out.push(Decoration.line({ class: `cm-heading-${range.level ?? 1}` }).range(range.from))
      continue
    }
    if (range.to <= range.from) continue
    switch (range.kind) {
      case 'task':
        out.push(Decoration.replace({ widget: new TaskWidget(range.checked === true) }).range(range.from, range.to))
        break
      case 'wikilink':
        out.push(
          Decoration.mark({
            class: range.unresolved === true ? 'cm-wikilink cm-wikilink-unresolved' : 'cm-wikilink',
            attributes: { 'data-target': range.value ?? '' },
          }).range(range.from, range.to),
        )
        break
      case 'tag':
        out.push(
          Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': range.value ?? '' } }).range(range.from, range.to),
        )
        break
      case 'syntax':
        out.push((range.hidden === true ? HIDDEN_SYNTAX : VISIBLE_SYNTAX).range(range.from, range.to))
        break
      default: {
        const cls = MARK_CLASSES[range.kind]
        if (cls) out.push(Decoration.mark({ class: cls }).range(range.from, range.to))
      }
    }
  }
  return out
}

/**
 * How far back we are willing to scan to learn whether a viewport starts inside
 * a fenced code block. Notes are not log files; beyond this the (very unlikely)
 * mis-detection is worth the guaranteed constant cost per keystroke.
 */
const MAX_FENCE_LOOKBACK = 4000

/** The fence marker open at the start of `lineNumber`, or null. */
function fenceStateAt(doc: Text, lineNumber: number): string | null {
  if (lineNumber <= 1) return null
  const start = Math.max(1, lineNumber - MAX_FENCE_LOOKBACK)
  let open: string | null = null
  const iter = doc.iterLines(start, lineNumber)
  while (!iter.next().done) {
    const match = FENCE.exec(iter.value)
    if (!match) continue
    if (open === null) {
      open = match[1]!
    } else if (match[1]![0] === open[0] && match[1]!.length >= open.length && match[2]!.trim() === '') {
      open = null
    }
  }
  return open
}

function buildDecorations(view: EditorView, config: MarkdownDecorationsConfig): DecorationSet {
  const state: EditorState = view.state
  const selection = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }))
  const hideSyntax = config.hideSyntax()
  const ranges: DecorationRange[] = []

  // Only the visible ranges are scanned — the cost of a keystroke stays
  // proportional to the screen, not to the note.
  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from)
    const last = state.doc.lineAt(to)
    const text = state.doc.sliceString(first.from, last.to)
    ranges.push(
      ...computeDecorationRanges(text, first.from, selection, config.resolve, hideSyntax, fenceStateAt(state.doc, first.number)),
    )
  }

  return Decoration.set(toDecorations(ranges), true)
}

/** The live markdown decoration plugin. */
export function markdownDecorations(config: MarkdownDecorationsConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, config)
      }

      update(update: ViewUpdate): void {
        const forced = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshDecorations)))
        if (update.docChanged || update.viewportChanged || update.selectionSet || forced) {
          this.decorations = buildDecorations(update.view, config)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}
