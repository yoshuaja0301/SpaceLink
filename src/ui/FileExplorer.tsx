/**
 * SpaceLink — the vault file tree.
 *
 * The store keeps a flat map of paths; this component is the only place that
 * turns those paths into a folder hierarchy. The tree is rebuilt behind a memo
 * and rendered recursively so the stylesheet's nesting rules (indent guides,
 * collapse) work, while a parallel flat list of *visible* rows drives keyboard
 * navigation — the two always agree because collapsed folders render no
 * children at all rather than being hidden with CSS.
 *
 * Past `WINDOW_THRESHOLD` rows that same flat list *is* the render: only the
 * slice around the scrollport reaches the DOM, with a spacer above and below
 * standing in for the rest, and each row carrying the `aria-posinset` /
 * `aria-setsize` the missing siblings would otherwise have conveyed.
 *
 * The subscription is deliberately narrow: the explorer watches note *paths*
 * (see `noteKeys`) and the dirty set, never the note map, so a keystroke — which
 * replaces the map — neither rebuilds the tree nor re-renders a single row.
 *
 * Folders are implicit: they exist because a file lives inside them. A folder
 * the user creates by hand is therefore held in component state until it gets
 * its first note (nothing else in the app can represent an empty directory).
 */
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
} from 'react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Note, NotePath } from '../types'
import type { AppState } from '../state/store'
import { basename, dirname, joinPath, useAppStore } from '../state/store'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem } from './useContextMenu'
import { useContextMenu } from './useContextMenu'
import { Icon } from './Icon'

/* ------------------------------------------------------------------ *
 * Tree model
 * ------------------------------------------------------------------ */

export type ExplorerSort = 'name' | 'modified' | 'created'

/** One file as the tree builder wants it: already named and time-stamped. */
export interface ExplorerEntry {
  path: NotePath
  /** Display name — notes drop the `.md`, attachments keep their extension. */
  name: string
  isMarkdown: boolean
  /** Sort timestamp for the current sort mode. Ignored when sorting by name. */
  time: number
}

export interface ExplorerFileNode extends ExplorerEntry {
  kind: 'file'
}

export interface ExplorerFolderNode {
  kind: 'folder'
  /** `''` for the synthetic root. */
  path: string
  name: string
  children: ExplorerNode[]
  /** Newest timestamp anywhere below this folder. */
  time: number
}

export type ExplorerNode = ExplorerFileNode | ExplorerFolderNode

const OPEN_STORAGE_KEY = 'spacelink.explorer.open'
const SORT_STORAGE_KEY = 'spacelink.explorer.sort'

/**
 * Above this many visible rows the tree renders as a window over the flat row
 * list instead of the full nested markup: a 5,000-note vault is 5,000 DOM rows
 * otherwise. Below it the nested markup costs nothing and keeps the indent
 * guides the stylesheet draws from `.nav-folder-children`.
 */
const WINDOW_THRESHOLD = 200
/** Row height used until a rendered row can be measured (jsdom has no layout). */
const DEFAULT_ROW_HEIGHT = 26
/** Rows kept rendered above and below the scrollport. */
const OVERSCAN = 8
/** Scrollport height used before the container has been measured. */
const FALLBACK_VIEWPORT = 640

/** Case-insensitive, deterministic name order (no locale data involved). */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function compareNodes(a: ExplorerNode, b: ExplorerNode, sort: ExplorerSort): number {
  // Folders always come first, whatever the sort mode.
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  if (sort !== 'name' && a.time !== b.time) return b.time - a.time
  return compareNames(a.name, b.name)
}

/** Sort a folder's children in place and roll the newest timestamp upwards. */
function sortFolder(folder: ExplorerFolderNode, sort: ExplorerSort): number {
  let newest = 0
  for (const child of folder.children) {
    const time = child.kind === 'folder' ? sortFolder(child, sort) : child.time
    if (time > newest) newest = time
  }
  folder.time = newest
  folder.children.sort((a, b) => compareNodes(a, b, sort))
  return newest
}

/**
 * Build the folder hierarchy from flat vault paths.
 *
 * `extraFolders` seeds folders that hold no file yet (freshly created ones).
 * The returned node is a synthetic root whose `path` is `''`.
 */
export function buildFileTree(
  entries: readonly ExplorerEntry[],
  sort: ExplorerSort = 'name',
  extraFolders: readonly string[] = [],
): ExplorerFolderNode {
  const root: ExplorerFolderNode = { kind: 'folder', path: '', name: '', children: [], time: 0 }
  const folders = new Map<string, ExplorerFolderNode>([['', root]])

  // Walks up creating any missing ancestor; `dirname('')` is `''`, which is
  // already in the map, so the recursion always terminates at the root.
  const folderAt = (path: string): ExplorerFolderNode => {
    const existing = folders.get(path)
    if (existing) return existing
    const node: ExplorerFolderNode = {
      kind: 'folder',
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      children: [],
      time: 0,
    }
    folders.set(path, node)
    folderAt(dirname(path)).children.push(node)
    return node
  }

  for (const folder of extraFolders) {
    if (folder !== '') folderAt(folder)
  }
  for (const entry of entries) {
    folderAt(dirname(entry.path)).children.push({ kind: 'file', ...entry })
  }

  sortFolder(root, sort)
  return root
}

/** One rendered row, in the order the tree shows them. */
interface ExplorerRow {
  node: ExplorerNode
  depth: number
  /** 1-based position among its siblings, and how many siblings there are.
   *  A windowed tree holds only a slice of the rows, so the browser cannot
   *  count them from the DOM — the row has to say. */
  posinset: number
  setsize: number
}

