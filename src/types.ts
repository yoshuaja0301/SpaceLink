/**
 * SpaceFore — core domain contracts.
 *
 * Every module in `src/core`, `src/state` and `src/ui` is written against the
 * types in this file. Treat it as the single source of truth: if a shape needs
 * to change, change it here first.
 */

/** POSIX-style path relative to the vault root. No leading slash. e.g. `notes/Zettelkasten.md` */
export type NotePath = string

/** A file discovered in the vault (markdown or attachment). */
export interface VaultFile {
  path: NotePath
  /** Basename without the `.md` extension for notes, with extension for attachments. */
  name: string
  /** Lowercase extension without the dot. Empty string for extensionless files. */
  extension: string
  isMarkdown: boolean
  size: number
  /** Epoch milliseconds. */
  mtime: number
}

export interface NoteFrontmatter {
  title?: string
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown
}

/** `[[Target#Heading|Alias]]` or `![[Target]]` (embed). */
export interface WikiLink {
  /** The full raw match, including brackets. */
  raw: string
  /** Link target as written, trimmed. May be empty for `[[#Heading]]` (same-note link). */
  target: string
  /** Heading fragment after `#`, if any. */
  heading?: string
  /** Block reference after `^`, if any. */
  blockId?: string
  /** Display text after `|`, if any. */
  alias?: string
  /** True when the link was written as `![[...]]`. */
  embed: boolean
  /** Character offset of `raw` within the note source. */
  start: number
  /** Exclusive end offset. */
  end: number
  /** 1-based line number in the note source. */
  line: number
}

/** A standard markdown link `[text](url)`. */
export interface MarkdownLink {
  raw: string
  text: string
  url: string
  /** True when the url points inside the vault rather than at http(s)/mailto. */
  internal: boolean
  start: number
  end: number
  line: number
}

/** An inline `#tag` occurrence. `tag` excludes the leading `#`. */
export interface TagRef {
  tag: string
  start: number
  end: number
  line: number
}

export interface HeadingRef {
  level: number
  text: string
  /** URL-safe slug used for `#heading` anchors. */
  slug: string
  start: number
  line: number
}

export interface TaskRef {
  checked: boolean
  text: string
  line: number
  /** Character offset of the `[ ]` / `[x]` marker itself. */
  start: number
}

/** Everything derived from a note's raw text by the markdown layer. */
export interface ParsedNote {
  frontmatter: NoteFrontmatter
  /** Raw YAML between the `---` fences, without the fences. Empty when absent. */
  frontmatterRaw: string
  /** Note text with the frontmatter block removed. */
  body: string
  /** Character offset at which `body` starts inside the original source. */
  bodyOffset: number
  links: WikiLink[]
  markdownLinks: MarkdownLink[]
  /** Inline `#tags` only; frontmatter tags live in `frontmatter.tags`. */
  tags: TagRef[]
  /** Inline tags plus frontmatter tags, deduped, without `#`. */
  allTags: string[]
  headings: HeadingRef[]
  tasks: TaskRef[]
  /** frontmatter.title -> first H1 -> file basename. */
  title: string
  /** First ~200 chars of prose, for previews. */
  excerpt: string
  wordCount: number
}

/** A markdown note held in memory. */
export interface Note {
  path: NotePath
  /** Basename without `.md`. */
  name: string
  content: string
  mtime: number
  parsed: ParsedNote
}

/* ------------------------------------------------------------------ *
 * Link graph
 * ------------------------------------------------------------------ */

export interface LinkEdge {
  from: NotePath
  /** Resolved target, or `null` when the link points at a note that does not exist yet. */
  to: NotePath | null
  /** The target exactly as written in the source. */
  targetText: string
  embed: boolean
  /** The source line the link appears on, for backlink context. */
  context: string
  line: number
}

export interface BacklinkGroup {
  source: NotePath
  title: string
  edges: LinkEdge[]
}

/** The whole-vault link index, rebuilt whenever notes change. */
export interface VaultIndex {
  /** path -> links leaving that note. */
  outgoing: Map<NotePath, LinkEdge[]>
  /** path -> links arriving at that note. */
  incoming: Map<NotePath, LinkEdge[]>
  /** lowercased link text -> edges pointing at a note that does not exist. */
  unresolved: Map<string, LinkEdge[]>
  /** tag (without `#`) -> notes carrying it. */
  tags: Map<string, NotePath[]>
  /** lowercased basename or alias -> candidate paths (for link resolution). */
  byName: Map<string, NotePath[]>
}

