import {
  extractHeadings,
  extractMarkdownLinks,
  extractTags,
  extractTasks,
  extractWikiLinks,
  parseFrontmatter,
  parseNote,
  slugifyHeading,
  toPlainText,
} from './parse'

/** Every extractor promises `source.slice(start, end) === raw`. */
function expectOffsetsRoundTrip(source: string, note = parseNote(source, 'Round Trip.md')): void {
  for (const link of note.links) expect(source.slice(link.start, link.end)).toBe(link.raw)
  for (const link of note.markdownLinks) expect(source.slice(link.start, link.end)).toBe(link.raw)
  for (const tag of note.tags) expect(source.slice(tag.start, tag.end)).toBe(`#${tag.tag}`)
  const lines = source.split('\n')
  for (const heading of note.headings) expect(lines[heading.line - 1]).toContain(heading.text)
  for (const task of note.tasks) {
    expect(source.slice(task.start, task.start + 3)).toMatch(/^\[[ xX]\]$/)
    expect(lines[task.line - 1]).toContain(task.text)
  }
}

/* ------------------------------------------------------------------ *
 * Frontmatter
 * ------------------------------------------------------------------ */

describe('parseFrontmatter', () => {
  it('returns the whole source as body when there is no frontmatter', () => {
    const result = parseFrontmatter('# Hello\n\nWorld')
    expect(result.frontmatter).toEqual({})
    expect(result.raw).toBe('')
    expect(result.body).toBe('# Hello\n\nWorld')
    expect(result.bodyOffset).toBe(0)
  })

  it('only treats `---` as an opening fence on line 1', () => {
    const source = 'intro\n---\ntitle: Nope\n---\nbody'
    const result = parseFrontmatter(source)
    expect(result.frontmatter).toEqual({})
    expect(result.bodyOffset).toBe(0)
    expect(result.body).toBe(source)
  })

  it('ignores an unclosed frontmatter fence', () => {
    const source = '---\ntitle: Dangling\n\nstill body'
    const result = parseFrontmatter(source)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe(source)
  })

  it('handles an empty frontmatter block', () => {
    const result = parseFrontmatter('---\n---\nbody')
    expect(result.frontmatter).toEqual({})
    expect(result.raw).toBe('')
    expect(result.body).toBe('body')
    expect(result.bodyOffset).toBe(8)
  })

  it('reports body and bodyOffset so the body slices out of the source', () => {
    const source = '---\ntitle: T\n---\n\n# Heading\n'
    const result = parseFrontmatter(source)
    expect(result.raw).toBe('title: T')
    expect(source.slice(result.bodyOffset)).toBe(result.body)
    expect(result.body).toBe('\n# Heading\n')
  })

  it('parses scalars, quotes, booleans, null and numbers', () => {
    const { frontmatter } = parseFrontmatter(
      [
        '---',
        'plain: hello world',
        'double: "he said \\"hi\\""',
        'single: \'it\'\'s\'',
        'yes: true',
        'no: FALSE',
        'nil: null',
        'tilde: ~',
        'blank:',
        'int: 42',
        'neg: -7',
        'float: 1.5',
        'zeroed: 007',
        'version: 1.2.3',
        '---',
        'body',
      ].join('\n'),
    )
    expect(frontmatter.plain).toBe('hello world')
    expect(frontmatter.double).toBe('he said "hi"')
    expect(frontmatter.single).toBe("it's")
    expect(frontmatter.yes).toBe(true)
    expect(frontmatter.no).toBe(false)
    expect(frontmatter.nil).toBeNull()
    expect(frontmatter.tilde).toBeNull()
    expect(frontmatter.blank).toBeNull()
    expect(frontmatter.int).toBe(42)
    expect(frontmatter.neg).toBe(-7)
    expect(frontmatter.float).toBe(1.5)
    // Leading zeros and dotted versions must survive as strings.
    expect(frontmatter.zeroed).toBe('007')
    expect(frontmatter.version).toBe('1.2.3')
  })

  it('parses inline arrays, block lists and one level of nesting', () => {
    const { frontmatter } = parseFrontmatter(
      [
        '---',
        'inline: [a, b, "c d"]',
        'block:',
        '  - one',
        '  - two',
        'nested:',
        '  deep: true',
        '  count: 3',
        'objects:',
        '  - name: alpha',
        '    weight: 1',
        '  - name: beta',
        'map: {x: 1, y: two}',
        '---',
      ].join('\n'),
    )
    expect(frontmatter.inline).toEqual(['a', 'b', 'c d'])
    expect(frontmatter.block).toEqual(['one', 'two'])
    expect(frontmatter.nested).toEqual({ deep: true, count: 3 })
    expect(frontmatter.objects).toEqual([
      { name: 'alpha', weight: 1 },
      { name: 'beta' },
    ])
    expect(frontmatter.map).toEqual({ x: 1, y: 'two' })
  })

  it('strips trailing comments outside quotes but keeps `#` inside values', () => {
    const { frontmatter } = parseFrontmatter(
      [
        '---',
        '# a whole-line comment',
        'a: value # trailing comment',
        'b: "keep # this"',
        'c: https://example.com/page#fragment',
        'd: [x, y] # after an array',
        '---',
      ].join('\n'),
    )
    expect(frontmatter.a).toBe('value')
    expect(frontmatter.b).toBe('keep # this')
    expect(frontmatter.c).toBe('https://example.com/page#fragment')
    expect(frontmatter.d).toEqual(['x', 'y'])
  })

  it('keeps block scalars readable', () => {
    const { frontmatter } = parseFrontmatter('---\nnote: |\n  line one\n  line two\nfolded: >\n  a\n  b\n---\n')
    expect(frontmatter.note).toBe('line one\nline two')
    expect(frontmatter.folded).toBe('a b')
  })

  it('never throws on malformed YAML and keeps what it can', () => {
    const broken = ['---', 'good: 1', 'bad: [1, 2', 'no colon here', '   - orphan item', '"unterminated: x', '---', 'body'].join('\n')
    expect(() => parseFrontmatter(broken)).not.toThrow()
    const { frontmatter, body } = parseFrontmatter(broken)
    expect(frontmatter.good).toBe(1)
    expect(frontmatter.bad).toBe('[1, 2')
    expect(body).toBe('body')
  })

  it('normalises tags written as a comma or space separated string', () => {
    expect(parseFrontmatter('---\ntags: "alpha, beta gamma"\n---\n').frontmatter.tags).toEqual(['alpha', 'beta', 'gamma'])
    expect(parseFrontmatter('---\ntags: solo\n---\n').frontmatter.tags).toEqual(['solo'])
  })

  it('normalises tags written as inline arrays, block lists and nested lists', () => {
    expect(parseFrontmatter('---\ntags: [a, b]\n---\n').frontmatter.tags).toEqual(['a', 'b'])
    expect(parseFrontmatter('---\ntags:\n  - one\n  - two/three\n---\n').frontmatter.tags).toEqual(['one', 'two/three'])
    expect(parseFrontmatter('---\ntags:\n  - [x, y]\n  - z\n---\n').frontmatter.tags).toEqual(['x', 'y', 'z'])
  })

  it('strips leading hashes and dedupes tags case-insensitively', () => {
    expect(parseFrontmatter('---\ntags: ["#Alpha", alpha, "#beta/"]\n---\n').frontmatter.tags).toEqual(['Alpha', 'beta'])
  })

  it('normalises aliases from a string, a list and the singular key', () => {
    expect(parseFrontmatter('---\naliases: My Note, Second Name\n---\n').frontmatter.aliases).toEqual(['My Note', 'Second Name'])
    expect(parseFrontmatter('---\naliases:\n  - One\n  - Two\n---\n').frontmatter.aliases).toEqual(['One', 'Two'])
    expect(parseFrontmatter('---\nalias: Only One\n---\n').frontmatter.aliases).toEqual(['Only One'])
  })

  it('coerces a non-string title to a string', () => {
    expect(parseFrontmatter('---\ntitle: 2024\n---\n').frontmatter.title).toBe('2024')
    expect(parseFrontmatter('---\ntitle:\n---\n').frontmatter.title).toBeUndefined()
  })

  it('handles CRLF line endings', () => {
    const source = '---\r\ntitle: CRLF\r\n---\r\n# Body\r\n'
    const result = parseFrontmatter(source)
    expect(result.frontmatter.title).toBe('CRLF')
    expect(result.body).toBe('# Body\r\n')
    expect(source.slice(result.bodyOffset)).toBe(result.body)
  })
})

