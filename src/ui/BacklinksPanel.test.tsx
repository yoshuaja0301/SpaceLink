import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AppState } from '../state/store'
import type { Note, NotePath } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { DEFAULT_SETTINGS, makeNote, useAppStore } from '../state/store'
import {
  BacklinksPanel,
  findUnlinkedMentions,
  linkMention,
  loadCollapse,
  maskNonProse,
  mentionNames,
  splitContext,
} from './BacklinksPanel'

/** The store as it was at import time — actions included, so spies are undone. */
const PRISTINE = useAppStore.getState()

const VAULT: Record<NotePath, string> = {
  'Zettelkasten.md': ['---', 'aliases: [Slip-box]', '---', '# Zettelkasten', '', 'An atomic note.', ''].join('\n'),
  'Method.md': [
    '# Method',
    '',
    'Zettelkasten is the core idea.',
    'The [[Zettelkasten]] page has more.',
    'Later: [[Zettelkasten|the method]] again.',
    '',
  ].join('\n'),
  'Journal.md': [
    '# Journal',
    '',
    'Read about zettelkasten today.',
    '',
    '```md',
    'zettelkasten inside a code fence',
    '```',
    '',
    'And `zettelkasten` inline.',
    '',
  ].join('\n'),
  'Index.md': ['# Index', '', 'See Zettelkasten for details.', ''].join('\n'),
  'Slipbox.md': ['# Slipbox', '', 'The Slip-box idea shows up here.', ''].join('\n'),
  'Recipes.md': ['# Recipes', '', 'Flour, water, salt.', ''].join('\n'),
}

function seed(files: Record<NotePath, string> = VAULT, patch: Partial<AppState> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

function notesOf(files: Record<NotePath, string>): Map<NotePath, Note> {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  return notes
}

/** The `.panel` whose header starts with `name`. */
function section(container: HTMLElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll('.panel')].find((panel) =>
    (panel.querySelector('.panel-header')?.textContent ?? '').startsWith(name),
  )
  if (!found) throw new Error(`no "${name}" section rendered`)
  return found as HTMLElement
}

/** `[title, count]` for every group in a section, in visual order. */
function groups(scope: HTMLElement): [string, string][] {
  return [...scope.querySelectorAll('.backlink-group')].map((group) => [
    group.querySelector('.nav-item-title')?.textContent ?? '',
    group.querySelector('.tag-count')?.textContent ?? '',
  ])
}

function contexts(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll('.backlink-context')].map((node) => node.textContent ?? '')
}

function marks(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll('mark')].map((node) => node.textContent ?? '')
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      settings: { ...DEFAULT_SETTINGS },
      searchQuery: '',
      sidebarPanel: 'files',
      hoveredPath: null,
      toasts: [],
      recent: [],
      starred: [],
      panes: [{ id: 'pane-a', tabs: [], activeTabId: null }],
      activePaneId: 'pane-a',
    },
    true,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ *
 * Masking
 * ------------------------------------------------------------------ */

describe('maskNonProse', () => {
  it('blanks fenced code without moving any other character', () => {
    const text = ['before', '```js', 'const zettel = 1', '```', 'after'].join('\n')
    const masked = maskNonProse(text)

    expect(masked.length).toBe(text.length)
    expect(masked.split('\n')).toEqual(['before', '     ', '                ', '   ', 'after'])
  })

  it('closes a fence only on a run of the same character that is long enough', () => {
    const text = ['````', 'zettel', '```', 'still code', '````', 'prose'].join('\n')
    const lines = maskNonProse(text).split('\n')

    expect(lines[3]).toBe('          ')
    expect(lines[5]).toBe('prose')
  })

  it('blanks tilde fences, inline code, links and html comments', () => {
    expect(maskNonProse('~~~\nzettel\n~~~').trim()).toBe('')
    expect(maskNonProse('a `zettel` b')).toBe('a          b')
    expect(maskNonProse('a [[Zettel]] b')).toBe('a            b')
    expect(maskNonProse('a [Zettel](x.md) b')).toBe('a                b')
    expect(maskNonProse('a <!-- zettel\nmore --> b')).toBe('a            \n         b')
  })

  it('leaves ordinary prose untouched', () => {
    expect(maskNonProse('Zettelkasten is a method.')).toBe('Zettelkasten is a method.')
  })
})

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

