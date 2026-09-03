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
 * Pane history and closed tabs are not in the store (nothing else needs them):
 * they live in `paneHistory`, the same module the tab strip's arrows and its
 * "Reopen closed tab" entry drive, so a keyboard step and a button step move
 * one stack rather than two that fight each other. All this module adds is a
 * store subscription that records where each pane currently is.
 */
import { useEffect, useMemo } from 'react'

import type { Command, NotePath, ThemeName } from '../types'
import type { AppState } from '../state/store'
import { buildExport } from '../core/vault/transfer'
import { basename, dirname, joinPath, sanitizeFileName, useAppStore } from '../state/store'
import { openRightSidebarTab } from './RightSidebar'
import { isReopenable, reopenClosedTab } from './TabBar'
import {
  back,
  canBack,
  canForward,
  canReopen,
  forward,
  push as pushHistory,
  pushClosed,
  reset as resetHistory,
  rename as renameHistory,
} from './paneHistory'
import { formatShortcut } from './useHotkeys'
import { getActiveEditor } from './editor/activeEditor'

export const SECTIONS = ['File', 'Navigation', 'Editor', 'View'] as const

const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 28

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

/** Panes seen in the last snapshot, so a closed pane's history can be dropped. */
let knownPanes: string[] = []
/** The last rename the tracker has already applied to the history. */
let seenRename = 0

/** Record where every pane currently is. `push` ignores a repeat of the entry
 * already on screen, which is what makes a Back step a no-op here rather than
 * an entry that truncates the forward stack. */
function recordState(state: AppState): void {
  // A rename rewrites the open tab's path in place. Told apart from a
  // navigation here, so the entry is renamed rather than pushed — a push
  // would truncate the forward stack and leave a dead entry behind Back.
  if (state.renamed && state.renamed.seq !== seenRename) {
    seenRename = state.renamed.seq
    renameHistory(state.renamed.from, state.renamed.to)
  }
  const live: string[] = []
  for (const pane of state.panes) {
    live.push(pane.id)
    const active = pane.tabs.find((t) => t.id === pane.activeTabId)
    if (active && active.kind === 'note' && active.path) pushHistory(pane.id, active.path)
  }
  for (const paneId of knownPanes) {
    if (!live.includes(paneId)) resetHistory(paneId)
  }
  knownPanes = live
}

/** A history entry is only worth stepping to while its note still exists. */
function noteExists(path: NotePath): boolean {
  return store().notes.has(path)
}

function stepHistory(direction: -1 | 1): void {
  const state = store()
  const paneId = state.activePaneId
  const path = direction === -1 ? back(paneId, noteExists) : forward(paneId, noteExists)
  if (path) state.openPath(path, { paneId })
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
  seenRename = 0
  resetHistory()
  knownPanes = []
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

/**
 * Questions go through the store, which renders them with the app's own modal.
 * `window.prompt` / `window.confirm` are not used: both are blocked in sandboxed
 * frames, where the command would silently do nothing.
 */
function ask(title: string, initial: string): Promise<string | null> {
  return store().askText(title, initial, { confirmLabel: 'Rename', inputLabel: 'New name' })
}

function confirmed(title: string, message: string): Promise<boolean> {
  return store().askConfirm(title, { message, confirmLabel: 'Delete', danger: true })
}

/** App.tsx owns the settings modal and vault picker and listens for these. */
function emit(type: 'spacefore:open-settings' | 'spacefore:open-vault-picker'): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(type))
}

/* ------------------------------------------------------------------ *
 * Small shared behaviours
 * ------------------------------------------------------------------ */

function hasEditor(): boolean {
  return getActiveEditor() !== null
}

/**
 * The editor commands, named rather than imported.
 *
 * Importing them here would pull CodeMirror into the chunk the browser
 * downloads before it can show anything, for the sake of a table of commands
 * that cannot run until an editor exists. Naming them instead lets the module
 * be fetched at the point one is actually invoked — by which time the editor is
 * on screen and the chunk is already in cache.
 */
type EditorCommandName =
  | 'cycleHeading'
  | 'duplicateLine'
  | 'insertCodeBlock'
  | 'insertLink'
  | 'insertTable'
  | 'insertWikiLink'
  | 'moveLineDown'
  | 'moveLineUp'
  | 'toggleBlockquote'
  | 'toggleBold'
  | 'toggleHighlight'
  | 'toggleInlineCode'
  | 'toggleItalic'
  | 'toggleStrikethrough'
  | 'toggleTaskCheckbox'

