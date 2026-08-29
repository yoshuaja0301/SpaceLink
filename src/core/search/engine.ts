/**
 * SpaceFore — full-text search and the quick switcher.
 *
 * ## Query language
 *
 * ```
 *   zettel note          two terms, both must be present (AND)
 *   "exact phrase"       matched literally, spaces included
 *   -draft               notes containing this are dropped
 *   tag:project   #project
 *   path:daily/          substring of the vault path
 *   file:index           substring of the file name
 *   /^#{1,2}\s/i         a regular expression
 * ```
 *
 * `parseQuery` lowercases everything it extracts *except* regex sources — a
 * pattern is user code, and folding it would change what it means. Case
 * sensitivity for plain terms is a search option rather than a parse option,
 * so `searchNotes` re-parses through the same tokeniser with folding switched
 * off when `caseSensitive` is set. A regex is user code all the way down: the
 * flags it was written with are honoured as-is, and `i` is only ever supplied
 * for a bare `/pattern/`.
 *
 * ## How a note is matched
 *
 * 1. `tag:` / `path:` / `file:` filters are applied first — they are cheap and
 *    throw most of the vault away before any text is scanned.
 * 2. Every remaining term, phrase and the regex must be present somewhere in
 *    the note (its text, its title or its path), and no excluded term may be.
 *    Presence is tested with a non-global regex against the whole note, which
 *    avoids allocating a lowercased copy of every file on every keystroke.
 * 3. Only for the survivors do we collect per-line matches, using a line-start
 *    table rather than splitting the file into an array of lines.
 *
 * Notes are never re-parsed: headings and tags come from `note.parsed`.
 */
import type {
  MatchRange,
  Note,
  NotePath,
  QuickSwitchItem,
  SearchHit,
  SearchLineMatch,
} from '../../types'
import { fuzzyMatch } from './fuzzy'

export interface SearchFilters {
  terms: string[]
  phrases: string[]
  excluded: string[]
  tags: string[]
  paths: string[]
  files: string[]
  regex: RegExp | null
}

export interface SearchOptions {
  limit?: number
  maxMatchesPerNote?: number
  caseSensitive?: boolean
}

const DEFAULT_LIMIT = 200
const DEFAULT_MAX_MATCHES = 5
const DEFAULT_QUICK_LIMIT = 20

/** Field weights: a hit in the title is worth eight body hits. */
const WEIGHT_TITLE = 8
const WEIGHT_HEADING = 4
const WEIGHT_PATH = 2
const WEIGHT_BODY = 1
/**
 * Matches near the top of a note are usually the ones the user meant. The
 * bonus is deliberately worth less than a single body match, so it only ever
 * breaks ties — a note with more matches still wins.
 */
const TOP_BONUS = 1
const TOP_BONUS_FALLOFF = 10
/** Score for a note that only had to satisfy `tag:`/`path:`/`file:` filters. */
const FILTER_ONLY_SCORE = 1

const QUICK_NAME_WEIGHT = 1
const QUICK_PATH_WEIGHT = 0.6

/* ------------------------------------------------------------------ *
 * Query parsing
 * ------------------------------------------------------------------ */

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

interface Token {
  /** Text with surrounding quotes removed. */
  text: string
  /** A quoted section appeared anywhere in the token. */
  quoted: boolean
  /** The token *opened* with a quote, so field prefixes must not be honoured. */
  startedQuoted: boolean
  /** Index just past the token. */
  end: number
}

/**
 * Read one whitespace-delimited token, letting a quoted section swallow spaces.
 * That makes both `"foo bar"` and `tag:"my tag"` work with one code path.
 */
function readToken(query: string, start: number): Token {
  let text = ''
  let quoted = false
  const startedQuoted = query[start] === '"'
  let i = start
  while (i < query.length && !isSpace(query[i])) {
    if (query[i] === '"') {
      quoted = true
      i += 1
      while (i < query.length && query[i] !== '"') {
        text += query[i]
        i += 1
      }
      if (i < query.length) i += 1 // closing quote
    } else {
      text += query[i]
      i += 1
    }
  }
  return { text, quoted, startedQuoted, end: i }
}

