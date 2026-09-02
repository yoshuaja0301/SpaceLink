/**
 * Tests for the central store — vault loading, autosave, the rename/link
 * rewrite, and the tab/pane invariants the whole workspace depends on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note, NotePath, Pane } from '../types'
import { buildIndex, resolveLinkTarget } from '../core/graph/index'
import { createMemoryVault } from '../core/vault/memoryVault'
import type { AppState } from './store'
import {
  LAST_VAULT_KEY,
  basename,
  dirname,
  formatDate,
  joinPath,
  makeNote,
  rewriteLinksTo,
  sanitizeFileName,
  useAppStore,
} from './store'

/**
 * How often the store rebuilt the whole-vault index. Counted at the module
 * boundary because the point of the debounce is *how many* rebuilds happen,
 * not how long one takes — a wall-clock assertion would only be flaky.
 */
const indexBuilds = vi.hoisted(() => ({ count: 0 }))

vi.mock('../core/graph/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/graph/index')>()
  return {
    ...actual,
    buildIndex: (notes: Map<NotePath, Note>) => {
      indexBuilds.count += 1
      return actual.buildIndex(notes)
    },
  }
})

const PRISTINE = useAppStore.getState()

const SEED: Record<NotePath, string> = {
  'Start Here.md': '# Start Here\n\nSee [[Concepts/Zettelkasten]] and [[Atomic Notes]].\n',
  'Concepts/Zettelkasten.md': '---\ntitle: Zettelkasten\naliases: [Slip-box]\ntags: [concept]\n---\n\nLinks to [[Atomic Notes]].\n',
  'Concepts/Atomic Notes.md': '# Atomic Notes\n\nBack to [[Zettelkasten]].\n',
  'Daily/2026-01-15.md': '# 2026-01-15\n\n- [ ] read [[Zettelkasten]]\n',
}

async function openSeededVault(seed: Record<NotePath, string> = SEED): Promise<void> {
  await useAppStore.getState().openVault(createMemoryVault({ ...seed }, { name: 'Test vault' }))
}

/**
 * Boot a *fresh* copy of the store module against the given persisted starred
 * value. State restored from `localStorage` is read at import time, so a store
 * that is already imported can never exercise it.
 */
async function bootStore(starred: string | null): Promise<AppState> {
  if (starred === null) localStorage.removeItem('spacefore.starred')
  else localStorage.setItem('spacefore.starred', starred)
  vi.resetModules()
  const fresh = await import('./store')
  return fresh.useAppStore.getState()
}

/** The pane the store considers active. */
function pane(): Pane {
  return useAppStore.getState().activePane()
}

beforeEach(() => {
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      dirty: new Set(),
      saving: new Set(),
      panes: PRISTINE.panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, kind: 'note', path: null })) })),
      recent: [],
      starred: [],
      toasts: [],
    },
    true,
  )
  vi.useRealTimers()
  localStorage.clear()
})

describe('path helpers', () => {
  it('splits and joins vault paths', () => {
    expect(basename('Concepts/Zettelkasten.md')).toBe('Zettelkasten')
    expect(basename('image.png')).toBe('image.png')
    expect(dirname('Concepts/Zettelkasten.md')).toBe('Concepts')
    expect(dirname('Start Here.md')).toBe('')
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('Daily/', 'a.md')).toBe('Daily/a.md')
  })

  it('strips characters a filesystem or a wiki link would choke on', () => {
    expect(sanitizeFileName('My/Note: draft #1?')).toBe('MyNote draft 1')
    expect(sanitizeFileName('   ')).toBe('Untitled')
    expect(sanitizeFileName('a'.repeat(300))).toHaveLength(120)
  })

  it('formats dates without touching the locale', () => {
    const date = new Date(2026, 0, 5, 9, 7, 3)
    expect(formatDate('YYYY-MM-DD', date)).toBe('2026-01-05')
    expect(formatDate('YYYY/MMM/DD HH:mm', date)).toBe('2026/Jan/05 09:07')
    expect(formatDate('DDDD', date)).toBe('Monday')
  })
})

/** A vault of `path -> content`, parsed and indexed the way the store holds it. */
function vault(files: Record<NotePath, string>): { notes: Map<NotePath, Note>; index: ReturnType<typeof buildIndex> } {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 0))
  return { notes, index: buildIndex(notes) }
}

describe('rewriteLinksTo', () => {
  it('retargets every form of the link and leaves the rest alone', () => {
    const { notes, index } = vault({
      'Old.md': '# Old\n',
      'Older.md': '# Older\n',
      'Hub.md': 'a [[Old]] b [[Old|alias]] c [[Old#Head]] d ![[Old]] e [[Older]] f [[old]] g [[Old#^abc123|see]]',
    })
    expect(rewriteLinksTo(notes.get('Hub.md')!, 'Old.md', 'New.md', index)).toBe(
      'a [[New]] b [[New|alias]] c [[New#Head]] d ![[New]] e [[Older]] f [[New]] g [[New#^abc123|see]]',
    )
  })

  it('is a no-op when the path does not change', () => {
    const { notes, index } = vault({ 'Old.md': '# Old\n', 'Hub.md': '[[Old]]' })
    expect(rewriteLinksTo(notes.get('Hub.md')!, 'Old.md', 'Old.md', index)).toBe('[[Old]]')
  })

  it('leaves a homonym that resolved to a different note alone', () => {
    // `[[Foo]]` in Baz/ resolves to Baz/Foo.md — its own folder wins — so
    // renaming Bar/Foo.md must not silently repoint it.
    const { notes, index } = vault({
      'Bar/Foo.md': '# Foo\n',
      'Baz/Foo.md': '# Foo\n',
      'Baz/Other.md': 'see [[Foo]]\n',
    })
    expect(rewriteLinksTo(notes.get('Baz/Other.md')!, 'Bar/Foo.md', 'Bar/Renamed.md', index)).toBe('see [[Foo]]\n')
  })

  it('rewrites a path-form link in path form', () => {
    const { notes, index } = vault({ 'Bar/Foo.md': '# Foo\n', 'Top.md': 'see [[Bar/Foo]] and [[Bar/Foo.md|x]]\n' })
    expect(rewriteLinksTo(notes.get('Top.md')!, 'Bar/Foo.md', 'Bar/Renamed.md', index)).toBe(
      'see [[Bar/Renamed]] and [[Bar/Renamed.md|x]]\n',
    )
  })

  it('never touches a link inside a code fence or an inline code span', () => {
    const source = 'real [[Old]]\n\n```\n[[Old]]\n```\n\nand `[[Old]]` too\n'
    const { notes, index } = vault({ 'Old.md': '# Old\n', 'Doc.md': source })
    expect(rewriteLinksTo(notes.get('Doc.md')!, 'Old.md', 'New.md', index)).toBe(
      'real [[New]]\n\n```\n[[Old]]\n```\n\nand `[[Old]]` too\n',
    )
  })

  it('leaves a link written as an alias to the resolver', () => {
    const { notes, index } = vault({
      'Old.md': '---\naliases: [Slip-box]\n---\n\n# Old\n',
      'Hub.md': 'see [[Slip-box]]\n',
    })
    expect(rewriteLinksTo(notes.get('Hub.md')!, 'Old.md', 'New.md', index)).toBe('see [[Slip-box]]\n')
  })
})

