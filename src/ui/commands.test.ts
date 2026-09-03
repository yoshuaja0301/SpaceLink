import { cleanup, renderHook } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import type { Command, Note, NotePath } from '../types'
import { buildIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { registerEditor } from './editor/markdownCommands'
import { parseShortcut } from './useHotkeys'
import { SECTIONS, resetNavigationHistory, useCommands } from './commands'
import { back as historyBack, canForward as historyCanForward, snapshot as historySnapshot } from './paneHistory'

const PRISTINE = useAppStore.getState()

const EDITOR_PANE = 'pane-editor'

function seed(files: Record<NotePath, string>): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes) })
}

/** The same stand-in `EditorView` the markdown command tests use, plus focus. */
function fakeEditor(doc: string): { view: EditorView; doc: () => string } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(doc.length) })
  const view = {
    hasFocus: true,
    focus() {},
    get state() {
      return state
    },
    dispatch(...specs: Array<TransactionSpec | Transaction>) {
      for (const spec of specs) state = spec instanceof Transaction ? spec.state : state.update(spec).state
    },
  } as unknown as EditorView
  return { view, doc: () => state.doc.toString() }
}

function commands(): { current: Command[]; unmount: () => void } {
  const rendered = renderHook(() => useCommands())
  return {
    get current() {
      return rendered.result.current
    },
    unmount: rendered.unmount,
  }
}

function find(list: Command[], id: string): Command {
  const command = list.find((c) => c.id === id)
  if (!command) throw new Error(`no command ${id}`)
  return command
}

beforeEach(() => {
  useAppStore.setState(PRISTINE, true)
  resetNavigationHistory()
  registerEditor(EDITOR_PANE, null)
})

afterEach(() => {
  cleanup()
  registerEditor(EDITOR_PANE, null)
  resetNavigationHistory()
  useAppStore.setState(PRISTINE, true)
  vi.restoreAllMocks()
})

describe('the command table', () => {
  it('gives every command a unique id, a known section and a runnable action', () => {
    const list = commands().current
    const ids = new Set<string>()
    for (const command of list) {
      expect(command.title.length).toBeGreaterThan(0)
      expect(SECTIONS).toContain(command.section as (typeof SECTIONS)[number])
      expect(typeof command.run).toBe('function')
      expect(ids.has(command.id)).toBe(false)
      ids.add(command.id)
    }
    expect(ids.size).toBe(list.length)
  })

  it('covers every section', () => {
    const list = commands().current
    for (const section of SECTIONS) {
      expect(list.some((command) => command.section === section)).toBe(true)
    }
  })

  it('renders parseable, unique shortcuts', () => {
    const list = commands().current
    const seen = new Set<string>()
    for (const command of list) {
      if (!command.shortcut) continue
      const parsed = parseShortcut(command.shortcut)
      expect(parsed.key).not.toBe('')
      const signature = `${parsed.mod}|${parsed.shift}|${parsed.alt}|${parsed.key}`
      expect(seen.has(signature)).toBe(false)
      seen.add(signature)
    }
    expect(seen.size).toBeGreaterThan(10)
  })

  it('labels shortcuts for the current platform', () => {
    const list = commands().current
    expect(find(list, 'nav:go-to-file').shortcut).toBe('Ctrl+P')
    expect(find(list, 'file:daily-note').shortcut).toBe('Ctrl+Shift+D')
    expect(find(list, 'nav:back').shortcut).toBe('Alt+Left')
    expect(find(list, 'file:rename').shortcut).toBe('F2')
  })

  it('keeps the identity of the list stable across unrelated renders', () => {
    const rendered = renderHook(() => useCommands())
    const first = rendered.result.current
    rendered.rerender()
    expect(rendered.result.current).toBe(first)
  })
})

