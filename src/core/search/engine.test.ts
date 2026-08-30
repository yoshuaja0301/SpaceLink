import type { HeadingRef, Note, NotePath, ParsedNote } from '../../types'
import { parseQuery, quickSwitch, searchNotes } from './engine'

/**
 * Build a `Note` without going through the markdown parser, so these tests
 * exercise the search engine alone. Only the parsed fields search actually
 * reads are derived (title, headings, allTags); the rest are filled in with
 * empty defaults and can be overridden per fixture.
 */
function makeNote(path: NotePath, content: string, over: Partial<ParsedNote> = {}): Note {
  const headings: HeadingRef[] = []
  let offset = 0
  content.split('\n').forEach((text, index) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(text)
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2],
        slug: match[2].toLowerCase().replace(/\s+/g, '-'),
        start: offset,
        line: index + 1,
      })
    }
    offset += text.length + 1
  })

  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const name = fileName.replace(/\.md$/i, '')
  const firstH1 = headings.find((heading) => heading.level === 1)

  const parsed: ParsedNote = {
    frontmatter: {},
    frontmatterRaw: '',
    body: content,
    bodyOffset: 0,
    links: [],
    markdownLinks: [],
    tags: [],
    allTags: [],
    headings,
    tasks: [],
    title: firstH1 ? firstH1.text : name,
    excerpt: content.slice(0, 200),
    wordCount: content.split(/\s+/).filter(Boolean).length,
    ...over,
  }

  return { path, name, content, lineEnding: '\n', mtime: 0, parsed }
}

function vault(...notes: Note[]): Map<NotePath, Note> {
  return new Map(notes.map((note) => [note.path, note]))
}

const alpha = makeNote('Alpha.md', '# Alpha\n\nfoo bar baz\nsecond foo line\n', {
  allTags: ['project/alpha', 'active'],
})
const beta = makeNote('notes/Beta.md', '# Beta\n\nfoo only here\n', { allTags: ['project'] })
const gamma = makeNote('projects/Gamma Ray.md', '# Gamma Ray\n\nbar without the sibling word\n')
const basic = vault(alpha, beta, gamma)

describe('parseQuery', () => {
  it('splits bare terms and lowercases them', () => {
    expect(parseQuery('Foo Bar').terms).toEqual(['foo', 'bar'])
  })

  it('keeps quoted phrases together', () => {
    const filters = parseQuery('"Exact Phrase" loose')
    expect(filters.phrases).toEqual(['exact phrase'])
    expect(filters.terms).toEqual(['loose'])
  })

  it('collects excluded terms and excluded phrases', () => {
    const filters = parseQuery('keep -drop -"two words"')
    expect(filters.terms).toEqual(['keep'])
    expect(filters.excluded).toEqual(['drop', 'two words'])
  })

  it('treats a lone dash as a term', () => {
    expect(parseQuery('- x').terms).toEqual(['-', 'x'])
    expect(parseQuery('- x').excluded).toEqual([])
  })

  it('reads tag filters from both tag: and #', () => {
    const filters = parseQuery('tag:Project #Other tag:#Third')
    expect(filters.tags).toEqual(['project', 'other', 'third'])
    expect(filters.terms).toEqual([])
  })

  it('reads path and file filters', () => {
    const filters = parseQuery('path:Daily/ file:Index')
    expect(filters.paths).toEqual(['daily/'])
    expect(filters.files).toEqual(['index'])
  })

  it('supports a quoted value after a field prefix', () => {
    expect(parseQuery('tag:"my tag"').tags).toEqual(['my tag'])
    expect(parseQuery('path:"two words/"').paths).toEqual(['two words/'])
  })

  it('does not treat a quoted token as a field or a tag', () => {
    expect(parseQuery('"tag:x"').phrases).toEqual(['tag:x'])
    expect(parseQuery('"tag:x"').tags).toEqual([])
    expect(parseQuery('"#hash"').phrases).toEqual(['#hash'])
    expect(parseQuery('"#hash"').tags).toEqual([])
  })

  it('compiles a regex and preserves its case', () => {
    const filters = parseQuery('/Foo\\d+/gi')
    expect(filters.regex).toBeInstanceOf(RegExp)
    expect(filters.regex!.source).toBe('Foo\\d+')
    expect(filters.regex!.flags).toContain('i')
    expect(filters.terms).toEqual([])
  })

  it('keeps spaces and escaped slashes inside a regex', () => {
    const filters = parseQuery('/foo bar/')
    expect(filters.regex!.source).toBe('foo bar')
    expect(parseQuery('/a\\/b/').regex!.source).toBe('a\\/b')
  })

  it('falls back to a literal term when the regex will not compile', () => {
    const broken = parseQuery('/[/ keep')
    expect(broken.regex).toBeNull()
    expect(broken.terms).toEqual(['/[/', 'keep'])

    const badFlags = parseQuery('/ok/zz')
    expect(badFlags.regex).toBeNull()
    expect(badFlags.terms).toEqual(['/ok/zz'])
  })

  it('treats an unterminated slash as an ordinary term', () => {
    const filters = parseQuery('/unclosed')
    expect(filters.regex).toBeNull()
    expect(filters.terms).toEqual(['/unclosed'])
  })

  it('parses a query that uses every operator at once', () => {
    const filters = parseQuery('alpha "some phrase" -nope tag:work path:notes/ file:log /x[0-9]/')
    expect(filters).toMatchObject({
      terms: ['alpha'],
      phrases: ['some phrase'],
      excluded: ['nope'],
      tags: ['work'],
      paths: ['notes/'],
      files: ['log'],
    })
    expect(filters.regex!.source).toBe('x[0-9]')
  })

  it('ignores empty tokens', () => {
    expect(parseQuery('   ')).toMatchObject({ terms: [], phrases: [] })
    expect(parseQuery('""').phrases).toEqual([])
    expect(parseQuery('tag:').tags).toEqual([])
  })
})