describe('openVault', () => {
  it('loads notes, indexes them and lands on a sensible first note', async () => {
    await openSeededVault()
    const state = useAppStore.getState()
    expect(state.notes.size).toBe(4)
    expect(state.vaultName).toBe('Test vault')
    expect(state.loading).toBe(false)
    expect(state.index.outgoing.get('Start Here.md')).toHaveLength(2)
    // "Start Here" wins the home-note heuristic.
    expect(state.activeTab()?.path).toBe('Start Here.md')
  })

  it('asks a backend for the whole vault at once when it can do that', async () => {
    const files: Record<NotePath, string> = {}
    for (let i = 0; i < 600; i += 1) files[`Note ${i}.md`] = `# Note ${i}\n\nbody ${i}\n`
    const adapter = createMemoryVault(files, { name: 'Bulk' })

    let reads = 0
    const oneAtATime = adapter.read.bind(adapter)
    adapter.read = async (path) => {
      reads += 1
      return oneAtATime(path)
    }
    adapter.readAll = async function* readAll() {
      // Two batches, so the batching path is the one under test.
      const paths = Object.keys(files)
      yield new Map(paths.slice(0, 400).map((p) => [p, files[p]!]))
      yield new Map(paths.slice(400).map((p) => [p, files[p]!]))
    }

    await useAppStore.getState().openVault(adapter)

    expect(useAppStore.getState().notes.size).toBe(600)
    expect(useAppStore.getState().notes.get('Note 599.md')?.content).toContain('body 599')
    // The whole point: not one request per note.
    expect(reads).toBe(0)
  })

  it('counts the notes as they land, and stops counting once they have', async () => {
    const files: Record<NotePath, string> = {}
    for (let i = 0; i < 300; i += 1) files[`Note ${i}.md`] = `# Note ${i}\n`
    const adapter = createMemoryVault(files, { name: 'Counted' })
    const seen: (number | null)[] = []
    const unsubscribe = useAppStore.subscribe((state) => {
      const at = state.loadingProgress ? state.loadingProgress.done : null
      if (seen.at(-1) !== at) seen.push(at)
    })

    adapter.readAll = async function* readAll() {
      const paths = Object.keys(files)
      yield new Map(paths.slice(0, 100).map((p) => [p, files[p]!]))
      yield new Map(paths.slice(100, 200).map((p) => [p, files[p]!]))
      yield new Map(paths.slice(200).map((p) => [p, files[p]!]))
    }

    await useAppStore.getState().openVault(adapter)
    unsubscribe()

    expect(seen.filter((at) => at !== null)).toEqual([0, 100, 200, 300])
    // Cleared when the vault is open, so the splash does not linger.
    expect(useAppStore.getState().loadingProgress).toBeNull()
  })

  it('still opens a backend that can only be read a note at a time', async () => {
    const files: Record<NotePath, string> = {}
    for (let i = 0; i < 600; i += 1) files[`Note ${i}.md`] = `# Note ${i}\n\nbody ${i}\n`
    const adapter = createMemoryVault(files, { name: 'One by one' })
    expect(adapter.readAll).toBeUndefined()

    await useAppStore.getState().openVault(adapter)

    expect(useAppStore.getState().notes.size).toBe(600)
    expect(useAppStore.getState().notes.get('Note 42.md')?.content).toContain('body 42')
  })

  it('reports a failure instead of leaving the app half-loaded', async () => {
    const broken = createMemoryVault({})
    broken.list = () => Promise.reject(new Error('disk on fire'))
    await useAppStore.getState().openVault(broken)
    expect(useAppStore.getState().error).toBe('disk on fire')
    expect(useAppStore.getState().loading).toBe(false)
  })

  it('leaves the open vault entirely alone when the new one fails to load', async () => {
    await openSeededVault()
    const current = useAppStore.getState().adapter!
    const writes: NotePath[] = []
    const broken = createMemoryVault({ 'Journal.md': 'my real notes\n' }, { name: 'Broken' })
    broken.read = () => Promise.reject(new Error('NotReadableError'))
    broken.write = async (path) => {
      writes.push(path)
    }

    await useAppStore.getState().openVault(broken)

    const state = useAppStore.getState()
    expect(state.error).toBe('NotReadableError')
    // Adapter, name and notes all still describe the vault that is open.
    expect(state.adapter).toBe(current)
    expect(state.vaultName).toBe('Test vault')
    expect(state.notes.has('Start Here.md')).toBe(true)

    // …so the next save goes to that vault, not through the adapter that failed.
    state.setNoteContent('Start Here.md', '# Start Here\n\nstill the old vault\n')
    await useAppStore.getState().saveNote('Start Here.md')
    expect(await current.read('Start Here.md')).toContain('still the old vault')
    expect(writes).toEqual([])
  })

  it('does not write the outgoing vault’s buffer through the incoming adapter', async () => {
    vi.useFakeTimers()
    await openSeededVault({ 'Welcome.md': 'SECRET FROM OLD VAULT\n' })
    useAppStore.getState().updateSettings({ autosaveDelay: 200 })
    const previous = useAppStore.getState().adapter!
    useAppStore.getState().setNoteContent('Welcome.md', 'SECRET FROM OLD VAULT\nand more\n')

    // A directory walk takes a while; the autosave debounce would fire during it.
    const next = createMemoryVault({ 'Welcome.md': 'MY REAL NOTES ON DISK\n' }, { name: 'On disk' })
    const list = next.list.bind(next)
    next.list = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return list()
    }

    const opening = useAppStore.getState().openVault(next)
    await vi.advanceTimersByTimeAsync(600)
    await opening

    expect(await next.read('Welcome.md')).toBe('MY REAL NOTES ON DISK\n')
    // The pending edit was flushed to the vault it belongs to, not discarded.
    expect(await previous.read('Welcome.md')).toBe('SECRET FROM OLD VAULT\nand more\n')
    expect(useAppStore.getState().notes.get('Welcome.md')!.content).toBe('MY REAL NOTES ON DISK\n')
    expect(useAppStore.getState().dirty.size).toBe(0)
  })

  it('blanks tabs and recents the new vault has no note for', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md')

    await useAppStore.getState().openVault(createMemoryVault({ 'Readme.md': '# Readme\n' }, { name: 'Other' }))

    const state = useAppStore.getState()
    expect(state.panes.flatMap((p) => p.tabs).some((t) => t.path === 'Concepts/Zettelkasten.md')).toBe(false)
    expect(state.recent).not.toContain('Concepts/Zettelkasten.md')
    // With the stale tab blanked, the home-note heuristic runs again.
    expect(state.activeTab()?.path).toBe('Readme.md')
  })

  it('keeps a tab whose note the new vault still has', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md')
    await useAppStore.getState().reloadVault()
    expect(useAppStore.getState().activeTab()?.path).toBe('Concepts/Zettelkasten.md')
    expect(useAppStore.getState().recent).toContain('Concepts/Zettelkasten.md')
  })

  it('flushes unsaved edits to the old vault before reloading over them', async () => {
    await openSeededVault()
    const adapter = useAppStore.getState().adapter!
    useAppStore.getState().setNoteContent('Start Here.md', '# Start Here\n\ntwo unsaved paragraphs\n')

    await useAppStore.getState().reloadVault()

    expect(await adapter.read('Start Here.md')).toContain('two unsaved paragraphs')
    expect(useAppStore.getState().notes.get('Start Here.md')!.content).toContain('two unsaved paragraphs')
    expect(useAppStore.getState().dirty.size).toBe(0)
  })

  it('warns by name about edits it could not flush instead of dropping them silently', async () => {
    await openSeededVault()
    const adapter = useAppStore.getState().adapter!
    adapter.write = () => Promise.reject(new Error('quota exceeded'))
    useAppStore.getState().setNoteContent('Start Here.md', '# Start Here\n\nunsaved\n')

    await useAppStore.getState().reloadVault()

    const toast = useAppStore.getState().toasts.find((t) => t.message.includes('could not be saved before loading'))
    expect(toast?.kind).toBe('error')
    expect(toast?.message).toContain('Start Here.md')
  })
})

