/**
 * SpaceLink — fuzzy subsequence matching.
 *
 * `fuzzyMatch` answers one question: can the characters of `query` be found in
 * `target`, in order, and how good does that particular arrangement look to a
 * human? Every character of the query must appear (case-insensitively) in the
 * target, but the *alignment* is what decides the score:
 *
 * | signal                                        | delta |
 * | --------------------------------------------- | ----- |
 * | continues a run of consecutive matches        |  +16  |
 * | lands on a word start (after ` / - _ .`)      |  +10  |
 * | lands on a camelCase hump (`fooBar` -> `B`)   |   +8  |
 * | lands on index 0                              |  +12  |
 * | each character skipped between two matches    |   -1  |
 * | each character skipped *before* the first one | -1.5  |
 *
 * Characters after the last match are free, so a short query is not punished
 * for hitting a long note title.
 *
 * ## Picking the alignment
 *
 * A greedy left-to-right scan is not enough: for `abc` against `a-bxabc` it
 * would take `a` at 0, `b` at 2 and `c` at 6 (score 18) and miss the obvious
 * `abc` run at the end (score 26). So the aligner is a dynamic program over
 * (query position x target position) that maximises the table above exactly.
 * It runs in O(|query| x |target|) thanks to a running maximum: the best "gap"
 * predecessor for column `j` only ever grows as `j` advances, so it is carried
 * along instead of being re-scanned.
 *
 * Three guards keep the cost sane when this is called once per note in a
 * 5,000-note vault:
 *
 * 1. a linear subsequence pre-check rejects non-matches before any table is
 *    allocated — that is the common case by a wide margin;
 * 2. each row of the table is restricted to the columns the query character
 *    could actually occupy, found by matching greedily from both ends. For a
 *    query that nearly covers its target this collapses the table to a narrow
 *    band and the aligner becomes close to linear;
 * 3. absurdly large inputs (a query against a whole file, say) fall back to a
 *    greedy aligner that retries from the first few possible starting points.
 */
import type { FuzzyMatch, MatchRange } from '../../types'

const BONUS_CONSECUTIVE = 16
const BONUS_WORD_START = 10
const BONUS_CAMEL = 8
const BONUS_FIRST_CHAR = 12
const PENALTY_SKIP = 1
const PENALTY_LEADING_EXTRA = 0.5
/** Leading characters are skipped *and* penalised extra. */
const PENALTY_LEADING = PENALTY_SKIP + PENALTY_LEADING_EXTRA

const NEG = -Infinity

/** Above this many DP cells we stop being exact and use the greedy aligner. */
const MAX_DP_CELLS = 1 << 16
/** How many alternative first-character positions the greedy fallback tries. */
const MAX_GREEDY_STARTS = 16

/** A match right after one of these counts as a word start. */
const WORD_SEPARATORS = ' \t\r\n/-_.'

/* ------------------------------------------------------------------ *
 * Character helpers
 * ------------------------------------------------------------------ */

function isSeparator(ch: string): boolean {
  return WORD_SEPARATORS.indexOf(ch) !== -1
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase()
}

function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase()
}

/**
 * Lowercase `s` while guaranteeing the result has the *same length*, so that an
 * index into the folded string is also a valid index into the original. A few
 * code points (`İ`) lowercase to more than one unit, which would otherwise
 * shift every range that follows them.
 */