/* ------------------------------------------------------------------ *
 * Wiki links
 * ------------------------------------------------------------------ */

describe('extractWikiLinks', () => {
  it('parses every wiki link shape', () => {
    const body = '[[Target]] [[Target|Alias]] [[Target#Heading]] [[Target#^block-id]] [[#Local]] ![[Embed]]'
    const links = extractWikiLinks(body, 0)
    expect(links.map((l) => l.target)).toEqual(['Target', 'Target', 'Target', 'Target', '', 'Embed'])
    expect(links[1]!.alias).toBe('Alias')
    expect(links[2]!.heading).toBe('Heading')
    expect(links[3]!.blockId).toBe('block-id')
    expect(links[4]!.heading).toBe('Local')
    expect(links[5]!.embed).toBe(true)
    expect(links.filter((l) => l.embed)).toHaveLength(1)
    for (const link of links) expect(body.slice(link.start, link.end)).toBe(link.raw)
  })

  it('includes the leading `!` in an embed raw', () => {
    const [embed] = extractWikiLinks('![[Picture.png]]', 0)
    expect(embed!.raw).toBe('![[Picture.png]]')
    expect(embed!.start).toBe(0)
    expect(embed!.end).toBe(16)
  })

  it('trims target and alias but keeps them faithful', () => {
    const [link] = extractWikiLinks('[[  Some Note  |  Nice Label  ]]', 0)
    expect(link!.target).toBe('Some Note')
    expect(link!.alias).toBe('Nice Label')
  })

  it('rejects empty links and links with no target, heading or block id', () => {
    expect(extractWikiLinks('[[]] [[ ]] [[|only alias]]', 0)).toEqual([])
  })

  it('never spans a newline', () => {
    expect(extractWikiLinks('[[Broken\nLink]]', 0)).toEqual([])
  })

  it('ignores links inside fenced code blocks and inline code', () => {
    const body = ['Real [[One]]', '', '```md', '[[Fenced]]', '```', '', '~~~', '[[Tilde]]', '~~~', '', 'Inline `[[Code]]` and ``[[Double]]``.'].join('\n')
    expect(extractWikiLinks(body, 0).map((l) => l.target)).toEqual(['One'])
  })

  it('ignores links inside HTML comments and block math', () => {
    const body = '<!-- [[Hidden]] -->\n$$\n[[Math]]\n$$\n[[Visible]]'
    expect(extractWikiLinks(body, 0).map((l) => l.target)).toEqual(['Visible'])
  })

  it('adds bodyOffset to offsets and reports body-relative lines', () => {
    const body = 'first\n[[Second]]'
    const [link] = extractWikiLinks(body, 100)
    expect(link!.start).toBe(106)
    expect(link!.end).toBe(116)
    expect(link!.line).toBe(2)
  })

  it('handles an unclosed code fence by masking to the end of the note', () => {
    expect(extractWikiLinks('[[Before]]\n```\n[[After]]\n', 0).map((l) => l.target)).toEqual(['Before'])
  })
})

