/**
 * Tests for the central store — vault loading, autosave, the rename/link
 * rewrite, and the tab/pane invariants the whole workspace depends on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotePath, Pane } from '../types'
import { createMemoryVault } from '../core/vault/memoryVault'
import {
  basename,
  dirname,
  formatDate,
  joinPath,
  rewriteWikiLinks,
  sanitizeFileName,
  useAppStore,
} from './store'

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

describe('rewriteWikiLinks', () => {
  it('retargets every form of the link and leaves the rest alone', () => {
    const source = 'a [[Old]] b [[Old|alias]] c [[Old#Head]] d ![[Old]] e [[Older]] f [[old]]'
    expect(rewriteWikiLinks(source, 'Old', 'New')).toBe(
      'a [[New]] b [[New|alias]] c [[New#Head]] d ![[New]] e [[Older]] f [[New]]',
    )
  })

  it('is a no-op when the name does not change', () => {
    expect(rewriteWikiLinks('[[Old]]', 'Old', 'Old')).toBe('[[Old]]')
  })

  it('keeps block references intact', () => {
    expect(rewriteWikiLinks('[[Old#^abc123|see]]', 'Old', 'New')).toBe('[[New#^abc123|see]]')
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
})

describe('editing and autosave', () => {
  it('marks a note dirty, reindexes it, and writes it through after the delay', async () => {
    vi.useFakeTimers()
    await openSeededVault()
    useAppStore.getState().updateSettings({ autosaveDelay: 500 })
    const adapter = useAppStore.getState().adapter!

    useAppStore.getState().setNoteContent('Start Here.md', '# Start Here\n\nNow links [[Daily/2026-01-15]].\n')

    expect(useAppStore.getState().dirty.has('Start Here.md')).toBe(true)
    // The index follows the edit immediately, so backlinks never lag the text.
    expect(useAppStore.getState().index.incoming.get('Daily/2026-01-15.md')).toHaveLength(1)
    expect(await adapter.read('Start Here.md')).toContain('[[Concepts/Zettelkasten]]')

    await vi.advanceTimersByTimeAsync(600)
    expect(await adapter.read('Start Here.md')).toContain('[[Daily/2026-01-15]]')
    expect(useAppStore.getState().dirty.has('Start Here.md')).toBe(false)
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
})

describe('renameNote', () => {
  it('moves the note and rewrites every link that pointed at it', async () => {
    await openSeededVault()
    await useAppStore.getState().renameNote('Concepts/Zettelkasten.md', 'Concepts/Slip Box.md')

    const state = useAppStore.getState()
    expect(state.notes.has('Concepts/Zettelkasten.md')).toBe(false)
    expect(state.notes.get('Concepts/Slip Box.md')).toBeDefined()
    expect(state.notes.get('Daily/2026-01-15.md')!.content).toContain('[[Slip Box]]')
    // A link written with a folder prefix is left for the resolver, not mangled.
    expect(state.notes.get('Start Here.md')!.content).toContain('[[Concepts/Zettelkasten]]')
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
