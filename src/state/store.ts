/**
 * SpaceFore — central application store.
 *
 * This module owns all mutable app state. Core modules (markdown, graph,
 * search, vault) are pure and are called from here; UI components read state
 * through `useAppStore` selectors and never talk to an adapter directly.
 */
import { create } from 'zustand'

import type {
  BacklinkGroup,
  Note,
  NotePath,
  Pane,
  SidebarPanel,
  Settings,
  Tab,
  ThemeName,
  Toast,
  VaultAdapter,
  VaultFile,
  VaultIndex,
  ViewMode,
} from '../types'
import { parseNote } from '../core/markdown/parse'
import { buildIndex, emptyIndex, getBacklinks, resolveLinkTarget } from '../core/graph/index'
import { createDemoVault } from '../core/vault/demoVault'

const AUTOSAVE_MS_MIN = 200

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  fontSize: 16,
  editorFont: '',
  showLineNumbers: false,
  liveSyntaxHiding: true,
  spellcheck: false,
  readableLineLength: true,
  newNoteFolder: '',
  dailyNoteFolder: 'Daily',
  dailyNoteFormat: 'YYYY-MM-DD',
  autosaveDelay: 800,
  graphShowUnresolved: true,
  graphShowTags: false,
  graphLinkDistance: 70,
  graphChargeStrength: -180,
}

const SETTINGS_KEY = 'spacefore.settings'
const STARRED_KEY = 'spacefore.starred'

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as object) } as T
  } catch {
    return fallback
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / quota — settings simply do not persist */
  }
}

let tabSeq = 0
const newId = (prefix: string): string => `${prefix}-${(tabSeq += 1).toString(36)}`

export function makeNote(path: NotePath, content: string, mtime: number): Note {
  const name = basename(path)
  return { path, name, content, mtime, parsed: parseNote(content, name) }
}

export function basename(path: NotePath): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.toLowerCase().endsWith('.md') ? file.slice(0, -3) : file
}

export function dirname(path: NotePath): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export function joinPath(dir: string, file: string): NotePath {
  return dir ? `${dir.replace(/\/+$/, '')}/${file}` : file
}

/** Turn arbitrary user text into a filesystem-safe note filename (without `.md`). */
export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Untitled'
  )
}

export function formatDate(pattern: string, date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return pattern
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MMMM/g, months[date.getMonth()]!)
    .replace(/MMM/g, months[date.getMonth()]!.slice(0, 3))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/DDDD/g, days[date.getDay()]!)
    .replace(/DDD/g, days[date.getDay()]!.slice(0, 3))
    .replace(/DD/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()))
    .replace(/ss/g, pad(date.getSeconds()))
}

export interface OpenOptions {
  /** Open in a new tab instead of replacing the active one. */
  newTab?: boolean
  /** Target pane; defaults to the active pane. */
  paneId?: string
  mode?: ViewMode
  /** Scroll the view to this heading slug after opening. */
  heading?: string
}

export interface AppState {
  /* vault ------------------------------------------------------------ */
  adapter: VaultAdapter | null
  vaultName: string
  notes: Map<NotePath, Note>
  attachments: VaultFile[]
  index: VaultIndex
  loading: boolean
  error: string | null
  dirty: Set<NotePath>
  saving: Set<NotePath>

  /* workspace -------------------------------------------------------- */
  panes: Pane[]
  activePaneId: string
  sidebarPanel: SidebarPanel
  sidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarWidth: number

  /* ui --------------------------------------------------------------- */
  settings: Settings
  palette: null | 'commands' | 'quickswitch' | 'headings'
  toasts: Toast[]
  starred: NotePath[]
  recent: NotePath[]
  searchQuery: string
  /** Note the user is hovering in the graph / file tree, highlighted elsewhere. */
  hoveredPath: NotePath | null
  /** Bumped whenever the editor should force-refresh from state. */
  revision: number