describe('typing in a note that is expensive to parse', () => {
  /** Big enough that parsing it costs real time — the same shape as a long journal. */
  const HUGE = ['# Journal', '', ...Array.from({ length: 14_000 }, (_, i) => `${i}. A line that links [[Hub]] and tags #jurnal.`), ''].join('\n')

  const seedHuge = async (): Promise<void> => {
    const adapter = createMemoryVault(
      { 'Hub.md': '# Hub\n', 'Target.md': '# Target\n', 'Journal.md': HUGE },
      { name: 'Heavy' },
    )
    await useAppStore.getState().openVault(adapter)
    // One keystroke to learn what this note costs to parse. Nothing is deferred
    // until it has been parsed once — there is nothing to go on before that.
    useAppStore.getState().setNoteContent('Journal.md', `${HUGE}\n`)
  }

  /** A note's `parsed` is replaced wholesale by a parse, so its identity says whether one happened. */
  const parsedOf = (path: NotePath): unknown => useAppStore.getState().notes.get(path)!.parsed

  it('stops reparsing the whole note on every keystroke once it proves slow', async () => {
    await seedHuge()

    let content = `${HUGE}\n`
    const afterFirst = parsedOf('Journal.md')

    for (let i = 0; i < 30; i += 1) {
      content += 'x'
      useAppStore.getState().setNoteContent('Journal.md', content)
    }

    // The rest of the burst reuses it rather than parsing 600 KB thirty times.
    expect(parsedOf('Journal.md')).toBe(afterFirst)
    // The text itself is never behind: it is what gets saved.
    expect(useAppStore.getState().notes.get('Journal.md')!.content).toBe(content)
  })

  it('catches the parse up once the typing stops', async () => {
    // The clock the deferral measures itself against is left real: a frozen
    // `performance.now()` reports every parse as free, and the store then
    // (correctly, but uninterestingly) never defers one.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    await seedHuge()

    const content = `${HUGE}\n## A brand new heading\n`
    useAppStore.getState().setNoteContent('Journal.md', content)

    // Mid-burst the outline has not noticed the heading yet…
    const headings = useAppStore.getState().notes.get('Journal.md')!.parsed.headings
    expect(headings.some((h) => h.text === 'A brand new heading')).toBe(false)

    await vi.advanceTimersByTimeAsync(400)

    // …and once the typing settles, it has.
    expect(
      useAppStore.getState().notes.get('Journal.md')!.parsed.headings.some((h) => h.text === 'A brand new heading'),
    ).toBe(true)
    vi.useRealTimers()
  })

  it('never hands out an index built on a parse that is behind', async () => {
    await seedHuge()

    useAppStore.getState().setNoteContent('Journal.md', `${HUGE}\nAnd now [[Target]].\n`)

    // Asked for right now, mid-burst: the answer has to be the true one, even
    // though the note's own `parsed` has not caught up yet.
    expect(useAppStore.getState().backlinksFor('Target.md')).toHaveLength(1)
  })

  it('writes the text that was typed, not the text that was last parsed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    await seedHuge()
    const adapter = useAppStore.getState().adapter!
    useAppStore.getState().updateSettings({ autosaveDelay: 300 })

    const content = `${HUGE}\nthe very last thing typed\n`
    useAppStore.getState().setNoteContent('Journal.md', content)
    await vi.advanceTimersByTimeAsync(500)

    expect(await adapter.read('Journal.md')).toBe(content)
    vi.useRealTimers()
  })

  it('leaves ordinary notes parsing on every keystroke', async () => {
    await openSeededVault()

    const seen = new Set<unknown>()
    for (const typed of ['a', 'ab', 'abc', 'abcd']) {
      useAppStore.getState().setNoteContent('Start Here.md', `# Start Here\n\n${typed}\n`)
      seen.add(parsedOf('Start Here.md'))
    }

    // Four keystrokes, four parses: a note this size is not worth deferring,
    // and nothing about it lags, not even for a frame.
    expect(seen.size).toBe(4)
    expect(useAppStore.getState().notes.get('Start Here.md')!.parsed.body).toContain('abcd')
  })
})

