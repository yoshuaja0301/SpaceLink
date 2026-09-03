/**
 * SpaceLink — markdown parsing.
 *
 * This module turns raw note text into the structured `ParsedNote` every other
 * feature reads. It is deliberately hand-written rather than built on a
 * markdown AST: we need *exact character offsets* into the original source so
 * the editor can jump to a link, the graph can quote the source line and the
 * renderer can line up with what the user typed.
 *
 * ## How offsets stay exact
 *
 * Everything that must be ignored — fenced code blocks, inline code spans,
 * HTML comments and `$$…$$` math — is blanked out in a *mask*: a copy of the
 * body with those regions replaced by spaces (newlines are preserved so line
 * numbers and line-anchored patterns still work). Every extractor matches
 * against the mask but slices its `raw` text out of the original string, so
 * `source.slice(item.start, item.end) === item.raw` always holds.
 *
 * ## Line numbers
 *
 * The extractors receive only `(body, bodyOffset)`. A character offset cannot
 * tell us how many *lines* the frontmatter occupied, so the extractors report
 * `line` 1-based **within `body`**, and `parseNote` shifts every line by the
 * number of frontmatter lines it stripped. The line numbers on a `ParsedNote`
 * therefore index the original source, exactly like the offsets do.
 *
 * ## Cost
 *
 * `parseNote` runs a small, fixed number of linear passes: one mask build
 * (shared by all five extractors through a one-entry cache), one line-index
 * build, and one scan per extractor. None of the regexes below contain nested
 * quantifiers over the same character set, so none of them can backtrack
 * catastrophically — and none of them may restart a scan from every `[`
 * either, which is the cheaper-looking way to end up quadratic.
 */
import type {
  HeadingRef,
  MarkdownLink,
  NoteFrontmatter,
  ParsedNote,
  TagRef,
  TaskRef,
  WikiLink,
} from '../../types'

/* ------------------------------------------------------------------ *
 * Masking
 * ------------------------------------------------------------------ */

/** Replace `[start, end)` with spaces, keeping line breaks intact. */
function blank(chars: string[], start: number, end: number): void {
  const from = Math.max(0, start)
  const to = Math.min(chars.length, end)
  for (let i = from; i < to; i += 1) {
    const c = chars[i]
    if (c !== '\n' && c !== '\r') chars[i] = ' '
  }
}