describe('mentionNames', () => {
  it('collects title, filename and aliases, longest first, deduped', () => {
    const note = makeNote(
      'notes/Zettelkasten.md',
      ['---', 'title: Zettelkasten', 'aliases: [Slip-box, zettelkasten]', '---', '# Zettelkasten', ''].join('\n'),
      1,
    )
    expect(mentionNames(note)).toEqual(['Zettelkasten', 'Slip-box'])
  })

  it('drops one-character names, which would match everything', () => {
    const note = makeNote('A.md', ['---', 'aliases: [A, AB]', '---', '# A', ''].join('\n'), 1)
    expect(mentionNames(note)).toEqual(['AB'])
  })
})

/* ------------------------------------------------------------------ *
 * Unlinked mentions
 * ------------------------------------------------------------------ */

describe('findUnlinkedMentions', () => {
  const notes = notesOf(VAULT)
  const linked = new Set<NotePath>(['Method.md'])

  it('finds prose mentions of the title and of an alias', () => {
    const found = findUnlinkedMentions('Zettelkasten.md', notes, linked)
    expect(found.map((group) => group.source)).toEqual(['Index.md', 'Journal.md', 'Slipbox.md'])
    expect(found.map((group) => group.mentions.length)).toEqual([1, 1, 1])
    expect(found[2]!.mentions[0]!.text).toBe('Slip-box')
  })

  it('ignores matches inside code fences and inline code', () => {
    const journal = findUnlinkedMentions('Zettelkasten.md', notes, linked).find((g) => g.source === 'Journal.md')!
    expect(journal.mentions).toHaveLength(1)
    expect(journal.mentions[0]!.line).toBe(3)
    expect(journal.mentions[0]!.context).toBe('Read about zettelkasten today.')
  })

  it('skips notes that already link here, and the note itself', () => {
    const sources = findUnlinkedMentions('Zettelkasten.md', notes, linked).map((group) => group.source)
    expect(sources).not.toContain('Method.md')
    expect(sources).not.toContain('Zettelkasten.md')
    expect(sources).not.toContain('Recipes.md')
  })

  it('records offsets into the source content that still hold', () => {
    const found = findUnlinkedMentions('Zettelkasten.md', notes, linked)
    for (const group of found) {
      const content = notes.get(group.source)!.content
      for (const mention of group.mentions) {
        expect(content.slice(mention.start, mention.end)).toBe(mention.text)
        expect(mention.context.slice(mention.contextStart, mention.contextStart + mention.text.length)).toBe(
          mention.text,
        )
      }
    }
  })

  it('matches whole words only', () => {
    const vault = {
      'Note.md': '# Note\n',
      'Other.md': '# Other\n\nNotebooks and footnotes are not notes.\nBut a Note is.\n',
    }
    const found = findUnlinkedMentions('Note.md', notesOf(vault), new Set())
    expect(found).toHaveLength(1)
    expect(found[0]!.mentions).toHaveLength(1)
    expect(found[0]!.mentions[0]!.line).toBe(4)
  })

  it('skips a name that is already inside a link to somewhere else', () => {
    const vault = {
      'Note.md': '# Note\n',
      'Other.md': '# Other\n\nSee [[Archive|Note]] and [Note](https://example.com).\n',
    }
    expect(findUnlinkedMentions('Note.md', notesOf(vault), new Set())).toEqual([])
  })

  it('never reports the same span twice when two names overlap', () => {
    const vault = {
      'Zettel Method.md': ['---', 'aliases: [Zettel]', '---', '# Zettel Method', ''].join('\n'),
      'Other.md': '# Other\n\nThe Zettel Method is useful.\n',
    }
    const found = findUnlinkedMentions('Zettel Method.md', notesOf(vault), new Set())
    expect(found[0]!.mentions).toHaveLength(1)
    expect(found[0]!.mentions[0]!.text).toBe('Zettel Method')
  })
})

