import type { Note, NotePath, WikiLink } from '../../types'
import { parseNote, slugifyHeading } from '../markdown/parse'
import { buildIndex, getBacklinks, getOrphans, resolveLinkTarget } from '../graph/index'
import { DEMO_NOTES, createDemoVault } from './demoVault'

/**
 * Targets that are unresolved *on purpose*, so the graph shows placeholder
 * nodes and the `is-unresolved` link styling is visible on first run. This list
 * is the contract: any other broken link in the demo vault is a typo.
 */
const INTENTIONALLY_UNRESOLVED = ['Books/How to Take Smart Notes', 'Note Refactoring']

const PATHS = Object.keys(DEMO_NOTES) as NotePath[]

function basenameOf(path: NotePath): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.toLowerCase().endsWith('.md') ? file.slice(0, -3) : file
}

/** Same shape the store builds, without pulling zustand/localStorage into the test. */
function buildNotes(): Map<NotePath, Note> {
  const notes = new Map<NotePath, Note>()
  for (const path of PATHS) {
    const name = basenameOf(path)
    const content = DEMO_NOTES[path]!
    notes.set(path, { path, name, content, mtime: 0, parsed: parseNote(content, name) })
  }
  return notes
}

const notes = buildNotes()
const index = buildIndex(notes)

/** Every wiki link in the vault, tagged with the note it came from. */
const allLinks: { from: NotePath; link: WikiLink }[] = []
for (const [path, note] of notes) {
  for (const link of note.parsed.links) allLinks.push({ from: path, link })
}

const sourceOf = (path: NotePath): string => DEMO_NOTES[path]!
const everySource = PATHS.map(sourceOf).join('\n')

