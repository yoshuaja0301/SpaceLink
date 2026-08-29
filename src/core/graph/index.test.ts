import type { Note, NoteFrontmatter, TagRef, WikiLink } from '../../types'
import {
  buildGraphData,
  buildIndex,
  emptyIndex,
  getBacklinks,
  getOrphans,
  getTagTree,
  getUnresolvedLinks,
  resolveLinkTarget,
} from './index'

/* ------------------------------------------------------------------ *
 * Fixtures
 *
 * The graph layer only ever reads `note.content` plus the handful of fields
 * the markdown layer fills in, so these tests build `Note`s with a tiny local
 * scanner instead of depending on `parseNote`. That keeps the graph tests
 * honest about *their* module and immune to churn in the parser.
 * ------------------------------------------------------------------ */

function fixture(path: string, content = '', frontmatter: NoteFrontmatter = {}): Note {
  const file = path.slice(path.lastIndexOf('/') + 1)
  const name = file.toLowerCase().endsWith('.md') ? file.slice(0, -3) : file

  const lineOf = (offset: number): number => content.slice(0, offset).split('\n').length

  const links: WikiLink[] = []
  const wiki = /(!?)\[\[([^\]\n]+)\]\]/g
  let match: RegExpExecArray | null
  while ((match = wiki.exec(content)) !== null) {
    const raw = match[0]
    const inner = match[2]!
    const pipe = inner.indexOf('|')
    const linkPart = pipe === -1 ? inner : inner.slice(0, pipe)
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim()
    const fragmentAt = linkPart.search(/[#^]/)
    const target = (fragmentAt === -1 ? linkPart : linkPart.slice(0, fragmentAt)).trim()
    const fragment = fragmentAt === -1 ? '' : linkPart.slice(fragmentAt)
    const start = match.index
    links.push({
      raw,
      target,
      heading: fragment.startsWith('#') ? fragment.slice(1) : undefined,
      blockId: fragment.startsWith('^') ? fragment.slice(1) : undefined,
      alias,
      embed: match[1] === '!',
      start,
      end: start + raw.length,
      line: lineOf(start),
    })
  }

  const tags: TagRef[] = []
  const tagPattern = /(^|[\s(])#([A-Za-z][\w/-]*)/gm
  while ((match = tagPattern.exec(content)) !== null) {
    const tag = match[2]!
    const start = match.index + match[1]!.length
    tags.push({ tag, start, end: start + tag.length + 1, line: lineOf(start) })
  }

  const frontmatterTags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : []
  const allTags = [...new Set([...frontmatterTags, ...tags.map((t) => t.tag)])]
  const h1 = /^#\s+(.+)$/m.exec(content)
  const title = frontmatter.title || h1?.[1]?.trim() || name

  return {
    path,
    name,
    content,
    mtime: 0,
    parsed: {
      frontmatter,
      frontmatterRaw: '',
      body: content,
      bodyOffset: 0,
      links,
      markdownLinks: [],
      tags,
      allTags,
      headings: [],
      tasks: [],
      title,
      excerpt: content.slice(0, 200),
      wordCount: content.split(/\s+/).filter(Boolean).length,
    },
  }
}

function vault(...notes: Note[]): Map<string, Note> {
  return new Map(notes.map((note) => [note.path, note]))
}

/* ------------------------------------------------------------------ *
 * Index construction
 * ------------------------------------------------------------------ */

describe('emptyIndex', () => {
  it('returns five independent empty maps', () => {
    const a = emptyIndex()
    const b = emptyIndex()
    expect(a.outgoing.size).toBe(0)
    expect(a.incoming.size).toBe(0)
    expect(a.unresolved.size).toBe(0)
    expect(a.tags.size).toBe(0)
    expect(a.byName.size).toBe(0)
    a.byName.set('x', ['x.md'])
    expect(b.byName.size).toBe(0)
  })
})

describe('buildIndex — byName', () => {
  it('registers basename, full path, path without .md and every alias, lowercased', () => {
    const index = buildIndex(vault(fixture('Notes/Alpha Note.md', '', { aliases: ['A1', 'First Note'] })))
    expect([...index.byName.keys()].sort()).toEqual([
      'a1',
      'alpha note',
      'first note',
      'notes/alpha note',
      'notes/alpha note.md',
    ])
    expect(index.byName.get('alpha note')).toEqual(['Notes/Alpha Note.md'])
  })

  it('never registers the same note twice under one key', () => {
    // At the vault root the basename and the path-without-extension collide,
    // and here an alias collides with both.
    const index = buildIndex(vault(fixture('Alpha.md', '', { aliases: ['alpha', 'ALPHA'] })))
    expect(index.byName.get('alpha')).toEqual(['Alpha.md'])
  })

  it('collects every homonym under one key', () => {
    const index = buildIndex(vault(fixture('x/Note.md'), fixture('y/Note.md')))
    expect(index.byName.get('note')).toEqual(['x/Note.md', 'y/Note.md'])
  })

  it('ignores non-string aliases instead of throwing', () => {
    const index = buildIndex(vault(fixture('A.md', '', { aliases: [42, null, 'ok'] as unknown as string[] })))
    expect(index.byName.get('ok')).toEqual(['A.md'])
    expect(index.byName.has('42')).toBe(false)
  })

  it('indexes inline and frontmatter tags, deduped per note', () => {
    const index = buildIndex(
      vault(
        fixture('A.md', 'body #idea and #idea again', { tags: ['project/alpha'] }),
        fixture('B.md', 'only #idea here'),
      ),
    )
    expect(index.tags.get('idea')).toEqual(['A.md', 'B.md'])
    expect(index.tags.get('project/alpha')).toEqual(['A.md'])
  })
})

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

describe('resolveLinkTarget', () => {
  const homonyms = () =>
    buildIndex(
      vault(
        fixture('Alpha.md'),
        fixture('archive/Alpha.md'),
        fixture('deep/nested/Note.md'),
        fixture('Note.md'),
      ),
    )

  it('prefers an exact path match over a same-folder basename match', () => {
    const index = homonyms()
    // `archive/Alpha.md` is in the same folder as the source and would win the
    // basename tiebreak — the exact path match outranks it.
    expect(resolveLinkTarget('Alpha.md', 'archive/Source.md', index)).toBe('Alpha.md')
  })

  it('resolves a path + .md', () => {
    const index = homonyms()
    expect(resolveLinkTarget('archive/Alpha', 'Source.md', index)).toBe('archive/Alpha.md')
    expect(resolveLinkTarget('deep/nested/Note', 'Source.md', index)).toBe('deep/nested/Note.md')
  })

  it('falls back to the basename when the written path does not exist', () => {
    const index = homonyms()
    expect(resolveLinkTarget('missing/folder/Note', 'Source.md', index)).toBe('Note.md')
  })

  it('prefers a basename over an alias, whatever order the notes were indexed in', () => {
    const beta = fixture('Beta.md')
    const gamma = fixture('Gamma.md', '', { aliases: ['Beta'] })
    expect(resolveLinkTarget('Beta', 'Source.md', buildIndex(vault(beta, gamma)))).toBe('Beta.md')
    expect(resolveLinkTarget('Beta', 'Source.md', buildIndex(vault(gamma, beta)))).toBe('Beta.md')
  })

  it('resolves through an alias when no note carries that basename', () => {
    const index = buildIndex(vault(fixture('Gamma.md', '', { aliases: ['Second Brain'] })))
    expect(resolveLinkTarget('Second Brain', 'Source.md', index)).toBe('Gamma.md')
    expect(resolveLinkTarget('second brain', 'Source.md', index)).toBe('Gamma.md')
  })

  it('breaks homonyms on the same folder first', () => {
    const index = buildIndex(vault(fixture('x/Note.md'), fixture('y/Note.md')))
    expect(resolveLinkTarget('Note', 'x/Other.md', index)).toBe('x/Note.md')
    expect(resolveLinkTarget('Note', 'y/Other.md', index)).toBe('y/Note.md')
  })

  it('prefers the note next door to a vault-root homonym', () => {
    // `[[Note]]` is a bare name, not the path `Note.md`, so the same-folder
    // rule outranks the root note whose path happens to spell the same thing.
    const index = buildIndex(vault(fixture('x/Note.md'), fixture('Note.md')))
    expect(resolveLinkTarget('Note', 'x/Source.md', index)).toBe('x/Note.md')
    // From the root the root note *is* the neighbour, so it wins there.
    expect(resolveLinkTarget('Note', 'Source.md', index)).toBe('Note.md')
  })

  it('keeps a same-folder homonym from being outranked by a root-level one', () => {
    const notes = vault(fixture('Foo.md'), fixture('Bar/Foo.md'), fixture('Bar/Baz.md', 'see [[Foo]]'))
    const index = buildIndex(notes)
    expect(resolveLinkTarget('Foo', 'Bar/Baz.md', index)).toBe('Bar/Foo.md')
    // The backlink and the graph edge follow the same answer.
    expect((index.incoming.get('Bar/Foo.md') ?? []).map((edge) => edge.from)).toEqual(['Bar/Baz.md'])
    expect(index.incoming.has('Foo.md')).toBe(false)

    // Resolution must not depend on where the *other* homonym happens to sit:
    // moving it out of the root leaves the same target.
    const moved = buildIndex(vault(fixture('Root/Foo.md'), fixture('Bar/Foo.md'), fixture('Bar/Baz.md', '[[Foo]]')))
    expect(resolveLinkTarget('Foo', 'Bar/Baz.md', moved)).toBe('Bar/Foo.md')
  })

  it('never lets a same-folder alias outrank a note that carries the name', () => {
    const index = buildIndex(vault(fixture('x/Holder.md', '', { aliases: ['Note'] }), fixture('y/Note.md')))
    expect(resolveLinkTarget('Note', 'x/Source.md', index)).toBe('y/Note.md')
  })

  it('breaks homonyms on the shortest path, then deterministically', () => {
    const index = buildIndex(vault(fixture('deep/nested/Note.md'), fixture('a/Note.md')))
    // From an unrelated folder, with no root-level `Note.md`: shortest path wins.
    expect(resolveLinkTarget('Note', 'other/Source.md', index)).toBe('a/Note.md')
    // Equal-length paths fall back to lexicographic order, not insertion order.
    const tie = buildIndex(vault(fixture('yy/Note.md'), fixture('xx/Note.md')))
    expect(resolveLinkTarget('Note', 'other/Source.md', tie)).toBe('xx/Note.md')
    const tieReversed = buildIndex(vault(fixture('xx/Note.md'), fixture('yy/Note.md')))
    expect(resolveLinkTarget('Note', 'other/Source.md', tieReversed)).toBe('xx/Note.md')
  })

  it('is case-insensitive on basenames, paths and aliases', () => {
    const index = buildIndex(vault(fixture('Notes/Alpha Note.md', '', { aliases: ['First'] })))
    expect(resolveLinkTarget('ALPHA NOTE', 'Source.md', index)).toBe('Notes/Alpha Note.md')
    expect(resolveLinkTarget('nOtEs/aLpHa nOtE.MD', 'Source.md', index)).toBe('Notes/Alpha Note.md')
    expect(resolveLinkTarget('fIrSt', 'Source.md', index)).toBe('Notes/Alpha Note.md')
  })

  it('strips heading, block and display fragments before resolving', () => {
    const index = buildIndex(vault(fixture('Alpha.md')))
    expect(resolveLinkTarget('Alpha#Some Heading', 'Source.md', index)).toBe('Alpha.md')
    expect(resolveLinkTarget('Alpha^block-1', 'Source.md', index)).toBe('Alpha.md')
    expect(resolveLinkTarget('Alpha#Heading|Display', 'Source.md', index)).toBe('Alpha.md')
    expect(resolveLinkTarget('  Alpha  ', 'Source.md', index)).toBe('Alpha.md')
    expect(resolveLinkTarget('./Alpha', 'Source.md', index)).toBe('Alpha.md')
  })

  it('resolves a fragment-only link to the note it was written in', () => {
    const index = buildIndex(vault(fixture('Alpha.md')))
    expect(resolveLinkTarget('#Some Heading', 'Notes/Here.md', index)).toBe('Notes/Here.md')
    expect(resolveLinkTarget('^block-1', 'Notes/Here.md', index)).toBe('Notes/Here.md')
    expect(resolveLinkTarget('   ', 'Notes/Here.md', index)).toBe('Notes/Here.md')
    // Even against a completely empty index.
    expect(resolveLinkTarget('#Top', 'Notes/Here.md', emptyIndex())).toBe('Notes/Here.md')
  })

  it('returns null for a target no note answers to', () => {
    expect(resolveLinkTarget('Ghost', 'Source.md', buildIndex(vault(fixture('Alpha.md'))))).toBeNull()
    expect(resolveLinkTarget('Ghost', 'Source.md', emptyIndex())).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

describe('buildIndex — edges', () => {
  it('records outgoing and incoming edges with context, line, embed and target text', () => {
    const source = fixture(
      'Source.md',
      ['# Source', '', '   See [[Alpha|the alpha note]] for details.', '', '![[Alpha]]'].join('\n'),
    )
    const index = buildIndex(vault(source, fixture('Alpha.md')))

    const outgoing = index.outgoing.get('Source.md')!
    expect(outgoing).toHaveLength(2)
    expect(outgoing[0]).toMatchObject({
      from: 'Source.md',
      to: 'Alpha.md',
      targetText: 'Alpha',
      embed: false,
      line: 3,
      context: 'See [[Alpha|the alpha note]] for details.',
    })
    expect(outgoing[1]).toMatchObject({ embed: true, line: 5, context: '![[Alpha]]' })
    expect(index.incoming.get('Alpha.md')).toHaveLength(2)
    expect(index.incoming.has('Source.md')).toBe(false)
  })

  it('clips a long context line to 220 characters', () => {
    const long = `${'x'.repeat(400)} [[Alpha]]`
    const index = buildIndex(vault(fixture('Source.md', `   ${long}`), fixture('Alpha.md')))
    const edge = index.outgoing.get('Source.md')![0]!
    expect(edge.context).toHaveLength(220)
    expect(edge.context.startsWith('xxx')).toBe(true)
  })

  it('groups unresolved links under one lowercased, fragment-free key', () => {
    const index = buildIndex(
      vault(
        fixture('A.md', '[[Ghost]] and [[ghost#Section]]'),
        fixture('B.md', '[[GHOST|spooky]]'),
        fixture('C.md', '[[Other]]'),
      ),
    )
    expect([...index.unresolved.keys()].sort()).toEqual(['ghost', 'other'])
    expect(index.unresolved.get('ghost')).toHaveLength(3)
    expect(index.unresolved.get('ghost')!.map((edge) => edge.from)).toEqual(['A.md', 'A.md', 'B.md'])
    // Unresolved edges still appear in `outgoing`, with a null target.
    expect(index.outgoing.get('A.md')!.every((edge) => edge.to === null)).toBe(true)
  })

  it('treats a self-link and a fragment-only link as edges onto the note itself', () => {
    const index = buildIndex(vault(fixture('Self.md', '[[Self]]\n[[#Heading]]')))
    const outgoing = index.outgoing.get('Self.md')!
    expect(outgoing.map((edge) => edge.to)).toEqual(['Self.md', 'Self.md'])
    expect(outgoing[1]!.targetText).toBe('')
    expect(index.incoming.get('Self.md')).toHaveLength(2)
    expect(index.unresolved.size).toBe(0)
    // ...but they are not backlinks.
    expect(getBacklinks('Self.md', index, vault(fixture('Self.md', '[[Self]]')))).toEqual([])
  })

  it('leaves notes without links out of the edge maps', () => {
    const index = buildIndex(vault(fixture('Lonely.md', 'no links here')))
    expect(index.outgoing.has('Lonely.md')).toBe(false)
    expect(index.incoming.has('Lonely.md')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Attachment embeds
 * ------------------------------------------------------------------ */

describe('buildIndex — attachment embeds', () => {
  it('leaves an image embed out of the link index instead of calling it unresolved', () => {
    const notes = vault(fixture('Note.md', '![[diagram.png]]\n![[photos/trip.jpg|400]]'))
    const index = buildIndex(notes)

    expect(getUnresolvedLinks(index)).toEqual([])
    expect(index.outgoing.has('Note.md')).toBe(false)
    // …so the graph draws no phantom "missing note" placeholder for a picture.
    const graph = buildGraphData(notes, index, { showUnresolved: true, showTags: false })
    expect(graph.nodes.map((node) => node.id)).toEqual(['Note.md'])
  })

  it('still records an embed of a note that does not exist', () => {
    const index = buildIndex(vault(fixture('Note.md', '![[Missing Note]]\n![[gone.md]]')))
    expect(getUnresolvedLinks(index)).toEqual([
      { target: 'gone.md', count: 1 },
      { target: 'missing note', count: 1 },
    ])
  })

  it('keeps an embed whose target really is a note with a dot in its name', () => {
    const notes = vault(fixture('Note.md', '![[Version 1.2]]'), fixture('Version 1.2.md'))
    expect(buildIndex(notes).incoming.get('Version 1.2.md')).toHaveLength(1)
  })

  it('only skips embeds, not plain links, to an attachment name', () => {
    const index = buildIndex(vault(fixture('Note.md', '[[diagram.png]]')))
    expect(getUnresolvedLinks(index)).toEqual([{ target: 'diagram.png', count: 1 }])
  })
})

/* ------------------------------------------------------------------ *
 * Tag case
 * ------------------------------------------------------------------ */

describe('buildIndex — tag case', () => {
  it('groups tags case-insensitively, keeping the first casing for display', () => {
    const notes = vault(fixture('A.md', 'text #Project'), fixture('B.md', 'text #project'))
    const index = buildIndex(notes)

    expect([...index.tags.keys()]).toEqual(['Project'])
    expect(index.tags.get('Project')).toEqual(['A.md', 'B.md'])
    expect(getTagTree(index).map((node) => [node.fullTag, node.count, node.totalCount])).toEqual([['Project', 2, 2]])

    const graph = buildGraphData(notes, index, { showUnresolved: false, showTags: true })
    expect(graph.nodes.filter((node) => node.id.startsWith('#')).map((node) => node.id)).toEqual(['#Project'])
  })

  it('nests differently cased branches of one tag under a single parent', () => {
    const index = buildIndex(vault(fixture('A.md', 'text #Project/alpha'), fixture('B.md', 'text #project/beta')))
    const tree = getTagTree(index)

    expect(tree).toHaveLength(1)
    expect(tree[0]!.fullTag).toBe('Project')
    expect(tree[0]!.totalCount).toBe(2)
    expect(tree[0]!.children.map((child) => child.fullTag)).toEqual(['Project/alpha', 'Project/beta'])
  })
})

/* ------------------------------------------------------------------ *
 * Backlinks
 * ------------------------------------------------------------------ */

describe('getBacklinks', () => {
  const notes = vault(
    fixture('Target.md'),
    fixture('Zed.md', ['[[Target]] first mention', '', 'and [[Target#Later]] again'].join('\n'), {
      title: 'apple pie',
    }),
    fixture('Ann.md', 'one [[Target]] here', { title: 'Banana' }),
    fixture('Nope.md', 'no links'),
  )
  const index = buildIndex(notes)

  it('groups edges by source note and sorts groups by title, case-insensitively', () => {
    const groups = getBacklinks('Target.md', index, notes)
    expect(groups.map((group) => group.title)).toEqual(['apple pie', 'Banana'])
    expect(groups.map((group) => group.source)).toEqual(['Zed.md', 'Ann.md'])
  })

  it('sorts the edges inside a group by line and carries the source line as context', () => {
    const [apple] = getBacklinks('Target.md', index, notes)
    expect(apple!.edges.map((edge) => edge.line)).toEqual([1, 3])
    expect(apple!.edges.map((edge) => edge.context)).toEqual([
      '[[Target]] first mention',
      'and [[Target#Later]] again',
    ])
  })

  it('falls back to the basename when the source note is missing from the map', () => {
    const groups = getBacklinks('Target.md', index, new Map())
    expect(groups.map((group) => group.title)).toEqual(['Ann', 'Zed'])
  })

  it('returns an empty array for a note nothing links to', () => {
    expect(getBacklinks('Nope.md', index, notes)).toEqual([])
    expect(getBacklinks('Unknown.md', index, notes)).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Unresolved links & orphans
 * ------------------------------------------------------------------ */

describe('getUnresolvedLinks', () => {
  it('sorts by count descending, then by name', () => {
    const index = buildIndex(
      vault(
        fixture('A.md', '[[Ghost]] [[Ghost]] [[Zeta]]'),
        fixture('B.md', '[[ghost]] [[Alpha Ghost]]'),
        fixture('C.md', '[[Zeta]]'),
      ),
    )
    expect(getUnresolvedLinks(index)).toEqual([
      { target: 'ghost', count: 3 },
      { target: 'zeta', count: 2 },
      { target: 'alpha ghost', count: 1 },
    ])
  })

  it('is empty when every link resolves', () => {
    const index = buildIndex(vault(fixture('A.md', '[[B]]'), fixture('B.md')))
    expect(getUnresolvedLinks(index)).toEqual([])
  })
})

describe('getOrphans', () => {
  it('lists notes with no incoming and no resolved outgoing links', () => {
    const notes = vault(
      fixture('Hub.md', '[[Leaf]]'),
      fixture('Leaf.md'),
      fixture('Lonely.md', 'nothing to see'),
      fixture('Wisher.md', '[[Nonexistent]]'),
      fixture('Selfish.md', '[[Selfish]]'),
    )
    // `Wisher` only links at a note that does not exist and `Selfish` only at
    // itself, so neither is actually connected to anything.
    expect(getOrphans(notes, buildIndex(notes))).toEqual(['Lonely.md', 'Selfish.md', 'Wisher.md'])
  })

  it('returns every note for a vault without links, and nothing for a linked pair', () => {
    const isolated = vault(fixture('B.md'), fixture('A.md'))
    expect(getOrphans(isolated, buildIndex(isolated))).toEqual(['A.md', 'B.md'])
    const linked = vault(fixture('A.md', '[[B]]'), fixture('B.md'))
    expect(getOrphans(linked, buildIndex(linked))).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Tag tree
 * ------------------------------------------------------------------ */

describe('getTagTree', () => {
  const index = buildIndex(
    vault(
      fixture('A.md', 'text #project #project/alpha'),
      fixture('B.md', 'text #project/alpha'),
      fixture('C.md', 'text #project/beta/ui'),
      fixture('D.md', 'text #zzz'),
    ),
  )

  it('nests tags on / and counts exact vs. subtree membership', () => {
    const [project] = getTagTree(index)
    expect(project!.name).toBe('project')
    expect(project!.fullTag).toBe('project')
    expect(project!.count).toBe(1) // only A carries the bare `#project`
    expect(project!.totalCount).toBe(3) // A, B and C, each counted once
    expect(project!.children.map((child) => child.fullTag)).toEqual(['project/alpha', 'project/beta'])

    const [alpha, beta] = project!.children
    expect(alpha).toMatchObject({ name: 'alpha', count: 2, totalCount: 2, children: [] })
    // An intermediate segment nobody tagged directly still exists, with count 0.
    expect(beta).toMatchObject({ name: 'beta', count: 0, totalCount: 1 })
    expect(beta!.children[0]).toMatchObject({ name: 'ui', fullTag: 'project/beta/ui', count: 1, totalCount: 1 })
  })

  it('sorts siblings by totalCount descending, then by name', () => {
    expect(getTagTree(index).map((node) => node.name)).toEqual(['project', 'zzz'])
    const tied = buildIndex(vault(fixture('A.md', '#zebra #apple #mango')))
    expect(getTagTree(tied).map((node) => node.name)).toEqual(['apple', 'mango', 'zebra'])
  })

  it('is empty for a vault without tags', () => {
    expect(getTagTree(buildIndex(vault(fixture('A.md', 'plain text'))))).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

describe('buildGraphData', () => {
  const notes = vault(
    fixture('A.md', 'links [[B]] twice: [[B]] and a [[Ghost]] #idea', { title: 'Alpha' }),
    fixture('B.md', 'links [[C]] #idea'),
    fixture('C.md', 'no outgoing links'),
    fixture('D.md', 'orphan'),
  )
  const index = buildIndex(notes)
  const plain = { showUnresolved: false, showTags: false }

  it('emits one node per note and merges parallel links into a counted edge', () => {
    const graph = buildGraphData(notes, index, plain)
    expect(graph.nodes.map((node) => node.id)).toEqual(['A.md', 'B.md', 'C.md', 'D.md'])
    expect(graph.nodes[0]!.label).toBe('Alpha')
    expect(graph.nodes.every((node) => node.unresolved === false)).toBe(true)
    expect(graph.edges).toEqual([
      { source: 'A.md', target: 'B.md', count: 2 },
      { source: 'B.md', target: 'C.md', count: 1 },
    ])
  })

  it('computes degree from the merged edges and derives the radius from it', () => {
    const graph = buildGraphData(notes, index, plain)
    const degrees = Object.fromEntries(graph.nodes.map((node) => [node.id, node.degree]))
    expect(degrees).toEqual({ 'A.md': 1, 'B.md': 2, 'C.md': 1, 'D.md': 0 })
    const radii = Object.fromEntries(graph.nodes.map((node) => [node.id, node.radius]))
    expect(radii['D.md']).toBe(4)
    expect(radii['A.md']).toBe(4 + 3)
    expect(radii['B.md']).toBeCloseTo(4 + Math.sqrt(2) * 3, 10)
  })

  it('caps the radius at 14 for very well-connected notes', () => {
    const hub = fixture('Hub.md', Array.from({ length: 30 }, (_, i) => `[[N${i}]]`).join(' '))
    const many = vault(hub, ...Array.from({ length: 30 }, (_, i) => fixture(`N${i}.md`)))
    const graph = buildGraphData(many, buildIndex(many), plain)
    const hubNode = graph.nodes.find((node) => node.id === 'Hub.md')!
    expect(hubNode.degree).toBe(30)
    expect(hubNode.radius).toBe(14)
  })

  it('lays nodes out on a deterministic golden-angle spiral with zero velocity', () => {
    const graph = buildGraphData(notes, index, plain)
    expect(graph.nodes[0]!.x).toBe(0)
    expect(graph.nodes[0]!.y).toBe(0)
    expect(graph.nodes[1]!.x).toBeCloseTo(12 * Math.cos(2.399963), 10)
    expect(graph.nodes[1]!.y).toBeCloseTo(12 * Math.sin(2.399963), 10)
    expect(graph.nodes[2]!.x).toBeCloseTo(12 * Math.sqrt(2) * Math.cos(2 * 2.399963), 10)
    expect(graph.nodes.every((node) => node.vx === 0 && node.vy === 0)).toBe(true)
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  })

  it('produces byte-identical output on repeated builds', () => {
    const first = buildGraphData(notes, index, { showUnresolved: true, showTags: true })
    const second = buildGraphData(notes, buildIndex(notes), { showUnresolved: true, showTags: true })
    expect(second).toEqual(first)
    // ...and does not hand out the same mutable objects twice.
    expect(second.nodes[0]).not.toBe(first.nodes[0])
  })

  it('adds placeholder nodes for unresolved targets only when asked', () => {
    expect(buildGraphData(notes, index, plain).nodes.some((node) => node.unresolved)).toBe(false)

    const graph = buildGraphData(notes, index, { showUnresolved: true, showTags: false })
    const ghost = graph.nodes.find((node) => node.unresolved)!
    expect(ghost.id).toBe('?ghost')
    expect(ghost.label).toBe('Ghost')
    expect(ghost.degree).toBe(1)
    expect(graph.edges).toContainEqual({ source: 'A.md', target: '?ghost', count: 1 })
  })

  it('merges several spellings of the same unresolved target into one node', () => {
    const messy = vault(fixture('A.md', '[[Ghost]] [[ghost#Section]]'), fixture('B.md', '[[GHOST|boo]]'))
    const graph = buildGraphData(messy, buildIndex(messy), { showUnresolved: true, showTags: false })
    expect(graph.nodes.filter((node) => node.unresolved).map((node) => node.id)).toEqual(['?ghost'])
    expect(graph.edges).toEqual([
      { source: 'A.md', target: '?ghost', count: 2 },
      { source: 'B.md', target: '?ghost', count: 1 },
    ])
    expect(graph.nodes.find((node) => node.id === '?ghost')!.degree).toBe(2)
  })

  it('adds a tag node linked to every note carrying it only when asked', () => {
    expect(buildGraphData(notes, index, plain).nodes.some((node) => node.id.startsWith('#'))).toBe(false)

    const graph = buildGraphData(notes, index, { showUnresolved: false, showTags: true })
    const tag = graph.nodes.find((node) => node.id === '#idea')!
    expect(tag).toMatchObject({ label: '#idea', unresolved: false, tags: ['idea'], degree: 2 })
    expect(graph.edges).toContainEqual({ source: 'A.md', target: '#idea', count: 1 })
    expect(graph.edges).toContainEqual({ source: 'B.md', target: '#idea', count: 1 })
  })

  it('drops self-links instead of drawing a loop', () => {
    const selfish = vault(fixture('S.md', '[[S]] [[#Heading]]'))
    const graph = buildGraphData(selfish, buildIndex(selfish), plain)
    expect(graph.edges).toEqual([])
    expect(graph.nodes[0]!.degree).toBe(0)
  })

  describe('focus', () => {
    // A -> B -> C -> D, plus an unrelated island.
    const chain = vault(
      fixture('A.md', '[[B]]'),
      fixture('B.md', '[[C]]'),
      fixture('C.md', '[[D]]'),
      fixture('D.md'),
      fixture('Island.md'),
    )
    const chainIndex = buildIndex(chain)

    it('keeps the note and its immediate neighbours at depth 1', () => {
      const graph = buildGraphData(chain, chainIndex, { ...plain, focus: { path: 'B.md', depth: 1 } })
      expect(graph.nodes.map((node) => node.id)).toEqual(['A.md', 'B.md', 'C.md'])
      expect(graph.edges).toEqual([
        { source: 'A.md', target: 'B.md', count: 1 },
        { source: 'B.md', target: 'C.md', count: 1 },
      ])
      // C -> D was cut, so C's degree reflects the visible graph.
      expect(graph.nodes.find((node) => node.id === 'C.md')!.degree).toBe(1)
      // Positions are re-laid-out for the visible subset.
      expect(graph.nodes[0]!.x).toBe(0)
    })

    it('walks two hops in both directions at depth 2', () => {
      const graph = buildGraphData(chain, chainIndex, { ...plain, focus: { path: 'B.md', depth: 2 } })
      expect(graph.nodes.map((node) => node.id)).toEqual(['A.md', 'B.md', 'C.md', 'D.md'])
      expect(graph.edges).toHaveLength(3)
      expect(graph.nodes.find((node) => node.id === 'C.md')!.degree).toBe(2)
    })

    it('keeps only the note itself at depth 0', () => {
      const graph = buildGraphData(chain, chainIndex, { ...plain, focus: { path: 'B.md', depth: 0 } })
      expect(graph.nodes.map((node) => node.id)).toEqual(['B.md'])
      expect(graph.edges).toEqual([])
    })

    it('treats an unknown focus path as an empty graph', () => {
      const graph = buildGraphData(chain, chainIndex, { ...plain, focus: { path: 'Nope.md', depth: 2 } })
      expect(graph).toEqual({ nodes: [], edges: [] })
    })

    it('ignores the focus when it is null', () => {
      const graph = buildGraphData(chain, chainIndex, { ...plain, focus: null })
      expect(graph.nodes).toHaveLength(5)
    })

    it('reaches unresolved placeholders and tags through the same BFS', () => {
      const tagged = vault(fixture('A.md', '[[Ghost]] #idea'), fixture('B.md', '#idea'), fixture('Far.md'))
      const graph = buildGraphData(tagged, buildIndex(tagged), {
        showUnresolved: true,
        showTags: true,
        focus: { path: 'A.md', depth: 1 },
      })
      expect(graph.nodes.map((node) => node.id).sort()).toEqual(['#idea', '?ghost', 'A.md'])
      // B is two hops away (A -> #idea -> B).
      const wider = buildGraphData(tagged, buildIndex(tagged), {
        showUnresolved: true,
        showTags: true,
        focus: { path: 'A.md', depth: 2 },
      })
      expect(wider.nodes.map((node) => node.id).sort()).toEqual(['#idea', '?ghost', 'A.md', 'B.md'])
    })
  })
})

/* ------------------------------------------------------------------ *
 * Scale
 * ------------------------------------------------------------------ */

describe('buildIndex — scale', () => {
  it(
    'indexes a large vault in linear time',
    () => {
      const COUNT = 4000
      const notes = new Map<string, Note>()
      for (let i = 0; i < COUNT; i += 1) {
        // Four links each: three resolve (previous, next, root hub), one never does.
        const body = `[[note-${i - 1}]] [[note-${i + 1}]] [[Hub]] [[missing-${i % 7}]]`
        notes.set(`folder-${i % 20}/note-${i}.md`, fixture(`folder-${i % 20}/note-${i}.md`, body))
      }
      notes.set('Hub.md', fixture('Hub.md'))

      const started = Date.now()
      const index = buildIndex(notes)
      const elapsed = Date.now() - started

      expect(index.byName.size).toBeGreaterThan(COUNT)
      expect(index.incoming.get('Hub.md')).toHaveLength(COUNT)
      expect(resolveLinkTarget('note-2500', 'folder-0/note-0.md', index)).toBe('folder-0/note-2500.md')
      // `note--1` and `note-4000` never exist, plus seven `missing-N` targets.
      expect(index.unresolved.size).toBe(9)
      // A per-link scan of the vault would be ~64M comparisons here and blow
      // straight past this bound; the two-pass build is a few milliseconds.
      expect(elapsed).toBeLessThan(2000)
    },
    30_000,
  )
})