/** Read a `/pattern/flags` token. Returns null when there is no closing slash. */
function readRegex(query: string, start: number): { body: string; flags: string; end: number } | null {
  let i = start + 1
  let body = ''
  let closed = false
  while (i < query.length) {
    const ch = query[i]
    if (ch === '\\' && i + 1 < query.length) {
      body += ch + query[i + 1]
      i += 2
      continue
    }
    if (ch === '/') {
      closed = true
      i += 1
      break
    }
    body += ch
    i += 1
  }
  if (!closed || body.length === 0) return null
  let flags = ''
  while (i < query.length && /[a-zA-Z]/.test(query[i])) {
    flags += query[i]
    i += 1
  }
  return { body, flags, end: i }
}

/** `tag:x` -> `{ name: 'tag', value: 'x' }`. */
function fieldPrefix(text: string): { name: string; value: string } | null {
  const colon = text.indexOf(':')
  if (colon <= 0) return null
  const name = text.slice(0, colon).toLowerCase()
  if (name !== 'tag' && name !== 'path' && name !== 'file') return null
  return { name, value: text.slice(colon + 1) }
}

/** Tags are compared case-insensitively and without their `#` or trailing `/`. */
function normalizeTag(value: string): string {
  let tag = value.trim().toLowerCase()
  while (tag.startsWith('#')) tag = tag.slice(1)
  while (tag.endsWith('/')) tag = tag.slice(0, -1)
  return tag
}

function parseQueryInternal(query: string, fold: boolean): SearchFilters {
  const filters: SearchFilters = {
    terms: [],
    phrases: [],
    excluded: [],
    tags: [],
    paths: [],
    files: [],
    regex: null,
  }
  const norm = (text: string): string => (fold ? text.toLowerCase() : text)

  let i = 0
  while (i < query.length) {
    if (isSpace(query[i])) {
      i += 1
      continue
    }

    // A lone `-` is just a term; `-x` negates.
    let negated = false
    if (query[i] === '-' && i + 1 < query.length && !isSpace(query[i + 1])) {
      negated = true
      i += 1
    }

    if (!negated && query[i] === '/') {
      const found = readRegex(query, i)
      if (found) {
        const raw = query.slice(i, found.end)
        i = found.end
        try {
          filters.regex = new RegExp(found.body, found.flags)
        } catch {
          // Not a usable pattern — fall back to searching for the text itself.
          filters.terms.push(norm(raw))
        }
        continue
      }
      // No closing slash: fall through and treat it as an ordinary token.
    }

    const token = readToken(query, i)
    i = token.end
    if (!token.text) continue

    if (negated) {
      filters.excluded.push(norm(token.text))
      continue
    }

    const field = token.startedQuoted ? null : fieldPrefix(token.text)
    if (field) {
      if (!field.value) continue
      if (field.name === 'tag') {
        const tag = normalizeTag(field.value)
        if (tag) filters.tags.push(tag)
      } else if (field.name === 'path') {
        filters.paths.push(field.value.toLowerCase())
      } else {
        filters.files.push(field.value.toLowerCase())
      }
      continue
    }

    if (!token.startedQuoted && token.text.startsWith('#') && token.text.length > 1) {
      const tag = normalizeTag(token.text)
      if (tag) filters.tags.push(tag)
      continue
    }

    if (token.quoted) filters.phrases.push(norm(token.text))
    else filters.terms.push(norm(token.text))
  }

  return filters
}

/** Parse `tag:x path:y file:z "exact phrase" -excluded /re/` into filters. */
export function parseQuery(query: string): SearchFilters {
  return parseQueryInternal(query, true)
}