  /* actions: vault --------------------------------------------------- */
  openVault: (adapter: VaultAdapter) => Promise<void>
  reloadVault: () => Promise<void>
  setNoteContent: (path: NotePath, content: string) => void
  saveNote: (path: NotePath) => Promise<void>
  saveAll: () => Promise<void>
  createNote: (path: NotePath, content?: string) => Promise<NotePath>
  createNoteFromTitle: (title: string, folder?: string) => Promise<NotePath>
  deleteNote: (path: NotePath) => Promise<void>
  renameNote: (from: NotePath, to: NotePath) => Promise<void>
  openDailyNote: () => Promise<void>

  /* actions: navigation ---------------------------------------------- */
  openPath: (path: NotePath, options?: OpenOptions) => void
  openLink: (target: string, fromPath: NotePath, options?: OpenOptions) => Promise<void>
  openView: (kind: 'graph' | 'search', options?: OpenOptions) => void
  closeTab: (paneId: string, tabId: string) => void
  closeOtherTabs: (paneId: string, tabId: string) => void
  setActiveTab: (paneId: string, tabId: string) => void
  moveTab: (fromPaneId: string, tabId: string, toPaneId: string, toIndex: number) => void
  togglePinTab: (paneId: string, tabId: string) => void
  splitPane: () => void
  closePane: (paneId: string) => void
  setActivePane: (paneId: string) => void
  setViewMode: (mode: ViewMode) => void
  cycleViewMode: () => void

  /* actions: ui ------------------------------------------------------- */
  setSidebarPanel: (panel: SidebarPanel) => void
  setSidebarWidth: (px: number) => void
  toggleRightSidebar: (open?: boolean) => void
  setRightSidebarWidth: (px: number) => void
  updateSettings: (patch: Partial<Settings>) => void
  setTheme: (theme: ThemeName) => void
  setPalette: (palette: AppState['palette']) => void
  setSearchQuery: (query: string) => void
  setHoveredPath: (path: NotePath | null) => void
  toggleStar: (path: NotePath) => void
  pushToast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: string) => void

  /* selectors (cheap derived helpers) --------------------------------- */
  activePane: () => Pane
  activeTab: () => Tab | null
  activeNote: () => Note | null
  backlinksFor: (path: NotePath) => BacklinkGroup[]
  outgoingFor: (path: NotePath) => BacklinkGroup[]
}

const saveTimers = new Map<NotePath, ReturnType<typeof setTimeout>>()

function makeTab(kind: Tab['kind'], path: NotePath | null, mode: ViewMode): Tab {
  return { id: newId('tab'), kind, path, mode, pinned: false }
}

function firstPane(): Pane {
  const tab = makeTab('note', null, 'edit')
  return { id: newId('pane'), tabs: [tab], activeTabId: tab.id }
}

const initialPane = firstPane()

