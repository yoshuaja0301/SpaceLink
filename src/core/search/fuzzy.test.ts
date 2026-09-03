import type { MatchRange } from '../../types'
import { fuzzyMatch, highlight } from './fuzzy'

/** Assert the invariants every returned range set must satisfy. */
function expectWellFormed(ranges: MatchRange[], target: string): void {
  let previousEnd = -1
  for (const [start, end] of ranges) {
    expect(Number.isInteger(start)).toBe(true)
    expect(Number.isInteger(end)).toBe(true)
    expect(end).toBeGreaterThan(start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeLessThanOrEqual(target.length)
    // ascending and non-overlapping — and merged, so not even touching
    expect(start).toBeGreaterThan(previousEnd)
    previousEnd = end
  }
}

/** The characters the ranges actually cover, in order. */
function covered(target: string, ranges: MatchRange[]): string {
  return ranges.map(([start, end]) => target.slice(start, end)).join('')
}

function score(query: string, target: string): number {
  const match = fuzzyMatch(query, target)
  if (!match) throw new Error(`expected ${query} to match ${target}`)
  return match.score
}

describe('fuzzyMatch', () => {
  it('returns a zero score and no ranges for an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, ranges: [] })
    expect(fuzzyMatch('', '')).toEqual({ score: 0, ranges: [] })
  })

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull()
    expect(fuzzyMatch('abc', '')).toBeNull()
    expect(fuzzyMatch('abcd', 'abc')).toBeNull()
    // order matters: the characters are all there, but not in sequence
    expect(fuzzyMatch('ac', 'abc')).not.toBeNull()
    expect(fuzzyMatch('ca', 'abc')).toBeNull()
  })

  it('merges consecutive matches into one range', () => {
    const match = fuzzyMatch('foo', 'foobar')
    expect(match).not.toBeNull()
    expect(match!.ranges).toEqual([[0, 3]])
    expectWellFormed(match!.ranges, 'foobar')
  })

  it('splits ranges around skipped characters', () => {
    const match = fuzzyMatch('fooar', 'foobar')
    expect(match!.ranges).toEqual([
      [0, 3],
      [4, 6],
    ])
    expect(covered('foobar', match!.ranges)).toBe('fooar')
    expectWellFormed(match!.ranges, 'foobar')
  })

  it('is case-insensitive but reports ranges into the original target', () => {
    const target = 'FooBarBaz'
    const match = fuzzyMatch('bar', target)
    expect(match).not.toBeNull()
    expect(covered(target, match!.ranges)).toBe('Bar')
    expect(match!.ranges).toEqual([[3, 6]])
    expectWellFormed(match!.ranges, target)
  })

  it('handles "fb" against a camelCase name', () => {
    const match = fuzzyMatch('fb', 'FooBar')
    expect(match!.ranges).toEqual([
      [0, 1],
      [3, 4],
    ])
    // +12 first char, +8 camel hump, -2 for the two skipped characters
    expect(match!.score).toBe(18)
  })

  it('handles "fb" against a spaced name and prefers the word start', () => {
    const spaced = fuzzyMatch('fb', 'foo bar')
    expect(spaced!.ranges).toEqual([
      [0, 1],
      [4, 5],
    ])
    // +12 first char, +10 word start, -3 skipped
    expect(spaced!.score).toBe(19)
    // the same query on a run-together name has no word start to claim
    expect(score('fb', 'foo bar')).toBeGreaterThan(score('fb', 'foobar'))
  })

  it('scores an exact prefix above a scattered match', () => {
    const prefix = score('foo', 'foobar')
    const separated = score('foo', 'f-o-o')
    const scattered = score('foo', 'xxfxoxo')
    expect(prefix).toBe(12 + 16 + 16)
    expect(prefix).toBeGreaterThan(separated)
    expect(separated).toBeGreaterThan(scattered)
  })

  it('rewards a match at index 0 over the same match further in', () => {
    expect(score('abc', 'abcdef')).toBeGreaterThan(score('abc', 'zabcdef'))
  })

  it('backtracks past a greedy dead end to the better alignment', () => {
    // Greedy would take a@0, b@2, c@6 (score 18); the run at the end is worth 26.
    const target = 'a-bxabc'
    const match = fuzzyMatch('abc', target)
    expect(match!.ranges).toEqual([[4, 7]])
    expect(covered(target, match!.ranges)).toBe('abc')
    expect(match!.score).toBe(16 + 16 - 4 * 1.5)
  })

  it('prefers a word-start alignment over an earlier interior one', () => {
    const target = 'zebra bat'
    const match = fuzzyMatch('ba', target)
    // 'b' also occurs inside "zebra" at index 3, but "bat" starts a word.
    expect(match!.ranges).toEqual([[6, 8]])
  })

  it('penalises leading characters harder than interior ones', () => {
    // Both targets skip three characters in total and collect no position
    // bonus, so only *where* the gap sits can separate them.
    const mostlyLeading = score('ab', 'zzazb') // 2 leading (-3) + 1 interior (-1)
    const mostlyInterior = score('ab', 'zazzb') // 1 leading (-1.5) + 2 interior (-2)
    expect(mostlyLeading).toBe(-4)
    expect(mostlyInterior).toBe(-3.5)
    expect(mostlyInterior).toBeGreaterThan(mostlyLeading)
  })

  it('does not penalise characters after the last match', () => {
    expect(score('foo', 'foobar')).toBe(score('foo', 'foobarbazqux'))
  })

  it('treats path separators as word starts', () => {
    expect(score('d n', 'daily notes')).toBeGreaterThan(0)
    expect(score('dn', 'daily/notes')).toBe(12 + 10 - 5)
  })

  it('falls back to a greedy aligner on oversized targets without hanging', () => {
    const target = `${'x'.repeat(30000)}abc`
    const match = fuzzyMatch('abc', target)
    expect(match).not.toBeNull()
    expect(match!.ranges).toEqual([[30000, 30003]])
    expect(covered(target, match!.ranges)).toBe('abc')
    expectWellFormed(match!.ranges, target)
  })

  it('finds the optimal alignment, cross-checked against brute force', () => {
    // An independent, exhaustive implementation of the documented scoring
    // rules. If the banded dynamic program ever misses a better arrangement,
    // this disagrees.
    const SEPARATORS = ' \t\r\n/-_.'
    const scoreRef = (positions: number[], target: string): number => {
      let total = 0
      for (let i = 0; i < positions.length; i += 1) {
        const at = positions[i]
        if (at === 0) {
          total += 12
        } else {
          const before = target[at - 1]
          const here = target[at]
          if (SEPARATORS.includes(before)) total += 10
          const hereUpper = here !== here.toLowerCase() && here === here.toUpperCase()
          const beforeLower = before !== before.toUpperCase() && before === before.toLowerCase()
          if (hereUpper && beforeLower) total += 8
        }
        if (i === 0) total -= at * 1.5
        else if (at === positions[i - 1] + 1) total += 16
        else total -= at - positions[i - 1] - 1
      }
      return total
    }

    const brute = (query: string, target: string): number | null => {
      const q = query.toLowerCase()
      const t = target.toLowerCase()
      let best: number | null = null
      const positions: number[] = []
      const walk = (qi: number, from: number): void => {
        if (qi === q.length) {
          const value = scoreRef(positions, target)
          if (best === null || value > best) best = value
          return
        }
        for (let j = from; j < t.length; j += 1) {
          if (t[j] !== q[qi]) continue
          positions.push(j)
          walk(qi + 1, j + 1)
          positions.pop()
        }
      }
      walk(0, 0)
      return best
    }

    // Deterministic PRNG — a failure here must be reproducible.
    let seed = 0x2f6e2b1
    const rand = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % bound
    }
    const alphabet = 'abABc-/ .'
    const pick = (length: number): string => {
      let out = ''
      for (let i = 0; i < length; i += 1) out += alphabet[rand(alphabet.length)]
      return out
    }

    let compared = 0
    for (let trial = 0; trial < 400; trial += 1) {
      const target = pick(4 + rand(7))
      const query = pick(1 + rand(3))
      const expected = brute(query, target)
      const actual = fuzzyMatch(query, target)
      if (expected === null) {
        expect(actual).toBeNull()
        continue
      }
      expect(actual).not.toBeNull()
      expect(actual!.score).toBeCloseTo(expected, 10)
      expect(covered(target, actual!.ranges).toLowerCase()).toBe(query.toLowerCase())
      expectWellFormed(actual!.ranges, target)
      compared += 1
    }
    expect(compared).toBeGreaterThan(100)
  })

  it('keeps ranges aligned when the target contains characters that expand when lowercased', () => {
    const target = 'İstanbul Notes'
    const match = fuzzyMatch('nt', target)
    expect(match).not.toBeNull()
    expectWellFormed(match!.ranges, target)
    expect(covered(target, match!.ranges).toLowerCase()).toBe('nt')
  })
})