function foldCase(s: string): string {
  const lower = s.toLowerCase()
  // Lowercasing never removes characters, so equal lengths proves 1:1 mapping.
  if (lower.length === s.length) return lower
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    const folded = s[i].toLowerCase()
    out += folded.length === 1 ? folded : folded[0]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Scratch buffers
 *
 * `fuzzyMatch` runs once per note per keystroke, so the tables are hoisted out
 * of the function and grown on demand rather than reallocated tens of thousands
 * of times. This is safe because matching is synchronous and never re-entrant —
 * nothing inside the aligner calls back out.
 * ------------------------------------------------------------------ */

let bonusBuffer: Float64Array = new Float64Array(0)
/** The two row buffers are a pool and must stay distinct objects. */
let prevRow: Float64Array = new Float64Array(0)
let currRow: Float64Array = new Float64Array(0)
let choiceTable: Int32Array = new Int32Array(0)
let lowestBand: Int32Array = new Int32Array(0)
let highestBand: Int32Array = new Int32Array(0)

function floats(current: Float64Array, size: number): Float64Array {
  return current.length >= size ? current : new Float64Array(size)
}

function ints(current: Int32Array, size: number): Int32Array {
  return current.length >= size ? current : new Int32Array(size)
}

/**
 * Position bonuses for every index of `target`. Computed once per call and
 * shared by the aligner and the scorer so both agree on the numbers.
 */
function positionBonuses(target: string): Float64Array {
  const bonuses = floats(bonusBuffer, target.length)
  bonusBuffer = bonuses
  for (let i = 0; i < target.length; i += 1) {
    let bonus = 0
    if (i === 0) {
      bonus += BONUS_FIRST_CHAR
    } else {
      const prev = target[i - 1]
      if (isSeparator(prev)) bonus += BONUS_WORD_START
      if (isUpper(target[i]) && isLower(prev)) bonus += BONUS_CAMEL
    }
    bonuses[i] = bonus
  }
  return bonuses
}

/** Linear rejection test: is every character of `q` present, in order, in `t`? */
function isSubsequence(q: string, t: string): boolean {
  let ti = 0
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]
    while (ti < t.length && t[ti] !== ch) ti += 1
    if (ti >= t.length) return false
    ti += 1
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Scoring + alignment
 * ------------------------------------------------------------------ */

/** Score one alignment. The single source of truth for what a match is worth. */
function scoreAlignment(positions: number[], bonuses: Float64Array): number {
  let score = 0
  for (let i = 0; i < positions.length; i += 1) {
    const at = positions[i]
    score += bonuses[at]
    if (i === 0) {
      score -= at * PENALTY_LEADING
    } else {
      const prev = positions[i - 1]
      if (at === prev + 1) score += BONUS_CONSECUTIVE
      else score -= (at - prev - 1) * PENALTY_SKIP
    }
  }
  return score
}

/**
 * Exact aligner.
 *
 * `D[i][j]` = best score for matching `q[0..i]` with `q[i]` sitting on `t[j]`.
 * For `i > 0` the predecessor is either `j - 1` (a consecutive run, worth
 * `+BONUS_CONSECUTIVE`) or some earlier `k`, costing one point per skipped
 * character. Written out, the second option is
 *
 *     max over k < j of ( D[i-1][k] - (j - k - 1) )
 *   = ( max over k < j of ( D[i-1][k] + k ) ) - j + 1
 *
 * and the inner maximum is independent of `j`, so it is maintained as a running
 * value (`bestGap`) while the row is filled. That turns the obvious O(n^2) per
 * row into O(n).
 */
function alignDP(q: string, t: string, bonuses: Float64Array): number[] | null {
  const m = q.length
  const n = t.length

  // Column band per row. `lowest[i]` is where `q[0..i]` can first finish
  // (greedy from the left); `highest[i]` is the last index `q[i]` can take
  // (greedy from the right). Outside that band a cell is unreachable.
  const lowest = ints(lowestBand, m)
  lowestBand = lowest
  const highest = ints(highestBand, m)
  highestBand = highest
  // Bounded on both ends: a non-matching pair must return, never spin.
  for (let i = 0, at = 0; i < m; i += 1, at += 1) {
    while (at < n && t[at] !== q[i]) at += 1
    if (at >= n) return null
    lowest[i] = at
  }
  for (let i = m - 1, at = n - 1; i >= 0; i -= 1, at -= 1) {
    while (at >= 0 && t[at] !== q[i]) at -= 1
    if (at < 0) return null
    highest[i] = at
  }

  let prev = floats(prevRow, n)
  prevRow = prev
  let curr = floats(currRow, n)
  currRow = curr

  // Row for query character 0: only the leading-gap penalty applies.
  prev.fill(NEG, 0, n)
  for (let j = lowest[0]; j <= highest[0]; j += 1) {
    if (q[0] === t[j]) prev[j] = bonuses[j] - j * PENALTY_LEADING
  }

  // choice[i * n + j] = target index used by query character i-1. Cells are
  // only ever read back along a chain that was written by this call, so the
  // table does not need clearing between calls.
  const choice = m > 1 ? ints(choiceTable, m * n) : choiceTable
  if (m > 1) choiceTable = choice

  for (let i = 1; i < m; i += 1) {
    curr.fill(NEG, 0, n)
    const qc = q[i]
    const from = lowest[i]
    const to = highest[i]
    let bestGap = NEG // max over k <= j-1 of prev[k] + k
    let bestGapAt = -1
    // Two pointers: `k` folds the previous row into the running maximum
    // exactly once, in step with `j`.
    let k = lowest[i - 1]
    const kMax = highest[i - 1]

    for (let j = from; j <= to; j += 1) {
      while (k <= kMax && k <= j - 1) {
        const value = prev[k]
        if (value > NEG) {
          const candidate = value + k
          if (candidate > bestGap) {
            bestGap = candidate
            bestGapAt = k
          }
        }
        k += 1
      }
      if (qc !== t[j] || bestGapAt < 0) continue

      let best = bestGap - j + 1
      let cameFrom = bestGapAt
      const left = j > 0 ? prev[j - 1] : NEG
      if (left > NEG) {
        const consecutive = left + BONUS_CONSECUTIVE
        if (consecutive > best) {
          best = consecutive
          cameFrom = j - 1
        }
      }
      curr[j] = best + bonuses[j]
      choice[i * n + j] = cameFrom
    }
    const swap = prev
    prev = curr
    curr = swap
  }

  // `prev` now holds the last row; the tail of the target is free, so simply
  // take the best cell in it.
  let bestAt = -1
  let bestScore = NEG
  for (let j = lowest[m - 1]; j <= highest[m - 1]; j += 1) {
    if (prev[j] > bestScore) {
      bestScore = prev[j]
      bestAt = j
    }
  }
  if (bestAt < 0 || bestScore === NEG) return null

  const positions = new Array<number>(m)
  positions[m - 1] = bestAt
  for (let i = m - 1; i > 0; i -= 1) {
    positions[i - 1] = choice[i * n + positions[i]]
  }
  return positions
}

/** Greedy left-to-right alignment starting at `start`, or null if it runs out. */
function greedyFrom(q: string, t: string, start: number): number[] | null {
  const positions = new Array<number>(q.length)
  positions[0] = start
  let ti = start + 1
  for (let qi = 1; qi < q.length; qi += 1) {
    const ch = q[qi]
    while (ti < t.length && t[ti] !== ch) ti += 1
    if (ti >= t.length) return null
    positions[qi] = ti
    ti += 1
  }
  return positions
}

/**
 * Fallback aligner for inputs too large for the exact table. A plain greedy
 * pass anchors on the first possible position, which is often wrong, so we also
 * retry from the next few occurrences of the first query character and keep the
 * best-scoring result.
 */
function alignGreedy(q: string, t: string, bonuses: Float64Array): number[] | null {
  let best: number[] | null = null
  let bestScore = NEG
  let tried = 0
  for (let j = 0; j < t.length && tried < MAX_GREEDY_STARTS; j += 1) {
    if (t[j] !== q[0]) continue
    tried += 1
    const positions = greedyFrom(q, t, j)
    if (!positions) break // no room left for the rest of the query
    const score = scoreAlignment(positions, bonuses)
    if (score > bestScore) {
      bestScore = score
      best = positions
    }
  }
  return best
}

/** Collapse matched indices into merged, ascending, non-overlapping ranges. */
function toRanges(positions: number[]): MatchRange[] {
  const ranges: MatchRange[] = []
  for (let i = 0; i < positions.length; i += 1) {
    const at = positions[i]
    const last = ranges[ranges.length - 1]
    if (last && last[1] === at) last[1] = at + 1
    else ranges.push([at, at + 1])
  }
  return ranges
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Subsequence match with bonuses for word starts, camelCase and consecutive runs. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, ranges: [] }
  if (target.length === 0) return null

  const q = foldCase(query)
  const t = foldCase(target)
  if (q.length > t.length) return null
  if (!isSubsequence(q, t)) return null

  // Bonuses read the *original* target: case carries the camelCase signal.
  const bonuses = positionBonuses(target)
  const positions =
    q.length * t.length <= MAX_DP_CELLS ? alignDP(q, t, bonuses) : alignGreedy(q, t, bonuses)
  if (!positions) return null

  return { score: scoreAlignment(positions, bonuses), ranges: toRanges(positions) }
}