/* ------------------------------------------------------------------ *
 * Markdown links
 * ------------------------------------------------------------------ */

describe('extractMarkdownLinks', () => {
  it('parses text, url, titles and angle-bracket destinations', () => {
    const body = '[plain](note.md) [titled](a.md "A title") [spaced](<my file.md>) [empty]()'
    const links = extractMarkdownLinks(body, 0)
    expect(links.map((l) => [l.text, l.url])).toEqual([
      ['plain', 'note.md'],
      ['titled', 'a.md'],
      ['spaced', 'my file.md'],
      ['empty', ''],
    ])
    for (const link of links) expect(body.slice(link.start, link.end)).toBe(link.raw)
    expect(links[1]!.raw).toBe('[titled](a.md "A title")')
    expect(links[2]!.raw).toBe('[spaced](<my file.md>)')
  })

  it('handles nested brackets in the text and balanced parens in the url', () => {
    const body = '[a [nested] b](https://en.wikipedia.org/wiki/Foo_(bar))'
    const [link] = extractMarkdownLinks(body, 0)
    expect(link!.text).toBe('a [nested] b')
    expect(link!.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(link!.raw).toBe(body)
  })

  it('classifies internal versus external urls', () => {
    const body = '[a](b.md) [b](sub/dir/n.md#h) [c](#frag) [d](https://x.com) [e](http://x.com) [f](mailto:a@b.c) [g](obsidian://x) [h](file:///t) [i](//cdn.example.com/x)'
    expect(extractMarkdownLinks(body, 0).map((l) => l.internal)).toEqual([true, true, true, false, false, false, false, false, false])
  })

  it('skips images and wiki links', () => {
    const body = '![alt](picture.png) [[Wiki]] [[Wiki]](trap.md) [real](ok.md)'
    expect(extractMarkdownLinks(body, 0).map((l) => l.url)).toEqual(['ok.md'])
  })

  it('ignores links inside code', () => {
    const body = '```\n[fenced](a.md)\n```\n`[inline](b.md)`\n[live](c.md)'
    expect(extractMarkdownLinks(body, 0).map((l) => l.url)).toEqual(['c.md'])
  })

  it('does not treat an unterminated construct as a link', () => {
    expect(extractMarkdownLinks('[text](unclosed', 0)).toEqual([])
    expect(extractMarkdownLinks('[text] (spaced.md)', 0)).toEqual([])
    expect(extractMarkdownLinks('[text](<unclosed.md)', 0)).toEqual([])
  })

  it('reports the line and offsets the caller can slice with', () => {
    const body = 'one\ntwo [x](y.md)'
    const [link] = extractMarkdownLinks(body, 7)
    expect(link!.line).toBe(2)
    expect(link!.start).toBe(15)
    expect(body.slice(link!.start - 7, link!.end - 7)).toBe(link!.raw)
  })
})

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

describe('extractTags', () => {
  it('finds simple, nested and unicode tags', () => {
    const body = '#simple #nested/tag #with-dash #with_underscore #café/naïve #2024/q1'
    const tags = extractTags(body, 0)
    expect(tags.map((t) => t.tag)).toEqual(['simple', 'nested/tag', 'with-dash', 'with_underscore', 'café/naïve', '2024/q1'])
    for (const tag of tags) expect(body.slice(tag.start, tag.end)).toBe(`#${tag.tag}`)
  })

  it('accepts tags after whitespace, line start and opening brackets', () => {
    expect(extractTags('#start of line', 0).map((t) => t.tag)).toEqual(['start'])
    expect(extractTags('text #middle', 0).map((t) => t.tag)).toEqual(['middle'])
    expect(extractTags('(#paren) [#bracket] {#brace}', 0).map((t) => t.tag)).toEqual(['paren', 'bracket', 'brace'])
  })

  it('rejects a tag that is all digits', () => {
    expect(extractTags('#1 #42 #1a', 0).map((t) => t.tag)).toEqual(['1a'])
  })

  it('excludes trailing punctuation from the tag', () => {
    const body = 'a #one. b #two, c #three) d #four: e #five; f #six! g #seven?'
    const tags = extractTags(body, 0)
    expect(tags.map((t) => t.tag)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven'])
    for (const tag of tags) expect(body.slice(tag.start, tag.end)).toBe(`#${tag.tag}`)
  })

  it('drops a dangling trailing slash', () => {
    const [tag] = extractTags('#work/ done', 0)
    expect(tag!.tag).toBe('work')
    expect(tag!.end - tag!.start).toBe(5)
  })

  it('does not treat markdown headings as tags', () => {
    const body = '# Heading One\n## Heading Two\n###### Six\n\n#realtag'
    expect(extractTags(body, 0).map((t) => t.tag)).toEqual(['realtag'])
  })

  it('does not treat url fragments or link anchors as tags', () => {
    const body = 'See https://example.com/page#section and [label](#anchor) and [other](docs/a.md#frag).'
    expect(extractTags(body, 0)).toEqual([])
  })

  it('does not treat a wiki-link heading reference as a tag', () => {
    expect(extractTags('[[#Local Heading]] [[Note#Other]] [[Note|#alias]]', 0)).toEqual([])
  })

  it('ignores tags inside fenced code, inline code, comments and math', () => {
    const body = ['#live', '```', '#fenced', '```', '`#inline`', '<!-- #comment -->', '$$ #math $$', '#alsolive'].join('\n')
    expect(extractTags(body, 0).map((t) => t.tag)).toEqual(['live', 'alsolive'])
  })

  it('rejects a bare `#` and a `#` glued to a word', () => {
    expect(extractTags('# \nsomething# nope\nC# is a language', 0)).toEqual([])
  })

  it('reports body-relative lines and absolute offsets', () => {
    const body = 'l1\nl2 #here'
    const [tag] = extractTags(body, 50)
    expect(tag!.line).toBe(2)
    expect(tag!.start).toBe(56)
    expect(tag!.end).toBe(61)
  })
})

/* ------------------------------------------------------------------ *
 * Headings
 * ------------------------------------------------------------------ */

describe('slugifyHeading', () => {
  it('lowercases, replaces spaces and strips punctuation', () => {
    expect(slugifyHeading('Hello World')).toBe('hello-world')
    expect(slugifyHeading('What? Really! (Yes.)')).toBe('what-really-yes')
    expect(slugifyHeading('C++ & Rust')).toBe('c-rust')
    expect(slugifyHeading('  Padded  Out  ')).toBe('padded-out')
    expect(slugifyHeading('snake_case-and-dash')).toBe('snake_case-and-dash')
  })

  it('keeps unicode letters and digits', () => {
    expect(slugifyHeading('Über Café 2024')).toBe('über-café-2024')
  })

  it('unwraps link syntax and emphasis before slugifying', () => {
    expect(slugifyHeading('**Bold** and `code`')).toBe('bold-and-code')
    expect(slugifyHeading('See [[Note|The Note]]')).toBe('see-the-note')
    expect(slugifyHeading('See [docs](https://x.com)')).toBe('see-docs')
  })
})

describe('extractHeadings', () => {
  it('extracts ATX headings of every level with slugs and offsets', () => {
    const body = '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n'
    const headings = extractHeadings(body, 0)
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6])
    expect(headings.map((h) => h.slug)).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
    for (const heading of headings) expect(body[heading.start]).toBe('#')
  })

  it('allows up to three spaces of indent but not four', () => {
    expect(extractHeadings('   # Indented\n    # Code block\n', 0).map((h) => h.text)).toEqual(['Indented'])
  })

  it('drops an optional closing sequence', () => {
    expect(extractHeadings('## Closed ##\n### Also ###   \n# C#\n', 0).map((h) => h.text)).toEqual(['Closed', 'Also', 'C#'])
  })

  it('does not treat `#tag` or seven hashes as a heading', () => {
    expect(extractHeadings('#tag\n####### seven\n', 0)).toEqual([])
  })

  it('dedupes repeated slugs with -2, -3 suffixes', () => {
    const headings = extractHeadings('# Notes\n## Notes\n### Notes\n## Other\n#### notes\n', 0)
    expect(headings.map((h) => h.slug)).toEqual(['notes', 'notes-2', 'notes-3', 'other', 'notes-4'])
  })

  it('supports setext headings', () => {
    const body = 'Title Line\n==========\n\nSubtitle\n--------\n'
    const headings = extractHeadings(body, 0)
    expect(headings).toEqual([
      { level: 1, text: 'Title Line', slug: 'title-line', start: 0, line: 1 },
      { level: 2, text: 'Subtitle', slug: 'subtitle', start: 23, line: 4 },
    ])
  })

  it('does not turn a thematic break or table divider into a setext heading', () => {
    expect(extractHeadings('\n---\n', 0)).toEqual([])
    expect(extractHeadings('# Real\n---\n', 0).map((h) => h.text)).toEqual(['Real'])
    expect(extractHeadings('| a | b |\n|---|---|\n', 0)).toEqual([])
    expect(extractHeadings('- item\n---\n', 0)).toEqual([])
  })

  it('ignores headings inside fenced code', () => {
    expect(extractHeadings('# Live\n```\n# Fenced\n```\n', 0).map((h) => h.text)).toEqual(['Live'])
  })

  it('keeps heading text that contains inline code', () => {
    const headings = extractHeadings('## Using `parseNote` here\n', 0)
    expect(headings[0]!.text).toBe('Using `parseNote` here')
    expect(headings[0]!.slug).toBe('using-parsenote-here')
  })

  it('offsets by bodyOffset and reports body-relative lines', () => {
    const [heading] = extractHeadings('\n# Later\n', 17)
    expect(heading!.start).toBe(18)
    expect(heading!.line).toBe(2)
  })
})

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