/* ------------------------------------------------------------------ *
 * Needles
 * ------------------------------------------------------------------ */

/**
 * One thing to look for. `probe` answers "is this anywhere in the note?" and
 * `scan` (the global twin) walks every occurrence. They are kept apart so the
 * cheap presence test never has to reset `lastIndex`.
 */
interface Needle {
  probe: RegExp
  scan: RegExp
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalNeedle(text: string, caseSensitive: boolean): Needle | null {
  if (!text) return null
  const source = escapeRegExp(text)
  const flags = caseSensitive ? '' : 'i'
  return { probe: new RegExp(source, flags), scan: new RegExp(source, `${flags}g`) }
}

function regexNeedle(regex: RegExp, caseSensitive: boolean): Needle | null {
  const flags = new Set(regex.flags.split(''))
  // Whether the user wrote flags of their own, decided before `g`/`y` are
  // stripped — `/foo/g` is still an authored pattern.
  const authored = regex.flags.length > 0
  // `g`/`y` are ours to manage; `m` makes `^`/`$` mean line edges, which is what
  // a line-oriented search reads like.
  flags.delete('g')
  flags.delete('y')
  flags.add('m')
  // A pattern is user code, so its casing is the user's to choose: `i` is only
  // supplied for a bare `/pattern/`. Once any flags are written the pattern
  // means exactly what it says, and `/TODO/m` no longer matches `todo`.
  if (!caseSensitive && !authored) flags.add('i')
  const base = [...flags].join('')
  try {
    return { probe: new RegExp(regex.source, base), scan: new RegExp(regex.source, `${base}g`) }
  } catch {
    return null
  }
}

function buildNeedles(filters: SearchFilters, caseSensitive: boolean): Needle[] {
  const needles: Needle[] = []
  for (const phrase of filters.phrases) {
    const needle = literalNeedle(phrase, caseSensitive)
    if (needle) needles.push(needle)
  }
  for (const term of filters.terms) {
    const needle = literalNeedle(term, caseSensitive)
    if (needle) needles.push(needle)
  }
  if (filters.regex) {
    const needle = regexNeedle(filters.regex, caseSensitive)
    if (needle) needles.push(needle)
  }
  return needles
}

/**
 * Walk every occurrence of `needle` in `text`. Zero-width matches (`/^/`) are
 * skipped *and* step `lastIndex` forward, otherwise `exec` would never finish.
 */
function collectMatches(scan: RegExp, text: string, out: MatchRange[] | null): number {
  if (!text) return 0
  scan.lastIndex = 0
  let count = 0
  let match = scan.exec(text)
  while (match !== null) {
    const length = match[0].length
    if (length === 0) {
      scan.lastIndex += 1
    } else {
      count += 1
      if (out) out.push([match.index, match.index + length])
    }
    if (scan.lastIndex > text.length) break
    match = scan.exec(text)
  }
  return count
}

function presentIn(needle: Needle, content: string, title: string, path: NotePath): boolean {
  return needle.probe.test(content) || needle.probe.test(title) || needle.probe.test(path)
}

/* ------------------------------------------------------------------ *
 * Line bookkeeping
 * ------------------------------------------------------------------ */

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1)
  }
  return starts
}

/** 1-based line number containing `index`. */
function lineOf(starts: number[], index: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return low + 1
}

function lineText(content: string, starts: number[], line: number): string {
  const from = starts[line - 1]
  const to = line < starts.length ? starts[line] - 1 : content.length
  const text = content.slice(from, to)
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) return ranges.map((r) => [r[0], r[1]] as MatchRange)
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: MatchRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      if (range[1] > last[1]) last[1] = range[1]
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/** `tag:project` also matches the nested tag `project/alpha`. */
function hasTag(tags: string[], wanted: string): boolean {
  for (const tag of tags) {
    const lower = tag.toLowerCase()
    if (lower === wanted || lower.startsWith(`${wanted}/`)) return true
  }
  return false
}