/* ------------------------------------------------------------------ *
 * Highlighting
 * ------------------------------------------------------------------ */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
}

/**
 * Clamp, drop and merge whatever the caller handed us. Ranges may arrive
 * out of order, reversed, fractional or pointing past the end of the string —
 * none of that may produce broken markup.
 */
function normalizeRanges(ranges: MatchRange[], length: number): MatchRange[] {
  const clean: MatchRange[] = []
  for (const range of ranges) {
    if (!range || range.length < 2) continue
    const rawStart = range[0]
    const rawEnd = range[1]
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue
    const start = Math.max(0, Math.min(length, Math.floor(rawStart)))
    const end = Math.max(0, Math.min(length, Math.ceil(rawEnd)))
    if (end > start) clean.push([start, end])
  }
  clean.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const merged: MatchRange[] = []
  for (const range of clean) {
    const last = merged[merged.length - 1]
    // `<=` also merges ranges that merely touch, so `[0,2]` + `[2,4]` becomes
    // one `<mark>` instead of two adjacent ones.
    if (last && range[0] <= last[1]) {
      if (range[1] > last[1]) last[1] = range[1]
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

/** Wrap the matched ranges in `<mark>`, escaping everything else. */
export function highlight(text: string, ranges: MatchRange[]): string {
  if (!ranges || ranges.length === 0) return escapeHtml(text)
  const merged = normalizeRanges(ranges, text.length)
  if (merged.length === 0) return escapeHtml(text)

  let out = ''
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) out += escapeHtml(text.slice(cursor, start))
    out += `<mark>${escapeHtml(text.slice(start, end))}</mark>`
    cursor = end
  }
  if (cursor < text.length) out += escapeHtml(text.slice(cursor))
  return out
}