/** `indexOf` for a literal needle inside a character array. */
function indexOfSeq(chars: string[], needle: string, from: number): number {
  const n = chars.length
  const m = needle.length
  outer: for (let i = Math.max(0, from); i + m <= n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (chars[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** Is the character at `k` whitespace, or is `k` past the end? */
function blankAt(chars: string[], k: number): boolean {
  return k >= chars.length || chars[k] === ' ' || chars[k] === '\t' || chars[k] === '\n' || chars[k] === '\r'
}

/** Does the text starting at `j` (first non-blank of a line) open a new block? */
function startsBlock(chars: string[], j: number): boolean {
  const c = chars[j]
  if (c === '>') return true
  if (c === '-' || c === '+' || c === '*') return blankAt(chars, j + 1)
  if (c === '`' || c === '~') return chars[j + 1] === c && chars[j + 2] === c
  if (c === '#') {
    let k = j
    while (k < chars.length && chars[k] === '#' && k - j < 6) k += 1
    return blankAt(chars, k)
  }
  if (c !== undefined && c >= '0' && c <= '9') {
    let k = j
    while (k < chars.length && (chars[k] as string) >= '0' && (chars[k] as string) <= '9' && k - j < 9) k += 1
    return (chars[k] === '.' || chars[k] === ')') && blankAt(chars, k + 1)
  }
  return false
}

/**
 * True when a code span from `start` to `end` would cross into a line that
 * starts a new block: a blank line, a heading, a list item, a blockquote or a
 * fence. A span may run on to the next line of its own paragraph, but not out
 * of the paragraph — `- use ` for code` and `- and ` there` are two list items
 * with a backtick each, not one code span hiding everything between them.
 */
function crossesBlockBoundary(chars: string[], start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (chars[i] !== '\n') continue
    let j = i + 1
    while (j < chars.length && (chars[j] === ' ' || chars[j] === '\t')) j += 1
    if (blankAt(chars, j) || startsBlock(chars, j)) return true
  }
  return false
}

// The optional list marker: `- ```js` opens a fence on the bullet line, and the
// reading view shows a code block for it. Its indent is the fence's column.
const FENCE_OPEN = /^([ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/

interface Fence {
  marker: string
  len: number
  indent: number
}

/**
 * The fence `line` opens, or null.
 *
 * Indentation is deliberately *not* capped at three columns: markdown-it
 * measures a fence's indent relative to the enclosing block, so a `~~~` inside
 * a list item opens a real code block even though it starts in column four.
 */
function openFence(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line)
  const marker = m?.[2]
  // A backtick fence's info string may not itself contain a backtick,
  // which is what keeps `` `a` `` from opening a fence.
  if (!m || !marker || (marker[0] === '`' && m[3]!.includes('`'))) return null
  return { marker: marker[0]!, len: marker.length, indent: m[1]!.length }
}

/** Does `line` close `fence`? A closer may not be indented past its opener. */
function closesFence(line: string, fence: Fence): boolean {
  const m = FENCE_CLOSE.exec(line)
  const marker = m?.[2]
  if (!m || !marker) return false
  if (marker[0] !== fence.marker || marker.length < fence.len) return false
  return m[1]!.length <= Math.max(fence.indent, 3)
}

/** Drop a trailing `\r` so CRLF files behave like LF files. */
function chomp(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** True when nothing but up to three spaces precedes `offset` on its line. */
function atBlockStart(text: string, offset: number): boolean {
  let i = offset - 1
  let indent = 0
  while (i >= 0 && text[i] === ' ') {
    indent += 1
    i -= 1
  }
  return indent <= 3 && (i < 0 || text[i] === '\n')
}

/**
 * Build the inert-region mask for `body`.
 *
 * Pass 1 walks lines and blanks fenced code blocks (``` and ~~~, with or
 * without an info string; an unclosed fence runs to the end of the note).
 * Pass 2 walks what survives and blanks inline code spans, HTML comments and
 * `$$…$$` math blocks.
 */
function buildMask(body: string): string {
  const n = body.length
  const out = body.split('')

  /* ---- pass 1: fenced code blocks ---------------------------------- */
  let lineStart = 0
  let fence: (Fence & { start: number }) | null = null
  while (lineStart <= n) {
    let lineEnd = body.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = n
    const line = chomp(body.slice(lineStart, lineEnd))

    if (fence) {
      if (closesFence(line, fence)) {
        blank(out, fence.start, lineEnd)
        fence = null
      }
    } else {
      const open = openFence(line)
      if (open) fence = { ...open, start: lineStart }
    }

    if (lineEnd === n) break
    lineStart = lineEnd + 1
  }
  if (fence) blank(out, fence.start, n)

  /* ---- pass 2: inline code, comments, block math -------------------- */
  let moreComments = true
  let i = 0
  while (i < n) {
    const c = out[i]
    if (c === '`') {
      let run = 1
      while (i + run < n && out[i + run] === '`') run += 1
      // CommonMark: the closing run must be *exactly* as long as the opener.
      let j = i + run
      let close = -1
      while (j < n) {
        if (out[j] === '`') {
          let r = 1
          while (j + r < n && out[j + r] === '`') r += 1
          if (r === run) {
            close = j + r
            break
          }
          j += r
        } else {
          j += 1
        }
      }
      if (close !== -1 && !crossesBlockBoundary(out, i, close)) {
        blank(out, i, close)
        i = close
      } else {
        i += run
      }
    } else if (c === '<' && out[i + 1] === '!' && out[i + 2] === '-' && out[i + 3] === '-') {
      // Once no `-->` follows, none follows any later `<!--` either: every
      // region we blank is behind us, so the tail can only lose delimiters.
      const idx = moreComments ? indexOfSeq(out, '-->', i + 4) : -1
      if (idx !== -1) {
        blank(out, i, idx + 3)
        i = idx + 3
      } else {
        moreComments = false
        // markdown-it only lets an unterminated comment swallow the rest of the
        // note when it opens a block; mid-line it is ordinary text. Masking to
        // the end there would hide every link, tag and heading below a stray
        // `<!--` from the index while the reading view still shows them.
        if (atBlockStart(body, i)) {
          blank(out, i, n)
          i = n
        } else {
          i += 4
        }
      }
    } else if (c === '$' && out[i + 1] === '$') {
      const idx = indexOfSeq(out, '$$', i + 2)
      if (idx === -1) {
        i += 2
      } else {
        blank(out, i, idx + 2)
        i = idx + 2
      }
    } else {
      i += 1
    }
  }

  return out.join('')
}

interface ScanContext {
  readonly body: string
  readonly mask: string
  readonly lineStarts: number[]
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/**
 * One-entry memo. `parseNote` calls all five extractors back-to-back with the
 * same string instance, so this collapses five mask builds into one while
 * keeping every extractor usable standalone.
 */
let contextCache: ScanContext | null = null

function getContext(body: string): ScanContext {
  if (contextCache && contextCache.body === body) return contextCache
  const ctx: ScanContext = { body, mask: buildMask(body), lineStarts: computeLineStarts(body) }
  contextCache = ctx
  return ctx
}

/** 1-based line number of `offset`, via binary search over the line starts. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/* ------------------------------------------------------------------ *
 * Wiki links
 * ------------------------------------------------------------------ */

/** `[[Target#Heading|Alias]]` / `![[Embed]]`. Never spans a line break. */
function wikiLinkRegex(): RegExp {
  return /(!?)\[\[([^[\]\n]*)\]\]/g
}

/** Is the character at `at` preceded by an odd run of backslashes? */
function isEscaped(text: string, at: number): boolean {
  let backslashes = 0
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1
  return backslashes % 2 === 1
}

export function extractWikiLinks(body: string, bodyOffset: number): WikiLink[] {
  const { mask, lineStarts } = getContext(body)
  const re = wikiLinkRegex()
  const out: WikiLink[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(mask)) !== null) {
    // `\[[Not A Link]]` is literal text in the reading view: the backslash
    // escapes the bracket. (An escaped backslash, `\\[[x]]`, escapes nothing.)
    if (isEscaped(mask, m.index + m[1]!.length)) continue
    const inner = m[2]!
    const pipe = inner.indexOf('|')
    const linkPart = pipe === -1 ? inner : inner.slice(0, pipe)
    const aliasPart = pipe === -1 ? '' : inner.slice(pipe + 1).trim()

    let target = linkPart
    let heading: string | undefined
    let blockId: string | undefined

    const hash = linkPart.indexOf('#')
    if (hash !== -1) {
      target = linkPart.slice(0, hash)
      const fragment = linkPart.slice(hash + 1).trim()
      if (fragment.startsWith('^')) {
        const id = fragment.slice(1).trim()
        if (id) blockId = id
      } else if (fragment) {
        heading = fragment
      }
    }
    target = target.trim()

    // `[[]]`, `[[ ]]` and `[[|x]]` are not links.
    if (!target && !heading && !blockId) continue

    const start = m.index
    const end = re.lastIndex
    const link: WikiLink = {
      raw: body.slice(start, end),
      target,
      embed: m[1] === '!',
      start: start + bodyOffset,
      end: end + bodyOffset,
      line: lineAt(lineStarts, start),
    }
    if (heading !== undefined) link.heading = heading
    if (blockId !== undefined) link.blockId = blockId
    if (aliasPart) link.alias = aliasPart
    out.push(link)
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Markdown links
 * ------------------------------------------------------------------ */

/** A url is external when it carries a scheme (`https:`, `mailto:`, …) or is protocol-relative. */
const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i

function isInternalUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return false
  return !EXTERNAL_URL.test(trimmed)
}

/**
 * For every `[` in `mask`, the `]` that closes it, or -1.
 *
 * One stack pass rather than a bracket walk from each `[`: a `]` pairs with the
 * most recent unclosed `[`, which is exactly where a walk's depth counter would
 * reach zero. Walking from every `[` cost one scan *per* bracket, so a line of
 * stray `[` — a pasted array or LaTeX fragment — made parsing quadratic.
 */
function matchBrackets(mask: string): Int32Array {
  const close = new Int32Array(mask.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < mask.length; i += 1) {
    const c = mask[i]
    if (c === '\\') {
      i += 1
    } else if (c === '\n') {
      open.length = 0 // link text never spans a line break
    } else if (c === '[') {
      open.push(i)
    } else if (c === ']') {
      const from = open.pop()
      if (from !== undefined) close[from] = i
    }
  }
  return close
}

/**
 * `[text](url)`, `[text](<url with spaces>)` and `[text](url "title")`.
 *
 * Image syntax (`![alt](src)`) and wiki links are deliberately skipped —
 * `MarkdownLink` has no way to express "this is an embed", and wiki links are
 * reported by `extractWikiLinks`.
 */
export function extractMarkdownLinks(body: string, bodyOffset: number): MarkdownLink[] {
  const { mask, lineStarts } = getContext(body)
  const n = mask.length
  const out: MarkdownLink[] = []
  const wikiAt = /\[\[[^[\]\n]*\]\]/y
  const closeOf = matchBrackets(mask)
  // Every link ends in `)`, so once the last one is behind us there is nothing
  // left to find — and no reason to re-scan the tail from every `[`.
  const lastParen = mask.lastIndexOf(')')

  let i = 0
  while (i <= lastParen) {
    if (mask[i] !== '[') {
      i += 1
      continue
    }
    // `![...]` is an image, not a link.
    if (i > 0 && mask[i - 1] === '!') {
      i += 1
      continue
    }
    // Step over `[[wiki links]]` so `[[A]](b)` is not read as a markdown link.
    if (mask[i + 1] === '[') {
      wikiAt.lastIndex = i
      const w = wikiAt.exec(mask)
      if (w) {
        i = wikiAt.lastIndex
        continue
      }
    }

    // --- link text, tracking nested brackets, single line only ---------
    const textEnd = closeOf[i]!
    if (textEnd === -1 || mask[textEnd + 1] !== '(') {
      i += 1
      continue
    }

    // --- destination ---------------------------------------------------
    let k = textEnd + 2
    while (k < n && (mask[k] === ' ' || mask[k] === '\t')) k += 1

    let url: string
    let ok = true
    if (mask[k] === '<') {
      let gt = -1
      for (let j = k + 1; j < n; j += 1) {
        const c = mask[j]
        if (c === '\n') break
        if (c === '>') {
          gt = j
          break
        }
      }
      if (gt === -1) {
        ok = false
        url = ''
      } else {
        url = body.slice(k + 1, gt)
        k = gt + 1
      }
    } else {
      const from = k
      let parens = 0
      while (k < n) {
        const c = mask[k]
        if (c === '\\') {
          k += 2
          continue
        }
        if (c === ' ' || c === '\t' || c === '\n') break
        if (c === '(') {
          parens += 1
          k += 1
          continue
        }
        if (c === ')') {
          if (parens === 0) break
          parens -= 1
          k += 1
          continue
        }
        k += 1
      }
      url = body.slice(from, Math.min(k, n))
    }

    // --- optional title ------------------------------------------------
    if (ok) {
      while (k < n && (mask[k] === ' ' || mask[k] === '\t')) k += 1
      const q = mask[k]
      if (q === '"' || q === "'" || q === '(') {
        const closer = q === '(' ? ')' : q
        const close = mask.indexOf(closer, k + 1)
        if (close === -1) ok = false
        else k = close + 1
      }
      while (k < n && (mask[k] === ' ' || mask[k] === '\t')) k += 1
      if (mask[k] !== ')') ok = false
    }
    if (!ok) {
      i += 1
      continue
    }

    const end = k + 1
    out.push({
      raw: body.slice(i, end),
      text: body.slice(i + 1, textEnd),
      url,
      internal: isInternalUrl(url),
      start: i + bodyOffset,
      end: end + bodyOffset,
      line: lineAt(lineStarts, i),
    })
    i = end
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

/**
 * `#tag`. The name class excludes `.,):;!?` so trailing punctuation naturally
 * falls outside the tag.
 */
function tagRegex(): RegExp {
  return /#[\p{L}\p{N}_/-]+/gu
}

/**
 * A `#` opens a tag unless it is glued to the end of a word or a url — the
 * same admission rule as `TAG_BLOCKED_PREFIX` in render.ts, which is what lets
 * `**#tag**` be a tag in the reading view *and* in the index.
 */
const TAG_BLOCKED_PREFIX = /[\p{L}\p{N}/\\.\-&=?%#]/u

const ALL_DIGITS = /^\p{N}+$/u

export function extractTags(body: string, bodyOffset: number): TagRef[] {
  const { mask, lineStarts } = getContext(body)

  // `[[#Heading]]` and `[[Note|#x]]` are wiki links, not tags — collect the
  // wiki-link spans once so we can skip anything landing inside one.
  const wikiSpans: Array<[number, number]> = []
  const wiki = wikiLinkRegex()
  let w: RegExpExecArray | null
  while ((w = wiki.exec(mask)) !== null) wikiSpans.push([w.index, wiki.lastIndex])

  let spanCursor = 0
  const insideWikiLink = (offset: number): boolean => {
    while (spanCursor < wikiSpans.length && wikiSpans[spanCursor]![1] <= offset) spanCursor += 1
    const span = wikiSpans[spanCursor]
    return span !== undefined && offset >= span[0] && offset < span[1]
  }

  const re = tagRegex()
  const out: TagRef[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(mask)) !== null) {
    const hash = m.index
    const prefix = hash === 0 ? '' : mask[hash - 1]!
    if (prefix !== '' && TAG_BLOCKED_PREFIX.test(prefix)) continue

    // A dangling separator cannot end a tag: `#work/` is the tag `work`.
    const tag = m[0]!.slice(1).replace(/[-/_]+$/, '')
    if (!tag) continue
    // `#1` is a number, not a tag.
    if (ALL_DIGITS.test(tag)) continue
    // `[label](#anchor)` is a link destination, not a tag.
    if (prefix === '(' && mask[hash - 2] === ']') continue
    if (insideWikiLink(hash)) continue

    out.push({
      tag,
      start: hash + bodyOffset,
      end: hash + 1 + tag.length + bodyOffset,
      line: lineAt(lineStarts, hash),
    })
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Headings
 * ------------------------------------------------------------------ */

const ATX = /^( {0,3})(#{1,6})(?:[ \t]+(.*))?$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntity(code: string): string {
  if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? ''
  const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
}

/**
 * The id-safe form of a heading's text. This is *the* slug: the renderer puts
 * it on the heading (see `headingElementId`), the outline and the palette look
 * headings up by it, and `[[Note#Heading]]` resolves through it — so it works
 * from the heading's source text, not from what it renders to, and strips the
 * inline syntax a reader would not think of as part of the heading's name.
 */
export function slugifyHeading(text: string): string {
  return text
    .replace(/!?\[\[([^[\]\n]*)\]\]/g, (_m, inner: string) => wikiDisplay(inner))
    .replace(/!?\[([^[\]\n]*)\]\([^[)\n]*\)/g, '$1')
    // Inline HTML is not heading text, and an entity stands for one character.
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_m, code: string) => decodeEntity(code))
    // Emphasis underscores: `_em_ text` is "em text". The underscores inside a
    // word (snake_case) stay.
    .replace(/(^|\s)_+/g, '$1')
    .replace(/_+(?=\s|$)/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The `id` the renderer puts on the heading with `slug`. It is not the bare
 * slug: DOMPurify drops an id that names a property of `document` or of a form
 * (`links`, `body`, `title`, `images`, `style`, …), so `## Links` would render
 * with no id at all and nothing could scroll to it — and any id becomes a
 * global on `window`, where `## Process` would shadow the `process` that
 * bundled libraries test for. A prefix keeps every heading reachable and no
 * heading a name.
 */
export function headingElementId(slug: string): string {
  return `h-${slug}`
}

/** The slug behind an id `headingElementId` produced; '' for any other id. */
export function slugOfHeadingId(id: string): string {
  return id.startsWith('h-') ? id.slice(2) : ''
}

/** Could `line` be the text of a setext heading? */
function isSetextCandidate(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  if (ATX.test(line)) return false
  if (SETEXT.test(line)) return false
  if (LIST_MARKER.test(line)) return false
  if (/^ {0,3}>/.test(line)) return false
  if (/^ {0,3}\|/.test(line)) return false
  return true
}

export function extractHeadings(body: string, bodyOffset: number): HeadingRef[] {
  const { mask, lineStarts } = getContext(body)
  const out: HeadingRef[] = []
  const slugCounts = new Map<string, number>()

  const push = (level: number, rawText: string, start: number, line: number): void => {
    // A setext heading's text can run over several lines.
    const text = rawText.trim().replace(/[ \t]*\r?\n[ \t]*/g, ' ')
    const base = slugifyHeading(text)
    // A heading with no slug gets no id from the renderer, so it stays out of
    // the `-2`/`-3` numbering too.
    const seen = base === '' ? 0 : (slugCounts.get(base) ?? 0)
    if (base !== '') slugCounts.set(base, seen + 1)
    out.push({
      level,
      text,
      slug: seen === 0 ? base : `${base}-${seen + 1}`,
      start: start + bodyOffset,
      line,
    })
  }

  /**
   * The run of lines above the current one that an underline would turn into
   * a setext heading — all of them, since a paragraph of several lines is one
   * heading. The masked text drove the structural tests; `start`/`end` slice
   * the real text.
   */
  let run: { start: number; end: number; line: number } | null = null

  for (let li = 0; li < lineStarts.length; li += 1) {
    const lineStart = lineStarts[li]!
    const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1]! - 1 : mask.length
    const line = chomp(mask.slice(lineStart, lineEnd))
    const lineNo = li + 1

    const atx = ATX.exec(line)
    if (atx) {
      // The text is sliced out of the *original* body so masked inline code
      // survives — from the first non-blank after the `#`s, found in the body
      // rather than in the mask, where a code span at the start of the heading
      // is blanks the regex would have skipped along with the real ones.
      const lineLimit = lineStart + line.length
      let textStart = lineStart + atx[1]!.length + atx[2]!.length
      while (textStart < lineLimit && (body[textStart] === ' ' || body[textStart] === '\t')) textStart += 1
      // Drop an optional closing sequence: `## Title ##`.
      const raw = body.slice(textStart, lineLimit).replace(/(^|[ \t])#+[ \t]*$/, '$1')
      push(atx[2]!.length, raw, lineStart + atx[1]!.length, lineNo)
      run = null
      continue
    }

    const setext = SETEXT.exec(line)
    if (setext && run) {
      push(setext[1]!.startsWith('=') ? 1 : 2, body.slice(run.start, run.end), run.start, run.line)
      run = null
      continue
    }

    if (isSetextCandidate(line)) {
      if (run) run.end = lineStart + line.length
      else run = { start: lineStart, end: lineStart + line.length, line: lineNo }
    } else {
      run = null
    }
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

const TASK = /^([ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)\[([ xX])\](?=[ \t]|$)(.*)$/

export function extractTasks(body: string, bodyOffset: number): TaskRef[] {
  const { mask, lineStarts } = getContext(body)
  const out: TaskRef[] = []

  for (let li = 0; li < lineStarts.length; li += 1) {
    const lineStart = lineStarts[li]!
    const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1]! - 1 : mask.length
    const line = chomp(mask.slice(lineStart, lineEnd))
    const m = TASK.exec(line)
    if (!m) continue
    const markerStart = lineStart + m[1]!.length
    out.push({
      checked: m[2] !== ' ',
      // Slice the display text from the original body: the mask may have
      // blanked inline code inside the task.
      text: body.slice(markerStart + 3, lineStart + line.length).trim(),
      line: li + 1,
      start: markerStart + bodyOffset,
    })
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Frontmatter
 * ------------------------------------------------------------------ */

const FM_FENCE = /^---[ \t]*$/
const FM_CLOSE = /^(?:-{3}|\.{3})[ \t]*$/

/** Locate the frontmatter block without paying for the YAML parse. */
function findFrontmatter(source: string): { raw: string; body: string; bodyOffset: number } {
  const none = { raw: '', body: source, bodyOffset: 0 }

  const firstEnd = source.indexOf('\n')
  if (firstEnd === -1) return none
  if (!FM_FENCE.test(chomp(source.slice(0, firstEnd)))) return none

  const openEnd = firstEnd + 1
  let pos = openEnd
  while (pos <= source.length) {
    let end = source.indexOf('\n', pos)
    const hasNewline = end !== -1
    if (!hasNewline) end = source.length
    if (FM_CLOSE.test(chomp(source.slice(pos, end)))) {
      const raw = source.slice(openEnd, pos).replace(/\r?\n$/, '')
      const bodyOffset = hasNewline ? end + 1 : source.length
      return { raw, body: source.slice(bodyOffset), bodyOffset }
    }
    if (!hasNewline) break
    pos = end + 1
  }
  return none
}

interface YamlLine {
  indent: number
  text: string
}

const MAX_YAML_DEPTH = 6

function toYamlLines(raw: string): YamlLine[] {
  const out: YamlLine[] = []
  for (const source of raw.split('\n')) {
    const line = chomp(source).replace(/\t/g, '  ')
    if (line.trim() === '') continue
    const stripped = line.replace(/^ +/, '')
    if (stripped.startsWith('#')) continue // whole-line comment
    out.push({ indent: line.length - stripped.length, text: stripped })
  }
  return out
}

/** Remove a trailing ` # comment`, ignoring `#` inside quotes or brackets. */
function stripComment(input: string): string {
  if (input.startsWith('#')) return ''
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '[' || c === '{') depth += 1
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (c === '#' && depth === 0 && (input[i - 1] === ' ' || input[i - 1] === '\t')) {
      return input.slice(0, i).trimEnd()
    }
  }
  return input
}

function unquote(input: string): string {
  if (input.length >= 2 && input[0] === '"' && input.endsWith('"')) {
    return input.slice(1, -1).replace(/\\(["\\nrt])/g, (_m, c: string) => {
      if (c === 'n') return '\n'
      if (c === 'r') return '\r'
      if (c === 't') return '\t'
      return c
    })
  }
  if (input.length >= 2 && input[0] === "'" && input.endsWith("'")) {
    return input.slice(1, -1).replace(/''/g, "'")
  }
  return input
}

/** Split `a, b, [c, d]` on top-level commas. */
function splitInline(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i]!
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth += 1
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
  }
  parts.push(input.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

/** `key: rest`, where the colon must be followed by whitespace or end-of-line. */
function splitKey(text: string): { key: string; rest: string } | null {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      const key = unquote(text.slice(0, i).trim())
      if (!key) return null
      return { key, rest: stripComment(text.slice(i + 1).trim()) }
    }
  }
  return null
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

function parseScalar(input: string): unknown {
  const s = input.trim()
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return null
  if (s.toLowerCase() === 'true') return true
  if (s.toLowerCase() === 'false') return false
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.length >= 2) return unquote(s)
  }
  if (s.startsWith('[') && s.endsWith(']')) return splitInline(s.slice(1, -1)).map((p) => parseScalar(p))
  if (s.startsWith('{') && s.endsWith('}')) {
    const obj: Record<string, unknown> = {}
    for (const part of splitInline(s.slice(1, -1))) {
      const kv = splitKey(part)
      if (kv) obj[kv.key] = parseScalar(kv.rest)
      else obj[unquote(part)] = null
    }
    return obj
  }
  if (NUMBER.test(s)) {
    const value = Number(s)
    if (Number.isFinite(value)) return value
  }
  return s
}

const BLOCK_SCALAR = /^[|>][-+]?$/

function isSequenceLine(text: string): boolean {
  return text === '-' || text.startsWith('- ')
}

function parseNode(lines: YamlLine[], from: number, indent: number, depth: number): { value: unknown; next: number } {
  const line = lines[from]
  if (line && isSequenceLine(line.text)) return parseSequence(lines, from, indent, depth)
  return parseMapping(lines, from, indent, depth)
}

function parseMapping(
  lines: YamlLine[],
  from: number,
  indent: number,
  depth: number,
): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {}
  let i = from

  while (i < lines.length) {
    const before = i
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) {
      // Orphaned deeper line (malformed) — ignore rather than throw.
      i += 1
      continue
    }
    if (isSequenceLine(line.text)) break

    const kv = splitKey(line.text)
    if (!kv) {
      i += 1
      continue
    }
    i += 1

    if (kv.rest !== '') {
      if (BLOCK_SCALAR.test(kv.rest)) {
        const joiner = kv.rest[0] === '>' ? ' ' : '\n'
        const parts: string[] = []
        while (i < lines.length && lines[i]!.indent > indent) {
          parts.push(lines[i]!.text)
          i += 1
        }
        obj[kv.key] = parts.join(joiner)
      } else {
        obj[kv.key] = parseScalar(kv.rest)
      }
      continue
    }

    // Value lives on the following, more-indented lines (or a block list at
    // the same indent, which YAML also allows).
    const next = lines[i]
    if (next && depth < MAX_YAML_DEPTH && next.indent > indent) {
      const child = parseNode(lines, i, next.indent, depth + 1)
      obj[kv.key] = child.value
      i = child.next
    } else if (next && depth < MAX_YAML_DEPTH && next.indent === indent && isSequenceLine(next.text)) {
      const child = parseSequence(lines, i, indent, depth + 1)
      obj[kv.key] = child.value
      i = child.next
    } else {
      obj[kv.key] = null
    }

    if (i === before) i += 1 // defensive: never stall on malformed input
  }

  return { value: obj, next: i }
}

function parseSequence(lines: YamlLine[], from: number, indent: number, depth: number): { value: unknown[]; next: number } {
  const arr: unknown[] = []
  let i = from

  while (i < lines.length) {
    const before = i
    const line = lines[i]!
    if (line.indent !== indent || !isSequenceLine(line.text)) break

    const rest = line.text === '-' ? '' : stripComment(line.text.slice(2).trim())
    i += 1

    const deeper: YamlLine[] = []
    while (i < lines.length && lines[i]!.indent > indent) {
      deeper.push(lines[i]!)
      i += 1
    }

    if (rest === '') {
      if (deeper.length > 0 && depth < MAX_YAML_DEPTH) {
        arr.push(parseNode(deeper, 0, deeper[0]!.indent, depth + 1).value)
      } else {
        arr.push(null)
      }
    } else if (splitKey(rest) && depth < MAX_YAML_DEPTH) {
      // `- key: value` — an inline mapping item, with any deeper lines as
      // sibling keys of that mapping.
      const item: YamlLine[] = [{ indent: 0, text: rest }]
      for (const l of deeper) item.push({ indent: Math.max(0, l.indent - (indent + 2)), text: l.text })
      arr.push(parseMapping(item, 0, 0, depth + 1).value)
    } else {
      arr.push(parseScalar(rest))
    }

    if (i === before) i += 1 // defensive
  }

  return { value: arr, next: i }
}

function parseYaml(raw: string): Record<string, unknown> {
  try {
    const lines = toYamlLines(raw)
    if (lines.length === 0) return {}
    const result = parseNode(lines, 0, lines[0]!.indent, 0).value
    if (!result || typeof result !== 'object' || Array.isArray(result)) return {}
    return result as Record<string, unknown>
  } catch {
    // "Malformed YAML must not throw" — degrade to no frontmatter.
    return {}
  }
}

/** Normalise `tags:` from a string, an array or a nested list into `string[]`. */
function normalizeTagList(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (raw: string): void => {
    const tag = raw.trim().replace(/^#+/, '').trim().replace(/\/+$/, '')
    if (!tag) return
    const key = tag.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(tag)
  }

  const visit = (v: unknown, depth: number, splitWhitespace: boolean): void => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') {
      for (const part of v.split(splitWhitespace ? /[,\s]+/ : /,/)) push(part)
      return
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      push(String(v))
      return
    }
    if (depth >= MAX_YAML_DEPTH) return
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1, false)
      return
    }
    if (typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) push(key)
    }
  }

  visit(value, 0, true)
  return out
}

/** Same idea as tags, but aliases keep spaces and only split on commas. */
function normalizeAliasList(value: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (raw: string): void => {
    const alias = raw.trim()
    if (!alias) return
    const key = alias.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(alias)
  }

  const visit = (v: unknown, depth: number, split: boolean): void => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') {
      if (split) for (const part of v.split(',')) push(part)
      else push(v)
      return
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      push(String(v))
      return
    }
    if (depth >= MAX_YAML_DEPTH) return
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1, false)
    }
  }

  visit(value, 0, true)
  return out
}