describe('searchNotes', () => {
  it('returns nothing for an empty query', () => {
    expect(searchNotes('', basic)).toEqual([])
    expect(searchNotes('   ', basic)).toEqual([])
  })

  it('requires every term to be present (AND)', () => {
    const hits = searchNotes('foo bar', basic)
    expect(hits.map((hit) => hit.path)).toEqual(['Alpha.md'])
  })

  it('matches each term independently of the others', () => {
    expect(searchNotes('foo', basic).map((hit) => hit.path).sort()).toEqual([
      'Alpha.md',
      'notes/Beta.md',
    ])
  })

  it('drops notes containing an excluded term', () => {
    const hits = searchNotes('foo -baz', basic)
    expect(hits.map((hit) => hit.path)).toEqual(['notes/Beta.md'])
  })

  it('matches phrases as a unit', () => {
    const swapped = makeNote('Swapped.md', 'bar then foo, never together\n')
    const notes = vault(alpha, swapped)
    expect(searchNotes('"foo bar"', notes).map((hit) => hit.path)).toEqual(['Alpha.md'])
    // the same two words unquoted match both notes
    expect(searchNotes('foo bar', notes).map((hit) => hit.path).sort()).toEqual([
      'Alpha.md',
      'Swapped.md',
    ])
  })

  it('returns every note carrying a tag when the query is only a tag filter', () => {
    const hits = searchNotes('tag:project', basic)
    expect(hits.map((hit) => hit.path).sort()).toEqual(['Alpha.md', 'notes/Beta.md'])
    for (const hit of hits) {
      expect(hit.matches).toEqual([])
      expect(hit.total).toBe(0)
    }
  })

  it('matches nested tags below the filtered one', () => {
    expect(searchNotes('tag:project/alpha', basic).map((hit) => hit.path)).toEqual(['Alpha.md'])
    expect(searchNotes('#active', basic).map((hit) => hit.path)).toEqual(['Alpha.md'])
  })

  it('returns nothing when a filter matches no note', () => {
    expect(searchNotes('tag:missing', basic)).toEqual([])
    expect(searchNotes('tag:missing foo', basic)).toEqual([])
    expect(searchNotes('path:nowhere/ foo', basic)).toEqual([])
  })

  it('combines a filter with terms', () => {
    expect(searchNotes('tag:project foo', basic).map((hit) => hit.path).sort()).toEqual([
      'Alpha.md',
      'notes/Beta.md',
    ])
    expect(searchNotes('tag:project bar', basic).map((hit) => hit.path)).toEqual(['Alpha.md'])
  })

  it('filters on path fragments and file names', () => {
    expect(searchNotes('path:projects/ bar', basic).map((hit) => hit.path)).toEqual([
      'projects/Gamma Ray.md',
    ])
    expect(searchNotes('file:beta foo', basic).map((hit) => hit.path)).toEqual(['notes/Beta.md'])
    expect(searchNotes('file:Beta.md foo', basic).map((hit) => hit.path)).toEqual(['notes/Beta.md'])
  })

  it('reports line numbers, text and ranges for each match', () => {
    const hits = searchNotes('bar', vault(alpha))
    expect(hits).toHaveLength(1)
    expect(hits[0].matches).toEqual([{ line: 3, text: 'foo bar baz', ranges: [[4, 7]] }])
    expect(hits[0].total).toBe(1)
  })

  it('merges overlapping ranges from different terms on one line', () => {
    const note = makeNote('Overlap.md', 'alphabet\n')
    const hits = searchNotes('alpha phab', vault(note))
    expect(hits[0].matches[0].ranges).toEqual([[0, 6]])
  })

  it('is case-insensitive by default and exact when asked', () => {
    const note = makeNote('Case.md', 'Foo and foo\n')
    const notes = vault(note)

    const loose = searchNotes('foo', notes)
    expect(loose[0].matches[0].ranges).toEqual([
      [0, 3],
      [8, 11],
    ])

    const strict = searchNotes('foo', notes, { caseSensitive: true })
    expect(strict[0].matches[0].ranges).toEqual([[8, 11]])

    expect(searchNotes('FOO', notes, { caseSensitive: true })).toEqual([])
  })

  it('caps the reported line matches but keeps the true total', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `needle on line ${index + 1}`)
    const note = makeNote('Many.md', `${lines.join('\n')}\n`)
    const notes = vault(note)

    const capped = searchNotes('needle', notes)
    expect(capped[0].matches).toHaveLength(5)
    expect(capped[0].total).toBe(12)
    expect(capped[0].matches.map((match) => match.line)).toEqual([1, 2, 3, 4, 5])

    const three = searchNotes('needle', notes, { maxMatchesPerNote: 3 })
    expect(three[0].matches).toHaveLength(3)
    expect(three[0].total).toBe(12)

    const all = searchNotes('needle', notes, { maxMatchesPerNote: 100 })
    expect(all[0].matches).toHaveLength(12)
    expect(all[0].total).toBe(12)
  })

  it('counts several matches on the same line as one line match', () => {
    const note = makeNote('Repeat.md', 'ha ha ha\nha\n')
    const hits = searchNotes('ha', vault(note))
    expect(hits[0].total).toBe(2)
    expect(hits[0].matches[0].ranges).toHaveLength(3)
  })

  it('ranks a title hit above a heading hit above a body hit', () => {
    const titleHit = makeNote('Zeta.md', '# Zeta\n\nnothing else here\n')
    const headingHit = makeNote('One.md', '# One\n\n## Zeta section\n\nbody\n')
    const bodyHit = makeNote('Two.md', '# Two\n\nmentions zeta in passing\n')
    const hits = searchNotes('zeta', vault(bodyHit, headingHit, titleHit))
    expect(hits.map((hit) => hit.path)).toEqual(['Zeta.md', 'One.md', 'Two.md'])
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    expect(hits[1].score).toBeGreaterThan(hits[2].score)
  })

  it('weights title, heading, path and body exactly as documented', () => {
    const body = makeNote('body.md', 'term\n')
    const heading = makeNote('head.md', '## term\n')
    const title = makeNote('title.md', '# term\n')
    const inPath = makeNote('term/path.md', 'term\n')
    const scores = new Map(
      searchNotes('term', vault(body, heading, title, inPath)).map((hit) => [hit.path, hit.score]),
    )
    // Every note matches once on line 1, so the top-of-note bonus is the same 1.
    expect(scores.get('body.md')).toBe(1 + 1)
    expect(scores.get('head.md')).toBe(4 + 1)
    expect(scores.get('term/path.md')).toBe(2 + 1 + 1)
    // The H1 is both the title and a heading line.
    expect(scores.get('title.md')).toBe(8 + 4 + 1)
  })

  it('ranks more matches higher, and breaks ties on the shorter path', () => {
    const few = makeNote('a/few.md', 'term\n')
    const many = makeNote('b/many.md', 'term\nterm\nterm\n')
    expect(searchNotes('term', vault(few, many)).map((hit) => hit.path)).toEqual([
      'b/many.md',
      'a/few.md',
    ])

    const short = makeNote('x.md', 'term\n')
    const long = makeNote('deeper/folder/y.md', 'term\n')
    const alphabetical = makeNote('w.md', 'term\n')
    const tied = searchNotes('term', vault(long, short, alphabetical))
    expect(tied.map((hit) => hit.path)).toEqual(['w.md', 'x.md', 'deeper/folder/y.md'])
  })

  it('gives a small bonus to matches near the top of a note', () => {
    const top = makeNote('top.md', 'term\nfiller\nfiller\nfiller\nfiller\nfiller\n')
    const bottom = makeNote('bot.md', 'filler\nfiller\nfiller\nfiller\nfiller\nterm\n')
    const hits = searchNotes('term', vault(bottom, top))
    expect(hits.map((hit) => hit.path)).toEqual(['top.md', 'bot.md'])
    // the bonus must stay small — it may not outweigh a second match
    expect(hits[0].score - hits[1].score).toBeLessThan(1)

    const twice = makeNote('twice.md', 'filler\nfiller\nfiller\nfiller\nterm\nterm\n')
    const once = makeNote('once.md', 'term\nfiller\nfiller\nfiller\nfiller\nfiller\n')
    expect(searchNotes('term', vault(once, twice)).map((hit) => hit.path)).toEqual([
      'twice.md',
      'once.md',
    ])
  })

  it('searches with a regular expression', () => {
    const hits = searchNotes('/ba[rz]/', basic)
    expect(hits.map((hit) => hit.path).sort()).toEqual(['Alpha.md', 'projects/Gamma Ray.md'])
    expect(hits.find((hit) => hit.path === 'Alpha.md')!.matches[0].ranges).toEqual([
      [4, 7],
      [8, 11],
    ])
  })

  it('anchors a regex per line and ignores case unless asked', () => {
    const note = makeNote('Re.md', 'alpha\nBETA\ngamma\n')
    expect(searchNotes('/^beta$/', vault(note))[0].matches[0].line).toBe(2)
    expect(searchNotes('/^beta$/', vault(note), { caseSensitive: true })).toEqual([])
  })

  it('does not hang on a regex that matches the empty string', () => {
    const note = makeNote('Empty.md', 'one\ntwo\n')
    const hits = searchNotes('/o*/', vault(note))
    expect(hits).toHaveLength(1)
    expect(hits[0].total).toBeGreaterThan(0)
  })

  it('treats an uncompilable regex as literal text', () => {
    const note = makeNote('Odd.md', 'contains /[/ literally\n')
    expect(searchNotes('/[/', vault(note)).map((hit) => hit.path)).toEqual(['Odd.md'])
    expect(searchNotes('/[/', basic)).toEqual([])
  })

  it('honours the flags a regex was written with', () => {
    const upper = makeNote('Todo.md', 'TODO write the thing\n')
    const lower = makeNote('Done.md', 'todo lowercase mention\n')
    const notes = vault(upper, lower)
    const found = (query: string): string[] =>
      searchNotes(query, notes)
        .map((hit) => hit.path)
        .sort()

    // A bare pattern carries no flags of its own, so the option decides.
    expect(parseQuery('/TODO/').regex!.flags).toBe('')
    expect(found('/TODO/')).toEqual(['Done.md', 'Todo.md'])

    // Once the user writes flags the pattern means exactly what it says, and
    // nothing folds it behind their back.
    expect(found('/TODO/m')).toEqual(['Todo.md'])
    expect(found('/[A-Z]{4}/m')).toEqual(['Todo.md'])

    // ...including when the flag they wrote *is* `i`.
    expect(found('/TODO/i')).toEqual(['Done.md', 'Todo.md'])
  })

  it('collects every occurrence of a regex written with g or y', () => {
    const note = makeNote('Rep.md', 'foo one\nfoo two\nfoo three\n')
    for (const query of ['/foo/', '/foo/g', '/foo/y', '/foo/gy']) {
      const hits = searchNotes(query, vault(note))
      expect(hits).toHaveLength(1)
      expect(hits[0].total).toBe(3)
      expect(hits[0].matches.map((match) => match.line)).toEqual([1, 2, 3])
    }
  })

  it('matches on the path even when the text does not contain the term', () => {
    const hits = searchNotes('projects', basic)
    expect(hits.map((hit) => hit.path)).toEqual(['projects/Gamma Ray.md'])
    expect(hits[0].matches).toEqual([])
    expect(hits[0].total).toBe(0)
  })

  it('honours the result limit', () => {
    const notes = vault(
      makeNote('a.md', 'term\n'),
      makeNote('b.md', 'term\n'),
      makeNote('c.md', 'term\n'),
    )
    expect(searchNotes('term', notes, { limit: 2 })).toHaveLength(2)
    expect(searchNotes('term', notes, { limit: 0 })).toEqual([])
    expect(searchNotes('term', notes)).toHaveLength(3)
  })

  it('ignores a query made only of exclusions', () => {
    expect(searchNotes('-foo', basic)).toEqual([])
  })

  it('handles a large vault', () => {
    const notes = new Map<NotePath, Note>()
    for (let index = 0; index < 5000; index += 1) {
      const body = `# Note ${index}\n\nfiller text about things\nmore filler\n`
      const extra = index % 1000 === 0 ? 'unicorn sighting\n' : ''
      const note = makeNote(`folder${index % 20}/note-${index}.md`, body + extra)
      notes.set(note.path, note)
    }
    const started = Date.now()
    const hits = searchNotes('unicorn', notes)
    expect(hits).toHaveLength(5)
    expect(hits.every((hit) => hit.matches.length === 1)).toBe(true)
    // A whole-vault scan should be milliseconds, not seconds.
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('quickSwitch', () => {
  it('lists the first notes by path for an empty query', () => {
    const items = quickSwitch('', basic)
    expect(items.map((item) => item.path)).toEqual([
      'Alpha.md',
      'notes/Beta.md',
      'projects/Gamma Ray.md',
    ])
    expect(items.every((item) => item.create === undefined)).toBe(true)
    expect(items[0]).toMatchObject({ title: 'Alpha', subtitle: 'Alpha.md', ranges: [] })

    expect(quickSwitch('   ', basic).map((item) => item.path)).toEqual([
      'Alpha.md',
      'notes/Beta.md',
      'projects/Gamma Ray.md',
    ])
    expect(quickSwitch('', basic, 2)).toHaveLength(2)
  })

  it('fuzzy-matches the basename and highlights it', () => {
    const items = quickSwitch('bet', basic)
    expect(items[0]).toMatchObject({
      path: 'notes/Beta.md',
      title: 'Beta',
      subtitle: 'notes/Beta.md',
      ranges: [[0, 3]],
    })
  })

  it('ranks a basename match above a path-only match', () => {
    const named = makeNote('Alpha.md', '')
    const foldered = makeNote('alpha-notes/Beta.md', '')
    const items = quickSwitch('alpha', vault(foldered, named))
    expect(items.map((item) => item.path)).toEqual(['Alpha.md', 'alpha-notes/Beta.md'])
    expect(items[0].score).toBeGreaterThan(items[1].score)
  })

  it('still matches when only the full path matches', () => {
    const note = makeNote('projects/Alpha.md', '')
    const items = quickSwitch('proal', vault(note))
    expect(items).toHaveLength(1)
    expect(items[0].create).toBeUndefined()
    // ranges always index the displayed title, so the folder part is dropped
    expect(items[0].title).toBe('Alpha')
    expect(items[0].ranges).toEqual([[0, 2]])
  })

  it('drops path ranges that fall entirely inside a folder segment', () => {
    const items = quickSwitch('proj', vault(gamma))
    expect(items.map((item) => item.path)).toEqual(['projects/Gamma Ray.md'])
    expect(items[0].ranges).toEqual([])
  })

  it('offers to create a note when nothing matches', () => {
    const items = quickSwitch('Zebra Quest', basic)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      create: true,
      title: 'Zebra Quest',
      subtitle: 'Create new note',
      score: 0,
      ranges: [],
    })
    expect(items[0].path).toBe('Zebra Quest.md')
    expect(quickSwitch('Already.md', basic)[0].path).toBe('Already.md')
  })

  it('never offers to create for an empty query', () => {
    expect(quickSwitch('', new Map())).toEqual([])
    expect(quickSwitch('x', new Map())).toHaveLength(1)
    expect(quickSwitch('x', new Map())[0].create).toBe(true)
  })

  it('sorts by score, breaking ties on the path, and honours the limit', () => {
    // All three basenames start with "note", so the scores tie exactly and the
    // path decides the order.
    const tied = vault(
      makeNote('b/note.md', ''),
      makeNote('a/note.md', ''),
      makeNote('note-extra.md', ''),
    )
    const items = quickSwitch('note', tied)
    expect(items.map((item) => item.path)).toEqual(['a/note.md', 'b/note.md', 'note-extra.md'])
    expect(new Set(items.map((item) => item.score)).size).toBe(1)
    expect(quickSwitch('note', tied, 1)).toHaveLength(1)
    expect(quickSwitch('note', tied, 0)).toEqual([])

    // Distinct alignments must sort by quality, not by path.
    const ranked = vault(
      makeNote('zzz/nope-toe.md', ''),
      makeNote('aaa/my-note.md', ''),
      makeNote('mmm/note.md', ''),
    )
    expect(quickSwitch('note', ranked).map((item) => item.title)).toEqual([
      'note',
      'my-note',
      'nope-toe',
    ])
  })

  it('handles a large vault', () => {
    const notes = new Map<NotePath, Note>()
    for (let index = 0; index < 5000; index += 1) {
      const note = makeNote(`folder${index % 20}/Meeting Notes ${index}.md`, '')
      notes.set(note.path, note)
    }
    const started = Date.now()
    const items = quickSwitch('mn', notes, 10)
    expect(items).toHaveLength(10)
    expect(items.every((item) => item.create === undefined)).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
