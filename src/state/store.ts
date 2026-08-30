/**
 * SpaceFore — central application store.
 *
 * This module owns all mutable app state. Core modules (markdown, graph,
 * search, vault) are pure and are called from here; UI components read state
 * through `useAppStore` selectors and never talk to an adapter directly.
 */
import { create } from 'zustand'

import type {
  AppDialog,
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
/** Which kind of vault was last opened, so a reload comes back to the same one. */
export const LAST_VAULT_KEY = 'spacefore.vault'
const STARRED_KEY = 'spacefore.starred'

/**
 * Read a persisted value, keeping the fallback's shape.
 *
 * Arrays are restored as arrays: spreading one into an object literal yields
 * `{"0": "A.md"}`, and every consumer of the value then throws on `.includes`
 * or `new Set(…)`. A persisted value whose shape does not match the fallback
 * (an object where an array is expected, or the reverse) is discarded rather
 * than merged, so a legacy or hand-edited entry cannot brick the app.
 */
function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    return { ...fallback, ...parsed } as T
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
  /** The question currently on screen, if any. Rendered by `DialogHost`. */
  dialog: AppDialog | null
  toasts: Toast[]
  starred: NotePath[]
  recent: NotePath[]
  searchQuery: string
  /** Note the user is hovering in the graph / file tree, highlighted elsewhere. */
  hoveredPath: NotePath | null
  /** Bumped whenever the editor should force-refresh from state. */
  revision: number

  /* actions: vault --------------------------------------------------- */
  /**
   * Load a vault and make it the current one.
   *
   * `remember: false` loads it without recording it as the user's choice —
   * used for the automatic fallback at boot, so a vault that could not be
   * reopened this time is still the one reopened next time.
   */
  openVault: (adapter: VaultAdapter, options?: { remember?: boolean }) => Promise<void>
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
  /** Ask for a line of text. Resolves with the answer, or null when dismissed. */
  askText: (title: string, initial: string, options?: { message?: string; confirmLabel?: string; inputLabel?: string }) => Promise<string | null>
  /** Ask for a yes/no. Resolves false when dismissed. */
  askConfirm: (title: string, options?: { message?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  /** Answer the open dialog and close it. */
  resolveDialog: (answer: string | boolean | null) => void
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

/** Trailing debounce before a typing burst is reflected in the link index. */
const INDEX_REBUILD_MS = 150

let indexTimer: ReturnType<typeof setTimeout> | null = null
/** The notes map whose index rebuild is still queued behind `indexTimer`. */
let pendingNotes: Map<NotePath, Note> | null = null
/** That rebuild, once somebody needed it before the timer fired. */
let pendingIndex: VaultIndex | null = null
/** The note being typed in, so a burst in one note cannot slow an edit to another. */
let burstPath: NotePath | null = null

/** Disarm every autosave debounce — used when the vault underneath them goes away. */
function clearSaveTimers(): void {
  for (const timer of saveTimers.values()) clearTimeout(timer)
  saveTimers.clear()
}

/** Drop a queued index rebuild; the caller is committing a fresh index itself. */
function clearPendingIndex(): void {
  if (indexTimer) clearTimeout(indexTimer)
  indexTimer = null
  pendingNotes = null
  pendingIndex = null
  burstPath = null
}

/**
 * Everything a note contributes to the link index: its link targets, its tags
 * and its aliases. Prose, headings and where on the page a link sits leave the
 * shape of the index alone — only its `line`/`context` detail, which the
 * trailing rebuild catches up on.
 */
function indexSignature(note: Note): string {
  const links = note.parsed.links.map((link) => `${link.embed ? '!' : ''}${link.target}`)
  const aliases = note.parsed.frontmatter.aliases
  return JSON.stringify([links, note.parsed.allTags, Array.isArray(aliases) ? aliases : []])
}

/**
 * The index describing `state.notes`.
 *
 * Usually that is `state.index`. While a rebuild is queued behind the typing
 * debounce it is built here instead — once, then cached — so a caller that
 * needs a correct index right now never sees the pre-keystroke one.
 */
function currentIndex(state: AppState): VaultIndex {
  if (pendingNotes !== state.notes) return state.index
  if (!pendingIndex) pendingIndex = buildIndex(state.notes)
  return pendingIndex
}

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
  dialog: null,
  toasts: [],
  starred: loadJSON<NotePath[]>(STARRED_KEY, []).filter((path) => typeof path === 'string'),
  recent: [],
  searchQuery: '',
  hoveredPath: null,
  revision: 0,

  /* ------------------------------------------------------------------ */

  async openVault(adapter, options = {}) {
    // Autosave timers armed against the outgoing vault must never fire once it
    // is gone. Their content is flushed here instead — to the adapter that is
    // still installed, which is the one that owns it.
    clearSaveTimers()
    set({ loading: true, error: null })
    if (get().adapter) {
      await get().saveAll()
      const unsaved = [...get().dirty]
      if (unsaved.length > 0) {
        get().pushToast(`Unsaved changes in ${unsaved.join(', ')} could not be saved before loading the vault`, 'error')
      }
    }

    try {
      // Nothing is published before every read has landed: a store holding the
      // new adapter next to the old notes writes one vault's text into another.
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
      const index = buildIndex(notes)
      clearPendingIndex()
      // Remember the kind so the next load reopens this vault instead of
      // dropping the reader back into the demo with their notes seemingly gone.
      // A fallback never overwrites the choice: one revoked folder permission
      // must not cost the reader their vault for good.
      if (options.remember !== false) saveJSON(LAST_VAULT_KEY, { kind: adapter.kind })
      set((s) => ({
        adapter,
        vaultName: adapter.name,
        notes,
        attachments,
        index,
        loading: false,
        dirty: new Set(),
        // A tab left on a note this vault does not have keeps rendering the
        // previous vault's text and silently swallows every keystroke, so it
        // goes back to being an empty tab.
        panes: s.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) =>
            tab.kind === 'note' && tab.path !== null && !notes.has(tab.path) ? { ...tab, path: null } : tab,
          ),
        })),
        recent: s.recent.filter((path) => notes.has(path)),
        revision: s.revision + 1,
      }))

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
      // The load failed: leave the vault that is open exactly as it was, down
      // to its adapter, rather than running on with a half-swapped store.
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

    const note = makeNote(path, content, previous.mtime)
    const notes = new Map(state.notes)
    notes.set(path, note)
    const dirty = new Set(state.dirty)
    dirty.add(path)
    // The notes map is published synchronously — the editor, the word count and
    // the dirty markers all read it — but the link index is not: rebuilding it
    // is O(whole vault) and typing must not pay that per keystroke. It is
    // committed on a short trailing debounce instead, and `currentIndex` hands
    // a fresh one to anyone who asks before the timer fires.
    set({ notes, dirty })
    // One exception: an edit that changes what this note contributes to the
    // index and does *not* arrive inside a typing burst in this same note is a
    // discrete action — linking a mention, a paste, a scripted edit — and costs
    // a single rebuild, so components keyed on `index` reflect it at once.
    const inBurst = indexTimer !== null && burstPath === path
    if (!inBurst && indexSignature(note) !== indexSignature(previous)) {
      pendingNotes = null
      pendingIndex = null
      set({ index: buildIndex(notes) })
    } else {
      pendingNotes = notes
      pendingIndex = null
    }
    burstPath = path
    if (indexTimer) clearTimeout(indexTimer)
    indexTimer = setTimeout(() => {
      indexTimer = null
      const latest = get()
      if (pendingNotes !== latest.notes) {
        pendingNotes = null
        pendingIndex = null
        return
      }
      const index = pendingIndex ?? buildIndex(latest.notes)
      pendingNotes = null
      pendingIndex = null
      set({ index })
    }, INDEX_REBUILD_MS)

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
    // The exact text this call is responsible for. The user can type again
    // while the write is in flight, and this write does not save that edit.
    const written = note.content
    set((s) => ({ saving: new Set(s.saving).add(path) }))
    if (get().adapter !== adapter) {
      // The vault was swapped while this save was being set up; its content
      // belongs to a vault that is no longer open.
      set((s) => {
        const saving = new Set(s.saving)
        saving.delete(path)
        return { saving }
      })
      return
    }
    try {
      await adapter.write(path, written)
      set((s) => {
        const dirty = new Set(s.dirty)
        // Only this write's text is saved: anything typed since is still dirty,
        // and clearing the flag for it would defeat the unload guard.
        if (s.notes.get(path)?.content === written) dirty.delete(path)
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
    const index = buildIndex(next)
    clearPendingIndex()
    set({ notes: next, index })
    if (adapter?.writable) {
      try {
        await adapter.write(target, content)
      } catch (error) {
        // A note that never reached the vault is unsaved, not saved: keeping it
        // dirty is what gets autosave, `saveAll` and the unload flush to retry.
        set((s) => ({ dirty: new Set(s.dirty).add(target) }))
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
    if (adapter?.writable) {
      // Remove the file first: a workspace that has forgotten a note the vault
      // still holds reads as data loss the moment the note comes back.
      try {
        await adapter.remove(path)
      } catch (error) {
        get().pushToast(`Could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`, 'error')
        return
      }
    }
    clearPendingIndex()
    set((s) => {
      const next = new Map(s.notes)
      next.delete(path)
      const dirty = new Set(s.dirty)
      dirty.delete(path)
      const starred = s.starred.filter((p) => p !== path)
      saveJSON(STARRED_KEY, starred)
      return {
        notes: next,
        index: buildIndex(next),
        dirty,
        starred,
        recent: s.recent.filter((p) => p !== path),
        panes: s.panes.map((pane) => closeTabsFor(pane, path)),
      }
    })
    get().pushToast(`Deleted ${path}`, 'info')
  },

  async renameNote(from, to) {
    const state = get()
    const { adapter, notes } = state
    const note = notes.get(from)
    if (!note) return
    const target = to.toLowerCase().endsWith('.md') ? to : `${to}.md`
    if (notes.has(target)) {
      get().pushToast(`A note named ${target} already exists`, 'error')
      return
    }

    // Links are rewritten against the vault as it stands *before* the rename,
    // so each one can be checked for where it actually pointed.
    const before = currentIndex(state)
    const newName = basename(target)
    const next = new Map<NotePath, Note>()
    const rewritten: NotePath[] = []

    for (const [path, current] of notes) {
      if (path === from) continue
      const updated = rewriteLinksTo(current, from, target, before)
      if (updated !== current.content) {
        next.set(path, makeNote(path, updated, current.mtime))
        rewritten.push(path)
      } else {
        next.set(path, current)
      }
    }
    next.set(target, makeNote(target, note.content, note.mtime))

    const index = buildIndex(next)
    clearPendingIndex()
    set((s) => {
      const dirty = new Set(s.dirty)
      dirty.delete(from)
      dirty.add(target)
      rewritten.forEach((p) => dirty.add(p))
      const starred = s.starred.map((p) => (p === from ? target : p))
      saveJSON(STARRED_KEY, starred)
      return {
        notes: next,
        index,
        dirty,
        starred,
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
        // A graph or search tab carries a placeholder mode; inheriting it would
        // drop the reader into preview when they click through from the graph.
        // Take the mode from a real note tab instead, and fall back to editing.
        const inherited =
          active?.kind === 'note' ? active.mode : pane.tabs.find((tab) => tab.kind === 'note')?.mode
        const mode = options.mode ?? inherited ?? 'edit'
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
    const state = get()
    const resolved = resolveLinkTarget(target, fromPath, currentIndex(state))
    if (resolved) {
      get().openPath(resolved, options)
      return
    }
    const folder = dirname(fromPath) || state.settings.newNoteFolder
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

  askText(title, initial, options = {}) {
    // Only one question at a time: an unanswered one is dismissed rather than
    // left dangling, so its caller always settles.
    get().resolveDialog(null)
    return new Promise<string | null>((resolve) => {
      set({
        dialog: {
          kind: 'prompt',
          title,
          initial,
          ...options,
          resolve: (answer) => resolve(typeof answer === 'string' ? answer : null),
        },
      })
    })
  },

  askConfirm(title, options = {}) {
    get().resolveDialog(null)
    return new Promise<boolean>((resolve) => {
      set({
        dialog: {
          kind: 'confirm',
          title,
          ...options,
          resolve: (answer) => resolve(answer === true),
        },
      })
    })
  },

  resolveDialog(answer) {
    const dialog = get().dialog
    if (!dialog) return
    set({ dialog: null })
    dialog.resolve(answer)
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
    const state = get()
    return getBacklinks(path, currentIndex(state), state.notes)
  },

  outgoingFor(path) {
    const state = get()
    const edges = currentIndex(state).outgoing.get(path) ?? []
    const groups = new Map<NotePath, BacklinkGroup>()
    for (const edge of edges) {
      if (!edge.to) continue
      const group = groups.get(edge.to)
      if (group) group.edges.push(edge)
      else
        groups.set(edge.to, {
          source: edge.to,
          title: state.notes.get(edge.to)?.parsed.title ?? basename(edge.to),
          edges: [edge],
        })
    }
    return [...groups.values()]
  },
}))

function closeTabsFor(pane: Pane, path: NotePath): Pane {
  const tabs = pane.tabs.map((tab) => (tab.kind === 'note' && tab.path === path ? { ...tab, path: null } : tab))
  return { ...pane, tabs }
}

/** `path` without its `.md` extension — the form a wiki link is usually written in. */
function withoutExtension(path: NotePath): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path
}

/**
 * Rewrite the links in `note` that point at `from` so they point at `to`,
 * leaving `[[Old|Alias]]`, `[[Old#Heading]]`, `[[Old#^block]]` and `![[Old]]`
 * decoration exactly as written.
 *
 * A link is only rewritten when it *resolved* to `from` in `index` and names it
 * directly, so `[[Foo]]` that pointed at a different `Foo.md` in another folder
 * is left alone, and a path-form `[[Bar/Foo]]` that did point here is rewritten
 * in path form rather than left dangling. Only the links `parseNote` reported
 * are touched, which is what keeps `[[Foo]]` inside a fenced code block or an
 * inline code span verbatim.
 */
export function rewriteLinksTo(note: Note, from: NotePath, to: NotePath, index: VaultIndex): string {
  if (from === to) return note.content
  const names = new Set(
    [basename(from), `${basename(from)}.md`, from, withoutExtension(from)].map((name) => name.toLowerCase()),
  )
  let content = note.content

  // Right to left, so the offsets of the links still to come stay valid.
  for (let i = note.parsed.links.length - 1; i >= 0; i -= 1) {
    const link = note.parsed.links[i]!
    const written = link.target.trim()
    // An alias — or any other spelling that happens to resolve here — is not a
    // name of this file, so renaming the file does not invalidate it.
    if (!names.has(written.toLowerCase())) continue
    if (resolveLinkTarget(link.target, note.path, index) !== from) continue

    const keepExtension = written.toLowerCase().endsWith('.md')
    const replacement = written.includes('/')
      ? keepExtension
        ? to
        : withoutExtension(to)
      : keepExtension
        ? `${basename(to)}.md`
        : basename(to)
    const raw = content.slice(link.start, link.end)
    const at = raw.indexOf(written, raw.indexOf('[[') + 2)
    if (at === -1) continue
    content =
      content.slice(0, link.start) +
      raw.slice(0, at) +
      replacement +
      raw.slice(at + written.length) +
      content.slice(link.end)
  }
  return content
}