function normalizeFrontmatter(obj: Record<string, unknown>): NoteFrontmatter {
  const fm: NoteFrontmatter = { ...obj }

  if ('tags' in obj) fm.tags = normalizeTagList(obj.tags)
  else if ('tag' in obj) fm.tags = normalizeTagList(obj.tag)

  if ('aliases' in obj) fm.aliases = normalizeAliasList(obj.aliases)
  else if ('alias' in obj) fm.aliases = normalizeAliasList(obj.alias)

  if ('title' in obj) {
    const title = obj.title
    if (typeof title === 'string') fm.title = title
    else if (typeof title === 'number' || typeof title === 'boolean') fm.title = String(title)
    else delete fm.title
  }

  return fm
}

export function parseFrontmatter(source: string): {
  frontmatter: NoteFrontmatter
  raw: string
  body: string
  bodyOffset: number
} {
  const { raw, body, bodyOffset } = findFrontmatter(source)
  return { frontmatter: normalizeFrontmatter(parseYaml(raw)), raw, body, bodyOffset }
}

/* ------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------ */

/** Display text for the inside of a `[[wiki link]]`. */
function wikiDisplay(inner: string): string {
  const pipe = inner.indexOf('|')
  if (pipe !== -1) return inner.slice(pipe + 1).trim()
  const hash = inner.indexOf('#')
  if (hash === -1) return inner.trim()
  const target = inner.slice(0, hash).trim()
  const fragment = inner.slice(hash + 1).replace(/^\^/, '').trim()
  return target || fragment
}