export const useAppStore = create<AppState>((set, get) => ({
  adapter: null,
  vaultName: '',
  notes: new Map(),
  attachments: [],
  index: emptyIndex(),
  loading: false,
  error: null,
  dirty: new Set(),
  saving: new Set(),

  panes: [initialPane],
  activePaneId: initialPane.id,
  sidebarPanel: 'files',
  sidebarWidth: 260,
  rightSidebarOpen: true,
  rightSidebarWidth: 300,

  settings: loadJSON<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS),
  palette: null,
  toasts: [],
  starred: loadJSON<NotePath[]>(STARRED_KEY, []) as NotePath[],
  recent: [],
  searchQuery: '',
  hoveredPath: null,
  revision: 0,

  /* ------------------------------------------------------------------ */

  async openVault(adapter) {
    set({ loading: true, error: null, adapter, vaultName: adapter.name })
    try {
      const files = await adapter.list()
      const notes = new Map<NotePath, Note>()
      const attachments: VaultFile[] = []
      await Promise.all(
        files.map(async (file) => {
          if (!file.isMarkdown) {
            attachments.push(file)
            return
          }
          const content = await adapter.read(file.path)
          notes.set(file.path, makeNote(file.path, content, file.mtime))
        }),
      )
      attachments.sort((a, b) => a.path.localeCompare(b.path))
      set({
        notes,
        attachments,
        index: buildIndex(notes),
        loading: false,
        dirty: new Set(),
        revision: get().revision + 1,
      })

      // Land on a sensible first note when nothing is open yet.
      const state = get()
      const pane = state.panes.find((p) => p.id === state.activePaneId)
      const activeTab = pane?.tabs.find((t) => t.id === pane.activeTabId)
      if (!activeTab?.path && notes.size > 0) {
        const home =
          [...notes.keys()].find((p) => /^(readme|home|index|welcome|start here)\.md$/i.test(p)) ??
          [...notes.keys()].sort()[0]!
        get().openPath(home)
      }
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async reloadVault() {
    const adapter = get().adapter
    if (adapter) await get().openVault(adapter)
  },

  setNoteContent(path, content) {
    const state = get()
    const previous = state.notes.get(path)
    if (!previous || previous.content === content) return

    const notes = new Map(state.notes)
    notes.set(path, makeNote(path, content, previous.mtime))
    const dirty = new Set(state.dirty)
    dirty.add(path)
    set({ notes, dirty, index: buildIndex(notes) })

    const timer = saveTimers.get(path)
    if (timer) clearTimeout(timer)
    saveTimers.set(
      path,
      setTimeout(
        () => {
          saveTimers.delete(path)
          void get().saveNote(path)
        },
        Math.max(AUTOSAVE_MS_MIN, state.settings.autosaveDelay),
      ),
    )
  },

  async saveNote(path) {
    const { adapter, notes } = get()
    const note = notes.get(path)
    if (!adapter || !note || !adapter.writable) return
    const timer = saveTimers.get(path)
    if (timer) {
      clearTimeout(timer)
      saveTimers.delete(path)
    }
    set((s) => ({ saving: new Set(s.saving).add(path) }))
    try {
      await adapter.write(path, note.content)
      set((s) => {
        const dirty = new Set(s.dirty)
        dirty.delete(path)
        const saving = new Set(s.saving)
        saving.delete(path)
        return { dirty, saving }
      })
    } catch (error) {
      set((s) => {
        const saving = new Set(s.saving)
        saving.delete(path)
        return { saving }
      })
      get().pushToast(`Could not save ${path}: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  },

  async saveAll() {
    const dirty = [...get().dirty]
    await Promise.all(dirty.map((path) => get().saveNote(path)))
  },

  async createNote(path, content = '') {
    const { adapter, notes } = get()
    let target = path.toLowerCase().endsWith('.md') ? path : `${path}.md`
    if (notes.has(target)) {
      const stem = target.slice(0, -3)
      let n = 1
      while (notes.has(`${stem} ${n}.md`)) n += 1
      target = `${stem} ${n}.md`
    }
    const next = new Map(notes)
    next.set(target, makeNote(target, content, Date.now()))
    set({ notes: next, index: buildIndex(next) })
    if (adapter?.writable) {
      try {
        await adapter.write(target, content)
      } catch (error) {
        get().pushToast(`Could not create ${target}: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    return target
  },

  async createNoteFromTitle(title, folder) {
    const { settings } = get()
    const name = sanitizeFileName(title)
    const dir = folder ?? settings.newNoteFolder
    const path = await get().createNote(joinPath(dir, `${name}.md`), `# ${name}\n\n`)
    get().openPath(path, { mode: 'edit' })
    return path
  },

  async deleteNote(path) {
    const { adapter, notes } = get()
    if (!notes.has(path)) return
    const next = new Map(notes)
    next.delete(path)
    set((s) => {
      const dirty = new Set(s.dirty)
      dirty.delete(path)
      return {
        notes: next,
        index: buildIndex(next),
        dirty,
        starred: s.starred.filter((p) => p !== path),
        recent: s.recent.filter((p) => p !== path),
        panes: s.panes.map((pane) => closeTabsFor(pane, path)),
      }
    })
    if (adapter?.writable) {
      try {
        await adapter.remove(path)
      } catch (error) {
        get().pushToast(`Could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    get().pushToast(`Deleted ${path}`, 'info')
  },

  async renameNote(from, to) {
    const { adapter, notes } = get()
    const note = notes.get(from)
    if (!note) return
    const target = to.toLowerCase().endsWith('.md') ? to : `${to}.md`
    if (notes.has(target)) {
      get().pushToast(`A note named ${target} already exists`, 'error')
      return
    }

    const oldName = basename(from)
    const newName = basename(target)
    const next = new Map<NotePath, Note>()
    const rewritten: NotePath[] = []

    for (const [path, current] of notes) {
      if (path === from) continue
      const updated = rewriteWikiLinks(current.content, oldName, newName)
      if (updated !== current.content) {
        next.set(path, makeNote(path, updated, current.mtime))
        rewritten.push(path)
      } else {
        next.set(path, current)
      }
    }
    next.set(target, makeNote(target, note.content, note.mtime))

    set((s) => {
      const dirty = new Set(s.dirty)
      dirty.delete(from)
      dirty.add(target)
      rewritten.forEach((p) => dirty.add(p))
      return {
        notes: next,
        index: buildIndex(next),
        dirty,
        starred: s.starred.map((p) => (p === from ? target : p)),
        recent: s.recent.map((p) => (p === from ? target : p)),
        panes: s.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => (tab.path === from ? { ...tab, path: target } : tab)),
        })),
        revision: s.revision + 1,
      }
    })

    if (adapter?.writable) {
      try {
        await adapter.rename(from, target)
        await Promise.all([target, ...rewritten].map((p) => get().saveNote(p)))
      } catch (error) {
        get().pushToast(`Could not rename: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    if (rewritten.length > 0) {
      get().pushToast(`Updated ${rewritten.length} link${rewritten.length === 1 ? '' : 's'} to ${newName}`, 'success')
    }
  },

  async openDailyNote() {
    const { settings, notes } = get()
    const name = formatDate(settings.dailyNoteFormat, new Date())
    const path = joinPath(settings.dailyNoteFolder, `${name}.md`)
    if (notes.has(path)) {
      get().openPath(path)
      return
    }
    await get().createNote(path, `# ${name}\n\n`)
    get().openPath(path, { mode: 'edit' })
  },

  /* ------------------------------------------------------------------ */

  openPath(path, options = {}) {
    set((state) => {
      const paneId = options.paneId ?? state.activePaneId
      const panes = state.panes.map((pane) => {
        if (pane.id !== paneId) return pane
        const existing = pane.tabs.find((tab) => tab.kind === 'note' && tab.path === path)
        if (existing) {
          return {
            ...pane,
            activeTabId: existing.id,
            tabs: options.mode ? pane.tabs.map((t) => (t.id === existing.id ? { ...t, mode: options.mode! } : t)) : pane.tabs,
          }
        }
        const active = pane.tabs.find((tab) => tab.id === pane.activeTabId)
        const mode = options.mode ?? active?.mode ?? 'edit'
        const reusable = !options.newTab && active && !active.pinned && (active.kind !== 'note' || active.path === null)
        if (reusable) {
          return {
            ...pane,
            tabs: pane.tabs.map((tab) => (tab.id === active.id ? { ...tab, kind: 'note' as const, path, mode } : tab)),
          }
        }
        if (!options.newTab && active && !active.pinned) {
          return {
            ...pane,
            tabs: pane.tabs.map((tab) => (tab.id === active.id ? { ...tab, kind: 'note' as const, path, mode } : tab)),
          }
        }
        const tab = makeTab('note', path, mode)
        return { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id }
      })
      const recent = [path, ...state.recent.filter((p) => p !== path)].slice(0, 50)
      return { panes, activePaneId: paneId, recent }
    })
  },

  async openLink(target, fromPath, options) {
    const { index, settings } = get()
    const resolved = resolveLinkTarget(target, fromPath, index)
    if (resolved) {
      get().openPath(resolved, options)
      return
    }
    const folder = dirname(fromPath) || settings.newNoteFolder
    const name = sanitizeFileName(target)
    const path = await get().createNote(joinPath(folder, `${name}.md`), `# ${name}\n\n`)
    get().openPath(path, { ...options, mode: 'edit' })
    get().pushToast(`Created ${path}`, 'success')
  },

  openView(kind, options = {}) {
    set((state) => {
      const paneId = options.paneId ?? state.activePaneId
      const panes = state.panes.map((pane) => {
        if (pane.id !== paneId) return pane
        const existing = pane.tabs.find((tab) => tab.kind === kind)
        if (existing) return { ...pane, activeTabId: existing.id }
        const tab = makeTab(kind, null, 'preview')
        return { ...pane, tabs: [...pane.tabs, tab], activeTabId: tab.id }
      })
      return { panes, activePaneId: paneId }
    })
  },

  closeTab(paneId, tabId) {
    set((state) => {
      const panes: Pane[] = []
      for (const pane of state.panes) {
        if (pane.id !== paneId) {
          panes.push(pane)
          continue
        }
        const index = pane.tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) {
          panes.push(pane)
          continue
        }
        const tabs = pane.tabs.filter((tab) => tab.id !== tabId)
        if (tabs.length === 0) {
          if (state.panes.length === 1) {
            const blank = makeTab('note', null, 'edit')
            panes.push({ ...pane, tabs: [blank], activeTabId: blank.id })
          }
          continue
        }
        const activeTabId =
          pane.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : pane.activeTabId
        panes.push({ ...pane, tabs, activeTabId })
      }
      const activePaneId = panes.some((p) => p.id === state.activePaneId) ? state.activePaneId : (panes[0]?.id ?? '')
      return { panes, activePaneId }
    })
  },

  closeOtherTabs(paneId, tabId) {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === paneId
          ? { ...pane, tabs: pane.tabs.filter((tab) => tab.id === tabId || tab.pinned), activeTabId: tabId }
          : pane,
      ),
    }))
  },

  setActiveTab(paneId, tabId) {
    set((state) => ({
      activePaneId: paneId,
      panes: state.panes.map((pane) => (pane.id === paneId ? { ...pane, activeTabId: tabId } : pane)),
    }))
  },

  moveTab(fromPaneId, tabId, toPaneId, toIndex) {
    set((state) => {
      const source = state.panes.find((p) => p.id === fromPaneId)
      const tab = source?.tabs.find((t) => t.id === tabId)
      if (!source || !tab) return {}
      let panes = state.panes.map((pane) =>
        pane.id === fromPaneId
          ? {
              ...pane,
              tabs: pane.tabs.filter((t) => t.id !== tabId),
              activeTabId: pane.activeTabId === tabId ? (pane.tabs.find((t) => t.id !== tabId)?.id ?? null) : pane.activeTabId,
            }
          : pane,
      )
      panes = panes.map((pane) => {
        if (pane.id !== toPaneId) return pane
        const tabs = [...pane.tabs]
        tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
        return { ...pane, tabs, activeTabId: tab.id }
      })
      panes = panes.filter((pane) => pane.tabs.length > 0 || panes.length === 1)
      return { panes, activePaneId: toPaneId }
    })
  },

  togglePinTab(paneId, tabId) {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === paneId
          ? { ...pane, tabs: pane.tabs.map((tab) => (tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab)) }
          : pane,
      ),
    }))
  },

  splitPane() {
    set((state) => {
      if (state.panes.length >= 3) return {}
      const active = state.panes.find((p) => p.id === state.activePaneId)
      const activeTab = active?.tabs.find((t) => t.id === active.activeTabId)
      const tab = makeTab(activeTab?.kind ?? 'note', activeTab?.path ?? null, activeTab?.mode ?? 'edit')
      const pane: Pane = { id: newId('pane'), tabs: [tab], activeTabId: tab.id }
      return { panes: [...state.panes, pane], activePaneId: pane.id }
    })
  },

  closePane(paneId) {
    set((state) => {
      if (state.panes.length <= 1) return {}
      const panes = state.panes.filter((p) => p.id !== paneId)
      return { panes, activePaneId: panes.some((p) => p.id === state.activePaneId) ? state.activePaneId : panes[0]!.id }
    })
  },

  setActivePane(paneId) {
    set({ activePaneId: paneId })
  },

  setViewMode(mode) {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === state.activePaneId
          ? { ...pane, tabs: pane.tabs.map((tab) => (tab.id === pane.activeTabId ? { ...tab, mode } : tab)) }
          : pane,
      ),
    }))
  },

  cycleViewMode() {
    const order: ViewMode[] = ['edit', 'split', 'preview']
    const current = get().activeTab()?.mode ?? 'edit'
    get().setViewMode(order[(order.indexOf(current) + 1) % order.length]!)
  },

  /* ------------------------------------------------------------------ */

  setSidebarPanel(panel) {
    set((state) => ({ sidebarPanel: state.sidebarPanel === panel ? null : panel }))
  },

  setSidebarWidth(px) {
    set({ sidebarWidth: Math.max(180, Math.min(520, px)) })
  },

  toggleRightSidebar(open) {
    set((state) => ({ rightSidebarOpen: open ?? !state.rightSidebarOpen }))
  },

  setRightSidebarWidth(px) {
    set({ rightSidebarWidth: Math.max(220, Math.min(560, px)) })
  },

  updateSettings(patch) {
    set((state) => {
      const settings = { ...state.settings, ...patch }
      saveJSON(SETTINGS_KEY, settings)
      return { settings }
    })
  },

  setTheme(theme) {
    get().updateSettings({ theme })
  },

  setPalette(palette) {
    set({ palette })
  },

  setSearchQuery(query) {
    set({ searchQuery: query })
  },

  setHoveredPath(path) {
    set({ hoveredPath: path })
  },

  toggleStar(path) {
    set((state) => {
      const starred = state.starred.includes(path) ? state.starred.filter((p) => p !== path) : [...state.starred, path]
      saveJSON(STARRED_KEY, starred)
      return { starred }
    })
  },

  pushToast(message, kind = 'info') {
    const toast: Toast = { id: newId('toast'), message, kind }
    set((state) => ({ toasts: [...state.toasts, toast] }))
    setTimeout(() => get().dismissToast(toast.id), 4000)
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },

  /* ------------------------------------------------------------------ */

  activePane() {
    const state = get()
    return state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0]!
  },

  activeTab() {
    const pane = get().activePane()
    return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null
  },

  activeNote() {
    const tab = get().activeTab()
    if (!tab?.path) return null
    return get().notes.get(tab.path) ?? null
  },

  backlinksFor(path) {
    const { index, notes } = get()
    return getBacklinks(path, index, notes)
  },

  outgoingFor(path) {
    const { index, notes } = get()
    const edges = index.outgoing.get(path) ?? []
    const groups = new Map<NotePath, BacklinkGroup>()
    for (const edge of edges) {
      if (!edge.to) continue
      const group = groups.get(edge.to)
      if (group) group.edges.push(edge)
      else groups.set(edge.to, { source: edge.to, title: notes.get(edge.to)?.parsed.title ?? basename(edge.to), edges: [edge] })
    }
    return [...groups.values()]
  },
}))

function closeTabsFor(pane: Pane, path: NotePath): Pane {
  const tabs = pane.tabs.map((tab) => (tab.kind === 'note' && tab.path === path ? { ...tab, path: null } : tab))
  return { ...pane, tabs }
}

/**
 * Rewrite `[[Old]]`, `[[Old|Alias]]`, `[[Old#Heading]]` and `![[Old]]` to point
 * at `newName`, leaving every other link untouched.
 */
export function rewriteWikiLinks(content: string, oldName: string, newName: string): string {
  if (oldName === newName) return content
  return content.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (match, bang: string, inner: string) => {
    const pipe = inner.indexOf('|')
    const linkPart = pipe === -1 ? inner : inner.slice(0, pipe)
    const rest = pipe === -1 ? '' : inner.slice(pipe)
    const hash = linkPart.search(/[#^]/)
    const target = (hash === -1 ? linkPart : linkPart.slice(0, hash)).trim()
    const fragment = hash === -1 ? '' : linkPart.slice(hash)
    if (target.toLowerCase() !== oldName.toLowerCase()) return match
    return `${bang}[[${newName}${fragment}${rest}]]`
  })
}