/* ------------------------------------------------------------------ *
 * Rewriting
 * ------------------------------------------------------------------ */

describe('linkMention', () => {
  const notes = notesOf(VAULT)
  const mentionIn = (source: NotePath): ReturnType<typeof findUnlinkedMentions>[number]['mentions'][number] =>
    findUnlinkedMentions('Zettelkasten.md', notes, new Set<NotePath>(['Method.md'])).find(
      (group) => group.source === source,
    )!.mentions[0]!

  it('writes a bare link when the text already matches the target', () => {
    const content = notes.get('Index.md')!.content
    expect(linkMention(content, mentionIn('Index.md'), 'Zettelkasten')).toBe(
      '# Index\n\nSee [[Zettelkasten]] for details.\n',
    )
  })

  it('keeps the original wording as display text when it differs', () => {
    const content = notes.get('Slipbox.md')!.content
    expect(linkMention(content, mentionIn('Slipbox.md'), 'Zettelkasten')).toBe(
      '# Slipbox\n\nThe [[Zettelkasten|Slip-box]] idea shows up here.\n',
    )
  })

  it('refuses to write when the source has drifted under the offsets', () => {
    const mention = mentionIn('Index.md')
    expect(linkMention('# Index\n\nnothing here now\n', mention, 'Zettelkasten')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Context emphasis
 * ------------------------------------------------------------------ */

describe('splitContext', () => {
  it('finds the raw wiki link that produced the context', () => {
    expect(splitContext('The [[Zettelkasten]] page has more.', 'Zettelkasten')).toEqual({
      before: 'The ',
      match: '[[Zettelkasten]]',
      after: ' page has more.',
    })
  })

  it('finds an aliased or heading-anchored link', () => {
    expect(splitContext('Later: [[Zettelkasten|the method]] again.', 'Zettelkasten').match).toBe(
      '[[Zettelkasten|the method]]',
    )
    expect(splitContext('See [[Zettelkasten#Origins]] too.', 'Zettelkasten').match).toBe('[[Zettelkasten#Origins]]')
  })

  it('ignores links to other notes', () => {
    expect(splitContext('Read [[Other]] and [[Zettelkasten]].', 'Zettelkasten').match).toBe('[[Zettelkasten]]')
  })

  it('falls back to the plain target text, then to no emphasis', () => {
    expect(splitContext('A markdown [link](Zettelkasten.md) here.', 'Zettelkasten')).toEqual({
      before: 'A markdown [link](',
      match: 'Zettelkasten',
      after: '.md) here.',
    })
    expect(splitContext('Nothing to see.', 'Zettelkasten')).toEqual({
      before: 'Nothing to see.',
      match: '',
      after: '',
    })
  })
})

/* ------------------------------------------------------------------ *
 * Component — linked mentions
 * ------------------------------------------------------------------ */

describe('BacklinksPanel — linked mentions', () => {
  it('groups edges by source note and counts them', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    const linked = section(container, 'Linked mentions')

    expect(groups(linked)).toEqual([['Method', '2']])
    expect(section(container, 'Linked mentions').querySelector('.panel-header')!.textContent).toContain('2')
    expect(contexts(linked)).toEqual([
      'The [[Zettelkasten]] page has more.',
      'Later: [[Zettelkasten|the method]] again.',
    ])
  })

  it('emphasises the link inside each context line', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    expect(marks(section(container, 'Linked mentions'))).toEqual([
      '[[Zettelkasten]]',
      '[[Zettelkasten|the method]]',
    ])
  })

  it('shows an empty state when nothing links here', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Recipes.md" />)
    const linked = section(container, 'Linked mentions')
    expect(linked.querySelector('.empty-state')!.textContent).toContain('No linked mentions')
    expect(groups(linked)).toEqual([])
  })

  it('opens the source note when the group title is clicked', () => {
    const openPath = vi.fn()
    seed(VAULT, { openPath })
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)

    fireEvent.click(section(container, 'Linked mentions').querySelector('.nav-item')!)
    expect(openPath).toHaveBeenCalledWith('Method.md')
  })

  it('opens the note and reveals the line when a context is clicked', () => {
    const openPath = vi.fn()
    seed(VAULT, { openPath })
    const listen = vi.fn()
    window.addEventListener('spacefore:reveal-line', listen)

    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    fireEvent.click([...section(container, 'Linked mentions').querySelectorAll('.backlink-context')][1]!)

    window.removeEventListener('spacefore:reveal-line', listen)
    expect(openPath).toHaveBeenCalledWith('Method.md')
    expect((listen.mock.calls[0]![0] as CustomEvent).detail).toEqual({ path: 'Method.md', line: 5 })
  })
})

/* ------------------------------------------------------------------ *
 * Component — very long groups
 * ------------------------------------------------------------------ */

describe('BacklinksPanel — a source note that links here thousands of times', () => {
  /** A journal whose every line links the same note, as a long daily log does. */
  const HEAVY: Record<NotePath, string> = {
    'Hub.md': '# Hub\n',
    'Journal.md':
      '# Journal\n\n' +
      Array.from({ length: 3000 }, (_, line) => `Line ${line} mentions [[Hub]].`).join('\n') +
      '\n',
  }

  it('renders a page of them rather than all three thousand', () => {
    seed(HEAVY)
    const { container } = render(<BacklinksPanel path="Hub.md" />)
    const linked = section(container, 'Linked mentions')

    // The count is honest about the total…
    expect(groups(linked)).toEqual([['Journal', '3000']])
    // …but the sidebar is not carrying 3,000 elements to say so.
    expect(contexts(linked)).toHaveLength(20)
    expect(contexts(linked)[0]).toContain('Line 0 mentions')
  })

  it('reveals the next page when asked, and stops offering once none are left', () => {
    seed(HEAVY)
    const { container } = render(<BacklinksPanel path="Hub.md" />)
    const linked = section(container, 'Linked mentions')
    const more = (): HTMLButtonElement | null => linked.querySelector('.backlink-more')

    expect(more()!.textContent).toBe('Show 200 more of 2,980')
    fireEvent.click(more()!)
    expect(contexts(linked)).toHaveLength(220)
    expect(more()!.textContent).toBe('Show 200 more of 2,780')

    for (let click = 0; click < 14; click += 1) fireEvent.click(more()!)
    expect(contexts(linked)).toHaveLength(3000)
    expect(more()).toBeNull()
  }, 20_000)

  it('forgets how far the reader had scrolled when a different note is opened', () => {
    seed(HEAVY)
    const view = render(<BacklinksPanel path="Hub.md" />)
    fireEvent.click(view.container.querySelector('.backlink-more')!)
    expect(contexts(section(view.container, 'Linked mentions'))).toHaveLength(220)

    view.rerender(<BacklinksPanel path="Journal.md" />)
    view.rerender(<BacklinksPanel path="Hub.md" />)
    expect(contexts(section(view.container, 'Linked mentions'))).toHaveLength(20)
  })
})

/* ------------------------------------------------------------------ *
 * Component — unlinked mentions
 * ------------------------------------------------------------------ */

describe('BacklinksPanel — unlinked mentions', () => {
  it('lists notes that name this one without linking to it', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    const unlinked = section(container, 'Unlinked mentions')

    expect(groups(unlinked)).toEqual([
      ['Index', '1'],
      ['Journal', '1'],
      ['Slipbox', '1'],
    ])
    expect(unlinked.querySelector('.panel-header')!.textContent).toContain('3')
  })

  it('does not offer a note that already links here, or code-fenced text', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    const unlinked = section(container, 'Unlinked mentions')

    expect(groups(unlinked).map(([title]) => title)).not.toContain('Method')
    expect(contexts(unlinked)).toEqual([
      'See Zettelkasten for details.',
      'Read about zettelkasten today.',
      'The Slip-box idea shows up here.',
    ])
    expect(marks(unlinked)).toEqual(['Zettelkasten', 'zettelkasten', 'Slip-box'])
  })

  it('shows an empty state when nothing mentions the note', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Recipes.md" />)
    expect(section(container, 'Unlinked mentions').querySelector('.empty-state')!.textContent).toContain(
      'No unlinked mentions',
    )
  })

  it('rewrites exactly one occurrence when Link is clicked', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    const unlinked = section(container, 'Unlinked mentions')
    const link = [...unlinked.querySelectorAll('.backlink-link')].find((button) =>
      (button.getAttribute('aria-label') ?? '').includes('Journal'),
    )!

    fireEvent.click(link)

    const journal = useAppStore.getState().notes.get('Journal.md')!.content
    expect(journal).toContain('Read about [[Zettelkasten|zettelkasten]] today.')
    // The fenced and inline-code occurrences must be untouched.
    expect(journal).toContain('zettelkasten inside a code fence')
    expect(journal).toContain('And `zettelkasten` inline.')
    expect(journal.match(/\[\[/g)).toHaveLength(1)
    expect(useAppStore.getState().dirty.has('Journal.md')).toBe(true)
  })

  it('moves the note into linked mentions once it has been linked', () => {
    seed()
    const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
    const link = [...container.querySelectorAll('.backlink-link')].find((button) =>
      (button.getAttribute('aria-label') ?? '').includes('Index'),
    )!

    fireEvent.click(link)

    expect(groups(section(container, 'Linked mentions')).map(([title]) => title)).toEqual(['Index', 'Method'])
    expect(groups(section(container, 'Unlinked mentions')).map(([title]) => title)).toEqual(['Journal', 'Slipbox'])
  })
})