describe('editing and autosave', () => {
  it('marks a note dirty, reindexes it, and writes it through after the delay', async () => {
    vi.useFakeTimers()
    await openSeededVault()
    useAppStore.getState().updateSettings({ autosaveDelay: 500 })
    const adapter = useAppStore.getState().adapter!

    useAppStore.getState().setNoteContent('Start Here.md', '# Start Here\n\nNow links [[Daily/2026-01-15]].\n')

    expect(useAppStore.getState().dirty.has('Start Here.md')).toBe(true)
    // The index rebuild is debounced now (rebuilding it is O(whole vault), and
    // typing must not pay that per keystroke), so `state.index` can lag the text
    // by one window. Anything that must be correct *now* goes through the
    // store's selectors, which build the pending index on demand.
    expect(useAppStore.getState().backlinksFor('Daily/2026-01-15.md')).toHaveLength(1)
    expect(await adapter.read('Start Here.md')).toContain('[[Concepts/Zettelkasten]]')

    await vi.advanceTimersByTimeAsync(600)
    expect(await adapter.read('Start Here.md')).toContain('[[Daily/2026-01-15]]')
    expect(useAppStore.getState().dirty.has('Start Here.md')).toBe(false)
    // …and the committed index has caught up well inside that window.
    expect(useAppStore.getState().index.incoming.get('Daily/2026-01-15.md')).toHaveLength(1)
  })

  it('does not rebuild the link index while prose is being typed', async () => {
    vi.useFakeTimers()
    await openSeededVault()
    const base = useAppStore.getState().notes.get('Start Here.md')!.content
    const before = indexBuilds.count

    for (const typed of ['t', 'th', 'the', 'the ', 'the z']) {
      useAppStore.getState().setNoteContent('Start Here.md', `${base}${typed}\n`)
    }

    // Typing prose changes no link, so the whole-vault index is untouched…
    expect(useAppStore.getState().notes.get('Start Here.md')!.content).toContain('the z')
    expect(indexBuilds.count).toBe(before)

    // …and one rebuild — not one per keystroke — catches up the line and
    // context each link is recorded at.
    await vi.advanceTimersByTimeAsync(300)
    expect(indexBuilds.count).toBe(before + 1)
    expect(useAppStore.getState().index.outgoing.get('Start Here.md')).toHaveLength(2)
  })

  it('rebuilds once per burst, not per keystroke, while a link is typed', async () => {
    vi.useFakeTimers()
    await openSeededVault()
    const base = '# Start Here\n\nSee [[Concepts/Zettelkasten]] and [[Atomic Notes]].\n\n'
    const before = indexBuilds.count

    // Auto-closed brackets: every keystroke completes a different link, so
    // every one of them changes what this note contributes to the index.
    for (const typed of ['[[D]]', '[[Da]]', '[[Dai]]', '[[Daily/2026-01-1]]', '[[Daily/2026-01-15]]']) {
      useAppStore.getState().setNoteContent('Start Here.md', `${base}${typed}\n`)
    }

    // The first keystroke of the burst lands outside it and is committed at
    // once; the four after it coalesce into the trailing rebuild.
    expect(indexBuilds.count).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(300)
    expect(indexBuilds.count).toBe(before + 2)

    const outgoing = useAppStore.getState().index.outgoing.get('Start Here.md')!
    expect(outgoing.map((edge) => edge.to)).toContain('Daily/2026-01-15.md')
  })

  it('commits a discrete edit to the index at once, even mid-burst elsewhere', async () => {
    vi.useFakeTimers()
    await openSeededVault()
    // Someone is typing in one note…
    useAppStore.getState().setNoteContent('Daily/2026-01-15.md', '# 2026-01-15\n\n- [ ] read [[Zettelkasten]] again\n')

    // …while a deliberate edit lands in another: linking an unlinked mention,
    // a paste, a scripted rewrite. Panels keyed on `index` must see that one
    // without waiting out the typing debounce.
    useAppStore.getState().setNoteContent('Concepts/Atomic Notes.md', '# Atomic Notes\n\nBack to [[Start Here]].\n')
    expect(useAppStore.getState().index.incoming.get('Start Here.md')).toHaveLength(1)
  })

  it('keeps a note dirty when the user types while its write is in flight', async () => {
    vi.useFakeTimers()
    await openSeededVault()
    const adapter = useAppStore.getState().adapter!
    const write = adapter.write.bind(adapter)
    let release = (): void => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    adapter.write = async (path, content) => {
      await inFlight
      await write(path, content)
    }

    useAppStore.getState().setNoteContent('Start Here.md', 'v1')
    const saving = useAppStore.getState().saveNote('Start Here.md')
    useAppStore.getState().setNoteContent('Start Here.md', 'v2 IMPORTANT UNSAVED')
    release()
    await saving

    const state = useAppStore.getState()
    expect(await adapter.read('Start Here.md')).toBe('v1')
    expect(state.notes.get('Start Here.md')!.content).toBe('v2 IMPORTANT UNSAVED')
    // The write that landed only carried `v1`, so `v2` is still unsaved — and
    // the unload guard keys off exactly this flag.
    expect(state.dirty.has('Start Here.md')).toBe(true)
  })

  it('does not write through an adapter the vault switched away from', async () => {
    await openSeededVault()
    const previous = useAppStore.getState().adapter!
    const other = createMemoryVault({}, { name: 'Other' })
    // Stand in for a vault swap landing between the save starting and its write:
    // zustand runs subscribers synchronously, so this fires from inside `set`.
    const stop = useAppStore.subscribe((s) => {
      if (s.saving.has('Start Here.md') && s.adapter === previous) useAppStore.setState({ adapter: other })
    })
    useAppStore.getState().setNoteContent('Start Here.md', '# Start Here\n\nold vault text\n')
    await useAppStore.getState().saveNote('Start Here.md')
    stop()

    expect(await previous.read('Start Here.md')).not.toContain('old vault text')
    expect(useAppStore.getState().saving.size).toBe(0)
  })

  it('ignores a write that does not change anything', async () => {
    await openSeededVault()
    const before = useAppStore.getState().notes.get('Start Here.md')
    useAppStore.getState().setNoteContent('Start Here.md', before!.content)
    expect(useAppStore.getState().notes.get('Start Here.md')).toBe(before)
    expect(useAppStore.getState().dirty.size).toBe(0)
  })

  it('surfaces a failed save instead of claiming success', async () => {
    await openSeededVault()
    const adapter = useAppStore.getState().adapter!
    adapter.write = () => Promise.reject(new Error('quota exceeded'))

    useAppStore.getState().setNoteContent('Start Here.md', 'changed')
    await useAppStore.getState().saveNote('Start Here.md')

    const state = useAppStore.getState()
    expect(state.dirty.has('Start Here.md')).toBe(true)
    expect(state.saving.has('Start Here.md')).toBe(false)
    expect(state.toasts.at(-1)?.kind).toBe('error')
  })
})

describe('createNote', () => {
  it('appends .md and never overwrites an existing note', async () => {
    await openSeededVault()
    const first = await useAppStore.getState().createNote('Notes/Idea')
    const second = await useAppStore.getState().createNote('Notes/Idea')
    expect(first).toBe('Notes/Idea.md')
    expect(second).toBe('Notes/Idea 1.md')
    expect(useAppStore.getState().notes.size).toBe(6)
  })

  it('keeps a note whose first write failed dirty so it is retried', async () => {
    await openSeededVault()
    const adapter = useAppStore.getState().adapter!
    adapter.write = () => Promise.reject(new Error('QuotaExceededError'))

    const path = await useAppStore.getState().createNote('Important Idea.md', '# Important Idea\n\nseed')

    const state = useAppStore.getState()
    expect(state.notes.has(path)).toBe(true)
    // Not on disk, so it must not be presented as saved: `saveAll` and the
    // unload flush both work off `dirty`.
    expect(state.dirty.has(path)).toBe(true)
    expect(state.toasts.at(-1)?.kind).toBe('error')
  })
})