function passesFilters(note: Note, filters: SearchFilters): boolean {
  if (filters.tags.length > 0) {
    const tags = note.parsed.allTags
    for (const tag of filters.tags) {
      if (!hasTag(tags, tag)) return false
    }
  }
  if (filters.paths.length > 0) {
    const path = note.path.toLowerCase()
    for (const fragment of filters.paths) {
      if (!path.includes(fragment)) return false
    }
  }
  if (filters.files.length > 0) {
    const slash = note.path.lastIndexOf('/')
    const fileName = note.path.slice(slash + 1).toLowerCase()
    const base = note.name.toLowerCase()
    for (const fragment of filters.files) {
      if (!fileName.includes(fragment) && !base.includes(fragment)) return false
    }
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function compareHits(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

export function searchNotes(
  query: string,
  notes: Map<NotePath, Note>,
  options: SearchOptions = {},
): SearchHit[] {
  if (!query.trim()) return []

  const limit = options.limit ?? DEFAULT_LIMIT
  const maxMatches = options.maxMatchesPerNote ?? DEFAULT_MAX_MATCHES
  const caseSensitive = options.caseSensitive === true

  const filters = parseQueryInternal(query, !caseSensitive)
  const required = buildNeedles(filters, caseSensitive)
  const excluded: Needle[] = []
  for (const term of filters.excluded) {
    const needle = literalNeedle(term, caseSensitive)
    if (needle) excluded.push(needle)
  }

  const hasFieldFilter =
    filters.tags.length > 0 || filters.paths.length > 0 || filters.files.length > 0
  // A query made only of exclusions has nothing positive to rank, so it is not
  // a search — same as the empty query.
  if (required.length === 0 && !hasFieldFilter) return []

  const hits: SearchHit[] = []

  for (const note of notes.values()) {
    if (!passesFilters(note, filters)) continue

    const content = note.content
    const title = note.parsed.title || note.name

    // Presence and collection are the same scan: a needle that turns up
    // nothing anywhere fails the AND, and we stop before touching the rest.
    let titleHits = 0
    let pathHits = 0
    const occurrences: MatchRange[] = []
    let ok = true
    for (const needle of required) {
      const inTitle = collectMatches(needle.scan, title, null)
      const inPath = collectMatches(needle.scan, note.path, null)
      const before = occurrences.length
      collectMatches(needle.scan, content, occurrences)
      if (inTitle === 0 && inPath === 0 && occurrences.length === before) {
        ok = false
        break
      }
      titleHits += inTitle
      pathHits += inPath
    }
    if (!ok) continue

    for (const needle of excluded) {
      if (presentIn(needle, content, title, note.path)) {
        ok = false
        break
      }
    }
    if (!ok) continue

    // `tag:x` on its own: the note qualifies, but there is nothing to highlight.
    if (required.length === 0) {
      hits.push({ path: note.path, title, score: FILTER_ONLY_SCORE, matches: [], total: 0 })
      continue
    }

    occurrences.sort((a, b) => a[0] - b[0] || a[1] - b[1])

    const starts = lineStartsOf(content)
    const headingLines = new Set<number>()
    for (const heading of note.parsed.headings) headingLines.add(heading.line)

    // Resolve every occurrence to its line once, then walk the runs.
    const lines = new Array<number>(occurrences.length)
    for (let index = 0; index < occurrences.length; index += 1) {
      lines[index] = lineOf(starts, occurrences[index][0])
    }

    const matches: SearchLineMatch[] = []
    let total = 0
    let bodyScore = 0
    let firstLine = 0

    let cursor = 0
    while (cursor < occurrences.length) {
      const line = lines[cursor]
      const group: MatchRange[] = []
      while (cursor < occurrences.length && lines[cursor] === line) {
        group.push(occurrences[cursor])
        cursor += 1
      }

      total += 1
      if (firstLine === 0) firstLine = line
      bodyScore += (headingLines.has(line) ? WEIGHT_HEADING : WEIGHT_BODY) * group.length

      if (matches.length < maxMatches) {
        const text = lineText(content, starts, line)
        const base = starts[line - 1]
        // A phrase or pattern may span a newline; clamp so ranges stay inside
        // the line they are reported on.
        const local = group.map(
          (range) => [range[0] - base, Math.min(range[1] - base, text.length)] as MatchRange,
        )
        matches.push({ line, text, ranges: mergeRanges(local.filter((r) => r[1] > r[0])) })
      }
    }

    const topBonus = firstLine > 0 ? TOP_BONUS / (1 + (firstLine - 1) / TOP_BONUS_FALLOFF) : 0
    const score = WEIGHT_TITLE * titleHits + WEIGHT_PATH * pathHits + bodyScore + topBonus

    hits.push({ path: note.path, title, score, matches, total })
  }

  hits.sort(compareHits)
  return limit > 0 ? hits.slice(0, limit) : []
}

/* ------------------------------------------------------------------ *
 * Quick switcher
 * ------------------------------------------------------------------ */

/**
 * Scale a fuzzy score by a confidence weight. A weight below 1 must always make
 * a candidate *less* attractive, but fuzzy scores can be negative (a gappy
 * match deep inside a long path), and `-20 * 0.6` is *greater* than `-20`.
 * Dividing instead keeps the ordering honest on both sides of zero.
 */
function weighted(score: number, weight: number): number {
  return score >= 0 ? score * weight : score / weight
}

/**
 * Translate ranges over the full path into ranges over the basename, so the
 * highlight always lines up with the title the UI renders. Anything covering a
 * folder segment is simply dropped.
 */
function pathRangesToName(ranges: MatchRange[], note: Note): MatchRange[] {
  const base = note.path.lastIndexOf('/') + 1
  const length = note.name.length
  const out: MatchRange[] = []
  for (const [from, to] of ranges) {
    const start = Math.max(0, from - base)
    const end = Math.min(length, to - base)
    if (end > start) out.push([start, end])
  }
  return out
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function quickSwitch(
  query: string,
  notes: Map<NotePath, Note>,
  limit: number = DEFAULT_QUICK_LIMIT,
): QuickSwitchItem[] {
  const trimmed = query.trim()
  const cap = Math.max(0, limit)

  if (!trimmed) {
    const all = [...notes.values()].sort((a, b) => comparePaths(a.path, b.path))
    return all.slice(0, cap).map((note) => ({
      path: note.path,
      title: note.name,
      subtitle: note.path,
      score: 0,
      ranges: [],
    }))
  }

  const items: QuickSwitchItem[] = []
  for (const note of notes.values()) {
    const nameMatch = fuzzyMatch(trimmed, note.name)
    const pathMatch = fuzzyMatch(trimmed, note.path)

    let ranges: MatchRange[]
    if (nameMatch) ranges = nameMatch.ranges
    else if (pathMatch) ranges = pathRangesToName(pathMatch.ranges, note)
    else continue

    const nameScore = nameMatch ? weighted(nameMatch.score, QUICK_NAME_WEIGHT) : -Infinity
    const pathScore = pathMatch ? weighted(pathMatch.score, QUICK_PATH_WEIGHT) : -Infinity

    items.push({
      path: note.path,
      title: note.name,
      subtitle: note.path,
      score: Math.max(nameScore, pathScore),
      ranges,
    })
  }

  if (items.length === 0) {
    const path = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`
    return [
      {
        path,
        title: trimmed,
        subtitle: 'Create new note',
        score: 0,
        ranges: [],
        create: true,
      },
    ]
  }

  items.sort((a, b) => (b.score !== a.score ? b.score - a.score : comparePaths(a.path, b.path)))
  return items.slice(0, cap)
}