describe('DEMO_NOTES', () => {
  it('ships a vault of 18-24 markdown notes with unique basenames', () => {
    expect(PATHS.length).toBeGreaterThanOrEqual(18)
    expect(PATHS.length).toBeLessThanOrEqual(24)

    for (const path of PATHS) {
      expect(path.endsWith('.md')).toBe(true)
      expect(path.startsWith('/')).toBe(false)
      expect(DEMO_NOTES[path]!.trim().length).toBeGreaterThan(0)
    }

    // Basename resolution ([[Atomic Notes]]) is only unambiguous while
    // basenames are unique, and the demo vault is where people learn it.
    const basenames = PATHS.map((p) => basenameOf(p).toLowerCase())
    expect(new Set(basenames).size).toBe(basenames.length)
  })

  it('organises the tour into the documented folders', () => {
    const folders = new Set(PATHS.filter((p) => p.includes('/')).map((p) => p.slice(0, p.indexOf('/'))))
    expect(folders).toEqual(new Set(['Guides', 'Concepts', 'Projects', 'Daily', 'Sandbox']))

    expect(PATHS).toContain('Start Here.md')
    expect(PATHS.filter((p) => p.startsWith('Guides/')).length).toBeGreaterThanOrEqual(7)
    expect(PATHS.filter((p) => p.startsWith('Concepts/')).length).toBeGreaterThanOrEqual(6)
    expect(PATHS.filter((p) => p.startsWith('Projects/')).length).toBeGreaterThanOrEqual(2)
    expect(PATHS.filter((p) => p.startsWith('Daily/')).length).toBeGreaterThanOrEqual(2)
    // Daily notes are named after the date, which the daily-note command relies on.
    for (const path of PATHS.filter((p) => p.startsWith('Daily/'))) {
      expect(basenameOf(path)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('parses every note into a titled, substantial document', () => {
    for (const [path, note] of notes) {
      const { parsed } = note
      expect(parsed.title.length, path).toBeGreaterThan(0)
      // "Roughly 150-500 words" — with slack for the tables and code blocks
      // that `toPlainText` keeps or drops.
      expect(parsed.wordCount, path).toBeGreaterThan(100)
      expect(parsed.wordCount, path).toBeLessThan(900)
      expect(parsed.excerpt.length, path).toBeGreaterThan(20)

      // Exactly one H1, and it is the first heading in the note.
      const h1s = parsed.headings.filter((h) => h.level === 1)
      expect(h1s.length, path).toBe(1)
      expect(parsed.headings[0]!.level, path).toBe(1)
      expect(parsed.headings.length, path).toBeGreaterThanOrEqual(2)
    }
  })

  it('parses frontmatter on every note that has it', () => {
    for (const [path, note] of notes) {
      const hasFence = DEMO_NOTES[path]!.startsWith('---\n')
      expect(hasFence, path).toBe(true)

      const { frontmatter, frontmatterRaw, bodyOffset } = note.parsed
      expect(frontmatterRaw.trim().length, path).toBeGreaterThan(0)
      expect(bodyOffset, path).toBeGreaterThan(0)

      expect(typeof frontmatter.title, path).toBe('string')
      expect((frontmatter.title as string).length, path).toBeGreaterThan(0)

      expect(Array.isArray(frontmatter.tags), path).toBe(true)
      for (const tag of frontmatter.tags!) {
        expect(typeof tag).toBe('string')
        expect(tag.startsWith('#')).toBe(false)
        expect(tag.trim()).toBe(tag)
      }

      if (frontmatter.aliases !== undefined) {
        expect(Array.isArray(frontmatter.aliases), path).toBe(true)
        for (const alias of frontmatter.aliases) expect(alias.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('demonstrates both YAML list styles plus non-standard keys', () => {
    const raws = PATHS.map((p) => notes.get(p)!.parsed.frontmatterRaw)
    // Inline flow sequence: `tags: [a, b]`
    expect(raws.some((raw) => /^tags:\s*\[/m.test(raw))).toBe(true)
    // Block sequence: `tags:` then indented `- item`
    expect(raws.some((raw) => /^tags:\s*\n\s+-\s+\S/m.test(raw))).toBe(true)

    // Arbitrary keys survive parsing and feed the frontmatter property table.
    const playground = notes.get('Sandbox/Formatting Playground.md')!.parsed.frontmatter
    expect(playground.draft).toBe(true)
    expect(playground.weight).toBe(42)
    expect(notes.get('Projects/Vault Migration.md')!.parsed.frontmatter.status).toBe('active')
  })
})

describe('demo vault link graph', () => {
  it('resolves every wiki link except the intentional placeholders', () => {
    const unresolved = new Set<string>()
    for (const { from, link } of allLinks) {
      if (resolveLinkTarget(link.target, from, index) === null) unresolved.add(link.target)
    }
    expect([...unresolved].sort()).toEqual([...INTENTIONALLY_UNRESOLVED].sort())
  })

  it('records the placeholders in the index so the graph can draw them', () => {
    const targets = [...index.unresolved.keys()].sort()
    expect(targets).toEqual(INTENTIONALLY_UNRESOLVED.map((t) => t.toLowerCase()).sort())
    // Each placeholder is written from more than one note, so the node has a
    // visible degree rather than dangling off a single edge.
    for (const edges of index.unresolved.values()) {
      expect(new Set(edges.map((e) => e.from)).size).toBeGreaterThanOrEqual(2)
    }
  })

  it('has enough links for the graph view to look like a graph', () => {
    expect(allLinks.length).toBeGreaterThanOrEqual(60)

    const resolved = allLinks.filter(({ from, link }) => resolveLinkTarget(link.target, from, index) !== null)
    expect(resolved.length).toBeGreaterThanOrEqual(60)

    // Connectivity, not just volume: every note links somewhere, and every note
    // but the deliberate orphan is linked to from somewhere.
    for (const [path, note] of notes) {
      if (path === 'Sandbox/Orphan Note.md') continue
      expect(note.parsed.links.length, path).toBeGreaterThan(0)
      expect((index.incoming.get(path) ?? []).length, path).toBeGreaterThan(0)
    }
  })

  it('uses all four wiki-link forms', () => {
    const links = allLinks.map((entry) => entry.link)
    expect(links.some((l) => !l.embed && !l.alias && !l.heading)).toBe(true)
    expect(links.some((l) => !l.embed && l.alias)).toBe(true)
    expect(links.some((l) => !l.embed && l.heading)).toBe(true)
    expect(links.some((l) => l.embed)).toBe(true)

    // A same-note link (`[[#Heading]]`) has an empty target and resolves to the
    // note it sits in.
    const selfLink = allLinks.find(({ link }) => link.target === '')
    expect(selfLink).toBeDefined()
    expect(resolveLinkTarget(selfLink!.link.target, selfLink!.from, index)).toBe(selfLink!.from)
  })

  it('embeds a whole note and a single heading', () => {
    const embeds = allLinks.filter(({ link }) => link.embed)
    expect(embeds.some(({ link }) => !link.heading)).toBe(true)
    expect(embeds.some(({ link }) => Boolean(link.heading))).toBe(true)
    // Nothing embeds itself, which would be an immediate render cycle.
    for (const { from, link } of embeds) {
      expect(resolveLinkTarget(link.target, from, index)).not.toBe(from)
    }
  })

  it('points every heading anchor at a heading that exists', () => {
    const anchored = allLinks.filter(({ link }) => link.heading)
    expect(anchored.length).toBeGreaterThanOrEqual(5)

    for (const { from, link } of anchored) {
      const target = resolveLinkTarget(link.target, from, index)
      expect(target, `${from} -> ${link.raw}`).not.toBeNull()
      const slugs = notes.get(target!)!.parsed.headings.map((h) => h.slug)
      expect(slugs, `${from} -> ${link.raw}`).toContain(slugifyHeading(link.heading!))
    }
  })

  it('links to two notes through their frontmatter aliases', () => {
    const aliasLinks = allLinks.filter(({ from, link }) => {
      if (link.target === '') return false // `[[#Heading]]` points at its own note
      const target = resolveLinkTarget(link.target, from, index)
      if (!target) return false
      const key = link.target.toLowerCase()
      // Not the path, not the path minus `.md`, not the basename => an alias.
      return key !== target.toLowerCase() && key !== target.toLowerCase().slice(0, -3) && key !== basenameOf(target).toLowerCase()
    })

    const aliased = new Set(aliasLinks.map(({ from, link }) => resolveLinkTarget(link.target, from, index)!))
    expect(aliased.size).toBeGreaterThanOrEqual(2)

    // The alias really is declared on the target note.
    for (const { from, link } of aliasLinks) {
      const target = resolveLinkTarget(link.target, from, index)!
      const aliases = (notes.get(target)!.parsed.frontmatter.aliases ?? []).map((a) => a.toLowerCase())
      expect(aliases, `${link.raw} in ${from}`).toContain(link.target.toLowerCase())
    }
  })

  it('gives the backlinks panel a note with six or more sources', () => {
    const groups = getBacklinks('Concepts/Atomic Notes.md', index, notes)
    expect(groups.length).toBeGreaterThanOrEqual(6)
    for (const group of groups) {
      expect(group.source).not.toBe('Concepts/Atomic Notes.md')
      expect(group.title.length).toBeGreaterThan(0)
      // Context is the source line, so the panel has something to show.
      for (const edge of group.edges) expect(edge.context.trim().length).toBeGreaterThan(0)
    }
  })

  it('has a hub note that links across the whole vault', () => {
    const hub = notes.get('PKM Map of Content.md')!
    const targets = new Set(
      hub.parsed.links
        .map((link) => resolveLinkTarget(link.target, hub.path, index))
        .filter((path): path is NotePath => path !== null),
    )
    expect(targets.size).toBeGreaterThanOrEqual(15)
    for (const folder of ['Guides/', 'Concepts/', 'Projects/', 'Daily/']) {
      expect([...targets].some((p) => p.startsWith(folder)), folder).toBe(true)
    }
  })

  it('makes Start Here the landing note that links into every folder', () => {
    const start = notes.get('Start Here.md')!
    const targets = start.parsed.links
      .map((link) => resolveLinkTarget(link.target, start.path, index))
      .filter((path): path is NotePath => path !== null)

    for (const folder of ['Guides/', 'Concepts/', 'Projects/', 'Daily/', 'Sandbox/']) {
      expect(targets.some((p) => p.startsWith(folder)), folder).toBe(true)
    }
    expect(targets).toContain('PKM Map of Content.md')

    // The "try this" list is real tasks, one of them already ticked.
    expect(start.parsed.tasks.length).toBeGreaterThanOrEqual(5)
    expect(start.parsed.tasks.some((t) => t.checked)).toBe(true)
    expect(start.parsed.tasks.some((t) => !t.checked)).toBe(true)
  })

  it('contains exactly one orphan', () => {
    expect(getOrphans(notes, index)).toEqual(['Sandbox/Orphan Note.md'])

    const orphan = notes.get('Sandbox/Orphan Note.md')!
    expect(orphan.parsed.links).toEqual([])
    expect(index.incoming.get(orphan.path) ?? []).toEqual([])
    // It still carries tags, so it is reachable from the tag panel.
    expect(orphan.parsed.allTags.length).toBeGreaterThan(0)
  })
})

describe('demo vault content coverage', () => {
  it('exercises nested tags across a hierarchy', () => {
    for (const tag of ['pkm/method', 'status/active', 'status/done', 'status/parked', 'meta/index']) {
      expect(index.tags.get(tag), tag).toBeDefined()
      expect(index.tags.get(tag)!.length, tag).toBeGreaterThan(0)
    }
    // Frontmatter tags and inline tags both land in the index.
    expect(index.tags.get('guide')!.length).toBeGreaterThanOrEqual(7)
    expect(index.tags.get('daily')!.length).toBeGreaterThanOrEqual(2)
  })

  it('includes checked and unchecked tasks across several notes', () => {
    const withTasks = [...notes.values()].filter((n) => n.parsed.tasks.length > 0)
    expect(withTasks.length).toBeGreaterThanOrEqual(4)

    const tasks = withTasks.flatMap((n) => n.parsed.tasks)
    expect(tasks.some((t) => t.checked)).toBe(true)
    expect(tasks.some((t) => !t.checked)).toBe(true)
    for (const task of tasks) expect(task.text.trim().length).toBeGreaterThan(0)

    // At least one note shows both states side by side.
    expect(
      withTasks.some((n) => n.parsed.tasks.some((t) => t.checked) && n.parsed.tasks.some((t) => !t.checked)),
    ).toBe(true)
  })

  it('exercises every renderer feature somewhere in the vault', () => {
    // Tables (header + divider row), blockquotes, horizontal rules, footnotes.
    expect(/^\|.*\|\s*\n\s*\|\s*:?-{3,}/m.test(everySource)).toBe(true)
    expect(/^> [A-Z]/m.test(everySource)).toBe(true)
    expect(/\n---\n/.test(everySource.replace(/^---[\s\S]*?\n---\n/gm, ''))).toBe(true)
    expect(/\[\^[^\]]+\]:/.test(everySource)).toBe(true)

    // Callouts, all three flavours.
    for (const kind of ['note', 'tip', 'warning']) {
      expect(everySource.includes(`> [!${kind}]`), kind).toBe(true)
    }

    // Nested lists (a list item indented under another).
    expect(/\n- .*\n {2,}- /.test(everySource)).toBe(true)

    // Fenced code blocks in several languages.
    const languages = new Set([...everySource.matchAll(/^```([a-z]+)$/gm)].map((m) => m[1]!))
    expect(languages.size).toBeGreaterThanOrEqual(4)
    expect(languages.has('typescript') || languages.has('javascript')).toBe(true)
    expect(languages.has('python')).toBe(true)

    // Math, inline and display.
    expect(everySource).toContain('$e^{i\\pi}+1=0$')
    expect(/\n\$\$\n[\s\S]+?\n\$\$\n/.test(everySource)).toBe(true)

    // External links get the external-link treatment in the renderer.
    expect(/\[[^\]]+\]\(https:\/\/[^)]+\)/.test(everySource)).toBe(true)
  })

  it('proves the parser ignores links and tags inside code', () => {
    const playground = notes.get('Sandbox/Formatting Playground.md')!
    expect(playground.content).toContain('`[[not a link]]`')
    expect(playground.content).toContain('`#nottag`')

    // Neither shows up as a link or a tag anywhere in the vault.
    for (const note of notes.values()) {
      expect(note.parsed.links.map((l) => l.target)).not.toContain('not a link')
      expect(note.parsed.allTags).not.toContain('nottag')
    }
    expect(index.byName.has('not a link')).toBe(false)
    expect(index.tags.has('nottag')).toBe(false)

    // The fenced markdown sample in the daily-notes guide contains wiki links
    // that must stay inert: no extracted link may sit inside the fence.
    const guide = notes.get('Guides/Daily Notes.md')!
    const lines = guide.content.split('\n')
    const open = lines.findIndex((line) => line === '```markdown')
    const close = lines.indexOf('```', open + 1)
    expect(open).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(open)
    expect(lines.slice(open, close).join('\n')).toContain('[[Atomic Notes]]')
    for (const link of guide.parsed.links) {
      // `line` is 1-based, the fence indices above are 0-based.
      const line = link.line - 1
      expect(line < open || line > close, `${link.raw} on line ${link.line}`).toBe(true)
    }
  })

  it('keeps link offsets pointing at the raw source', () => {
    for (const [path, note] of notes) {
      for (const link of note.parsed.links) {
        expect(note.content.slice(link.start, link.end), `${path} ${link.raw}`).toBe(link.raw)
      }
      for (const heading of note.parsed.headings) {
        expect(note.content[heading.start], `${path} ${heading.text}`).toBe('#')
      }
    }
  })
})

describe('createDemoVault', () => {
  it('is a writable in-memory vault called "Demo vault"', () => {
    const vault = createDemoVault()
    expect(vault.kind).toBe('demo')
    expect(vault.name).toBe('Demo vault')
    expect(vault.writable).toBe(true)
  })

  it('lists every demo note with sane metadata', async () => {
    const files = await createDemoVault().list()
    expect(files.map((f) => f.path).sort()).toEqual([...PATHS].sort())

    for (const file of files) {
      expect(file.isMarkdown).toBe(true)
      expect(file.extension).toBe('md')
      expect(file.name).toBe(basenameOf(file.path))
      expect(file.size).toBeGreaterThan(0)
      expect(file.mtime).toBeGreaterThan(0)
    }
  })

  it('reads back exactly what DEMO_NOTES declares', async () => {
    const vault = createDemoVault()
    for (const path of PATHS) {
      expect(await vault.exists(path)).toBe(true)
      expect(await vault.read(path)).toBe(DEMO_NOTES[path])
    }
    expect(await vault.exists('Nope.md')).toBe(false)
  })

  it('accepts edits without touching DEMO_NOTES or other instances', async () => {
    const before = Object.keys(DEMO_NOTES).length
    const a = createDemoVault()
    const b = createDemoVault()

    await a.write('Sandbox/Scratch.md', '# Scratch\n\nLinks to [[Atomic Notes]].\n')
    await a.write('Start Here.md', 'rewritten')

    expect(await a.read('Sandbox/Scratch.md')).toContain('[[Atomic Notes]]')
    expect(await a.read('Start Here.md')).toBe('rewritten')

    // The seed record and any sibling vault are untouched.
    expect(Object.keys(DEMO_NOTES).length).toBe(before)
    expect(DEMO_NOTES['Start Here.md']!.startsWith('---')).toBe(true)
    expect(await b.exists('Sandbox/Scratch.md')).toBe(false)
    expect(await b.read('Start Here.md')).toBe(DEMO_NOTES['Start Here.md'])
  })
})

describe('demo vault freshness', () => {
  it('stamps its notes near the present, not at the fixed test epoch', async () => {
    // A vault that opens claiming every note was modified years ago reads as
    // broken; the demo is generated now, so it should look recent.
    const files = await createDemoVault().list()
    const newest = Math.max(...files.map((file) => file.mtime))
    const ageDays = (Date.now() - newest) / (1000 * 60 * 60 * 24)
    expect(ageDays).toBeLessThan(31)
    expect(ageDays).toBeGreaterThanOrEqual(0)
  })
})