/* ------------------------------------------------------------------ *
 * Collapse state
 * ------------------------------------------------------------------ */

describe('BacklinksPanel — collapse', () => {
  it('persists each section to localStorage and restores it', () => {
    seed()
    const first = render(<BacklinksPanel path="Zettelkasten.md" />)
    fireEvent.click(section(first.container, 'Unlinked mentions').querySelector('.panel-header')!)

    expect(loadCollapse()).toEqual({ linked: false, unlinked: true })
    expect(section(first.container, 'Unlinked mentions').className).toContain('is-collapsed')
    cleanup()

    const second = render(<BacklinksPanel path="Zettelkasten.md" />)
    const restored = section(second.container, 'Unlinked mentions')
    expect(restored.className).toContain('is-collapsed')
    expect(restored.querySelector('.panel-header')!.getAttribute('aria-expanded')).toBe('false')
    expect(section(second.container, 'Linked mentions').className).not.toContain('is-collapsed')
  })

  it('survives unreadable storage', () => {
    localStorage.setItem('spacefore.backlinksCollapsed', 'not json')
    expect(loadCollapse()).toEqual({ linked: false, unlinked: false })
  })
})

/* ------------------------------------------------------------------ *
 * Rescan cost
 *
 * The scan reads the whole vault, so what matters is how often it runs and
 * how much of it re-does work it already did. Both are counted through the
 * note fields the scan reads, rather than timed.
 * ------------------------------------------------------------------ */