/** Run a CodeMirror command against whichever editor the user was last in. */
function runInEditor(name: EditorCommandName): void {
  const view = getActiveEditor()
  if (!view) return
  void import('./editor/markdownCommands').then((commands) => {
    // The editor may have gone away while the module was in flight.
    if (getActiveEditor() !== view) return
    commands[name](view)
    view.focus()
  })
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
  command: EditorCommandName,
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
      run: async () => {
        const state = store()
        const note = state.activeNote()
        if (!note) return
        const answer = await ask('Rename note', note.name)
        if (answer === null) return
        const name = sanitizeFileName(answer)
        if (!name || name === note.name) return
        await state.renameNote(note.path, joinPath(dirname(note.path), `${name}.md`))
      },
    },
    {
      id: 'file:delete',
      title: 'Delete current note',
      section: 'File',
      enabled: () => store().activeNote() !== null,
      run: async () => {
        const state = store()
        const note = state.activeNote()
        if (!note) return
        if (!(await confirmed(`Delete "${note.name}"?`, 'This cannot be undone.'))) return
        await state.deleteNote(note.path)
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
      run: async () => {
        const state = store()
        // Shared with the Settings button on purpose: these were two copies of
        // the same object literal, and only one of them would ever have been
        // remembered when the shape changed.
        const { payload, skipped } = await buildExport(state)
        const name = `${sanitizeFileName(state.vaultName || 'spacefore-vault')}.json`
        if (!downloadFile(name, JSON.stringify(payload, null, 2), 'application/json')) {
          state.pushToast('Downloads are not available in this browser', 'error')
          return
        }
        if (skipped.length > 0) state.pushToast(`Could not read ${skipped.join(', ')}`, 'error')
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
        // The local graph lives in the right sidebar, next to backlinks; it
        // follows the active pane, so it needs no path of its own.
        if (selectActivePath(store()) !== null) openRightSidebarTab('graph')
      },
    },
    {
      id: 'nav:back',
      title: 'Back',
      section: 'Navigation',
      shortcut: 'Alt+Left',
      enabled: () => canBack(store().activePaneId, noteExists),
      run: () => stepHistory(-1),
    },
    {
      id: 'nav:forward',
      title: 'Forward',
      section: 'Navigation',
      shortcut: 'Alt+Right',
      enabled: () => canForward(store().activePaneId, noteExists),
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
        const tab = pane.tabs.find((t) => t.id === pane.activeTabId)
        if (!tab || tab.pinned) return
        // Closures are recorded where they happen, never inferred from a diff:
        // `deleteNote` blanks a tab's path without closing it, and a diff reads
        // that as a closed tab and offers to reopen a note that is gone. The
        // blank placeholder itself is not worth remembering: reopening it
        // would hand back nothing, in front of the note that was closed.
        if (tab.kind !== 'note' || tab.path) pushClosed(tab)
        state.closeTab(pane.id, tab.id)
      },
    },
    {
      id: 'nav:reopen-tab',
      title: 'Reopen closed tab',
      section: 'Navigation',
      shortcut: 'Mod+Shift+T',
      enabled: () => canReopen((tab) => isReopenable(tab, store().notes)),
      run: () => reopenClosedTab(store().activePaneId),
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
    editorCommand('toggle-bold', 'Toggle bold', 'toggleBold', 'Mod+B'),
    editorCommand('toggle-italic', 'Toggle italic', 'toggleItalic', 'Mod+I'),
    editorCommand('toggle-strikethrough', 'Toggle strikethrough', 'toggleStrikethrough'),
    editorCommand('toggle-inline-code', 'Toggle inline code', 'toggleInlineCode'),
    editorCommand('toggle-highlight', 'Toggle highlight', 'toggleHighlight'),
    editorCommand('toggle-blockquote', 'Toggle blockquote', 'toggleBlockquote'),
    editorCommand('toggle-task', 'Toggle task checkbox', 'toggleTaskCheckbox', 'Mod+Enter'),
    editorCommand('insert-link', 'Insert link', 'insertLink', 'Mod+K'),
    editorCommand('insert-wiki-link', 'Insert wiki link', 'insertWikiLink', 'Mod+Shift+K'),
    editorCommand('cycle-heading', 'Cycle heading level', 'cycleHeading'),
    editorCommand('insert-table', 'Insert table', 'insertTable'),
    editorCommand('insert-code-block', 'Insert code block', 'insertCodeBlock'),
    editorCommand('move-line-up', 'Move line up', 'moveLineUp'),
    editorCommand('move-line-down', 'Move line down', 'moveLineDown'),
    editorCommand('duplicate-line', 'Duplicate line', 'duplicateLine'),

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