/** Depth-first list of the rows that are actually on screen. */
function flattenTree(root: ExplorerFolderNode, openFolders: ReadonlySet<string>): ExplorerRow[] {
  const rows: ExplorerRow[] = []
  const walk = (nodes: readonly ExplorerNode[], depth: number): void => {
    nodes.forEach((node, index) => {
      rows.push({ node, depth, posinset: index + 1, setsize: nodes.length })
      if (node.kind === 'folder' && openFolders.has(node.path)) walk(node.children, depth + 1)
    })
  }
  walk(root.children, 0)
  return rows
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** A typed note name without a trailing `.md`, however it was cased. */
function noteStem(raw: string): string {
  return raw.trim().replace(/\.md$/i, '').trim()
}

/** `a/b/c.md` -> `['a', 'a/b']`. */
function ancestorsOf(path: string): string[] {
  const out: string[] = []
  let dir = dirname(path)
  while (dir !== '') {
    out.push(dir)
    dir = dirname(dir)
  }
  return out
}

function isInside(path: string, folder: string): boolean {
  return folder === '' ? path.includes('/') : path.startsWith(`${folder}/`)
}

/** Rewrite folder paths after a folder moved or was renamed. */
function remapFolders(folders: ReadonlySet<string>, from: string, to: string): Set<string> {
  const next = new Set<string>()
  for (const folder of folders) {
    if (folder === from) next.add(to)
    else if (isInside(folder, from)) next.add(to + folder.slice(from.length))
    else next.add(folder)
  }
  return next
}

function loadOpenFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === 'string'))
  } catch {
    // Private mode, disabled storage or corrupt JSON — start collapsed.
    return new Set()
  }
}

function saveOpenFolders(folders: ReadonlySet<string>): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify([...folders]))
  } catch {
    /* storage unavailable — the tree simply does not remember its state */
  }
}

function loadSort(): ExplorerSort {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY)
    if (raw === 'name' || raw === 'modified' || raw === 'created') return raw
  } catch {
    /* ignore */
  }
  return 'name'
}

function saveSort(sort: ExplorerSort): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort)
  } catch {
    /* ignore */
  }
}

/**
 * Creation time for a note. No vault backend records one, so the frontmatter
 * is the only honest source; notes without it fall back to their mtime.
 */