interface Reads {
  /** Times this note was handed to the scan. */
  scans: number
  /** Times its prose had to be masked — the expensive half of a scan. */
  masks: number
}

/** A note that counts the reads the unlinked scan makes, so they can be asserted. */
function watched(note: Note, reads: Reads): Note {
  const parsed = { ...note.parsed }
  Object.defineProperty(parsed, 'bodyOffset', {
    get: () => {
      reads.scans += 1
      return note.parsed.bodyOffset
    },
  })
  Object.defineProperty(parsed, 'body', {
    get: () => {
      reads.masks += 1
      return note.parsed.body
    },
  })
  return { ...note, parsed }
}

/** Seed the store with `VAULT`, counting every scan of one source note. */
function seedWatched(reads: Reads, source: NotePath = 'Index.md'): void {
  const notes = notesOf(VAULT)
  notes.set(source, watched(notes.get(source)!, reads))
  useAppStore.setState({ notes, index: buildIndex(notes) })
  reads.scans = 0
  reads.masks = 0
}

/** Replace one note the way `setNoteContent` does: a fresh map, a fresh note. */
function type(path: NotePath, content: string): void {
  const notes = new Map(useAppStore.getState().notes)
  notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes })
}

const UNLINKED = ['Index', 'Journal', 'Slipbox']

