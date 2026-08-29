/**
 * SpaceFore — markdown parsing.
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
 * catastrophically.
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

/** True when `[start, end)` contains a blank line (code spans may not). */
function containsBlankLine(chars: string[], start: number, end: number): boolean {
  let sawNewline = false
  let blankSoFar = true
  for (let i = start; i < end; i += 1) {
    const c = chars[i]
    if (c === '\n') {
      if (sawNewline && blankSoFar) return true
      sawNewline = true
      blankSoFar = true
    } else if (sawNewline && c !== ' ' && c !== '\t' && c !== '\r') {
      blankSoFar = false
    }
  }
  return false
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** Drop a trailing `\r` so CRLF files behave like LF files. */
function chomp(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Build the inert-region mask for `body`.
 *
 * Pass 1 walks lines and blanks fenced code blocks (``` and ~~~, indented up
 * to three spaces, with or without an info string; an unclosed fence runs to
 * the end of the note). Pass 2 walks what survives and blanks inline code
 * spans, HTML comments and `$$…$$` math blocks.
 */
function buildMask(body: string): string {
  const n = body.length
  const out = body.split('')

  /* ---- pass 1: fenced code blocks ---------------------------------- */
  let lineStart = 0
  let fence: { marker: string; len: number; start: number } | null = null
  while (lineStart <= n) {
    let lineEnd = body.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = n
    const line = chomp(body.slice(lineStart, lineEnd))

    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      const marker = close?.[1]
      if (marker && marker[0] === fence.marker && marker.length >= fence.len) {
        blank(out, fence.start, lineEnd)
        fence = null
      }
    } else {
      const open = FENCE_OPEN.exec(line)
      const marker = open?.[1]
      // A backtick fence's info string may not itself contain a backtick,
      // which is what keeps `` `a` `` from opening a fence.
      if (open && marker && !(marker[0] === '`' && open[2]!.includes('`'))) {
        fence = { marker: marker[0]!, len: marker.length, start: lineStart }
      }
    }

    if (lineEnd === n) break
    lineStart = lineEnd + 1
  }
  if (fence) blank(out, fence.start, n)

  /* ---- pass 2: inline code, comments, block math -------------------- */
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
      if (close !== -1 && !containsBlankLine(out, i, close)) {
        blank(out, i, close)
        i = close
      } else {
        i += run
      }
    } else if (c === '<' && out[i + 1] === '!' && out[i + 2] === '-' && out[i + 3] === '-') {
      const idx = indexOfSeq(out, '-->', i + 4)
      const end = idx === -1 ? n : idx + 3
      blank(out, i, end)
      i = end
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

export function extractWikiLinks(body: string, bodyOffset: number): WikiLink[] {
  const { mask, lineStarts } = getContext(body)
  const re = wikiLinkRegex()
  const out: WikiLink[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(mask)) !== null) {
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

  let i = 0
  while (i < n) {
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
    let depth = 0
    let textEnd = -1
    for (let j = i; j < n; j += 1) {
      const c = mask[j]
      if (c === '\n') break
      if (c === '\\') {
        j += 1
        continue
      }
      if (c === '[') depth += 1
      else if (c === ']') {
        depth -= 1
        if (depth === 0) {
          textEnd = j
          break
        }
      }
    }
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
 * `#tag`, preceded by start-of-line, whitespace or an opening bracket. The
 * character class excludes `.,):;!?` so trailing punctuation naturally falls
 * outside the tag.
 */
function tagRegex(): RegExp {
  return /(^|[\s\(\[\{])#([\p{L}\p{N}_/-]+)/gmu
}

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
    const prefix = m[1]!
    const hash = m.index + prefix.length

    // A dangling `/` cannot end a tag: `#work/` is the tag `work`.
    const tag = m[2]!.replace(/\/+$/, '')
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

export function slugifyHeading(text: string): string {
  return text
    .replace(/!?\[\[([^\]\n]*)\]\]/g, (_m, inner: string) => wikiDisplay(inner))
    .replace(/!?\[([^\]]*)\]\([^)\n]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
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
    const text = rawText.trim()
    const base = slugifyHeading(text)
    const seen = slugCounts.get(base) ?? 0
    slugCounts.set(base, seen + 1)
    out.push({
      level,
      text,
      slug: seen === 0 ? base : `${base}-${seen + 1}`,
      start: start + bodyOffset,
      line,
    })
  }

  /** Previous line: masked text drives the structural tests, `start`/`length` slice the real text. */
  let previous: { masked: string; start: number; length: number; line: number; isHeading: boolean } | null = null

  for (let li = 0; li < lineStarts.length; li += 1) {
    const lineStart = lineStarts[li]!
    const lineEnd = li + 1 < lineStarts.length ? lineStarts[li + 1]! - 1 : mask.length
    const line = chomp(mask.slice(lineStart, lineEnd))
    const lineNo = li + 1

    const atx = ATX.exec(line)
    if (atx) {
      // `atx[0] === line`, so the text capture ends the line: take the same
      // span out of the *original* body so masked inline code survives.
      const captured = atx[3] ?? ''
      const textStart = lineStart + line.length - captured.length
      // Drop an optional closing sequence: `## Title ##`.
      const raw = body.slice(textStart, lineStart + line.length).replace(/(^|[ \t])#+[ \t]*$/, '$1')
      push(atx[2]!.length, raw, lineStart + atx[1]!.length, lineNo)
      previous = { masked: line, start: lineStart, length: line.length, line: lineNo, isHeading: true }
      continue
    }

    const setext = SETEXT.exec(line)
    if (setext && previous && !previous.isHeading && isSetextCandidate(previous.masked)) {
      const text = body.slice(previous.start, previous.start + previous.length)
      push(setext[1]!.startsWith('=') ? 1 : 2, text, previous.start, previous.line)
      previous = { masked: line, start: lineStart, length: line.length, line: lineNo, isHeading: true }
      continue
    }

    previous = { masked: line, start: lineStart, length: line.length, line: lineNo, isHeading: false }
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
  let fence: { marker: string; len: number } | null = null
  for (const source of text.split('\n')) {
    const line = chomp(source)
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      const marker = close?.[1]
      if (marker && marker[0] === fence.marker && marker.length >= fence.len) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(line)
    const marker = open?.[1]
    if (open && marker && !(marker[0] === '`' && open[2]!.includes('`'))) {
      fence = { marker: marker[0]!, len: marker.length }
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
  out = out.replace(/!\[\[[^\]\n]*\]\]/g, '') // image / note embeds
  out = out.replace(/!\[[^\]]*\]\([^)\n]*\)/g, '') // markdown images
  out = out.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => wikiDisplay(inner))
  out = out.replace(/\[\^[^\]\s]+\]/g, '') // footnote references
  out = out.replace(/\[([^\]]*)\]\([^)\n]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\[[^\]\n]*\]/g, '$1') // reference links
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

function makeExcerpt(plain: string): string {
  const collapsed = plain.replace(/\s+/g, ' ').trim()
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
    excerpt: makeExcerpt(plain),
    wordCount: plain.match(WORD)?.length ?? 0,
  }
}
