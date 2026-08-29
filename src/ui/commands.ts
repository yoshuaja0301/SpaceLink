/**
 * SpaceFore — the command table.
 *
 * Everything the app can do on demand lives here exactly once: the palette
 * renders this list, `useHotkeys` binds the shortcuts on it, and nothing else
 * needs its own key handling.
 *
 * Two rules keep the list honest:
 *
 * - **`run` reads fresh state.** Commands are built during render but may be
 *   invoked much later, so every closure goes through `useAppStore.getState()`
 *   rather than capturing values. Only text that is *shown* (the star/unstar
 *   title) depends on the render-time snapshot.
 * - **`enabled` is the single gate.** The palette hides disabled commands and
 *   the hotkey layer skips them, so a command never has to defend itself.
 *
 * Pane history and closed tabs are not in the store (nothing else needs them),
 * so this module keeps them by watching the store for pane changes.
 */
import { useEffect, useMemo } from 'react'

import type { Command, NotePath, ThemeName, ViewMode } from '../types'
import type { AppState } from '../state/store'
import { basename, dirname, joinPath, sanitizeFileName, useAppStore } from '../state/store'
import { formatShortcut } from './useHotkeys'
import {
  cycleHeading,
  duplicateLine,
  getActiveEditor,
  insertCodeBlock,
  insertLink,
  insertTable,
  insertWikiLink,
  moveLineDown,
  moveLineUp,
  toggleBlockquote,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
  toggleTaskCheckbox,
} from './editor/markdownCommands'
import type { EditorView } from '@codemirror/view'

export const SECTIONS = ['File', 'Navigation', 'Editor', 'View'] as const

const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 28
const HISTORY_LIMIT = 100
const CLOSED_TAB_LIMIT = 20

const store = (): AppState => useAppStore.getState()

/** The note the active tab is showing, or null when it is a graph/search tab. */
export function selectActivePath(state: AppState): NotePath | null {
  const pane = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0]
  if (!pane) return null
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId)
  return tab && tab.kind === 'note' ? tab.path : null
}

/* ------------------------------------------------------------------ *
 * Pane history + closed tabs
 * ------------------------------------------------------------------ */

interface PaneHistory {
  entries: NotePath[]
  /** Index of the entry currently on screen; -1 before anything is recorded. */
  cursor: number
}

interface ClosedTab {
  paneId: string
  path: NotePath
  mode: ViewMode
}

const histories = new Map<string, PaneHistory>()
const closedTabs: ClosedTab[] = []
let knownTabs = new Map<string, ClosedTab>()

function pushHistory(paneId: string, path: NotePath): void {
  const history = histories.get(paneId) ?? { entries: [], cursor: -1 }
  histories.set(paneId, history)
  // Re-recording where we already are (which is what Back/Forward do) must not
  // truncate the forward stack.
  if (history.entries[history.cursor] === path) return
  history.entries = history.entries.slice(0, history.cursor + 1)
  history.entries.push(path)
  if (history.entries.length > HISTORY_LIMIT) history.entries.shift()
  history.cursor = history.entries.length - 1
}

/** Fold one store snapshot into the history + closed-tab bookkeeping. */
function recordState(state: AppState): void {
  const livePanes = new Set<string>()
  const tabs = new Map<string, ClosedTab>()

  for (const pane of state.panes) {
    livePanes.add(pane.id)
    for (const tab of pane.tabs) {
      if (tab.kind === 'note' && tab.path) tabs.set(tab.id, { paneId: pane.id, path: tab.path, mode: tab.mode })
    }
    const active = pane.tabs.find((t) => t.id === pane.activeTabId)
    if (active && active.kind === 'note' && active.path) pushHistory(pane.id, active.path)
  }

  for (const [id, info] of knownTabs) {
    if (tabs.has(id)) continue
    closedTabs.push(info)
    if (closedTabs.length > CLOSED_TAB_LIMIT) closedTabs.shift()
  }
  knownTabs = tabs

  for (const paneId of [...histories.keys()]) {
    if (!livePanes.has(paneId)) histories.delete(paneId)
  }
}

/**
 * Walk the pane's history. Entries whose note has since been deleted are
 * skipped rather than reopening a blank tab.
 */
function findStep(paneId: string, direction: -1 | 1): number | null {
  const history = histories.get(paneId)
  if (!history) return null
  const { notes } = store()
  for (let cursor = history.cursor + direction; cursor >= 0 && cursor < history.entries.length; cursor += direction) {
    if (notes.has(history.entries[cursor]!)) return cursor
  }
  return null
}

