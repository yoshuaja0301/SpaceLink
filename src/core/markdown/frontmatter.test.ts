/**
 * Writing frontmatter back.
 *
 * The assertion that matters most in here is not about YAML at all: it is that
 * the body comes back byte for byte. Everything else is a value that has to
 * read back as itself, which is checked by parsing what was written — a
 * round trip, not a string comparison against what the author of the test
 * happened to expect the quoting to look like.
 */
import { describe, expect, it } from 'vitest'

import {
  readProperties,
  renameProperty,
  serializeFrontmatter,
  setProperty,
  withFrontmatter,
} from './frontmatter'

/** What a note's properties read back as after being written. */
function roundTrip(properties: Record<string, unknown>, body = 'body\n'): Record<string, unknown> {
  return readProperties(withFrontmatter(body, properties)) as Record<string, unknown>
}

describe('writing frontmatter', () => {
  it('leaves the body exactly as it was', () => {
    // The one thing that must never go wrong: a property edit cannot disturb a
    // character of what somebody wrote.
    const body = '# Title\n\nA line with --- in it, and a `---` fence:\n\n```\n---\nnot frontmatter\n---\n```\n\nEnd.\n'
    const written = withFrontmatter(`---\nold: value\n---\n\n${body}`, { fresh: 'value' })
    expect(written.endsWith(body)).toBe(true)
  })

  it('adds a block to a note that had none', () => {
    expect(withFrontmatter('# Title\n', { title: 'One' })).toBe('---\ntitle: One\n---\n\n# Title\n')
  })

  it('removes the block, and the blank line with it, when nothing is left', () => {
    // A note whose properties were all deleted should look like a note that
    // never had any.
    expect(withFrontmatter('---\ntitle: One\n---\n\n# Title\n', {})).toBe('# Title\n')
    expect(withFrontmatter('---\ntitle: One\n---\n# Title\n', {})).toBe('# Title\n')
  })

  it('does not push the note further down on every edit', () => {
    let source = '---\na: 1\n---\n\n# Title\n'
    for (let i = 0; i < 5; i += 1) source = setProperty(source, 'a', i)
    expect(source).toBe('---\na: 4\n---\n\n# Title\n')
  })

  it('reads back every kind of value as itself', () => {
    expect(
      roundTrip({
        title: 'A plain title',
        count: 42,
        done: true,
        nothing: null,
        tags: ['one', 'two'],
        empty: [],
      }),
    ).toEqual({
      title: 'A plain title',
      count: 42,
      done: true,
      nothing: null,
      tags: ['one', 'two'],
      empty: [],
    })
  })

  it('quotes a value that would otherwise mean something else', () => {
    // Each of these reads back as a different type, or not at all, unquoted.
    const awkward = {
      looksNumeric: '007',
      looksBoolean: 'true',
      looksNull: 'null',
      hasColon: 'ratio: 3',
      hasHash: 'a # b',
      leadingSpace: ' padded',
      trailingSpace: 'padded ',
      empty: '',
      startsWithDash: '- not a list',
      startsWithBracket: '[not a list]',
      hasQuote: 'she said "hi"',
      hasApostrophe: "it's fine",
    }
    expect(roundTrip(awkward)).toEqual(awkward)
  })

  it('quotes list items on the same terms as any other value', () => {
    // A neutral key on purpose. `tags` and `aliases` are normalised on the way
    // back in — see below — so they cannot tell a quoting bug from that.
    expect(roundTrip({ people: ['plain', 'true', '2024', 'has: colon', ''] }).people).toEqual([
      'plain',
      'true',
      '2024',
      'has: colon',
      '',
    ])
  })

  it('writes tags and aliases in the shape the parser normalises them into', () => {
    // These two keys are not plain lists on the way in: the parser strips a
    // leading `#`, drops blanks and de-duplicates. Writing them and reading
    // them back has to settle, or every save would churn the file.
    const once = withFrontmatter('body\n', { tags: ['one', 'two'], aliases: ['A', 'B'] })
    expect(withFrontmatter(once, readProperties(once) as Record<string, unknown>)).toBe(once)
    // And what the parser drops stays dropped rather than coming back empty.
    expect(roundTrip({ tags: ['keep', ''] }).tags).toEqual(['keep'])
  })

  it('refuses to write a key that would not read back as itself', () => {
    // A half-written key is worse than a missing one: it reads back as
    // something else, silently.
    expect(serializeFrontmatter({ 'has space': 1, 'has:colon': 2, '': 3, good: 4 })).toBe('good: 4')
  })

  it('drops a number with no YAML spelling rather than writing nonsense', () => {
    expect(serializeFrontmatter({ n: Number.NaN, i: Number.POSITIVE_INFINITY, ok: 1 })).toBe('ok: 1')
  })
})

describe('setting one property', () => {
  const note = '---\ntitle: One\ntags:\n  - a\nstatus: draft\n---\n\n# Body\n'

  it('keeps a property where it was rather than moving it to the end', () => {
    // Somebody watching the file should see a value change, not a reshuffle.
    expect(setProperty(note, 'title', 'Two')).toBe('---\ntitle: Two\ntags:\n  - a\nstatus: draft\n---\n\n# Body\n')
  })

  it('puts a new property last', () => {
    expect(setProperty(note, 'icon', '📘')).toContain('status: draft\nicon: 📘\n')
  })

  it('removes a property when given undefined', () => {
    const without = setProperty(note, 'tags', undefined)
    expect(readProperties(without).tags).toBeUndefined()
    expect(readProperties(without).title).toBe('One')
  })

  it('adds a block to a note that had none', () => {
    expect(setProperty('# Body\n', 'icon', '📘')).toBe('---\nicon: 📘\n---\n\n# Body\n')
  })
})

describe('renaming a property', () => {
  const note = '---\na: 1\nb: 2\nc: 3\n---\n\nBody\n'

  it('keeps its place among the others', () => {
    // Delete-then-add would send it to the end, which reads as the property
    // having moved rather than been renamed.
    expect(renameProperty(note, 'b', 'beta')).toBe('---\na: 1\nbeta: 2\nc: 3\n---\n\nBody\n')
  })

  it('leaves the note alone when there is nothing to rename', () => {
    expect(renameProperty(note, 'missing', 'x')).toBe(note)
    expect(renameProperty(note, 'b', 'b')).toBe(note)
  })

  it('removes the property when renamed to nothing', () => {
    expect(renameProperty(note, 'b', '')).toBe('---\na: 1\nc: 3\n---\n\nBody\n')
  })

  it('does not leave two properties with one name', () => {
    // Renaming `a` onto `b` has to consume the `b` that was there, or the file
    // holds a key twice and only one of them is ever read.
    const merged = renameProperty(note, 'a', 'b')
    expect(merged).toBe('---\nb: 1\nc: 3\n---\n\nBody\n')
  })
})