export interface GraphNode {
  id: NotePath
  label: string
  /** Number of edges touching the node. */
  degree: number
  /** True for placeholder nodes created from unresolved links. */
  unresolved: boolean
  tags: string[]
  x: number
  y: number
  vx: number
  vy: number
  /** Rendered radius in canvas units. */
  radius: number
}

export interface GraphEdge {
  source: NotePath
  target: NotePath
  count: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/* ------------------------------------------------------------------ *
 * Vault storage
 * ------------------------------------------------------------------ */

export type VaultKind = 'demo' | 'browser' | 'directory'

/**
 * Storage backend for a vault. Implementations must be safe to call
 * concurrently and must normalise paths to POSIX form.
 */
export interface VaultAdapter {
  readonly kind: VaultKind
  /** Human readable vault name, shown in the UI. */
  readonly name: string
  /** False for read-only backends. */
  readonly writable: boolean
  list(): Promise<VaultFile[]>
  read(path: NotePath): Promise<string>
  readBinary(path: NotePath): Promise<Blob>
  write(path: NotePath, content: string): Promise<void>
  writeBinary(path: NotePath, data: Blob): Promise<void>
  remove(path: NotePath): Promise<void>
  rename(from: NotePath, to: NotePath): Promise<void>
  exists(path: NotePath): Promise<boolean>
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/** Inclusive-start / exclusive-end character ranges to highlight. */
export type MatchRange = [number, number]

export interface SearchLineMatch {
  line: number
  text: string
  ranges: MatchRange[]
}

export interface SearchHit {
  path: NotePath
  title: string
  score: number
  matches: SearchLineMatch[]
  /** Total number of matches in the note (may exceed `matches.length`). */
  total: number
}

export interface FuzzyMatch {
  score: number
  ranges: MatchRange[]
}

export interface QuickSwitchItem {
  path: NotePath
  title: string
  /** Path shown under the title. */
  subtitle: string
  score: number
  ranges: MatchRange[]
  /** True when the note does not exist yet and would be created. */
  create?: boolean
}

/* ------------------------------------------------------------------ *
 * Workspace
 * ------------------------------------------------------------------ */

export type ViewMode = 'edit' | 'preview' | 'split'

export type TabKind = 'note' | 'graph' | 'search'

export interface Tab {
  id: string
  kind: TabKind
  /** Set for `kind === 'note'`. */
  path: NotePath | null
  mode: ViewMode
  /** Pinned tabs are not reused when opening a different note. */
  pinned: boolean
}

export interface Pane {
  id: string
  tabs: Tab[]
  activeTabId: string | null
}

export type ThemeName = 'dark' | 'light' | 'system'

export type SidebarPanel = 'files' | 'search' | 'tags' | 'starred' | null

export interface Command {
  id: string
  title: string
  /** Group label shown in the palette, e.g. "Editor". */
  section: string
  /** Human readable shortcut, e.g. "Ctrl+P". */
  shortcut?: string
  /** Return false to hide the command in the current context. */
  enabled?: () => boolean
  run: () => void | Promise<void>
}

export interface Settings {
  theme: ThemeName
  /** Base font size for the editor, in px. */
  fontSize: number
  /** Editor font family override; empty string = theme default. */
  editorFont: string
  showLineNumbers: boolean
  /** Fold the note as you type by hiding markdown syntax around the cursor. */
  liveSyntaxHiding: boolean
  spellcheck: boolean
  readableLineLength: boolean
  /** Folder new notes land in. Empty string = vault root. */
  newNoteFolder: string
  /** Folder for daily notes. */
  dailyNoteFolder: string
  /** `YYYY-MM-DD` style tokens. */
  dailyNoteFormat: string
  /** Autosave debounce in ms. */
  autosaveDelay: number
  graphShowUnresolved: boolean
  graphShowTags: boolean
  graphLinkDistance: number
  graphChargeStrength: number
}

/**
 * A question the app needs answered before it can continue — a rename, or a
 * confirmation before something destructive. Native `prompt`/`confirm` are not
 * an option: they are blocked outright in sandboxed frames, so the action would
 * silently do nothing.
 */
export interface AppDialog {
  kind: 'prompt' | 'confirm'
  title: string
  /** Supporting line under the title. */
  message?: string
  /** Starting value for a `prompt`. */
  initial?: string
  /** Visible label for a `prompt`'s field. Defaults to "Name". */
  inputLabel?: string
  /** Label for the affirmative button. Defaults to "OK". */
  confirmLabel?: string
  /** Style the affirmative button as destructive. */
  danger?: boolean
  /** Rejects nothing — resolves with the answer, or null/false when dismissed. */
  resolve: (answer: string | boolean | null) => void
}

export interface Toast {
  id: string
  message: string
  kind: 'info' | 'error' | 'success'
}