describe('renameNote', () => {
  it('moves the note and rewrites every link that pointed at it', async () => {
    await openSeededVault()
    await useAppStore.getState().renameNote('Concepts/Zettelkasten.md', 'Concepts/Slip Box.md')

    const state = useAppStore.getState()
    expect(state.notes.has('Concepts/Zettelkasten.md')).toBe(false)
    expect(state.notes.get('Concepts/Slip Box.md')).toBeDefined()
    expect(state.notes.get('Daily/2026-01-15.md')!.content).toContain('[[Slip Box]]')
    // A link written with a folder prefix resolved to the renamed note as much
    // as a bare one did, so it is rewritten too — in path form. Leaving it as
    // `[[Concepts/Zettelkasten]]` (the old behaviour) left a dead link behind.
    expect(state.notes.get('Start Here.md')!.content).toContain('[[Concepts/Slip Box]]')
    expect(state.index.unresolved.size).toBe(0)
  })

  it('only rewrites links that actually resolved to the renamed note', async () => {
    await openSeededVault({
      'Bar/Foo.md': '# Foo\n',
      'Baz/Foo.md': '# Foo\n',
      'Baz/Other.md': 'see [[Foo]]\n',
      'Top.md': 'see [[Bar/Foo]]\n',
      'Doc.md': 'documented as:\n\n```\n[[Foo]]\n```\n',
    })
    const adapter = useAppStore.getState().adapter!

    await useAppStore.getState().renameNote('Bar/Foo.md', 'Bar/Renamed.md')

    const state = useAppStore.getState()
    // A homonym in another folder kept its own target…
    expect(state.notes.get('Baz/Other.md')!.content).toBe('see [[Foo]]\n')
    expect(await adapter.read('Baz/Other.md')).toBe('see [[Foo]]\n')
    // …the path-form link that did point here followed the rename…
    expect(state.notes.get('Top.md')!.content).toBe('see [[Bar/Renamed]]\n')
    // …and documentation inside a code fence is not markup to rewrite.
    expect(state.notes.get('Doc.md')!.content).toContain('```\n[[Foo]]\n```')
    expect(state.backlinksFor('Baz/Foo.md').map((g) => g.source)).toEqual(['Baz/Other.md'])
  })

  it('refuses to clobber an existing note', async () => {
    await openSeededVault()
    await useAppStore.getState().renameNote('Concepts/Zettelkasten.md', 'Concepts/Atomic Notes.md')
    const state = useAppStore.getState()
    expect(state.notes.has('Concepts/Zettelkasten.md')).toBe(true)
    expect(state.toasts.at(-1)?.kind).toBe('error')
  })

  it('carries open tabs, stars and recents across the rename', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md')
    useAppStore.getState().toggleStar('Concepts/Zettelkasten.md')
    await useAppStore.getState().renameNote('Concepts/Zettelkasten.md', 'Concepts/Slip Box.md')

    const state = useAppStore.getState()
    expect(state.activeTab()?.path).toBe('Concepts/Slip Box.md')
    expect(state.starred).toContain('Concepts/Slip Box.md')
    expect(state.recent).toContain('Concepts/Slip Box.md')
  })
})

describe('deleteNote', () => {
  it('removes the note everywhere it was referenced by the workspace', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md')
    useAppStore.getState().toggleStar('Concepts/Zettelkasten.md')
    await useAppStore.getState().deleteNote('Concepts/Zettelkasten.md')

    const state = useAppStore.getState()
    expect(state.notes.has('Concepts/Zettelkasten.md')).toBe(false)
    expect(state.starred).not.toContain('Concepts/Zettelkasten.md')
    expect(state.recent).not.toContain('Concepts/Zettelkasten.md')
    expect(state.panes.flatMap((p) => p.tabs).some((t) => t.path === 'Concepts/Zettelkasten.md')).toBe(false)
    // The link that pointed at it is now unresolved rather than dangling.
    expect(state.index.outgoing.get('Start Here.md')!.some((e) => e.to === null)).toBe(true)
  })

  it('does not claim success, or forget the note, when the remove fails', async () => {
    await openSeededVault()
    const adapter = useAppStore.getState().adapter!
    adapter.remove = () => Promise.reject(new Error('NoModificationAllowedError'))

    await useAppStore.getState().deleteNote('Concepts/Zettelkasten.md')

    const state = useAppStore.getState()
    // The file is still in the vault, so the workspace must still show it.
    expect(await adapter.exists('Concepts/Zettelkasten.md')).toBe(true)
    expect(state.notes.has('Concepts/Zettelkasten.md')).toBe(true)
    expect(state.toasts.some((t) => t.message.startsWith('Deleted'))).toBe(false)
    expect(state.toasts.at(-1)?.kind).toBe('error')
  })
})

describe('starred persistence', () => {
  it('survives a reload as an array rather than an object', async () => {
    await openSeededVault()
    useAppStore.getState().toggleStar('Concepts/Zettelkasten.md')

    const restored = await bootStore(localStorage.getItem('spacefore.starred'))

    expect(Array.isArray(restored.starred)).toBe(true)
    expect(restored.starred).toEqual(['Concepts/Zettelkasten.md'])
    expect(restored.starred.includes('Concepts/Zettelkasten.md')).toBe(true)
    expect([...restored.starred]).toEqual(['Concepts/Zettelkasten.md'])
  })

  it('falls back to an empty list for a corrupt or legacy value', async () => {
    // What the object-spreading loader used to hand back, and what a hand-edited
    // or half-written entry looks like.
    expect((await bootStore('{"0":"A.md"}')).starred).toEqual([])
    expect((await bootStore('"A.md"')).starred).toEqual([])
    expect((await bootStore('not json')).starred).toEqual([])
    expect((await bootStore('[1, "A.md", null]')).starred).toEqual(['A.md'])
    expect((await bootStore('[]')).starred).toEqual([])
  })

  it('still merges an object-shaped setting over the defaults', async () => {
    localStorage.setItem('spacefore.settings', JSON.stringify({ fontSize: 22 }))
    expect((await bootStore(null)).settings.fontSize).toBe(22)
    expect((await bootStore(null)).settings.dailyNoteFormat).toBe('YYYY-MM-DD')

    localStorage.setItem('spacefore.settings', JSON.stringify(['nonsense']))
    expect((await bootStore(null)).settings.fontSize).toBe(16)
  })

  it('is written back when a delete or a rename changes it', async () => {
    await openSeededVault()
    useAppStore.getState().toggleStar('Concepts/Zettelkasten.md')

    await useAppStore.getState().renameNote('Concepts/Zettelkasten.md', 'Concepts/Slip Box.md')
    expect((await bootStore(localStorage.getItem('spacefore.starred'))).starred).toEqual(['Concepts/Slip Box.md'])

    await useAppStore.getState().deleteNote('Concepts/Slip Box.md')
    expect((await bootStore(localStorage.getItem('spacefore.starred'))).starred).toEqual([])
  })
})