describe('file commands', () => {
  it('creates a note in the configured folder, or the current one', () => {
    const createNoteFromTitle = vi.fn(async () => 'x.md')
    seed({ 'notes/deep/A.md': '# A' })
    useAppStore.setState({ createNoteFromTitle })
    act(() => useAppStore.getState().openPath('notes/deep/A.md'))

    const list = commands().current
    find(list, 'file:new-note').run()
    expect(createNoteFromTitle).toHaveBeenLastCalledWith('Untitled')

    find(list, 'file:new-note-here').run()
    expect(createNoteFromTitle).toHaveBeenLastCalledWith('Untitled', 'notes/deep')
  })

  it('flips the star command label with the note it points at', () => {
    seed({ 'A.md': '# A' })
    const rendered = renderHook(() => useCommands())
    act(() => useAppStore.getState().openPath('A.md'))
    expect(find(rendered.result.current, 'file:toggle-star').title).toBe('Star current note')

    act(() => find(rendered.result.current, 'file:toggle-star').run())
    expect(useAppStore.getState().starred).toEqual(['A.md'])
    expect(find(rendered.result.current, 'file:toggle-star').title).toBe('Unstar current note')
  })

  it('disables note commands until a note is open', () => {
    seed({ 'A.md': '# A' })
    const rendered = renderHook(() => useCommands())
    for (const id of ['file:save', 'file:rename', 'file:delete', 'file:copy-wiki-link', 'file:export-note']) {
      expect(find(rendered.result.current, id).enabled?.()).toBe(false)
    }
    act(() => useAppStore.getState().openPath('A.md'))
    for (const id of ['file:save', 'file:rename', 'file:delete', 'file:copy-wiki-link', 'file:export-note']) {
      expect(find(rendered.result.current, id).enabled?.()).toBe(true)
    }
  })

  it('renames through the store, keeping the note in its folder', async () => {
    const renameNote = vi.fn(async () => {})
    seed({ 'notes/Old.md': '# Old' })
    useAppStore.setState({ renameNote })
    act(() => useAppStore.getState().openPath('notes/Old.md'))

    // Rename asks through the store, which renders the app's own modal — not
    // window.prompt, which sandboxed frames block outright.
    const done = find(commands().current, 'file:rename').run()
    expect(useAppStore.getState().dialog?.kind).toBe('prompt')
    act(() => useAppStore.getState().resolveDialog('New name'))
    await done

    expect(renameNote).toHaveBeenCalledWith('notes/Old.md', 'notes/New name.md')
  })

  it('does not rename when the prompt is cancelled', async () => {
    const renameNote = vi.fn(async () => {})
    seed({ 'Old.md': '# Old' })
    useAppStore.setState({ renameNote })
    act(() => useAppStore.getState().openPath('Old.md'))

    const done = find(commands().current, 'file:rename').run()
    act(() => useAppStore.getState().resolveDialog(null))
    await done

    expect(renameNote).not.toHaveBeenCalled()
    expect(useAppStore.getState().dialog).toBeNull()
  })

  it('asks before deleting', async () => {
    const deleteNote = vi.fn(async () => {})
    seed({ 'A.md': '# A' })
    useAppStore.setState({ deleteNote })
    act(() => useAppStore.getState().openPath('A.md'))

    // Declining leaves the note alone.
    let done = find(commands().current, 'file:delete').run()
    expect(useAppStore.getState().dialog?.kind).toBe('confirm')
    expect(useAppStore.getState().dialog?.danger).toBe(true)
    act(() => useAppStore.getState().resolveDialog(false))
    await done
    expect(deleteNote).not.toHaveBeenCalled()

    // Confirming goes through.
    done = find(commands().current, 'file:delete').run()
    act(() => useAppStore.getState().resolveDialog(true))
    await done
    expect(deleteNote).toHaveBeenCalledWith('A.md')
  })

  it('copies a wiki link for the open note', async () => {
    seed({ 'notes/Zettelkasten.md': '# Z' })
    act(() => useAppStore.getState().openPath('notes/Zettelkasten.md'))
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await find(commands().current, 'file:copy-wiki-link').run()
    expect(writeText).toHaveBeenCalledWith('[[Zettelkasten]]')
    expect(useAppStore.getState().toasts.at(-1)?.kind).toBe('success')

    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('exports the vault as JSON', async () => {
    seed({ 'A.md': '# A', 'sub/B.md': 'body' })
    useAppStore.setState({ vaultName: 'My Vault' })

    let exported: Blob | null = null
    const createObjectURL = vi.fn((blob: Blob) => {
      exported = blob
      return 'blob:spacelink'
    })
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('My Vault.json')
    })

    await find(commands().current, 'file:export-vault').run()
    expect(click).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(await (exported as unknown as Blob).text()) as { notes: Record<string, string> }
    expect(payload.notes).toEqual({ 'A.md': '# A', 'sub/B.md': 'body' })

    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('reports a refused download instead of throwing', () => {
    seed({ 'A.md': '# A' })
    act(() => useAppStore.getState().openPath('A.md'))
    expect(() => find(commands().current, 'file:export-note').run()).not.toThrow()
    expect(useAppStore.getState().toasts.at(-1)?.kind).toBe('error')
  })
})

describe('navigation commands', () => {
  it('walks back and forward through the pane history', () => {
    seed({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c' })
    const rendered = renderHook(() => useCommands())
    const back = (): Command => find(rendered.result.current, 'nav:back')
    const forward = (): Command => find(rendered.result.current, 'nav:forward')
    const openPath = (path: string): void => act(() => useAppStore.getState().openPath(path))
    const current = (): NotePath | null => useAppStore.getState().activeTab()?.path ?? null

    expect(back().enabled?.()).toBe(false)
    openPath('A.md')
    openPath('B.md')
    openPath('C.md')

    expect(forward().enabled?.()).toBe(false)
    act(() => back().run())
    expect(current()).toBe('B.md')
    act(() => back().run())
    expect(current()).toBe('A.md')
    expect(back().enabled?.()).toBe(false)

    act(() => forward().run())
    expect(current()).toBe('B.md')
    expect(forward().enabled?.()).toBe(true)

    // Opening from the middle of the history truncates the forward stack.
    openPath('C.md')
    expect(forward().enabled?.()).toBe(false)
  })

  it('skips history entries whose note is gone', () => {
    seed({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c' })
    const rendered = renderHook(() => useCommands())
    const openPath = (path: string): void => act(() => useAppStore.getState().openPath(path))
    openPath('A.md')
    openPath('B.md')
    openPath('C.md')

    act(() => {
      const notes = new Map(useAppStore.getState().notes)
      notes.delete('B.md')
      useAppStore.setState({ notes, index: buildIndex(notes) })
    })

    act(() => find(rendered.result.current, 'nav:back').run())
    expect(useAppStore.getState().activeTab()?.path).toBe('A.md')
  })

  it('steps the same history the tab strip drives, in both directions', () => {
    // Two stacks used to shadow each other here: a command step looked like a
    // fresh visit to the strip's stack (so its Back arrow walked *forward*),
    // and a strip step left the command's Forward disabled.
    seed({ 'A.md': 'a', 'B.md': 'b', 'C.md': 'c' })
    const rendered = renderHook(() => useCommands())
    const paneId = useAppStore.getState().activePaneId
    const current = (): NotePath | null => useAppStore.getState().activeTab()?.path ?? null
    const openPath = (path: string): void => act(() => useAppStore.getState().openPath(path))

    openPath('A.md')
    openPath('B.md')
    openPath('C.md')

    act(() => find(rendered.result.current, 'nav:back').run())
    expect(current()).toBe('B.md')
    // The cursor moved inside the one stack; nothing was appended to it.
    expect(historySnapshot(paneId)).toEqual({ entries: ['A.md', 'B.md', 'C.md'], index: 1 })
    // ...so the strip's Forward arrow is lit, as the command's own is.
    expect(historyCanForward(paneId)).toBe(true)
    expect(find(rendered.result.current, 'nav:forward').enabled?.()).toBe(true)

    // Now step with the strip's Back arrow instead: the command must see it.
    act(() => {
      const path = historyBack(paneId)
      if (path) useAppStore.getState().openPath(path, { paneId })
    })
    expect(current()).toBe('A.md')
    expect(find(rendered.result.current, 'nav:forward').enabled?.()).toBe(true)
    act(() => find(rendered.result.current, 'nav:forward').run())
    expect(current()).toBe('B.md')
  })

  it('does not offer to reopen a note that was deleted rather than closed', () => {
    seed({ 'A.md': 'a' })
    const rendered = renderHook(() => useCommands())
    const reopen = (): Command => find(rendered.result.current, 'nav:reopen-tab')

    act(() => useAppStore.getState().openPath('A.md'))
    // `deleteNote` blanks the tab's path instead of closing the tab; inferring
    // closures from that used to offer the deleted note back.
    act(() => {
      void useAppStore.getState().deleteNote('A.md')
    })
    expect(useAppStore.getState().notes.has('A.md')).toBe(false)

    expect(reopen().enabled?.()).toBe(false)
    act(() => reopen().run())
    expect(useAppStore.getState().activePane().tabs.map((t) => t.path)).toEqual([null])
  })

  it('drops a closed tab whose note is deleted before it is reopened', () => {
    seed({ 'A.md': 'a', 'B.md': 'b' })
    const rendered = renderHook(() => useCommands())
    const reopen = (): Command => find(rendered.result.current, 'nav:reopen-tab')

    act(() => useAppStore.getState().openPath('A.md'))
    act(() => useAppStore.getState().openPath('B.md', { newTab: true }))
    act(() => find(rendered.result.current, 'nav:close-tab').run())
    expect(reopen().enabled?.()).toBe(true)

    act(() => {
      void useAppStore.getState().deleteNote('B.md')
    })
    expect(reopen().enabled?.()).toBe(false)
    act(() => reopen().run())
    expect(useAppStore.getState().activePane().tabs.map((t) => t.path)).toEqual(['A.md'])
  })

  it('opens the right sidebar on its local graph tab', () => {
    seed({ 'A.md': 'a' })
    const rendered = renderHook(() => useCommands())
    const localGraph = (): Command => find(rendered.result.current, 'nav:local-graph')

    useAppStore.setState({ rightSidebarOpen: false })
    expect(localGraph().enabled?.()).toBe(false)

    act(() => useAppStore.getState().openPath('A.md'))
    expect(localGraph().enabled?.()).toBe(true)
    act(() => localGraph().run())

    expect(useAppStore.getState().rightSidebarOpen).toBe(true)
    expect(localStorage.getItem('spacelink.rightSidebarTab')).toBe('graph')
  })

  it('reopens the last closed tab', () => {
    seed({ 'A.md': 'a', 'B.md': 'b' })
    const rendered = renderHook(() => useCommands())
    const reopen = (): Command => find(rendered.result.current, 'nav:reopen-tab')

    expect(reopen().enabled?.()).toBe(false)
    act(() => useAppStore.getState().openPath('A.md'))
    act(() => useAppStore.getState().openPath('B.md', { newTab: true }))

    // Closing goes through the command, which is what records the closure.
    act(() => find(rendered.result.current, 'nav:close-tab').run())
    expect(useAppStore.getState().activePane().tabs.map((t) => t.path)).toEqual(['A.md'])

    expect(reopen().enabled?.()).toBe(true)
    act(() => reopen().run())
    expect(useAppStore.getState().activePane().tabs.map((t) => t.path)).toEqual(['A.md', 'B.md'])
  })

  it('cycles tabs and closes the active one', () => {
    seed({ 'A.md': 'a', 'B.md': 'b' })
    const rendered = renderHook(() => useCommands())
    expect(find(rendered.result.current, 'nav:next-tab').enabled?.()).toBe(false)

    act(() => useAppStore.getState().openPath('A.md'))
    act(() => useAppStore.getState().openPath('B.md', { newTab: true }))
    expect(useAppStore.getState().activeTab()?.path).toBe('B.md')

    act(() => find(rendered.result.current, 'nav:next-tab').run())
    expect(useAppStore.getState().activeTab()?.path).toBe('A.md')
    act(() => find(rendered.result.current, 'nav:prev-tab').run())
    expect(useAppStore.getState().activeTab()?.path).toBe('B.md')

    act(() => find(rendered.result.current, 'nav:close-tab').run())
    expect(useAppStore.getState().activePane().tabs.map((t) => t.path)).toEqual(['A.md'])
  })

  it('opens the search panel without toggling it shut again', () => {
    const rendered = renderHook(() => useCommands())
    act(() => find(rendered.result.current, 'nav:search').run())
    expect(useAppStore.getState().sidebarPanel).toBe('search')
    act(() => find(rendered.result.current, 'nav:search').run())
    expect(useAppStore.getState().sidebarPanel).toBe('search')
  })

  it('only offers headings when the note has some', () => {
    seed({ 'Flat.md': 'no headings here', 'Deep.md': '# One\n## Two' })
    const rendered = renderHook(() => useCommands())
    act(() => useAppStore.getState().openPath('Flat.md'))
    expect(find(rendered.result.current, 'nav:go-to-heading').enabled?.()).toBe(false)
    act(() => useAppStore.getState().openPath('Deep.md'))
    expect(find(rendered.result.current, 'nav:go-to-heading').enabled?.()).toBe(true)
    act(() => find(rendered.result.current, 'nav:go-to-heading').run())
    expect(useAppStore.getState().palette).toBe('headings')
  })
})

describe('editor commands', () => {
  it('are disabled while no editor is registered', () => {
    const list = commands().current
    const editorCommands = list.filter((command) => command.section === 'Editor')
    expect(editorCommands.length).toBeGreaterThan(10)
    for (const command of editorCommands) expect(command.enabled?.()).toBe(false)
  })

  it('delegate to the focused editor', async () => {
    const editor = fakeEditor('hello')
    registerEditor(EDITOR_PANE, editor.view)
    const list = commands().current

    // The implementations live in the editor's own chunk, so a command reaches
    // them a microtask later than it used to. Whether one is *enabled* is still
    // answered synchronously — the palette asks that while it renders.
    expect(find(list, 'editor:toggle-bold').enabled?.()).toBe(true)

    const run = async (id: string, expected: string): Promise<void> => {
      find(list, id).run()
      await vi.waitFor(() => {
        expect(editor.doc()).toBe(expected)
      })
    }

    await run('editor:toggle-bold', '**hello**')
    await run('editor:cycle-heading', '# **hello**')
    await run('editor:duplicate-line', '# **hello**\n# **hello**')
  })

  it('do nothing at all once the editor unregisters', () => {
    const editor = fakeEditor('hello')
    registerEditor(EDITOR_PANE, editor.view)
    const list = commands().current
    registerEditor(EDITOR_PANE, null)

    expect(() => find(list, 'editor:toggle-bold').run()).not.toThrow()
    expect(editor.doc()).toBe('hello')
  })
})

describe('view commands', () => {
  it('toggles between edit and preview', () => {
    seed({ 'A.md': 'a' })
    const rendered = renderHook(() => useCommands())
    act(() => useAppStore.getState().openPath('A.md', { mode: 'edit' }))

    act(() => find(rendered.result.current, 'view:toggle-preview').run())
    expect(useAppStore.getState().activeTab()?.mode).toBe('preview')
    act(() => find(rendered.result.current, 'view:toggle-preview').run())
    expect(useAppStore.getState().activeTab()?.mode).toBe('edit')

    act(() => find(rendered.result.current, 'view:cycle-mode').run())
    expect(useAppStore.getState().activeTab()?.mode).toBe('split')
  })

  it('splits and closes panes', () => {
    const rendered = renderHook(() => useCommands())
    expect(find(rendered.result.current, 'view:close-pane').enabled?.()).toBe(false)

    act(() => find(rendered.result.current, 'view:split-right').run())
    expect(useAppStore.getState().panes).toHaveLength(2)
    expect(find(rendered.result.current, 'view:close-pane').enabled?.()).toBe(true)

    act(() => find(rendered.result.current, 'nav:focus-next-pane').run())
    expect(useAppStore.getState().activePaneId).toBe(useAppStore.getState().panes[0]!.id)

    act(() => find(rendered.result.current, 'view:close-pane').run())
    expect(useAppStore.getState().panes).toHaveLength(1)
  })

  it('toggles the sidebars', () => {
    const rendered = renderHook(() => useCommands())
    expect(useAppStore.getState().sidebarPanel).toBe('files')
    act(() => find(rendered.result.current, 'view:toggle-left-sidebar').run())
    expect(useAppStore.getState().sidebarPanel).toBe(null)
    act(() => find(rendered.result.current, 'view:toggle-left-sidebar').run())
    expect(useAppStore.getState().sidebarPanel).toBe('files')

    act(() => find(rendered.result.current, 'view:toggle-right-sidebar').run())
    expect(useAppStore.getState().rightSidebarOpen).toBe(false)
  })

  it('cycles the theme and clamps the font size', () => {
    const rendered = renderHook(() => useCommands())
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, theme: 'light', fontSize: 11 } })

    act(() => find(rendered.result.current, 'view:toggle-theme').run())
    expect(useAppStore.getState().settings.theme).toBe('dark')
    act(() => find(rendered.result.current, 'view:toggle-theme').run())
    expect(useAppStore.getState().settings.theme).toBe('system')

    act(() => find(rendered.result.current, 'view:decrease-font').run())
    expect(useAppStore.getState().settings.fontSize).toBe(10)
    expect(find(rendered.result.current, 'view:decrease-font').enabled?.()).toBe(false)
    act(() => find(rendered.result.current, 'view:increase-font').run())
    expect(useAppStore.getState().settings.fontSize).toBe(11)
  })

  it('asks App to open the settings modal', () => {
    const listener = vi.fn()
    window.addEventListener('spacelink:open-settings', listener)
    find(commands().current, 'view:settings').run()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('spacelink:open-settings', listener)
  })
})

describe('what the third bug hunt found', () => {
  function setPanes(tabs: Array<{ id: string; path: NotePath | null; pinned?: boolean }>, activeTabId = tabs[0]!.id): void {
    useAppStore.setState({
      panes: [{ id: 'pane-a', tabs: tabs.map((t) => ({ id: t.id, kind: 'note' as const, path: t.path, mode: 'edit' as const, pinned: t.pinned ?? false })), activeTabId }],
      activePaneId: 'pane-a',
    })
  }
  const activePath = (): NotePath | null => {
    const state = useAppStore.getState()
    const pane = state.panes.find((p) => p.id === state.activePaneId)!
    return pane.tabs.find((t) => t.id === pane.activeTabId)?.path ?? null
  }

  it('Ctrl+W on the blank placeholder does not bury the note that was closed before it', () => {
    seed({ 'a.md': '# a' })
    setPanes([{ id: 't1', path: 'a.md' }])
    const list = commands()
    find(list.current, 'nav:close-tab').run() // a.md closes; a blank placeholder is left
    expect(useAppStore.getState().panes[0]!.tabs.map((t) => t.path)).toEqual([null])
    find(list.current, 'nav:close-tab').run() // on the placeholder: visibly nothing
    find(list.current, 'nav:reopen-tab').run()
    expect(activePath()).toBe('a.md')
  })

  it('does not let a run of Ctrl+W on the placeholder push the closed note off the stack', () => {
    seed({ 'a.md': '# a' })
    setPanes([{ id: 't1', path: 'a.md' }])
    const list = commands()
    find(list.current, 'nav:close-tab').run()
    // The stack keeps twenty entries; twenty blanks would bury the note for good.
    for (let i = 0; i < 25; i += 1) find(list.current, 'nav:close-tab').run()
    find(list.current, 'nav:reopen-tab').run()
    expect(activePath()).toBe('a.md')
  })

  it('closing only ever-blank tabs leaves nothing to reopen', () => {
    setPanes([{ id: 't1', path: null }])
    const list = commands()
    find(list.current, 'nav:close-tab').run()
    expect(find(list.current, 'nav:reopen-tab').enabled?.()).toBe(false)
  })

  it('Ctrl+W leaves a pinned tab alone', () => {
    seed({ 'a.md': '# a', 'b.md': '# b' })
    setPanes([{ id: 't1', path: 'a.md', pinned: true }, { id: 't2', path: 'b.md' }])
    const list = commands()
    find(list.current, 'nav:close-tab').run()
    expect(useAppStore.getState().panes[0]!.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])
    expect(find(list.current, 'nav:reopen-tab').enabled?.()).toBe(false)
  })

  it('F2 refuses a name that differs from an existing note only by case, as the explorer does', async () => {
    seed({ 'foo.md': 'precious', 'Bar.md': '# bar' })
    setPanes([{ id: 't1', path: 'Bar.md' }])
    useAppStore.setState({ askText: async () => 'Foo' })
    const list = commands()
    await find(list.current, 'file:rename').run()
    // On a Mac or Windows disk Foo.md and foo.md are one file, and the save
    // after the rename would have written Bar's text over "precious".
    expect([...useAppStore.getState().notes.keys()].sort()).toEqual(['Bar.md', 'foo.md'])
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('already exists'))).toBe(true)
  })

  it('renaming the note on screen keeps the forward stack', async () => {
    seed({ 'a.md': '', 'b.md': '', 'c.md': '' })
    setPanes([{ id: 't1', path: null }])
    const list = commands()
    act(() => useAppStore.getState().openPath('a.md'))
    act(() => useAppStore.getState().openPath('b.md'))
    act(() => useAppStore.getState().openPath('c.md'))
    act(() => find(list.current, 'nav:back').run())
    expect(activePath()).toBe('b.md')
    expect(historyCanForward('pane-a')).toBe(true)

    await act(() => useAppStore.getState().renameNote('b.md', 'b2.md'))

    expect(activePath()).toBe('b2.md')
    expect(historySnapshot('pane-a').entries).toEqual(['a.md', 'b2.md', 'c.md'])
    expect(historyCanForward('pane-a')).toBe(true)
  })

  it('rename and rename back: Back goes to the previous note, not to a stale copy of this one', async () => {
    seed({ 'a.md': '', 'b.md': '' })
    setPanes([{ id: 't1', path: null }])
    const list = commands()
    act(() => useAppStore.getState().openPath('a.md'))
    act(() => useAppStore.getState().openPath('b.md'))
    await act(() => useAppStore.getState().renameNote('b.md', 'c.md'))
    await act(() => useAppStore.getState().renameNote('c.md', 'b.md'))
    expect(activePath()).toBe('b.md')
    act(() => find(list.current, 'nav:back').run())
    expect(activePath()).toBe('a.md')
  })
})