describe('highlight', () => {
  it('escapes HTML when there is nothing to highlight', () => {
    const out = highlight('<script>alert(1)</script>', [])
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).not.toContain('<script>')
  })

  it('escapes the highlighted text too', () => {
    const out = highlight('<script>', [[0, 8]])
    expect(out).toBe('<mark>&lt;script&gt;</mark>')
    expect(out).not.toContain('<script>')
  })

  it('escapes ampersands and quotes', () => {
    expect(highlight(`a & "b" 'c'`, [])).toBe('a &amp; &quot;b&quot; &#39;c&#39;')
  })

  it('wraps each range and keeps the surrounding text', () => {
    expect(highlight('foobar', [[0, 3]])).toBe('<mark>foo</mark>bar')
    expect(
      highlight('foobar', [
        [0, 1],
        [4, 5],
      ]),
    ).toBe('<mark>f</mark>oob<mark>a</mark>r')
  })

  it('tolerates out-of-order ranges', () => {
    expect(
      highlight('abcdef', [
        [4, 6],
        [0, 2],
      ]),
    ).toBe('<mark>ab</mark>cd<mark>ef</mark>')
  })

  it('clamps out-of-bounds ranges and drops empty ones', () => {
    expect(
      highlight('abc', [
        [-5, 2],
        [10, 20],
        [1, 1],
        [3, 1],
      ]),
    ).toBe('<mark>ab</mark>c')
  })

  it('merges overlapping and touching ranges into one mark', () => {
    expect(
      highlight('abcd', [
        [0, 2],
        [2, 4],
      ]),
    ).toBe('<mark>abcd</mark>')
    expect(
      highlight('abcd', [
        [0, 3],
        [1, 2],
      ]),
    ).toBe('<mark>abc</mark>d')
  })

  it('ignores non-finite range bounds', () => {
    expect(highlight('abc', [[NaN, 2]])).toBe('abc')
    expect(highlight('abc', [[0, Infinity]])).toBe('abc')
  })

  it('round-trips with fuzzyMatch ranges', () => {
    const target = 'Notes/Foo & Bar.md'
    const match = fuzzyMatch('fbar', target)
    expect(match).not.toBeNull()
    const out = highlight(target, match!.ranges)
    expect(out).toContain('&amp;')
    expect(out).not.toContain(' & ')
    // stripping the marks must give back the escaped original
    expect(out.replace(/<\/?mark>/g, '')).toBe(
      'Notes/Foo &amp; Bar.md',
    )
  })
})