describe('extractTasks', () => {
  it('recognises every bullet and numbered marker', () => {
    const body = '- [ ] dash\n* [ ] star\n+ [ ] plus\n1. [ ] numbered\n2) [ ] paren\n'
    expect(extractTasks(body, 0).map((t) => t.text)).toEqual(['dash', 'star', 'plus', 'numbered', 'paren'])
  })

  it('reads the checked state, including uppercase X', () => {
    expect(extractTasks('- [ ] a\n- [x] b\n- [X] c\n', 0).map((t) => t.checked)).toEqual([false, true, true])
  })

  it('works at any indent and points start at the marker', () => {
    const body = '- [ ] top\n    - [x] nested\n\t- [ ] tabbed\n'
    const tasks = extractTasks(body, 0)
    expect(tasks.map((t) => t.text)).toEqual(['top', 'nested', 'tabbed'])
    for (const task of tasks) expect(body.slice(task.start, task.start + 3)).toMatch(/^\[[ xX]\]$/)
    expect(tasks.map((t) => t.line)).toEqual([1, 2, 3])
  })

  it('rejects non-task checkboxes and missing markers', () => {
    expect(extractTasks('- [y] wrong\n-[ ] no space\n[ ] no bullet\n- [] empty\n', 0)).toEqual([])
  })

  it('ignores tasks inside fenced code', () => {
    expect(extractTasks('- [ ] live\n```\n- [ ] fenced\n```\n', 0).map((t) => t.text)).toEqual(['live'])
  })

  it('keeps inline code in the task text and offsets by bodyOffset', () => {
    const [task] = extractTasks('- [x] run `npm test`\n', 40)
    expect(task!.text).toBe('run `npm test`')
    expect(task!.start).toBe(42)
  })
})