function createdTime(note: Note): number {
  const frontmatter = note.parsed.frontmatter
  for (const key of ['created', 'date', 'created_at']) {
    const value = frontmatter[key]
    if (typeof value !== 'string') continue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return note.mtime
}

/**
 * The notes, encoded as one string per note, so the explorer can subscribe to
 * them without subscribing to their content: every keystroke replaces the notes
 * map, but only a path (or, under a time sort, a timestamp) can change what the
 * tree looks like. Compared shallowly, this array is stable while typing.
 */
function noteKeys(notes: Map<NotePath, Note>, sort: ExplorerSort): string[] {
  const keys: string[] = []
  // Sorted by name, the time is not part of what the tree looks like — so it is
  // left out of the key rather than formatted into one string per note on every
  // store update, which on a five thousand note vault is five thousand strings
  // allocated and compared for nothing.
  if (sort === 'name') {
    for (const path of notes.keys()) keys.push(path)
    return keys
  }
  for (const note of notes.values()) {
    keys.push(`${sort === 'created' ? createdTime(note) : note.mtime}\u0000${note.path}`)
  }
  return keys
}

function decodeNoteKey(key: string): ExplorerEntry {
  const cut = key.indexOf('\u0000')
  const path = cut === -1 ? key : key.slice(cut + 1)
  // `makeNote` names a note after its path, so the name needs no subscription.
  return { path, name: basename(path), isMarkdown: true, time: cut === -1 ? 0 : Number(key.slice(0, cut)) }
}

/** The note tab the workspace is currently showing, if any. */
function selectActivePath(state: AppState): NotePath | null {
  const pane = state.panes.find((p) => p.id === state.activePaneId)
  const tab = pane?.tabs.find((t) => t.id === pane.activeTabId)
  return tab && tab.kind === 'note' ? tab.path : null
}

function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Indent is CSS-driven: rows only publish their depth. */
function depthStyle(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

interface RenameState {
  path: string
  kind: 'file' | 'folder'
  value: string
  /** Name we started from, so an unchanged commit is a no-op. */
  original: string
  error: string | null
}

interface CreateFolderState {
  parent: string
  value: string
  error: string | null
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function FileExplorer(): JSX.Element {
  const attachments = useAppStore((s) => s.attachments)
  const vaultName = useAppStore((s) => s.vaultName)
  const starred = useAppStore((s) => s.starred)
  const dirty = useAppStore((s) => s.dirty)
  const hoveredPath = useAppStore((s) => s.hoveredPath)
  const panes = useAppStore((s) => s.panes)
  const activePaneId = useAppStore((s) => s.activePaneId)
  const activePath = useAppStore(selectActivePath)

  const openPath = useAppStore((s) => s.openPath)
  const createNoteFromTitle = useAppStore((s) => s.createNoteFromTitle)
  const deleteNote = useAppStore((s) => s.deleteNote)
  const renameNote = useAppStore((s) => s.renameNote)
  const toggleStar = useAppStore((s) => s.toggleStar)
  const setHoveredPath = useAppStore((s) => s.setHoveredPath)
  const pushToast = useAppStore((s) => s.pushToast)
  const splitPane = useAppStore((s) => s.splitPane)

  const [sort, setSort] = useState<ExplorerSort>(loadSort)
  const [openFolders, setOpenFolders] = useState<Set<string>>(loadOpenFolders)
  /** Folders created from the UI that hold no file yet. */
  const [pendingFolders, setPendingFolders] = useState<string[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [creating, setCreating] = useState<CreateFolderState | null>(null)
  const [dragPath, setDragPath] = useState<string | null>(null)
  /** Folder currently under the pointer during a drag; `''` is the vault root. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT)

  // Subscribed *after* `sort`, which the encoding depends on. Shallow-compared,
  // so typing in a note — which replaces the notes map — is not a re-render.
  const noteRows = useAppStore(useShallow((s: AppState) => noteKeys(s.notes, sort)))

  const { menu, open: openMenu, close: closeMenu } = useContextMenu()

  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const rowCallbacks = useRef(new Map<string, (element: HTMLDivElement | null) => void>())
  /** Set when a keyboard move should also pull DOM focus after the render. */
  const focusWanted = useRef<string | null>(null)
  /** The scrolling element the window is measured against. */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLDivElement | null>(null)

  /* -- derived tree ------------------------------------------------- */

  const entries = useMemo<ExplorerEntry[]>(() => {
    const out = noteRows.map(decodeNoteKey)
    for (const file of attachments) {
      out.push({ path: file.path, name: file.name, isMarkdown: false, time: file.mtime })
    }
    return out
  }, [noteRows, attachments])

  /** Note paths on their own: everything below only asks whether one exists. */
  const notePaths = useMemo(() => {
    const set = new Set<string>()
    for (const entry of entries) {
      if (entry.isMarkdown) set.add(entry.path)
    }
    return set
  }, [entries])

  const tree = useMemo(() => buildFileTree(entries, sort, pendingFolders), [entries, sort, pendingFolders])

  const folderIndex = useMemo(() => {
    const map = new Map<string, ExplorerFolderNode>()
    const walk = (folder: ExplorerFolderNode): void => {
      for (const child of folder.children) {
        if (child.kind !== 'folder') continue
        map.set(child.path, child)
        walk(child)
      }
    }
    walk(tree)
    return map
  }, [tree])

  const rows = useMemo(() => flattenTree(tree, openFolders), [tree, openFolders])
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, index) => map.set(row.node.path, index))
    return map
  }, [rows])

  const isEmpty = entries.length === 0 && pendingFolders.length === 0
  const starredSet = useMemo(() => new Set(starred), [starred])

  /* -- windowing ----------------------------------------------------- */

  const windowed = rows.length > WINDOW_THRESHOLD
  const perScreen = Math.ceil((viewportHeight || FALLBACK_VIEWPORT) / rowHeight)
  const start = windowed ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN) : 0
  const end = windowed ? Math.min(rows.length, start + perScreen + OVERSCAN * 2) : rows.length
  const visibleRows = windowed ? rows.slice(start, end) : rows

  /** Roving tab index: one *rendered* row is always reachable with Tab. */
  const tabbablePath =
    focused !== null && visibleRows.some((row) => row.node.path === focused)
      ? focused
      : visibleRows[0]?.node.path ?? null

  /** Row the keyboard or an inline editor points at: it has to stay rendered. */
  const anchorPath = renaming?.path ?? creating?.parent ?? confirming ?? focused ?? null

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  /* -- persistence + reveal ----------------------------------------- */

  useEffect(() => {
    saveOpenFolders(openFolders)
  }, [openFolders])

  useEffect(() => {
    saveSort(sort)
  }, [sort])

  // Reveal the active note: a row that is not rendered cannot be scrolled to.
  useEffect(() => {
    if (!activePath) return
    setOpenFolders((prev) => {
      const missing = ancestorsOf(activePath).filter((folder) => !prev.has(folder))
      if (missing.length === 0) return prev
      const next = new Set(prev)
      for (const folder of missing) next.add(folder)
      return next
    })
  }, [activePath])

  /** Scroll the windowed viewport until row `index` is inside the scrollport. */
  const scrollRowIntoView = useCallback(
    (index: number): void => {
      const viewport = viewportRef.current
      const height = viewport?.clientHeight || FALLBACK_VIEWPORT
      const current = viewport?.scrollTop ?? 0
      const top = index * rowHeight
      const next = top < current ? top : top + rowHeight > current + height ? top + rowHeight - height : current
      if (next === current) return
      // The state drives the window; the DOM has to follow it, and in jsdom
      // (no layout, no scroll events) it is the only thing that does.
      if (viewport) viewport.scrollTop = next
      setScrollTop(next)
    },
    [rowHeight],
  )

  useEffect(() => {
    if (!windowed) return undefined
    const measure = (): void => setViewportHeight(viewportRef.current?.clientHeight ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [windowed])

  // How tall a row is, is a stylesheet decision — the spacers have to measure
  // it rather than assume it, or the scrollbar lies about the vault's size.
  useEffect(() => {
    if (!windowed) return
    const measured = viewportRef.current?.querySelector<HTMLElement>('.nav-item')?.offsetHeight ?? 0
    if (measured > 0 && measured !== rowHeight) setRowHeight(measured)
  }, [windowed, rowHeight, rows.length])

  useEffect(() => {
    if (!activePath) return
    const element = rowRefs.current.get(activePath)
    // jsdom has no layout and therefore no `scrollIntoView`.
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' })
      return
    }
    // Windowed: the row may not be in the DOM at all, so move the window to it.
    const index = rowIndex.get(activePath)
    if (windowed && index !== undefined) scrollRowIntoView(index)
  }, [activePath, rows, rowIndex, windowed, scrollRowIntoView])

  // A row an inline editor or the keyboard points at must be in the rendered
  // slice; otherwise the editor never mounts and the focus request never lands.
  useEffect(() => {
    if (!windowed || anchorPath === null) return
    const index = anchorPath === '' ? 0 : rowIndex.get(anchorPath)
    if (index !== undefined) scrollRowIntoView(index)
  }, [windowed, anchorPath, rowIndex, scrollRowIntoView])

  // Roving tab index: focus follows the keyboard selection, once the row
  // exists. It can be a render or two away — an async rename creates it, a
  // windowed tree has to scroll to it — so the request is kept until it lands.
  useEffect(() => {
    const wanted = focusWanted.current
    if (!wanted) return
    const element = rowRefs.current.get(wanted)
    if (!element) return
    focusWanted.current = null
    element.focus?.()
  })

  // An alertdialog is only announced when it takes focus, and Escape/Enter can
  // only reach it once it has.
  useEffect(() => {
    if (confirming === null) return
    confirmRef.current?.focus?.()
  }, [confirming])

  // One stable callback per path: a fresh closure every render would make
  // React detach and reattach every row's ref on every keystroke.
  const registerRow = useCallback((path: string) => {
    const cached = rowCallbacks.current.get(path)
    if (cached) return cached
    const callback = (element: HTMLDivElement | null): void => {
      if (element) {
        rowRefs.current.set(path, element)
      } else {
        rowRefs.current.delete(path)
        rowCallbacks.current.delete(path)
      }
    }
    rowCallbacks.current.set(path, callback)
    return callback
  }, [])

  /* -- folder open/closed ------------------------------------------- */

  const setFolderOpen = useCallback((path: string, open: boolean): void => {
    setOpenFolders((prev) => {
      if (prev.has(path) === open) return prev
      const next = new Set(prev)
      if (open) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  /** Toggle one folder, or (Alt) the whole subtree hanging off it. */
  const toggleFolder = useCallback(
    (path: string, deep: boolean): void => {
      setOpenFolders((prev) => {
        const open = !prev.has(path)
        const next = new Set(prev)
        const targets = deep
          ? [path, ...[...folderIndex.keys()].filter((folder) => isInside(folder, path))]
          : [path]
        for (const target of targets) {
          if (open) next.add(target)
          else next.delete(target)
        }
        return next
      })
    },
    [folderIndex],
  )

  const collapseAll = useCallback((): void => setOpenFolders(new Set()), [])

  const focusRow = useCallback((path: string | null): void => {
    setFocused(path)
    if (path) focusWanted.current = path
  }, [])

  /* -- opening ------------------------------------------------------ */

  const openFile = useCallback(
    (node: ExplorerFileNode, newTab: boolean): void => {
      // Attachments have no editor view; selecting one is as far as we go.
      if (!node.isMarkdown) return
      openPath(node.path, newTab ? { newTab: true } : {})
    },
    [openPath],
  )

  const openToTheRight = useCallback(
    (path: NotePath): void => {
      const index = panes.findIndex((pane) => pane.id === activePaneId)
      const right = panes[index + 1]
      if (right) {
        openPath(path, { paneId: right.id, newTab: true })
        return
      }
      // No pane to the right yet — make one. `splitPane` focuses it, so the
      // following `openPath` lands there.
      splitPane()
      openPath(path)
    },
    [panes, activePaneId, openPath, splitPane],
  )

  /* -- rename ------------------------------------------------------- */

  /**
   * Validate a name typed into an inline editor. `selfPath` is the row being
   * renamed (it may keep its own name); `null` when creating something new.
   */
  const validateName = useCallback(
    (raw: string, kind: 'file' | 'folder', parent: string, selfPath: string | null): string | null => {
      // The box shows a note's name without its extension, so one typed in
      // is the same name, not a note called "B.md.md".
      const name = kind === 'file' ? noteStem(raw) : raw.trim()
      if (name === '') return 'Name cannot be empty'
      if (name.includes('/') || name.includes('\\')) return 'Name cannot contain "/"'
      if (name === '.' || name === '..') return 'That name is not allowed'
      if (kind === 'file') {
        const target = joinPath(parent, `${name}.md`).toLowerCase()
        for (const existing of notePaths) {
          if (existing !== selfPath && existing.toLowerCase() === target) return 'A note with that name already exists'
        }
      } else {
        const target = joinPath(parent, name).toLowerCase()
        for (const existing of folderIndex.keys()) {
          if (existing !== selfPath && existing.toLowerCase() === target) {
            return 'A folder with that name already exists'
          }
        }
      }
      return null
    },
    [notePaths, folderIndex],
  )

  const beginRename = useCallback((node: ExplorerNode): void => {
    // Attachments are not part of the note map, so the store cannot rename them.
    if (node.kind === 'file' && !node.isMarkdown) return
    setConfirming(null)
    setCreating(null)
    setRenaming({ path: node.path, kind: node.kind, value: node.name, original: node.name, error: null })
  }, [])

  /** Rename a folder by renaming every note beneath it, one at a time. */
  const renameFolder = useCallback(
    async (from: string, to: string): Promise<void> => {
      const moving = [...notePaths].filter((path) => isInside(path, from)).sort()
      const strandedAttachments = attachments.filter((file) => isInside(file.path, from)).length
      for (const path of moving) {
        await renameNote(path, to + path.slice(from.length))
      }
      setOpenFolders((prev) => remapFolders(prev, from, to))
      setPendingFolders((prev) => [...remapFolders(new Set(prev), from, to)])
      if (strandedAttachments > 0) {
        pushToast(
          `${strandedAttachments} attachment${strandedAttachments === 1 ? '' : 's'} could not be moved`,
          'error',
        )
      }
    },
    [notePaths, attachments, renameNote, pushToast],
  )

  const commitRename = useCallback((): void => {
    if (!renaming) return
    const error = validateName(renaming.value, renaming.kind, dirname(renaming.path), renaming.path)
    if (error) {
      setRenaming({ ...renaming, error })
      return
    }
    const name = renaming.kind === 'file' ? noteStem(renaming.value) : renaming.value.trim()
    setRenaming(null)
    if (name === renaming.original) {
      focusRow(renaming.path)
      return
    }
    const parent = dirname(renaming.path)
    const target = renaming.kind === 'file' ? joinPath(parent, `${name}.md`) : joinPath(parent, name)
    // The renamed row only exists once the store has caught up; the focus
    // request waits for it rather than leaving focus on `document.body`.
    focusRow(target)
    if (renaming.kind === 'file') {
      void renameNote(renaming.path, target)
    } else {
      void renameFolder(renaming.path, target)
    }
  }, [renaming, validateName, renameNote, renameFolder, focusRow])

  /* -- create ------------------------------------------------------- */

  /** `folder` undefined means "wherever the settings say new notes go". */
  const newNoteIn = useCallback(
    async (folder?: string): Promise<void> => {
      const path = folder === undefined ? await createNoteFromTitle('Untitled') : await createNoteFromTitle('Untitled', folder)
      setOpenFolders((prev) => {
        const next = new Set(prev)
        for (const ancestor of ancestorsOf(path)) next.add(ancestor)
        return next
      })
      setFocused(path)
      // Drop straight into rename: nobody wants a vault full of "Untitled".
      setRenaming({ path, kind: 'file', value: basename(path), original: basename(path), error: null })
    },
    [createNoteFromTitle],
  )

  const beginCreateFolder = useCallback(
    (parent: string): void => {
      setRenaming(null)
      setConfirming(null)
      setCreating({ parent, value: '', error: null })
      if (parent !== '') setFolderOpen(parent, true)
    },
    [setFolderOpen],
  )

  const commitCreateFolder = useCallback((): void => {
    if (!creating) return
    const name = creating.value.trim()
    const error = validateName(creating.value, 'folder', creating.parent, null)
    if (error) {
      setCreating({ ...creating, error })
      return
    }
    const path = joinPath(creating.parent, name)
    setCreating(null)
    setPendingFolders((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setFolderOpen(path, true)
    setFocused(path)
  }, [creating, validateName, setFolderOpen])

  /* -- delete ------------------------------------------------------- */

  const confirmDelete = useCallback(
    async (node: ExplorerNode): Promise<void> => {
      setConfirming(null)
      if (node.kind === 'file') {
        await deleteNote(node.path)
        return
      }
      const doomed = [...notePaths].filter((path) => isInside(path, node.path)).sort()
      for (const path of doomed) await deleteNote(path)
      setPendingFolders((prev) => prev.filter((folder) => folder !== node.path && !isInside(folder, node.path)))
      setOpenFolders((prev) => {
        const next = new Set([...prev].filter((folder) => folder !== node.path && !isInside(folder, node.path)))
        return next.size === prev.size ? prev : next
      })
    },
    [deleteNote, notePaths],
  )

  /* -- drag and drop ------------------------------------------------- */

  const canDrop = useCallback(
    (source: string | null, targetFolder: string): boolean => {
      if (!source) return false
      if (source === targetFolder) return false
      // A folder cannot become its own descendant.
      if (folderIndex.has(source) && isInside(targetFolder, source)) return false
      // Already there: nothing to do, so do not offer a drop.
      if (dirname(source) === targetFolder) return false
      return true
    },
    [folderIndex],
  )

  const moveInto = useCallback(
    async (source: string, targetFolder: string): Promise<void> => {
      if (!canDrop(source, targetFolder)) return
      if (folderIndex.has(source)) {
        const name = source.slice(source.lastIndexOf('/') + 1)
        const target = joinPath(targetFolder, name)
        if (folderIndex.has(target)) {
          pushToast(`A folder named ${name} already exists there`, 'error')
          return
        }
        await renameFolder(source, target)
        return
      }
      if (!notePaths.has(source)) {
        pushToast('Attachments cannot be moved', 'error')
        return
      }
      const target = joinPath(targetFolder, `${basename(source)}.md`)
      if (notePaths.has(target)) {
        pushToast(`A note named ${target.slice(target.lastIndexOf('/') + 1)} already exists there`, 'error')
        return
      }
      await renameNote(source, target)
    },
    [canDrop, folderIndex, notePaths, renameNote, renameFolder, pushToast],
  )

  const handleDragEnd = useCallback((): void => {
    setDragPath(null)
    setDropTarget(null)
  }, [])

  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, path: string): void => {
      event.dataTransfer?.setData('text/plain', path)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      setDragPath(path)
      // Scrolling during a drag can unmount the source row in a windowed tree,
      // and a row that is gone never fires `dragend` — the window always does,
      // so the drag styling cannot be left switched on.
      window.addEventListener('dragend', handleDragEnd, { once: true })
    },
    [handleDragEnd],
  )

  /**
   * `bubble: false` is used by every row: a row that refuses the drop must not
   * let the event reach an outer zone, or hovering a file inside a folder would
   * silently offer to move it to the vault root.
   */
  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, folder: string, bubble: boolean): void => {
      if (!bubble) event.stopPropagation()
      if (!canDrop(dragPath, folder)) {
        setDropTarget(null)
        return
      }
      // Only a prevented dragover marks a valid drop zone.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      setDropTarget(folder)
    },
    [canDrop, dragPath],
  )

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>, folder: string, bubble: boolean): void => {
    if (!bubble) event.stopPropagation()
    setDropTarget((current) => (current === folder ? null : current))
  }, [])

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, folder: string): void => {
      event.preventDefault()
      event.stopPropagation()
      const source = dragPath ?? event.dataTransfer?.getData('text/plain') ?? null
      setDropTarget(null)
      setDragPath(null)
      if (source) void moveInto(source, folder)
    },
    [dragPath, moveInto],
  )

  /* -- context menus ------------------------------------------------- */

  const fileMenuItems = useCallback(
    (node: ExplorerFileNode): ContextMenuItem[] => {
      const md = node.isMarkdown
      return [
        { id: 'open', label: 'Open', icon: 'file', disabled: !md, onSelect: () => openFile(node, false) },
        { id: 'open-new-tab', label: 'Open in new tab', icon: 'plus', disabled: !md, onSelect: () => openFile(node, true) },
        { id: 'open-right', label: 'Open to the right', icon: 'split', disabled: !md, onSelect: () => openToTheRight(node.path) },
        { id: 'sep-open', label: '', separator: true },
        { id: 'rename', label: 'Rename', icon: 'edit', disabled: !md, onSelect: () => beginRename(node) },
        { id: 'delete', label: 'Delete', icon: 'trash', danger: true, disabled: !md, onSelect: () => setConfirming(node.path) },
        { id: 'sep-edit', label: '', separator: true },
        {
          id: 'star',
          label: starredSet.has(node.path) ? 'Remove from starred' : 'Star',
          icon: 'star',
          disabled: !md,
          onSelect: () => toggleStar(node.path),
        },
        { id: 'copy-path', label: 'Copy path', icon: 'copy', onSelect: () => void copyText(node.path, 'Copied path', pushToast) },
        {
          id: 'copy-link',
          label: 'Copy wiki link',
          icon: 'link',
          disabled: !md,
          onSelect: () => void copyText(`[[${node.name}]]`, 'Copied wiki link', pushToast),
        },
      ]
    },
    [openFile, openToTheRight, beginRename, starredSet, toggleStar, pushToast],
  )

  const folderMenuItems = useCallback(
    (node: ExplorerFolderNode): ContextMenuItem[] => [
      { id: 'new-note', label: 'New note here', icon: 'plus', onSelect: () => void newNoteIn(node.path) },
      { id: 'new-folder', label: 'New subfolder', icon: 'folder', onSelect: () => beginCreateFolder(node.path) },
      { id: 'sep-new', label: '', separator: true },
      { id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => beginRename(node) },
      { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => setConfirming(node.path) },
    ],
    [newNoteIn, beginCreateFolder, beginRename],
  )

  /* -- keyboard ------------------------------------------------------ */

  const handleTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Inline inputs handle their own keys and stop propagation; this is a
      // belt-and-braces guard for anything that slips through.
      if (renaming || creating) return
      const index = focused === null ? -1 : rowIndex.get(focused) ?? -1
      const row = index === -1 ? undefined : rows[index]
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault()
          const next = rows[index + 1] ?? (index === -1 ? rows[0] : undefined)
          if (next) focusRow(next.node.path)
          break
        }
        case 'ArrowUp': {
          event.preventDefault()
          if (index > 0) focusRow(rows[index - 1]!.node.path)
          break
        }
        case 'Home': {
          event.preventDefault()
          if (rows[0]) focusRow(rows[0].node.path)
          break
        }
        case 'End': {
          event.preventDefault()
          const last = rows[rows.length - 1]
          if (last) focusRow(last.node.path)
          break
        }
        case 'ArrowRight': {
          event.preventDefault()
          if (!row || row.node.kind !== 'folder') break
          if (!openFolders.has(row.node.path)) setFolderOpen(row.node.path, true)
          else if (rows[index + 1] && dirname(rows[index + 1]!.node.path) === row.node.path) {
            focusRow(rows[index + 1]!.node.path)
          }
          break
        }
        case 'ArrowLeft': {
          event.preventDefault()
          if (!row) break
          if (row.node.kind === 'folder' && openFolders.has(row.node.path)) {
            setFolderOpen(row.node.path, false)
            break
          }
          const parent = dirname(row.node.path)
          if (parent !== '') focusRow(parent)
          break
        }
        case 'Enter': {
          event.preventDefault()
          if (!row) break
          if (row.node.kind === 'folder') toggleFolder(row.node.path, event.altKey)
          else openFile(row.node, event.metaKey || event.ctrlKey)
          break
        }
        case 'F2': {
          event.preventDefault()
          if (row) beginRename(row.node)
          break
        }
        case 'Delete':
        case 'Backspace': {
          if (!row) break
          event.preventDefault()
          setConfirming(row.node.path)
          break
        }
        case 'Escape': {
          if (confirming === null) break
          event.preventDefault()
          setConfirming(null)
          break
        }
        default:
          break
      }
    },
    [
      rows,
      rowIndex,
      focused,
      renaming,
      creating,
      confirming,
      openFolders,
      setFolderOpen,
      focusRow,
      toggleFolder,
      openFile,
      beginRename,
    ],
  )

  /* -- inline editors ------------------------------------------------ */

  const renameInput = (): JSX.Element | null => {
    if (!renaming) return null
    return (
      <span className="nav-rename">
        <input
          className="nav-rename-input"
          aria-label="New name"
          aria-invalid={renaming.error !== null}
          value={renaming.value}
          autoFocus
          onChange={(event) => {
            const value = event.target.value
            setRenaming((prev) =>
              prev
                ? { ...prev, value, error: validateName(value, prev.kind, dirname(prev.path), prev.path) }
                : prev,
            )
          }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(null)
              focusRow(renaming.path)
            }
          }}
          // Clicking away abandons the edit rather than committing a
          // half-typed name; Enter is the only way to commit. Focus is left
          // where the click put it, so no `focusRow` here.
          onBlur={() => setRenaming(null)}
        />
        {renaming.error ? (
          <span className="nav-rename-error" role="alert">
            {renaming.error}
          </span>
        ) : null}
      </span>
    )
  }

  const createFolderInput = (depth: number): JSX.Element | null => {
    if (!creating) return null
    return (
      <div className="nav-folder nav-folder-new" style={depthStyle(depth)}>
        <div className="nav-item">
          <Icon name="folder" size={14} />
          <input
            className="nav-rename-input"
            aria-label="New folder name"
            aria-invalid={creating.error !== null}
            value={creating.value}
            autoFocus
            onChange={(event) => {
              const value = event.target.value
              setCreating((prev) =>
                prev
                  ? {
                      ...prev,
                      value,
                      error: validateName(value, 'folder', prev.parent, null),
                    }
                  : prev,
              )
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                commitCreateFolder()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setCreating(null)
              }
            }}
            // Same rule as rename: only Enter creates the folder.
            onBlur={() => setCreating(null)}
          />
        </div>
        {creating.error ? (
          <div className="nav-rename-error" role="alert">
            {creating.error}
          </div>
        ) : null}
      </div>
    )
  }

  const confirmBar = (node: ExplorerNode, depth: number): JSX.Element => {
    const what = `${node.kind === 'folder' ? 'folder ' : ''}${node.name}`
    const cancel = (): void => {
      setConfirming(null)
      focusRow(node.path)
    }
    return (
      <div
        ref={confirmRef}
        className="nav-confirm"
        role="alertdialog"
        aria-label={`Delete ${node.name}?`}
        // Focused when it opens, so it is announced and can be answered from
        // the keyboard; it is never in the tab order itself.
        tabIndex={-1}
        style={depthStyle(depth)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          } else if (event.key === 'Enter' && event.target === event.currentTarget) {
            // A focused button answers Enter itself; only the dialog needs this.
            event.preventDefault()
            void confirmDelete(node)
          }
        }}
      >
        <span className="nav-confirm-text">Delete {what}?</span>
        <button
          type="button"
          className="nav-confirm-yes btn-danger"
          aria-label={`Delete ${what}`}
          onClick={() => void confirmDelete(node)}
        >
          Delete
        </button>
        <button type="button" className="nav-confirm-no btn-ghost" onClick={cancel}>
          Cancel
        </button>
      </div>
    )
  }

  /* -- rows ---------------------------------------------------------- */

  const renderFile = (node: ExplorerFileNode, depth: number, posinset: number, setsize: number): JSX.Element => {
    const isRenaming = renaming?.path === node.path
    const isActive = activePath === node.path
    return (
      <div className={classes('nav-file', isActive && 'is-active')} role="none" key={`file:${node.path}`}>
        <div
          ref={registerRow(node.path)}
          className={classes(
            'nav-item',
            isActive && 'is-active',
            focused === node.path && 'is-focused',
            hoveredPath === node.path && 'is-hovered',
            dirty.has(node.path) && 'is-dirty',
            !node.isMarkdown && 'is-attachment',
            dragPath === node.path && 'is-dragging',
          )}
          role="treeitem"
          aria-level={depth + 1}
          aria-posinset={posinset}
          aria-setsize={setsize}
          aria-selected={focused === node.path}
          aria-current={isActive ? 'true' : undefined}
          tabIndex={tabbablePath === node.path ? 0 : -1}
          data-path={node.path}
          data-kind="file"
          draggable={!isRenaming}
          style={depthStyle(depth)}
          onClick={
            isRenaming
              ? undefined
              : (event: ReactMouseEvent<HTMLDivElement>) => {
                  setFocused(node.path)
                  openFile(node, event.metaKey || event.ctrlKey)
                }
          }
          onAuxClick={
            isRenaming
              ? undefined
              : (event: ReactMouseEvent<HTMLDivElement>) => {
                  // Middle click: the universal "open in a new tab".
                  if (event.button !== 1) return
                  event.preventDefault()
                  setFocused(node.path)
                  openFile(node, true)
                }
          }
          onFocus={() => setFocused(node.path)}
          onContextMenu={(event) => {
            setFocused(node.path)
            openMenu(event, fileMenuItems(node))
          }}
          onMouseEnter={() => setHoveredPath(node.path)}
          onMouseLeave={() => setHoveredPath(null)}
          onDragStart={(event) => handleDragStart(event, node.path)}
          onDragEnd={handleDragEnd}
          // Dropping onto a file means "into the folder that holds it".
          onDragOver={(event) => handleDragOver(event, dirname(node.path), false)}
          onDragLeave={(event) => handleDragLeave(event, dirname(node.path), false)}
          onDrop={(event) => handleDrop(event, dirname(node.path))}
        >
          <Icon name="file" size={14} />
          {isRenaming ? (
            renameInput()
          ) : (
            <span className="nav-file-title">{node.name}</span>
          )}
          {starredSet.has(node.path) ? (
            <span className="nav-file-star" role="img" aria-label="Starred">
              <Icon name="star" size={12} />
            </span>
          ) : null}
          {dirty.has(node.path) ? (
            <span className="nav-file-dirty" role="img" aria-label="Unsaved changes" />
          ) : null}
        </div>
        {confirming === node.path ? confirmBar(node, depth) : null}
      </div>
    )
  }

  const renderFolder = (
    node: ExplorerFolderNode,
    depth: number,
    posinset: number,
    setsize: number,
    nested: boolean,
  ): JSX.Element => {
    const isOpen = openFolders.has(node.path)
    const isRenaming = renaming?.path === node.path
    const isDropTarget = dropTarget === node.path
    return (
      <div
        className={classes('nav-folder', !isOpen && 'is-collapsed', isDropTarget && 'is-drop-target')}
        role="none"
        key={`folder:${node.path}`}
        style={depthStyle(depth)}
      >
        <div
          ref={registerRow(node.path)}
          className={classes(
            'nav-item',
            'nav-folder-row',
            focused === node.path && 'is-focused',
            hoveredPath === node.path && 'is-hovered',
            isDropTarget && 'is-drop-target',
            dragPath === node.path && 'is-dragging',
          )}
          role="treeitem"
          aria-expanded={isOpen}
          aria-level={depth + 1}
          aria-posinset={posinset}
          aria-setsize={setsize}
          aria-selected={focused === node.path}
          tabIndex={tabbablePath === node.path ? 0 : -1}
          data-path={node.path}
          data-kind="folder"
          draggable={!isRenaming}
          style={depthStyle(depth)}
          onClick={
            isRenaming
              ? undefined
              : (event: ReactMouseEvent<HTMLDivElement>) => {
                  setFocused(node.path)
                  // Alt collapses / expands everything underneath in one go.
                  toggleFolder(node.path, event.altKey)
                }
          }
          onFocus={() => setFocused(node.path)}
          onContextMenu={(event) => {
            setFocused(node.path)
            openMenu(event, folderMenuItems(node))
          }}
          onMouseEnter={() => setHoveredPath(node.path)}
          onMouseLeave={() => setHoveredPath(null)}
          onDragStart={(event) => handleDragStart(event, node.path)}
          onDragEnd={handleDragEnd}
          onDragOver={(event) => handleDragOver(event, node.path, false)}
          onDragLeave={(event) => handleDragLeave(event, node.path, false)}
          onDrop={(event) => handleDrop(event, node.path)}
        >
          <span className="nav-folder-collapse" aria-hidden="true">
            <Icon name="chevron-down" size={14} />
          </span>
          <Icon name={isOpen ? 'folder-open' : 'folder'} size={14} />
          {isRenaming ? renameInput() : <span className="nav-folder-title">{node.name}</span>}
        </div>
        {confirming === node.path ? confirmBar(node, depth) : null}
        {nested && isOpen ? (
          <div className="nav-folder-children" role="group" style={depthStyle(depth)}>
            {creating?.parent === node.path ? createFolderInput(depth + 1) : null}
            {node.children.map((child, index) =>
              renderNode(child, depth + 1, index + 1, node.children.length, true),
            )}
          </div>
        ) : null}
      </div>
    )
  }

  const renderNode = (
    node: ExplorerNode,
    depth: number,
    posinset: number,
    setsize: number,
    nested: boolean,
  ): JSX.Element =>
    node.kind === 'folder'
      ? renderFolder(node, depth, posinset, setsize, nested)
      : renderFile(node, depth, posinset, setsize)

  /* -- chrome -------------------------------------------------------- */

  return (
    <div className="file-explorer nav-explorer">
      <div className="sidebar-header">
        <div className="sidebar-title" title={vaultName}>
          {vaultName || 'Vault'}
        </div>
        <div className="sidebar-actions">
          <button type="button" aria-label="New note" title="New note" onClick={() => void newNoteIn()}>
            <Icon name="plus" size={16} />
          </button>
          <button type="button" aria-label="New folder" title="New folder" onClick={() => beginCreateFolder('')}>
            <Icon name="folder" size={16} />
          </button>
          <button type="button" aria-label="Collapse all" title="Collapse all" onClick={collapseAll}>
            <Icon name="chevron-down" size={16} />
          </button>
          <select
            className="nav-sort"
            aria-label="Sort order"
            value={sort}
            onChange={(event) => setSort(event.target.value as ExplorerSort)}
          >
            <option value="name">Name</option>
            <option value="modified">Modified</option>
            <option value="created">Created</option>
          </select>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={classes('sidebar-body', 'nav-files-container', dropTarget === '' && 'is-drop-target')}
        onScroll={windowed ? handleScroll : undefined}
        onDragOver={(event) => handleDragOver(event, '', true)}
        onDragLeave={(event) => handleDragLeave(event, '', true)}
        onDrop={(event) => handleDrop(event, '')}
      >
        {isEmpty && !creating ? (
          <div className="empty-state">
            <p>This vault has no notes yet.</p>
            <button type="button" className="empty-state-action" onClick={() => void newNoteIn()}>
              Create your first note
            </button>
          </div>
        ) : (
          <div
            className="nav-files"
            role="tree"
            aria-label="Vault files"
            aria-multiselectable={false}
            onKeyDown={handleTreeKeyDown}
          >
            {creating?.parent === '' ? createFolderInput(0) : null}
            {windowed ? (
              <>
                {/* Spacers stand in for the rows outside the window so the
                    scrollbar still measures the whole vault. */}
                <div className="nav-window-spacer" style={{ height: start * rowHeight }} aria-hidden="true" />
                {visibleRows.map((row) => {
                  const element = renderNode(row.node, row.depth, row.posinset, row.setsize, false)
                  if (!creating || creating.parent !== row.node.path) return element
                  return (
                    <Fragment key={`new-folder:${row.node.path}`}>
                      {element}
                      {createFolderInput(row.depth + 1)}
                    </Fragment>
                  )
                })}
                <div
                  className="nav-window-spacer"
                  style={{ height: (rows.length - end) * rowHeight }}
                  aria-hidden="true"
                />
              </>
            ) : (
              tree.children.map((child, index) =>
                renderNode(child, 0, index + 1, tree.children.length, true),
              )
            )}
          </div>
        )}
      </div>

      <ContextMenu menu={menu} onClose={closeMenu} label="File menu" />
    </div>
  )
}

/** Clipboard writes are best-effort: the API is absent in jsdom and insecure contexts. */
async function copyText(
  text: string,
  message: string,
  pushToast: (message: string, kind?: 'info' | 'error' | 'success') => void,
): Promise<void> {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text)
      pushToast(message, 'success')
      return
    }
  } catch {
    /* permission denied — reported below */
  }
  pushToast('Clipboard is not available', 'error')
}

export default FileExplorer