describe('BacklinksPanel — rescan cost', () => {
  it('masks each note once however often the scan runs', () => {
    const reads: Reads = { scans: 0, masks: 0 }
    const notes = notesOf(VAULT)
    notes.set('Index.md', watched(notes.get('Index.md')!, reads))

    findUnlinkedMentions('Zettelkasten.md', notes, new Set())
    findUnlinkedMentions('Zettelkasten.md', notes, new Set())

    expect(reads.scans).toBe(2)
    expect(reads.masks).toBe(1)
  })

  it('rescans once after a typing burst, not once per keystroke', () => {
    vi.useFakeTimers()
    try {
      const reads: Reads = { scans: 0, masks: 0 }
      seedWatched(reads)
      const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)
      expect(groups(section(container, 'Unlinked mentions')).map(([title]) => title)).toEqual(UNLINKED)

      reads.scans = 0
      reads.masks = 0
      act(() => {
        for (let n = 1; n <= 5; n += 1) type('Journal.md', `${VAULT['Journal.md']!}Word ${n}.\n`)
      })
      expect(reads.scans).toBe(0)

      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(reads.scans).toBe(1)
      // The untouched note was cached by the first scan, so the rescan is only
      // the cheap sweep.
      expect(reads.masks).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rescan at all while the described note is the one being typed in', () => {
    vi.useFakeTimers()
    try {
      const reads: Reads = { scans: 0, masks: 0 }
      seedWatched(reads)
      render(<BacklinksPanel path="Zettelkasten.md" />)

      reads.scans = 0
      act(() => {
        for (let n = 1; n <= 5; n += 1) type('Zettelkasten.md', `${VAULT['Zettelkasten.md']!}Line ${n}.\n`)
      })
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(reads.scans).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does rescan when the described note is renamed under the reader', () => {
    vi.useFakeTimers()
    try {
      const reads: Reads = { scans: 0, masks: 0 }
      seedWatched(reads)
      const { container } = render(<BacklinksPanel path="Zettelkasten.md" />)

      reads.scans = 0
      act(() => {
        type('Zettelkasten.md', ['---', 'aliases: [Slip-box, Recipes]', '---', '# Zettelkasten', ''].join('\n'))
      })
      act(() => {
        vi.advanceTimersByTime(400)
      })

      expect(reads.scans).toBe(1)
      expect(groups(section(container, 'Unlinked mentions')).map(([title]) => title)).toEqual([
        'Index',
        'Journal',
        'Recipes',
        'Slipbox',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the scan entirely while the panel is off screen', () => {
    const reads: Reads = { scans: 0, masks: 0 }
    seedWatched(reads)
    const view = render(<BacklinksPanel path="Zettelkasten.md" visible={false} />)

    expect(reads.scans).toBe(0)
    expect(groups(section(view.container, 'Unlinked mentions'))).toEqual([])

    view.rerender(<BacklinksPanel path="Zettelkasten.md" visible />)
    expect(reads.scans).toBe(1)
    expect(groups(section(view.container, 'Unlinked mentions')).map(([title]) => title)).toEqual(UNLINKED)
  })
})