/* ------------------------------------------------------------------ *
 * toPlainText
 * ------------------------------------------------------------------ */

describe('toPlainText', () => {
  it('strips frontmatter', () => {
    expect(toPlainText('---\ntitle: X\n---\nHello').trim()).toBe('Hello')
  })

  it('drops fenced code blocks but keeps inline code text', () => {
    const source = 'before\n```js\nconst x = 1\n```\nafter `inline` end'
    expect(toPlainText(source)).toBe('before\nafter inline end')
  })

  it('strips heading, blockquote, list and task markers', () => {
    expect(toPlainText('## Heading')).toBe('Heading')
    expect(toPlainText('> quoted\n>> deeper')).toBe('quoted\ndeeper')
    expect(toPlainText('- one\n2. two\n* three')).toBe('one\ntwo\nthree')
    expect(toPlainText('- [x] done\n- [ ] todo')).toBe('done\ntodo')
  })

  it('keeps link display text and drops images', () => {
    expect(toPlainText('a [label](https://x.com) b')).toBe('a label b')
    expect(toPlainText('a [[Note]] b')).toBe('a Note b')
    expect(toPlainText('a [[Note|Alias]] b')).toBe('a Alias b')
    expect(toPlainText('a [[Note#Section]] b')).toBe('a Note b')
    expect(toPlainText('a ![alt](pic.png) b')).toBe('a  b')
    expect(toPlainText('a ![[embed.png]] b')).toBe('a  b')
  })

  it('strips emphasis markers without eating intra-word underscores', () => {
    expect(toPlainText('**bold** _italic_ ~~strike~~ ==mark== snake_case')).toBe('bold italic strike mark snake_case')
  })

  it('removes html tags and comments but keeps autolink urls', () => {
    expect(toPlainText('a <b>bold</b> c <!-- hidden --> d <https://x.com>')).toBe('a bold c  d https://x.com')
  })

  it('removes thematic breaks and setext underlines', () => {
    expect(toPlainText('Title\n=====\n\ntext\n\n---\n\n***')).toBe('Title\n\n\ntext\n\n\n\n')
  })

  it('unescapes escaped punctuation', () => {
    expect(toPlainText('a \\* b \\[c\\]')).toBe('a * b [c]')
  })
})