const THEMATIC_OR_SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/
const TABLE_LINE = /^[ \t]*\|/
const TABLE_DIVIDER = /^[\s|:-]+$/

/**
 * Strip markdown syntax down to readable prose. Fenced code blocks are dropped
 * whole (their contents are not prose); inline code keeps its text but loses
 * the backticks. Line structure is preserved — callers collapse whitespace if
 * they want a single line.
 */
function stripToProse(text: string): string {
  /* ---- drop fenced code blocks -------------------------------------- */
  const kept: string[] = []
  let fence: Fence | null = null
  for (const source of text.split('\n')) {
    const line = chomp(source)
    if (fence) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    const open = openFence(line)
    if (open) {
      fence = open
      continue
    }
    kept.push(line)
  }

  /* ---- park backslash escapes ---------------------------------------- *
   * `\*` must survive the emphasis stripper below and come back as a
   * literal `*`, so escaped punctuation is swapped for a sentinel that none
   * of the later passes can match and restored at the very end. */
  const escapes: string[] = []
  const parked = kept
    .join('\n')
    // NUL never appears in real notes; drop any so the sentinel is unambiguous.
    .replace(/\u0000/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!>|~=])/g, (_m, c: string) => {
      escapes.push(c)
      return `\u0000${escapes.length - 1}\u0000`
    })

  /* ---- line-level markers ------------------------------------------- */
  const lines = parked.split('\n').map((line) => {
    // Thematic breaks, setext underlines and `***` / `___` rules.
    if (THEMATIC_OR_SETEXT.test(line)) return ''
    const compact = line.replace(/[ \t]/g, '')
    if (/^ {0,3}[-*_]/.test(line) && /^(?:\*{3,}|-{3,}|_{3,})$/.test(compact)) return ''
    // Table divider rows disappear; other table rows lose their pipes.
    if (TABLE_LINE.test(line)) {
      if (TABLE_DIVIDER.test(line)) return ''
      return line.replace(/\|/g, ' ')
    }
    let l = line
    l = l.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '')
    l = l.replace(/^ {0,3}(?:>[ \t]?)+/, '')
    l = l.replace(/^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+/, '$1')
    l = l.replace(/^([ \t]*)\[[ xX]\][ \t]*/, '$1')
    return l
  })

  let out = lines.join('\n')

  /* ---- inline syntax -------------------------------------------------- */
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  out = out.replace(/\$\$[\s\S]*?\$\$/g, ' ')
  // Every class below excludes `[` as well as `]`: with `[` allowed, each stray
  // `[` restarted a scan that ran to the end of the note, which is what made
  // `toPlainText` quadratic on a line of unmatched brackets. Link text and
  // destinations that do contain a `[` never matched these patterns anyway.
  out = out.replace(/!\[\[[^[\]\n]*\]\]/g, '') // image / note embeds
  out = out.replace(/!\[[^[\]\n]*\]\([^[)\n]*\)/g, '') // markdown images
  out = out.replace(/\[\[([^[\]\n]+)\]\]/g, (_m, inner: string) => wikiDisplay(inner))
  out = out.replace(/\[\^[^\]\s]+\]/g, '') // footnote references
  out = out.replace(/\[([^[\]\n]*)\]\([^[)\n]*\)/g, '$1')
  out = out.replace(/\[([^[\]\n]*)\]\[[^[\]\n]*\]/g, '$1') // reference links
  out = out.replace(/<((?:[a-z][a-z0-9+.-]*:|www\.)[^>\s]*)>/gi, '$1') // autolinks
  out = out.replace(/<\/?[a-z][^>\n]*>/gi, '') // html tags
  out = out.replace(/`+/g, '')
  out = out.replace(/\*\*|__|~~|==/g, '')
  out = out.replace(/\*/g, '')
  out = out.replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '')

  // Put the escaped punctuation back now that nothing else can eat it.
  return escapes.length === 0
    ? out
    : out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => escapes[Number(index)] ?? '')
}

export function toPlainText(markdown: string): string {
  return stripToProse(findFrontmatter(markdown).body)
}

/* ------------------------------------------------------------------ *
 * parseNote
 * ------------------------------------------------------------------ */

const WORD = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu
const EXCERPT_LENGTH = 200

function countNewlines(text: string, end: number): number {
  let count = 0
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') count += 1
  }
  return count
}

function shiftLines<T extends { line: number }>(items: T[], by: number): T[] {
  if (by === 0) return items
  for (const item of items) item.line += by
  return items
}

/**
 * A short prose summary of the note.
 *
 * `title` is dropped when the body opens with it — every surface that shows an
 * excerpt (the hover card, quick switcher, search results) already shows the
 * title right above it, and repeating it wastes the first line.
 */
function makeExcerpt(plain: string, title?: string): string {
  let collapsed = plain.replace(/\s+/g, ' ').trim()
  const heading = title?.replace(/\s+/g, ' ').trim()
  if (heading && collapsed.length > heading.length && collapsed.slice(0, heading.length) === heading) {
    const rest = collapsed.slice(heading.length)
    // Only when the title ends a word — "Notes" must not be shaved off "Notes on X".
    if (/^[\s\p{P}]/u.test(rest)) collapsed = rest.replace(/^[\s\p{Pd}:;,.]+/u, '').trim()
  }
  if (collapsed.length <= EXCERPT_LENGTH) return collapsed
  const window = collapsed.slice(0, EXCERPT_LENGTH + 1)
  const cut = window.lastIndexOf(' ')
  return `${(cut > 0 ? window.slice(0, cut) : collapsed.slice(0, EXCERPT_LENGTH)).trimEnd()}…`
}

function stripMdExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith('.md') ? fileName.slice(0, -3) : fileName
}

export function parseNote(source: string, fileName: string): ParsedNote {
  const { frontmatter, raw, body, bodyOffset } = parseFrontmatter(source)

  // Offsets are made absolute by `bodyOffset`; line numbers need the frontmatter
  // line count added on top (see the module docblock).
  const lineShift = countNewlines(source, bodyOffset)

  const links = shiftLines(extractWikiLinks(body, bodyOffset), lineShift)
  const markdownLinks = shiftLines(extractMarkdownLinks(body, bodyOffset), lineShift)
  const tags = shiftLines(extractTags(body, bodyOffset), lineShift)
  const headings = shiftLines(extractHeadings(body, bodyOffset), lineShift)
  const tasks = shiftLines(extractTasks(body, bodyOffset), lineShift)

  const plain = stripToProse(body)

  /* ---- allTags: inline first, then frontmatter, deduped case-insensitively */
  const seen = new Set<string>()
  const allTags: string[] = []
  const addTag = (tag: string): void => {
    const value = tag.trim()
    if (!value) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    allTags.push(value)
  }
  for (const ref of tags) addTag(ref.tag)
  for (const tag of frontmatter.tags ?? []) addTag(tag)

  /* ---- title: frontmatter -> first H1 -> file name --------------------- */
  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : ''
  const h1 = headings.find((h) => h.level === 1 && h.text.trim() !== '')
  const title = fmTitle || (h1 ? stripToProse(h1.text).trim() : '') || stripMdExtension(fileName).trim() || 'Untitled'

  return {
    frontmatter,
    frontmatterRaw: raw,
    body,
    bodyOffset,
    links,
    markdownLinks,
    tags,
    allTags,
    headings,
    tasks,
    title,
    excerpt: makeExcerpt(plain, title),
    wordCount: plain.match(WORD)?.length ?? 0,
  }
}