describe('tabs and panes', () => {
  it('reuses the active tab but respects a pinned one', async () => {
    await openSeededVault()
    const store = useAppStore.getState()
    store.openPath('Concepts/Zettelkasten.md')
    expect(pane().tabs).toHaveLength(1)

    useAppStore.getState().togglePinTab(pane().id, pane().activeTabId!)
    useAppStore.getState().openPath('Concepts/Atomic Notes.md')
    expect(pane().tabs).toHaveLength(2)
    expect(pane().tabs[0]!.path).toBe('Concepts/Zettelkasten.md')
  })

  it('focuses an already-open note instead of opening it twice', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md', { newTab: true })
    useAppStore.getState().openPath('Concepts/Atomic Notes.md', { newTab: true })
    const count = pane().tabs.length
    useAppStore.getState().openPath('Concepts/Zettelkasten.md')
    expect(pane().tabs).toHaveLength(count)
    expect(useAppStore.getState().activeTab()?.path).toBe('Concepts/Zettelkasten.md')
  })

  it('does not inherit a graph tab’s placeholder mode when opening a note', async () => {
    await openSeededVault()
    useAppStore.getState().setViewMode('edit')
    useAppStore.getState().openView('graph')
    expect(useAppStore.getState().activeTab()?.kind).toBe('graph')

    useAppStore.getState().openPath('Concepts/Atomic Notes.md')
    expect(useAppStore.getState().activeTab()?.mode).toBe('edit')
  })

  it('always leaves the last pane with at least one tab', async () => {
    await openSeededVault()
    const id = pane().id
    for (const tab of [...pane().tabs]) useAppStore.getState().closeTab(id, tab.id)
    expect(useAppStore.getState().panes).toHaveLength(1)
    expect(pane().tabs).toHaveLength(1)
    expect(pane().activeTabId).toBe(pane().tabs[0]!.id)
  })

  it('keeps activeTabId pointing at a tab that still exists', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md', { newTab: true })
    useAppStore.getState().openPath('Concepts/Atomic Notes.md', { newTab: true })
    const id = pane().id
    const active = pane().activeTabId!
    useAppStore.getState().closeTab(id, active)
    expect(pane().tabs.some((t) => t.id === pane().activeTabId)).toBe(true)
  })

  it('moves a tab between panes without losing or duplicating it', async () => {
    await openSeededVault()
    useAppStore.getState().openPath('Concepts/Zettelkasten.md')
    useAppStore.getState().splitPane()
    const [left, right] = useAppStore.getState().panes
    const moving = left!.tabs[0]!.id

    useAppStore.getState().moveTab(left!.id, moving, right!.id, 0)

    const panes = useAppStore.getState().panes
    const all = panes.flatMap((p) => p.tabs.map((t) => t.id))
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain(moving)
    for (const p of panes) {
      expect(p.tabs.some((t) => t.id === p.activeTabId)).toBe(true)
    }
  })

  it('cycles edit → split → preview', async () => {
    await openSeededVault()
    useAppStore.getState().setViewMode('edit')
    useAppStore.getState().cycleViewMode()
    expect(useAppStore.getState().activeTab()?.mode).toBe('split')
    useAppStore.getState().cycleViewMode()
    expect(useAppStore.getState().activeTab()?.mode).toBe('preview')
    useAppStore.getState().cycleViewMode()
    expect(useAppStore.getState().activeTab()?.mode).toBe('edit')
  })
})

describe('openLink', () => {
  it('navigates to an existing note', async () => {
    await openSeededVault()
    await useAppStore.getState().openLink('Atomic Notes', 'Start Here.md')
    expect(useAppStore.getState().activeTab()?.path).toBe('Concepts/Atomic Notes.md')
  })

  it('creates the note next to its source when the link is unresolved', async () => {
    await openSeededVault()
    await useAppStore.getState().openLink('Brand New', 'Concepts/Zettelkasten.md')
    const state = useAppStore.getState()
    expect(state.notes.has('Concepts/Brand New.md')).toBe(true)
    expect(state.activeTab()?.path).toBe('Concepts/Brand New.md')
    expect(state.activeTab()?.mode).toBe('edit')
  })
})

describe('backlink selectors', () => {
  it('groups incoming links by source note', async () => {
    await openSeededVault()
    const groups = useAppStore.getState().backlinksFor('Concepts/Atomic Notes.md')
    expect(groups.map((g) => g.source).sort()).toEqual(['Concepts/Zettelkasten.md', 'Start Here.md'])
    expect(groups[0]!.edges[0]!.context).toBeTruthy()
  })

  it('lists resolved outgoing links only', async () => {
    await openSeededVault()
    await useAppStore.getState().deleteNote('Concepts/Atomic Notes.md')
    const outgoing = useAppStore.getState().outgoingFor('Start Here.md')
    expect(outgoing.map((g) => g.source)).toEqual(['Concepts/Zettelkasten.md'])
  })
})

describe('the last vault kind is remembered', () => {
  it('records the kind of a vault that loaded successfully', async () => {
    localStorage.removeItem(LAST_VAULT_KEY)
    await openSeededVault()
    expect(JSON.parse(localStorage.getItem(LAST_VAULT_KEY)!)).toEqual({ kind: 'demo' })
  })

  it('does not record a vault that failed to load', async () => {
    await openSeededVault()
    localStorage.setItem(LAST_VAULT_KEY, JSON.stringify({ kind: 'demo' }))
    const broken = createMemoryVault({})
    Object.defineProperty(broken, 'kind', { value: 'browser' })
    broken.list = () => Promise.reject(new Error('no storage'))
    await useAppStore.getState().openVault(broken)
    expect(JSON.parse(localStorage.getItem(LAST_VAULT_KEY)!)).toEqual({ kind: 'demo' })
  })
})