/* ------------------------------------------------------------------ *
 * parseNote
 * ------------------------------------------------------------------ */

describe('parseNote', () => {
  it('prefers the frontmatter title', () => {
    expect(parseNote('---\ntitle: From Frontmatter\n---\n# From Heading\n', 'File.md').title).toBe('From Frontmatter')
  })

  it('falls back to the first H1 and strips its markup', () => {
    expect(parseNote('## Not H1\n\n# The **Real** Title\n\n# Second\n', 'File.md').title).toBe('The Real Title')
  })

  it('falls back to the file name without the .md extension', () => {
    expect(parseNote('just prose', 'My Note.md').title).toBe('My Note')
    expect(parseNote('just prose', 'My Note').title).toBe('My Note')
    expect(parseNote('', '').title).toBe('Untitled')
  })

  it('skips an empty H1 when choosing a title', () => {
    expect(parseNote('#\n\ntext', 'Fallback.md').title).toBe('Fallback')
  })

  it('builds an excerpt from prose, collapsed and cut on a word boundary', () => {
    const note = parseNote('# Heading\n\n- [ ] A **bold** [[Link|point]] with\n  `code` and more    prose.\n', 'x.md')
    expect(note.excerpt).toBe('Heading A bold point with code and more prose.')
  })

  it('truncates long excerpts on a word boundary and adds an ellipsis', () => {
    const word = 'lorem '
    const note = parseNote(word.repeat(120), 'x.md')
    expect(note.excerpt.length).toBeLessThanOrEqual(201)
    expect(note.excerpt.endsWith('…')).toBe(true)
    expect(note.excerpt.slice(0, -1).endsWith('lorem')).toBe(true)
  })

  it('counts words unicode-aware and excludes code fences and frontmatter', () => {
    const note = parseNote('---\ntitle: Ignored Words Here\n---\nCafé naïve 汉字 don\'t\n\n```\nnot counted at all\n```\n', 'x.md')
    expect(note.wordCount).toBe(4)
  })

  it('merges inline and frontmatter tags, deduping case-insensitively', () => {
    const note = parseNote('---\ntags: [Beta, gamma, ALPHA]\n---\n#alpha and #delta\n', 'x.md')
    expect(note.allTags).toEqual(['alpha', 'delta', 'Beta', 'gamma'])
  })

  it('exposes frontmatterRaw, body and bodyOffset', () => {
    const source = '---\ntags: [a]\n---\n# Body\n'
    const note = parseNote(source, 'x.md')
    expect(note.frontmatterRaw).toBe('tags: [a]')
    expect(note.body).toBe('# Body\n')
    expect(source.slice(note.bodyOffset)).toBe(note.body)
  })

  it('reports line numbers that index the original source, frontmatter included', () => {
    const source = ['---', 'title: T', 'tags: [x]', '---', '', '# Heading', '', 'Body with [[Link]] and #tag', '', '- [ ] task'].join('\n')
    const note = parseNote(source, 'x.md')
    expect(note.headings[0]!.line).toBe(6)
    expect(note.links[0]!.line).toBe(8)
    expect(note.tags[0]!.line).toBe(8)
    expect(note.tasks[0]!.line).toBe(10)

    const lines = source.split('\n')
    expect(lines[note.links[0]!.line - 1]).toContain(note.links[0]!.raw)
    expect(lines[note.headings[0]!.line - 1]).toContain(note.headings[0]!.text)
  })

  it('keeps offsets absolute across the frontmatter boundary', () => {
    const source = '---\ntitle: T\n---\n\n[[Target]] and [md](x.md) and #tag\n'
    const note = parseNote(source, 'x.md')
    expect(source.slice(note.links[0]!.start, note.links[0]!.end)).toBe('[[Target]]')
    expect(source.slice(note.markdownLinks[0]!.start, note.markdownLinks[0]!.end)).toBe('[md](x.md)')
    expect(source.slice(note.tags[0]!.start, note.tags[0]!.end)).toBe('#tag')
    expectOffsetsRoundTrip(source, note)
  })

  it('returns empty collections for an empty note', () => {
    const note = parseNote('', 'Empty.md')
    expect(note).toMatchObject({
      frontmatter: {},
      frontmatterRaw: '',
      body: '',
      bodyOffset: 0,
      links: [],
      markdownLinks: [],
      tags: [],
      allTags: [],
      headings: [],
      tasks: [],
      excerpt: '',
      wordCount: 0,
    })
  })

  it('never throws on hostile input', () => {
    const hostile = ['---', 'a: [[[[', '---', '[[[[[[', '```', '`'.repeat(200), '[x](((((', '#'.repeat(50), '<!--', '$$'].join('\n')
    expect(() => parseNote(hostile, 'Hostile.md')).not.toThrow()
  })

  it('parses a large synthetic note correctly and quickly', () => {
    const block = [
      '## Section {{i}}',
      '',
      'Prose with [[Note {{i}}]], [[Other|alias {{i}}]] and #topic/{{i}} plus [ext](https://example.com/{{i}}).',
      '',
      '```ts',
      'const trap = "[[nope]] #nope [x](y)"',
      '```',
      '',
      '- [ ] open task {{i}}',
      '- [x] closed task {{i}}',
      '',
      'Inline `[[code]] #code` and <!-- [[comment]] #comment -->.',
      '',
    ].join('\n')

    const count = 400
    let source = '---\ntitle: Big Note\ntags: [big, synthetic]\n---\n\n# Big Note\n\n'
    for (let i = 0; i < count; i += 1) source += block.replace(/\{\{i\}\}/g, String(i))

    const started = performance.now()
    const note = parseNote(source, 'Big Note.md')
    const elapsed = performance.now() - started

    expect(note.title).toBe('Big Note')
    expect(note.headings).toHaveLength(count + 1)
    expect(note.links).toHaveLength(count * 2)
    expect(note.markdownLinks).toHaveLength(count)
    expect(note.tags).toHaveLength(count)
    expect(note.tasks).toHaveLength(count * 2)
    expect(note.allTags.slice(-2)).toEqual(['big', 'synthetic'])
    // Slug dedupe must not collide across 400 distinct sections.
    expect(new Set(note.headings.map((h) => h.slug)).size).toBe(count + 1)

    expectOffsetsRoundTrip(source, note)
    // Linear passes only: a ~50k-char note is well under a second.
    expect(elapsed).toBeLessThan(1000)
  })
})