function stepHistory(direction: -1 | 1): void {
  const state = store()
  const paneId = state.activePaneId
  const cursor = findStep(paneId, direction)
  if (cursor === null) return
  const history = histories.get(paneId)!
  history.cursor = cursor
  state.openPath(history.entries[cursor]!, { paneId })
}

let trackerRefs = 0
let detachTracker: (() => void) | null = null

/** Ref-counted so several `useCommands()` callers share one subscription. */
function attachNavigationTracking(): () => void {
  trackerRefs += 1
  if (!detachTracker) {
    recordState(useAppStore.getState())
    detachTracker = useAppStore.subscribe((state) => recordState(state))
  }
  return () => {
    trackerRefs -= 1
    if (trackerRefs > 0 || !detachTracker) return
    detachTracker()
    detachTracker = null
    trackerRefs = 0
  }
}

/** Test seam: drop every recorded pane history and closed tab. */
export function resetNavigationHistory(): void {
  histories.clear()
  closedTabs.length = 0
  knownTabs = new Map()
}

/* ------------------------------------------------------------------ *
 * Browser odds and ends (all feature detected — the tests run in jsdom)
 * ------------------------------------------------------------------ */

function downloadFile(fileName: string, content: string, mime: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false
  }
  let url = ''
  try {
    url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } catch {
    // Blob URLs can be refused outright (sandboxed frames, hardened browsers).
    return false
  } finally {
    // Revoking synchronously can cancel the download in some browsers.
    if (url && typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return true
}

async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      /* denied or insecure context — try the legacy path */
    }
  }
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.setAttribute('readonly', '')
  scratch.style.position = 'fixed'
  scratch.style.opacity = '0'
  document.body.appendChild(scratch)
  scratch.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  scratch.remove()
  return ok
}

function ask(question: string, initial: string): string | null {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null
  const answer = window.prompt(question, initial)
  return answer === null ? null : answer
}

function confirmed(question: string): boolean {
  // No `confirm` at all (a worker, a test harness) means nobody can answer;
  // the command was invoked deliberately, so take that as the answer.
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
  return window.confirm(question) === true
}

/** App.tsx owns the settings modal and vault picker and listens for these. */
function emit(type: 'spacefore:open-settings' | 'spacefore:open-vault-picker' | 'spacefore:open-local-graph', detail?: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(type, { detail }))
}

/* ------------------------------------------------------------------ *
 * Small shared behaviours
 * ------------------------------------------------------------------ */

function hasEditor(): boolean {
  return getActiveEditor() !== null
}

/** Run a CodeMirror command against whichever editor the user was last in. */
function runInEditor(command: (view: EditorView) => boolean): void {
  const view = getActiveEditor()
  if (!view) return
  command(view)
  view.focus()
}

function cycleTab(delta: number): void {
  const state = store()
  const pane = state.activePane()
  if (pane.tabs.length < 2) return
  const index = pane.tabs.findIndex((t) => t.id === pane.activeTabId)
  const next = pane.tabs[(index + delta + pane.tabs.length) % pane.tabs.length]
  if (next) state.setActiveTab(pane.id, next.id)
}

function adjustFontSize(delta: number): void {
  const state = store()
  const fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, state.settings.fontSize + delta))
  if (fontSize !== state.settings.fontSize) state.updateSettings({ fontSize })
}

const THEME_ORDER: ThemeName[] = ['light', 'dark', 'system']

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

interface CommandSpec {
  id: string
  title: string
  section: (typeof SECTIONS)[number]
  /** Canonical binding (`Mod+Shift+D`); rendered per platform on the way out. */
  shortcut?: string
  enabled?: () => boolean
  run: () => void | Promise<void>
}

function toCommand(spec: CommandSpec): Command {
  return { ...spec, shortcut: spec.shortcut ? formatShortcut(spec.shortcut) : undefined }
}

interface CommandContext {
  /** Path of the active tab at render time — only used for labels. */
  activePath: NotePath | null
  isStarred: boolean
}

/** One editor command, disabled whenever there is no editor to act on. */
function editorCommand(
  id: string,
  title: string,
  command: (view: EditorView) => boolean,
  shortcut?: string,
): CommandSpec {
  return {
    id: `editor:${id}`,
    title,
    section: 'Editor',
    ...(shortcut ? { shortcut } : {}),
    enabled: hasEditor,
    run: () => runInEditor(command),
  }
}