describe('a fallback vault does not overwrite the remembered choice', () => {
  it('leaves the recorded kind alone when remember is false', async () => {
    localStorage.setItem(LAST_VAULT_KEY, JSON.stringify({ kind: 'directory' }))
    // The boot fallback: a folder that could not be reopened this time must
    // still be the vault reopened next time.
    await useAppStore.getState().openVault(createMemoryVault(SEED, { name: 'Demo' }), { remember: false })
    expect(useAppStore.getState().notes.size).toBe(4)
    expect(JSON.parse(localStorage.getItem(LAST_VAULT_KEY)!)).toEqual({ kind: 'directory' })
  })

  it('still records a vault the user picked deliberately', async () => {
    localStorage.setItem(LAST_VAULT_KEY, JSON.stringify({ kind: 'directory' }))
    await openSeededVault()
    expect(JSON.parse(localStorage.getItem(LAST_VAULT_KEY)!)).toEqual({ kind: 'demo' })
  })
})

describe('line endings survive editing', () => {
  const CRLF = '# Rapat\r\n\r\nDitulis di Windows.\r\n'

  it('normalises to \\n in memory but remembers what the file uses', async () => {
    await useAppStore.getState().openVault(createMemoryVault({ 'Rapat.md': CRLF }, { name: 'CRLF' }))
    const note = useAppStore.getState().notes.get('Rapat.md')!
    expect(note.lineEnding).toBe('\r\n')
    // Everything downstream — offsets, search, the editor — works in \n.
    expect(note.content).toBe('# Rapat\n\nDitulis di Windows.\n')
    expect(note.content).not.toMatch(/\r/)
  })

  it('writes the file back with its own line endings', async () => {
    vi.useFakeTimers()
    try {
      const adapter = createMemoryVault({ 'Rapat.md': CRLF }, { name: 'CRLF' })
      await useAppStore.getState().openVault(adapter)
      useAppStore.getState().updateSettings({ autosaveDelay: 300 })

      const note = useAppStore.getState().notes.get('Rapat.md')!
      useAppStore.getState().setNoteContent('Rapat.md', `${note.content}\nBaris baru.\n`)
      await vi.advanceTimersByTimeAsync(500)

      const onDisk = await adapter.read('Rapat.md')
      expect(onDisk).toBe('# Rapat\r\n\r\nDitulis di Windows.\r\n\r\nBaris baru.\r\n')
      expect(onDisk).not.toMatch(/[^\r]\n/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an LF file alone', async () => {
    vi.useFakeTimers()
    try {
      const adapter = createMemoryVault({ 'Catatan.md': '# Catatan\n\nUnix.\n' }, { name: 'LF' })
      await useAppStore.getState().openVault(adapter)
      useAppStore.getState().updateSettings({ autosaveDelay: 300 })
      expect(useAppStore.getState().notes.get('Catatan.md')!.lineEnding).toBe('\n')

      useAppStore.getState().setNoteContent('Catatan.md', '# Catatan\n\nUnix.\nDitambah.\n')
      await vi.advanceTimersByTimeAsync(500)
      expect(await adapter.read('Catatan.md')).toBe('# Catatan\n\nUnix.\nDitambah.\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the file’s endings through a rename that rewrites links', async () => {
    const adapter = createMemoryVault(
      { 'A.md': '# A\r\n\r\nLihat [[B]].\r\n', 'B.md': '# B\r\n' },
      { name: 'CRLF' },
    )
    await useAppStore.getState().openVault(adapter)
    await useAppStore.getState().renameNote('B.md', 'C.md')

    expect(useAppStore.getState().notes.get('A.md')!.lineEnding).toBe('\r\n')
    expect(await adapter.read('A.md')).toBe('# A\r\n\r\nLihat [[C]].\r\n')
    expect(await adapter.read('C.md')).toBe('# B\r\n')
  })
})

describe('attaching a file', () => {
  const png = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' })

  it('writes the bytes and answers with what to type in the note', async () => {
    await openSeededVault()
    const attached = await useAppStore.getState().attachFile(png())

    expect(attached?.path).toMatch(/^attachments\/Pasted image \d{14}\.png$/)
    expect(attached?.embed).toBe(`![[${attached!.path.slice('attachments/'.length)}]]`)

    // Read it back off the vault, not out of the store's own bookkeeping.
    const bytes = new Uint8Array(await (await useAppStore.getState().adapter!.readBinary(attached!.path)).arrayBuffer())
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('lists it, which is what makes the embed resolve', async () => {
    await openSeededVault()
    const attached = await useAppStore.getState().attachFile(png())
    expect(useAppStore.getState().attachments.map((file) => file.path)).toContain(attached!.path)
  })

  it('honours the configured folder, including the vault root', async () => {
    await openSeededVault()
    useAppStore.getState().updateSettings({ attachmentFolder: 'files/pictures' })
    expect((await useAppStore.getState().attachFile(png()))?.path).toMatch(/^files\/pictures\//)

    useAppStore.getState().updateSettings({ attachmentFolder: '' })
    // The root is the case that used to be impossible twice over: `||` turned
    // an empty folder back into the default, and `normalizePath` threw on an
    // empty path. No slash in the result is the whole assertion — the ` 1` is
    // the vault-wide name rule doing its job, since both pastes in this test
    // land on the same second.
    const atRoot = (await useAppStore.getState().attachFile(png()))?.path
    expect(atRoot).toMatch(/^Pasted image \d{14}( \d+)?\.png$/)
    expect(atRoot).not.toContain('/')
  })

  it('never overwrites a file that is already there', async () => {
    await openSeededVault()
    const first = await useAppStore.getState().attachFile(new File([new Uint8Array([1])], 'chart.png', { type: 'image/png' }))
    const second = await useAppStore.getState().attachFile(new File([new Uint8Array([2])], 'chart.png', { type: 'image/png' }))

    expect(second?.path).not.toBe(first?.path)
    const bytes = new Uint8Array(await (await useAppStore.getState().adapter!.readBinary(first!.path)).arrayBuffer())
    expect([...bytes]).toEqual([1])
  })

  it('says so rather than failing quietly on a read-only vault', async () => {
    // The demo vault is writable, so a genuinely read-only one is needed here.
    await useAppStore.getState().openVault(createMemoryVault({ 'a.md': 'A' }, { name: 'Docs', writable: false }))
    expect(useAppStore.getState().adapter?.writable).toBe(false)

    expect(await useAppStore.getState().attachFile(png())).toBeNull()
    const toast = useAppStore.getState().toasts.at(-1)
    expect(toast?.kind).toBe('error')
    expect(toast?.message).toMatch(/read-only/i)
  })
})


describe('renaming and moving: what a link is left pointing at', () => {
  /** The links a note carries, as written. */
  const written = (path: NotePath): string[] =>
    [...(useAppStore.getState().notes.get(path)?.content ?? '').matchAll(/\[\[([^\]]*)\]\]/g)].map((m) => m[1]!)
  const resolves = (target: string, from: NotePath): NotePath | null =>
    resolveLinkTarget(target, from, useAppStore.getState().index)

  it('rewrites the links a note makes to itself', async () => {
    // These were skipped outright — the loop stepped over the note being
    // renamed — so [[Note]], [[Note#Top]] and [[Note|me]] inside Note.md all
    // dangled the moment it became New.md.
    await openSeededVault({ 'Note.md': '# Note\n\nSee [[Note]], [[Note#Top]] and [[Note|me]].\n' })
    await useAppStore.getState().renameNote('Note.md', 'New.md')

    expect(useAppStore.getState().notes.get('New.md')?.content).toBe('# Note\n\nSee [[New]], [[New#Top]] and [[New|me]].\n')
    expect(await useAppStore.getState().adapter!.read('New.md')).toBe('# Note\n\nSee [[New]], [[New#Top]] and [[New|me]].\n')
    expect(useAppStore.getState().index.unresolved.size).toBe(0)
  })

  it('keeps a bare link on the note that moved, not on a namesake it now falls back to', async () => {
    // [[Note]] from Ref.md meant the root Note.md. Move that into zzz/ and a
    // bare [[Note]] would resolve to a/Note.md instead — the shortest path
    // wins — so the link is written as a path, the one spelling that cannot
    // be misread.
    await openSeededVault({ 'Note.md': '# root\n', 'a/Note.md': '# other\n', 'Ref.md': 'see [[Note]]\n' })
    expect(resolves('Note', 'Ref.md')).toBe('Note.md')

    await useAppStore.getState().renameNote('Note.md', 'zzz/Note.md')

    const [link] = written('Ref.md')
    expect(resolves(link!, 'Ref.md')).toBe('zzz/Note.md')
    expect(useAppStore.getState().index.incoming.get('zzz/Note.md')?.map((edge) => edge.from)).toEqual(['Ref.md'])
  })

  it('leaves a bare link bare when it still lands on the moved note', async () => {
    // No namesake anywhere: the spelling the person chose is kept.
    await openSeededVault({ 'Note.md': '# root\n', 'Ref.md': 'see [[Note]]\n' })
    await useAppStore.getState().renameNote('Note.md', 'zzz/Note.md')
    expect(written('Ref.md')).toEqual(['Note'])
    expect(resolves('Note', 'Ref.md')).toBe('zzz/Note.md')
  })

  it('keeps a moved note’s own bare links pointing where they did', async () => {
    // From inside sub/, [[Sibling]] is the sibling next door. From the root
    // it would be the root’s Sibling.md — a different note — so the link is
    // re-anchored to the one it always meant.
    await openSeededVault({ 'sub/Note.md': 'see [[Sibling]]\n', 'sub/Sibling.md': '# local\n', 'Sibling.md': '# root\n' })
    expect(resolves('Sibling', 'sub/Note.md')).toBe('sub/Sibling.md')

    await useAppStore.getState().renameNote('sub/Note.md', 'Note.md')

    const [link] = written('Note.md')
    expect(resolves(link!, 'Note.md')).toBe('sub/Sibling.md')
    expect(useAppStore.getState().index.outgoing.get('Note.md')?.map((edge) => edge.to)).toEqual(['sub/Sibling.md'])
  })

  for (const form of ['./f/Note', '/f/Note', 'f\\Note', 'x/Note']) {
    it(`follows the rename when the link was written [[${form}]]`, async () => {
      // The resolver accepts all of these for f/Note.md; the rewrite used to
      // recognise only the exact spellings it expected, and left the rest
      // pointing at a file that no longer existed.
      await openSeededVault({ 'f/Note.md': '# Note\n', 'Ref.md': `see [[${form}]]\n` })
      expect(resolves(form, 'Ref.md')).toBe('f/Note.md')

      await useAppStore.getState().renameNote('f/Note.md', 'g/New.md')

      const [link] = written('Ref.md')
      expect(resolves(link!, 'Ref.md')).toBe('g/New.md')
      expect(useAppStore.getState().index.unresolved.size).toBe(0)
    })
  }

  it('does not touch an alias that happens to resolve to the renamed note', async () => {
    await openSeededVault({
      'Note.md': '---\naliases: [Nickname]\n---\n\n# Note\n',
      'Ref.md': 'see [[Nickname]] and [[Note]]\n',
    })
    await useAppStore.getState().renameNote('Note.md', 'New.md')
    // The alias still belongs to the note; only the name changed.
    expect(written('Ref.md')).toEqual(['Nickname', 'New'])
  })

  describe('while a big note has a deferred parse', () => {
    // A note big enough that parsing it costs more than the per-keystroke
    // budget, so the store defers its reparse while typing — leaving
    // `parsed.links` describing text that is no longer there.
    const FILLER = Array.from({ length: 14_000 }, (_, i) => `${i}. A plain line of journal prose without any links at all.`).join('\n') + '\n'
    // After 101 characters are inserted at the top, the stale link offsets
    // land on the prose word "xHubyyy" instead of on `[[Hub]]`.
    const PROSE = 'z'.repeat(10) + 'xHubyyy' + 'w'.repeat(89) + '\n'
    const JOURNAL = FILLER + PROSE + 'See [[Hub]].\n'

    async function seedAndDeferParse(): Promise<void> {
      await openSeededVault({ 'Journal.md': JOURNAL, 'Hub.md': '# Hub\n' })
      // First keystroke: parsed and timed, and it proves expensive.
      useAppStore.getState().setNoteContent('Journal.md', JOURNAL + 'x')
      // Second keystroke, before the settle: the parse is deferred, so
      // `parsed.links` still carries offsets for the old text.
      useAppStore.getState().setNoteContent('Journal.md', 'A'.repeat(100) + '\n' + JOURNAL + 'x')
      const note = useAppStore.getState().notes.get('Journal.md')!
      expect(note.content.startsWith('AAAA')).toBe(true)
      expect(note.parsed.links[0]!.start).toBeLessThan(FILLER.length + PROSE.length + 10)
    }

    it('never splices the new name into prose at the stale offsets', async () => {
      await seedAndDeferParse()
      await useAppStore.getState().renameNote('Hub.md', 'Hub2.md')
      const tail = useAppStore.getState().notes.get('Journal.md')!.content.slice(-140)
      // This is what it used to do: "xHubyyy" three lines up became "xHub2yyy".
      expect(tail).not.toContain('xHub2yyy')
    })

    it('still rewrites the link that really pointed at the renamed note', async () => {
      await seedAndDeferParse()
      await useAppStore.getState().renameNote('Hub.md', 'Hub2.md')
      const tail = useAppStore.getState().notes.get('Journal.md')!.content.slice(-140)
      expect(tail).toContain('[[Hub2]]')
      expect(useAppStore.getState().index.unresolved.size).toBe(0)
    })
  })
})
