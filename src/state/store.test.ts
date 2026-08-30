/**
 * Tests for the central store — vault loading, autosave, the rename/link
 * rewrite, and the tab/pane invariants the whole workspace depends on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note, NotePath, Pane } from '../types'
import { createMemoryVault } from '../core/vault/memoryVault'
import { buildIndex } from '../core/graph/index'
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