export function buildCommands(context: CommandContext): Command[] {
  const specs: CommandSpec[] = [
    /* ---------------------------------------------------------- File */
    {
      id: 'file:new-note',
      title: 'New note',
      section: 'File',
      shortcut: 'Mod+N',
      run: () => void store().createNoteFromTitle('Untitled'),
    },
    {
      id: 'file:new-note-here',
      title: 'New note in current folder',
      section: 'File',
      run: () => {
        const state = store()
        const path = selectActivePath(state)
        void state.createNoteFromTitle('Untitled', path ? dirname(path) : state.settings.newNoteFolder)
      },
    },
    {
      id: 'file:quick-switcher',
      title: 'Open quick switcher',
      section: 'File',
      shortcut: 'Mod+O',
      run: () => store().setPalette('quickswitch'),
    },
    {
      id: 'file:daily-note',
      title: "Open today's daily note",
      section: 'File',
      shortcut: 'Mod+Shift+D',
      run: () => store().openDailyNote(),
    },
    {
      id: 'file:save',
      title: 'Save current note',
      section: 'File',
      shortcut: 'Mod+S',
      enabled: () => selectActivePath(store()) !== null,
      run: () => {
        const state = store()
        const path = selectActivePath(state)
        if (path) return state.saveNote(path)
      },
    },
    {
      id: 'file:save-all',
      title: 'Save all',
      section: 'File',
      enabled: () => store().dirty.size > 0,
      run: () => store().saveAll(),
    },
    {
      id: 'file:rename',
      title: 'Rename current note',
      section: 'File',
      shortcut: 'F2',
      enabled: () => store().activeNote() !== null,
      run: () => {
        const state = store()
        const note = state.activeNote()
        if (!note) return
        const answer = ask('Rename note', note.name)
        if (answer === null) return
        const name = sanitizeFileName(answer)
        if (!name || name === note.name) return
        return state.renameNote(note.path, joinPath(dirname(note.path), `${name}.md`))
      },
    },
    {
      id: 'file:delete',
      title: 'Delete current note',
      section: 'File',
      enabled: () => store().activeNote() !== null,
      run: () => {
        const state = store()
        const note = state.activeNote()
        if (!note) return
        if (!confirmed(`Delete "${note.name}"? This cannot be undone.`)) return
        return state.deleteNote(note.path)
      },
    },
    {
      id: 'file:toggle-star',
      title: context.isStarred ? 'Unstar current note' : 'Star current note',
      section: 'File',
      shortcut: 'Mod+Shift+S',
      enabled: () => selectActivePath(store()) !== null,
      run: () => {
        const state = store()
        const path = selectActivePath(state)
        if (path) state.toggleStar(path)
      },
    },
    {
      id: 'file:copy-wiki-link',
      title: 'Copy wiki link to current note',
      section: 'File',
      enabled: () => selectActivePath(store()) !== null,
      run: async () => {
        const state = store()
        const path = selectActivePath(state)
        if (!path) return
        const link = `[[${basename(path)}]]`
        const copied = await copyText(link)
        state.pushToast(copied ? `Copied ${link}` : 'Could not reach the clipboard', copied ? 'success' : 'error')
      },
    },
    {
      id: 'file:reload-vault',
      title: 'Reload vault',
      section: 'File',
      enabled: () => store().adapter !== null,
      run: () => store().reloadVault(),
    },
    {
      id: 'file:open-folder',
      title: 'Open a folder as vault',
      section: 'File',
      run: () => emit('spacefore:open-vault-picker'),
    },
    {
      id: 'file:export-note',
      title: 'Export current note as Markdown',
      section: 'File',
      enabled: () => store().activeNote() !== null,
      run: () => {
        const state = store()
        const note = state.activeNote()
        if (!note) return
        if (!downloadFile(`${note.name}.md`, note.content, 'text/markdown')) {
          state.pushToast('Downloads are not available in this browser', 'error')
        }
      },
    },
    {
      id: 'file:export-vault',
      title: 'Export vault as JSON',
      section: 'File',
      enabled: () => store().notes.size > 0,
      run: () => {
        const state = store()
        const payload = {
          vault: state.vaultName || 'SpaceFore',
          exportedAt: new Date().toISOString(),
          notes: Object.fromEntries([...state.notes].map(([path, note]) => [path, note.content])),
        }
        const name = `${sanitizeFileName(state.vaultName || 'spacefore-vault')}.json`
        if (!downloadFile(name, JSON.stringify(payload, null, 2), 'application/json')) {
          state.pushToast('Downloads are not available in this browser', 'error')
        }
      },
    },

    /* ---------------------------------------------------- Navigation */
    {
      id: 'nav:go-to-file',
      title: 'Go to file',
      section: 'Navigation',
      shortcut: 'Mod+P',
      run: () => store().setPalette('quickswitch'),
    },
    {
      id: 'nav:search',
      title: 'Search in vault',
      section: 'Navigation',
      shortcut: 'Mod+Shift+F',
      run: () => {
        const state = store()
        // `setSidebarPanel` toggles, so only call it when it would *open*.
        if (state.sidebarPanel !== 'search') state.setSidebarPanel('search')
      },
    },
    {
      id: 'nav:graph',
      title: 'Open graph view',
      section: 'Navigation',
      shortcut: 'Mod+G',
      run: () => store().openView('graph'),
    },
    {
      id: 'nav:local-graph',
      title: 'Open local graph',
      section: 'Navigation',
      enabled: () => selectActivePath(store()) !== null,
      run: () => {
        const state = store()
        const path = selectActivePath(state)
        if (!path) return
        // The local graph lives in the right sidebar, next to backlinks.
        state.toggleRightSidebar(true)
        emit('spacefore:open-local-graph', { path })
      },
    },
    {
      id: 'nav:back',
      title: 'Back',
      section: 'Navigation',
      shortcut: 'Alt+Left',
      enabled: () => findStep(store().activePaneId, -1) !== null,
      run: () => stepHistory(-1),
    },
    {
      id: 'nav:forward',
      title: 'Forward',
      section: 'Navigation',
      shortcut: 'Alt+Right',
      enabled: () => findStep(store().activePaneId, 1) !== null,
      run: () => stepHistory(1),
    },
    {
      id: 'nav:next-tab',
      title: 'Next tab',
      section: 'Navigation',
      shortcut: 'Mod+Tab',
      enabled: () => store().activePane().tabs.length > 1,
      run: () => cycleTab(1),
    },
    {
      id: 'nav:prev-tab',
      title: 'Previous tab',
      section: 'Navigation',
      shortcut: 'Mod+Shift+Tab',
      enabled: () => store().activePane().tabs.length > 1,
      run: () => cycleTab(-1),
    },
    {
      id: 'nav:close-tab',
      title: 'Close tab',
      section: 'Navigation',
      shortcut: 'Mod+W',
      run: () => {
        const state = store()
        const pane = state.activePane()
        if (pane.activeTabId) state.closeTab(pane.id, pane.activeTabId)
      },
    },
    {
      id: 'nav:reopen-tab',
      title: 'Reopen closed tab',
      section: 'Navigation',
      shortcut: 'Mod+Shift+T',
      enabled: () => closedTabs.length > 0,
      run: () => {
        const closed = closedTabs.pop()
        if (!closed) return
        const state = store()
        const paneId = state.panes.some((p) => p.id === closed.paneId) ? closed.paneId : state.activePaneId
        state.openPath(closed.path, { newTab: true, paneId, mode: closed.mode })
      },
    },
    {
      id: 'nav:focus-next-pane',
      title: 'Focus next pane',
      section: 'Navigation',
      enabled: () => store().panes.length > 1,
      run: () => {
        const state = store()
        const index = state.panes.findIndex((p) => p.id === state.activePaneId)
        const next = state.panes[(index + 1) % state.panes.length]
        if (next) state.setActivePane(next.id)
      },
    },
    {
      id: 'nav:go-to-heading',
      title: 'Go to heading',
      section: 'Navigation',
      shortcut: 'Mod+Shift+O',
      enabled: () => (store().activeNote()?.parsed.headings.length ?? 0) > 0,
      run: () => store().setPalette('headings'),
    },

    /* -------------------------------------------------------- Editor */
    editorCommand('toggle-bold', 'Toggle bold', toggleBold, 'Mod+B'),
    editorCommand('toggle-italic', 'Toggle italic', toggleItalic, 'Mod+I'),
    editorCommand('toggle-strikethrough', 'Toggle strikethrough', toggleStrikethrough),
    editorCommand('toggle-inline-code', 'Toggle inline code', toggleInlineCode),
    editorCommand('toggle-highlight', 'Toggle highlight', toggleHighlight),
    editorCommand('toggle-blockquote', 'Toggle blockquote', toggleBlockquote),
    editorCommand('toggle-task', 'Toggle task checkbox', toggleTaskCheckbox, 'Mod+Enter'),
    editorCommand('insert-link', 'Insert link', insertLink, 'Mod+K'),
    editorCommand('insert-wiki-link', 'Insert wiki link', insertWikiLink, 'Mod+Shift+K'),
    editorCommand('cycle-heading', 'Cycle heading level', cycleHeading),
    editorCommand('insert-table', 'Insert table', insertTable),
    editorCommand('insert-code-block', 'Insert code block', insertCodeBlock),
    editorCommand('move-line-up', 'Move line up', moveLineUp),
    editorCommand('move-line-down', 'Move line down', moveLineDown),
    editorCommand('duplicate-line', 'Duplicate line', duplicateLine),

    /* ---------------------------------------------------------- View */
    {
      id: 'view:toggle-preview',
      title: 'Toggle edit / preview',
      section: 'View',
      shortcut: 'Mod+E',
      enabled: () => store().activeTab()?.kind === 'note',
      run: () => {
        const state = store()
        state.setViewMode(state.activeTab()?.mode === 'preview' ? 'edit' : 'preview')
      },
    },
    {
      id: 'view:cycle-mode',
      title: 'Cycle edit → split → preview',
      section: 'View',
      enabled: () => store().activeTab()?.kind === 'note',
      run: () => store().cycleViewMode(),
    },
    {
      id: 'view:split-right',
      title: 'Split right',
      section: 'View',
      shortcut: 'Mod+\\',
      enabled: () => store().panes.length < 3,
      run: () => store().splitPane(),
    },
    {
      id: 'view:close-pane',
      title: 'Close pane',
      section: 'View',
      enabled: () => store().panes.length > 1,
      run: () => {
        const state = store()
        state.closePane(state.activePaneId)
      },
    },
    {
      id: 'view:toggle-left-sidebar',
      title: 'Toggle left sidebar',
      section: 'View',
      shortcut: 'Mod+Alt+B',
      run: () => {
        const state = store()
        // Passing the open panel closes it; anything else opens that panel.
        state.setSidebarPanel(state.sidebarPanel ?? 'files')
      },
    },
    {
      id: 'view:toggle-right-sidebar',
      title: 'Toggle right sidebar',
      section: 'View',
      run: () => store().toggleRightSidebar(),
    },
    {
      id: 'view:toggle-theme',
      title: 'Toggle theme (dark / light / system)',
      section: 'View',
      run: () => {
        const state = store()
        const index = THEME_ORDER.indexOf(state.settings.theme)
        state.setTheme(THEME_ORDER[(index + 1) % THEME_ORDER.length]!)
      },
    },
    {
      id: 'view:increase-font',
      title: 'Increase font size',
      section: 'View',
      shortcut: 'Mod+=',
      enabled: () => store().settings.fontSize < FONT_SIZE_MAX,
      run: () => adjustFontSize(1),
    },
    {
      id: 'view:decrease-font',
      title: 'Decrease font size',
      section: 'View',
      shortcut: 'Mod+-',
      enabled: () => store().settings.fontSize > FONT_SIZE_MIN,
      run: () => adjustFontSize(-1),
    },
    {
      id: 'view:toggle-readable-line-length',
      title: 'Toggle readable line length',
      section: 'View',
      run: () => {
        const state = store()
        state.updateSettings({ readableLineLength: !state.settings.readableLineLength })
      },
    },
    {
      id: 'view:toggle-line-numbers',
      title: 'Toggle line numbers',
      section: 'View',
      run: () => {
        const state = store()
        state.updateSettings({ showLineNumbers: !state.settings.showLineNumbers })
      },
    },
    {
      id: 'view:settings',
      title: 'Open settings',
      section: 'View',
      shortcut: 'Mod+,',
      run: () => emit('spacefore:open-settings'),
    },
  ]

  return specs.map(toCommand)
}

/**
 * The full command list. Rebuilt only when something that changes a *label*
 * changes — every `run`/`enabled` closure reads the store itself.
 */
export function useCommands(): Command[] {
  const activePath = useAppStore(selectActivePath)
  const starred = useAppStore((s) => s.starred)
  const isStarred = activePath !== null && starred.includes(activePath)

  // Pane history has to be watched from the moment the app renders, not from
  // the first Back — otherwise there is nothing to go back to.
  useEffect(() => attachNavigationTracking(), [])

  return useMemo(() => buildCommands({ activePath, isStarred }), [activePath, isStarred])
}
