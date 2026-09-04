# SpaceLink — module contracts

`src/types.ts` holds the domain types. `src/state/store.ts` holds all mutable
state. Everything below is the **exact** public surface each module must export.
Signatures are binding: the store and the UI already import them by name.

Project rules that apply to every file:

- TypeScript `strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`.
  Type-only imports **must** be written `import type { X } from '...'`.
- No default exports except React components.
- Relative imports only, with no file extension (e.g. `import { parseNote } from '../markdown/parse'`).
- No new npm dependencies. Available: react, react-dom, zustand, markdown-it,
  dompurify, katex, and the `@codemirror/*` + `@lezer/highlight` packages.
- Browser-only APIs must be feature-detected — the test env is jsdom.
- Every module ships colocated `*.test.ts` files (vitest, `describe`/`it`/`expect` are globals).

---

## `src/core/markdown/parse.ts`

```ts
export function parseNote(source: string, fileName: string): ParsedNote
export function parseFrontmatter(source: string): {
  frontmatter: NoteFrontmatter
  raw: string
  body: string
  bodyOffset: number
}
export function extractWikiLinks(body: string, bodyOffset: number): WikiLink[]
export function extractMarkdownLinks(body: string, bodyOffset: number): MarkdownLink[]
export function extractTags(body: string, bodyOffset: number): TagRef[]
export function extractHeadings(body: string, bodyOffset: number): HeadingRef[]
export function extractTasks(body: string, bodyOffset: number): TaskRef[]
export function slugifyHeading(text: string): string
/** The `id` the renderer puts on the heading with `slug` (prefixed: `h-<slug>`), and its inverse. */
export function headingElementId(slug: string): string
export function slugOfHeadingId(id: string): string
/** Strip markdown syntax down to readable prose (used for excerpts + search context). */
export function toPlainText(markdown: string): string
```

Notes:
- `bodyOffset` is added to every offset so the returned offsets index the
  **original source**, frontmatter included.
- Offsets returned by the extractors must be usable as `source.slice(start, end) === raw`.
- Links, tags and headings inside fenced code blocks (``` / ~~~), inline code
  spans and HTML comments must be **ignored**.
- `#tag` must not match `#` used for headings, `#` inside a URL fragment, or a
  bare `#`. Tags may contain `/`, `-`, `_` and unicode letters; a tag that is
  all digits (`#1`) is not a tag.
- Frontmatter is a minimal YAML subset: `key: value`, `key: [a, b]`,
  block lists (`key:` then `  - item`), quoted strings, booleans, numbers,
  and nested one level. Never `eval`. Malformed YAML must not throw.
- `parseFrontmatter` only treats `---` as an opening fence when it is the very
  first line of the file.

## `src/core/markdown/render.ts`

```ts
export interface RenderContext {
  currentPath: NotePath
  /** Resolve `[[target]]` to a vault path, or null when the note does not exist. */
  resolveLink(target: string, fromPath: NotePath): NotePath | null
  /** Resolve an embedded image/attachment to a URL usable in `<img src>`. */
  resolveAsset?(target: string, fromPath: NotePath): string | null
  /** Raw markdown of an embedded note for `![[Note]]` transclusion. */
  getEmbedContent?(path: NotePath): string | null
  /** Recursion guard used internally by embeds. */
  depth?: number
}

/** Returns sanitized HTML. Never returns untrusted markup. */
export function renderMarkdown(source: string, ctx: RenderContext): string
/** Rendered HTML for a heading-anchored table of contents. */
export function renderInline(source: string): string
```

Requirements:
- Built on `markdown-it` with `html: true, linkify: true, typographer: false`,
  then sanitized through `dompurify`. Sanitization is mandatory.
- Wiki links render as
  `<a class="internal-link" data-href="TARGET" href="#">DISPLAY</a>`, and get an
  extra class `is-unresolved` when `resolveLink` returns null. Click handling
  lives in the UI, so `href` stays `#`.
- Tags render as `<a class="tag" data-tag="NAME" href="#">#NAME</a>`.
- `![[image.png]]` renders an `<img>` via `resolveAsset`; `![[Note]]` renders
  `<div class="embed"><div class="embed-title">…</div><div class="embed-body">…</div></div>`
  with the embedded note rendered recursively, max depth 3, cycles broken.
- Task list items render as `<li class="task-item"><input type="checkbox" disabled … data-line="N">`.
- `$inline$` and `$$block$$` math render with KaTeX (`throwOnError: false`);
  a KaTeX failure must degrade to the raw text, never throw.
- Fenced code blocks render `<pre class="code-block" data-lang="LANG"><code>…</code></pre>`.
  No syntax-highlighting dependency — just escape.
- Frontmatter is rendered as a small `<div class="frontmatter">` property table,
  not as body text — unless `ctx.showProperties` is `false`, which the preview
  passes because the page header above it shows the same properties and lets
  them be edited.
- A callout written with a fold marker (`> [!note]-` or `> [!note]+`) renders as
  `<details class="callout">` with the title as its `<summary>`; `+` carries
  `open`. Without a marker it stays a `<div>`, and nothing folds.
- External links get `target="_blank" rel="noopener noreferrer"` and class `external-link`.

## `src/core/markdown/frontmatter.ts`

```ts
export function withFrontmatter(source: string, properties: Readonly<Record<string, unknown>>): string
export function setProperty(source: string, key: string, value: PropertyValue | undefined): string
export function renameProperty(source: string, from: string, to: string): string
export function serializeFrontmatter(properties: Readonly<Record<string, unknown>>): string
export function readProperties(source: string): NoteFrontmatter
```

- **The body is preserved byte for byte.** Everything below the closing `---` is
  sliced out and put back untouched. This is the one guarantee that matters:
  editing a property can never disturb a character of what was written.
- The block itself is rewritten from the values given, so comments and
  hand-formatting inside it do not survive an edit.
- A value is quoted whenever it would not read back as itself — empty, padded,
  numeric-looking, boolean-looking, or holding `:`/`#`. Over-quoting is free;
  under-quoting silently changes a value.
- A key that could not round-trip (empty, or holding whitespace, `:` or `#`) is
  not written at all, and neither is a non-finite number.
- Key order is the order of the object given. `setProperty` keeps a property
  where it was and puts a new one last; `renameProperty` keeps its place.
- No properties left means no block, and no blank line where it was.

## `src/core/table/folderTable.ts`

```ts
export function buildFolderTable(notes: ReadonlyMap<NotePath, Note>, folder: string): FolderTable
export function sortRows(rows: readonly TableRow[], key: string | null, direction: SortDirection): TableRow[]
export function filterRows(rows: readonly TableRow[], query: string): TableRow[]
export function compareCells(a: unknown, b: unknown): number
```

- A folder's table includes its **subfolders**. A project with `Tasks/2024/`
  under it is still the project.
- Columns are every frontmatter key the folder's notes use, minus `icon` and
  `cover` (the page header draws those), ordered by how many notes use them and
  then alphabetically.
- `inFolder` matches on a `/` boundary: `ProjectsOld/` is not inside
  `Projects/`.
- Numbers compare as numbers — `10` after `9` — and everything else as text,
  case-insensitively.
- An **empty cell sorts last in both directions**. Sorting by a column is how
  somebody asks to see what is in it.
- Ties break by name, so the same sort twice looks the same.
- Filtering is a case-insensitive **substring**, not the fuzzy match the quick
  switcher uses: in a list somebody can already see, "dr" quietly matching
  "Dashboard" is noise.

## `src/core/graph/index.ts`

```ts
export function emptyIndex(): VaultIndex
export function buildIndex(notes: Map<NotePath, Note>): VaultIndex
/** Obsidian-style resolution: exact path, then path+`.md`, then basename, then alias. Case-insensitive. */
export function resolveLinkTarget(target: string, fromPath: NotePath, index: VaultIndex): NotePath | null
export function getBacklinks(path: NotePath, index: VaultIndex, notes: Map<NotePath, Note>): BacklinkGroup[]
export function getUnresolvedLinks(index: VaultIndex): { target: string; count: number }[]
export function getOrphans(notes: Map<NotePath, Note>, index: VaultIndex): NotePath[]
export function getTagTree(index: VaultIndex): TagTreeNode[]

export interface TagTreeNode {
  name: string       // leaf segment
  fullTag: string    // "project/alpha"
  count: number      // notes carrying this exact tag
  totalCount: number // including descendants
  children: TagTreeNode[]
}

export interface GraphOptions {
  showUnresolved: boolean
  showTags: boolean
  /** Restrict to a note and everything within N hops; null = whole vault. */
  focus?: { path: NotePath; depth: number } | null
}
export function buildGraphData(notes: Map<NotePath, Note>, index: VaultIndex, options: GraphOptions): GraphData
```

Notes:
- `buildIndex` must run over a 5,000-note vault without pathological cost:
  build `byName` once, then resolve. No nested scans over all notes per link.
- `byName` maps lowercased basename **and** every frontmatter alias to paths.
- Backlink `context` is the trimmed source line the link sits on.
- Graph nodes start at deterministic positions (a golden-angle spiral around the
  origin) — no `Math.random()`, so the layout is reproducible in tests.
- `radius` scales with degree: `4 + Math.min(10, Math.sqrt(degree) * 3)`.
- Tag nodes (when `showTags`) use id `#tagname` and `unresolved: false`.

## `src/core/graph/layout.ts`

```ts
export interface ForceLayoutOptions {
  linkDistance: number
  charge: number
  centerStrength: number
  width: number
  height: number
}

export class ForceLayout {
  constructor(data: GraphData, options: ForceLayoutOptions)
  readonly data: GraphData
  get alpha(): number
  setData(data: GraphData): void
  setOptions(patch: Partial<ForceLayoutOptions>): void
  /** Advance the simulation. Returns the new alpha. */
  tick(steps?: number): number
  reheat(alpha?: number): void
  nodeAt(x: number, y: number, tolerance?: number): GraphNode | null
  pin(id: NotePath, x: number, y: number): void
  unpin(id: NotePath): void
  /** Bounding box of all nodes, for fit-to-view. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number }
}
```

Notes:
- Plain Verlet/velocity integration: repulsion (Barnes–Hut not required, but
  cap cost with a simple grid when `nodes.length > 400`), spring attraction on
  edges, weak centering, velocity damping 0.85, alpha decay toward 0.
- `setData` preserves x/y/vx/vy for nodes that already existed (stable layout
  across re-index).
- Deterministic: no `Math.random()`.

## `src/core/search/fuzzy.ts`

```ts
/** Subsequence match with bonuses for word starts, camelCase and consecutive runs. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null
/** Wrap the matched ranges in `<mark>`, escaping everything else. */
export function highlight(text: string, ranges: MatchRange[]): string
```

## `src/core/search/engine.ts`

```ts
export interface SearchFilters {
  terms: string[]
  phrases: string[]
  excluded: string[]
  tags: string[]
  paths: string[]
  files: string[]
  regex: RegExp | null
  /** Every `/pattern/` in the query, all required; `regex` is the first of them. */
  regexes: RegExp[]
}
/** Parse `tag:x path:y file:z "exact phrase" -excluded /re/` into filters. */
export function parseQuery(query: string): SearchFilters

export interface SearchOptions {
  limit?: number
  maxMatchesPerNote?: number
  caseSensitive?: boolean
}
export function searchNotes(query: string, notes: Map<NotePath, Note>, options?: SearchOptions): SearchHit[]
export function quickSwitch(query: string, notes: Map<NotePath, Note>, limit?: number): QuickSwitchItem[]
```

Notes:
- `searchNotes('')` returns `[]`.
- Ranking: title hit > heading hit > body hit; more matches ranks higher; ties
  break on shorter path.
- `quickSwitch` fuzzy-matches basename first, then the full path, and when
  nothing matches returns a single `create: true` item for the query.
- Regex queries that fail to compile must be treated as literal text, not throw.

## `src/core/vault/idb.ts`

```ts
export function idbAvailable(): boolean
export function openDB(name?: string): Promise<IDBDatabase>
export function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined>
export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]>
export function idbSet(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void>
export function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void>
export function idbClear(db: IDBDatabase, store: string): Promise<void>
```
Object stores: `files` (key = path) and `meta`. Version 1.

## `src/core/vault/memoryVault.ts`

```ts
export interface MemoryVaultOptions { name?: string; writable?: boolean }
export function createMemoryVault(seed: Record<NotePath, string>, options?: MemoryVaultOptions): VaultAdapter
```
`kind: 'demo'`. Fully synchronous under the hood, promises resolved immediately.

## `src/core/vault/browserVault.ts`

```ts
/** IndexedDB-backed vault that survives reloads. Falls back to memory when IDB is unavailable. */
export function createBrowserVault(name?: string): Promise<VaultAdapter>
/** True when this browser session already has a persisted vault with content. */
export function hasStoredVault(name?: string): Promise<boolean>
export function seedVault(adapter: VaultAdapter, files: Record<NotePath, string>): Promise<void>
```
`kind: 'browser'`.

## `src/core/vault/directoryVault.ts`

```ts
export function isDirectoryVaultSupported(): boolean
/** Show the directory picker; resolves null when the user cancels. */
export function pickDirectoryVault(): Promise<VaultAdapter | null>
export function createDirectoryVault(handle: FileSystemDirectoryHandle, name?: string): VaultAdapter
/** Remember / restore the picked directory across reloads (handle stored in IDB). */
export function rememberVaultHandle(handle: FileSystemDirectoryHandle): Promise<void>
export function restoreVaultHandle(): Promise<FileSystemDirectoryHandle | null>
export function forgetVaultHandle(): Promise<void>
```
`kind: 'directory'`. Recursively walks the directory, skipping dot-directories
and `node_modules`. Types for the File System Access API go in
`src/core/vault/fsaccess.d.ts` if the DOM lib lacks them.

## `src/core/vault/demoVault.ts`

```ts
export const DEMO_NOTES: Record<NotePath, string>
export function createDemoVault(): VaultAdapter
```

## `src/core/vault/remoteVault.ts`

```ts
export interface RemoteVaultOptions {
  url: string
  token: string
  name?: string
  /** Set when `token` came from signing in, so a refusal can say the right thing. */
  email?: string
}
/** Which of the two credentials a call is carrying. */
export type Credential = 'token' | 'account'

export function deviceId(): string
export function normalizeServerUrl(input: string): string
export function describeDevice(agent?: string): string
export function probeServer(
  url: string,
  token: string,
  credential?: Credential,
): Promise<{ ok: true; name: string } | { ok: false; error: string }>
export function signIn(
  url: string,
  email: string,
  password: string,
): Promise<{ ok: true; token: string; email: string; name: string } | { ok: false; error: string }>
export function signOut(url: string, token: string): Promise<void>
export class RemoteConflict extends Error { readonly conflictPath: NotePath }
export function createRemoteVault(options: RemoteVaultOptions): Promise<VaultAdapter>
```
`kind: 'remote'`. Every write is conditional on the hash the device believed it
was editing; a refusal becomes a conflict copy rather than an overwrite.

Two credentials reach the same API and are not interchangeable in what they
*mean*: an access token is the server's, a session belongs to one account and
opens only that account's folder. `signIn` exchanges a password for a session
and is the only place a password is ever sent — it is never stored, and only the
session it returns is. `signOut` ends that one session on the server, which is
what a borrowed device needs: forgetting the token locally would leave it valid
for its full 30 days. `probeServer` and the adapter's own 401 handling take the
`Credential` so the message names the right fix: a rotated token is copied
again, an expired sign-in needs the password.

## `src/core/vault/remoteConnection.ts`

```ts
export interface RemoteConnection {
  url: string
  token: string
  name?: string
  /** The account this device signed in as; absent when it was paired with a token. */
  email?: string
}
export const REMOTE_KEY = 'spacelink.remote'

export function loadRemoteConnection(): RemoteConnection | null
export function saveRemoteConnection(connection: RemoteConnection): void
export function forgetRemoteConnection(): void
export function isLoopbackOrigin(origin: string): boolean
/** A `#token=…` handed to this page by whatever launched it, consumed on read. */
export function takeHandoffConnection(location: Location, history: History): RemoteConnection | null
```
Kept in `localStorage` so a device reconnects by itself. Only a session token or
an access token is ever written there — never a password. A handoff is accepted
only from a loopback origin, and the fragment is cleared whether or not it is
used.

## UI components

Every component reads state via `useAppStore` and calls store actions. Props are
listed per component in the task description. All components are named exports
plus a default export of the same component.

Styling: classes only, no inline style objects except for computed geometry
(pane widths, canvas transforms). All colors come from the CSS variables defined
in `src/styles/theme.css` — never hardcode a hex value in a component.

---

## UI component surface (binding)

`src/App.tsx` composes these. Signatures are fixed; add optional props only.

```ts
// src/ui/Editor.tsx
export function Editor(props: { path: NotePath; paneId: string }): JSX.Element

// src/ui/Preview.tsx
export function Preview(props: { path: NotePath; paneId: string; scrollSync?: boolean }): JSX.Element

// src/ui/GraphView.tsx
export function GraphView(props: { focusPath?: NotePath | null; local?: boolean; compact?: boolean }): JSX.Element

// src/ui/FileExplorer.tsx
export function FileExplorer(): JSX.Element

// src/ui/SearchPanel.tsx
export function SearchPanel(props: { variant?: 'sidebar' | 'tab' }): JSX.Element

// src/ui/TagPanel.tsx
export function TagPanel(): JSX.Element

// src/ui/StarredPanel.tsx
export function StarredPanel(): JSX.Element

// src/ui/BacklinksPanel.tsx
export function BacklinksPanel(props: { path: NotePath }): JSX.Element

// src/ui/OutlinePanel.tsx
export function OutlinePanel(props: { path: NotePath }): JSX.Element

// src/ui/CommandPalette.tsx
export function CommandPalette(): JSX.Element | null

// src/ui/commands.ts
export function useCommands(): Command[]

// src/ui/useHotkeys.ts
export function useHotkeys(commands: Command[]): void

// src/ui/Workspace.tsx  — renders panes, tab bars and routes each tab to Editor/Preview/GraphView/SearchPanel
export function Workspace(): JSX.Element

// src/ui/TabBar.tsx
export function TabBar(props: { pane: Pane }): JSX.Element

// src/ui/Ribbon.tsx    — the far-left icon rail
export function Ribbon(props: { onOpenSettings: () => void }): JSX.Element

// src/ui/StatusBar.tsx
export function StatusBar(): JSX.Element

// src/ui/Toasts.tsx
export function Toasts(): JSX.Element

// src/ui/SettingsModal.tsx
export function SettingsModal(props: { open: boolean; onClose: () => void }): JSX.Element | null

// src/ui/VaultPicker.tsx — first-run screen: demo vault / browser vault / open a folder
export function VaultPicker(props: { onReady?: () => void }): JSX.Element

// src/ui/Icon.tsx — shared inline SVG icon set
export type IconName =
  | 'files' | 'search' | 'tag' | 'star' | 'graph' | 'settings' | 'menu'
  | 'chevron-right' | 'chevron-down' | 'close' | 'plus' | 'folder' | 'folder-open'
  | 'file' | 'edit' | 'eye' | 'columns' | 'split' | 'trash' | 'link' | 'pin'
  | 'sun' | 'moon' | 'calendar' | 'more' | 'arrow-left' | 'arrow-right' | 'check' | 'copy'
export function Icon(props: { name: IconName; size?: number; className?: string }): JSX.Element
```

`src/ui/Icon.tsx` is owned by the theme/design task and imported by everyone
else — do not redefine icons locally.

---

## Window event contract

Components that must talk across the tree do it with `CustomEvent`s on `window`
rather than by threading props through the workspace. Both sides are binding.

| Event | `detail` | Emitted by | Handled by |
| --- | --- | --- | --- |
| `spacelink:reveal-line` | `{ path: NotePath; line: number }` (0-based) | SearchPanel result rows, BacklinksPanel context lines | **Editor** — if its `path` matches, scroll the line into view and put the cursor on it. **Preview** — scroll to the rendered block carrying that line. |
| `spacelink:reveal-heading` | `{ path: NotePath; slug: string; line: number }` | OutlinePanel | **Editor** — scroll to `line`. **Preview** — scroll the heading whose id is `headingElementId(slug)` into view. |
| `spacelink:editor-scroll` | `{ paneId: string; ratio: number }` (0–1) | Editor, on scroll | **Preview** in the same pane, when `scrollSync` is on. |
| `spacelink:preview-scroll` | `{ path: NotePath; slug: string }` | Preview, as a heading crosses the top of the viewport | **OutlinePanel** — highlights the current heading. |
| `spacelink:open-vault-picker` | — | StatusBar, SettingsModal, commands | **App** |
| `spacelink:open-settings` | — | commands | **App** |

Rules: emit with `window.dispatchEvent(new CustomEvent(name, { detail }))`;
every listener must ignore events for a different `path`/`paneId`, and must be
removed on unmount. A seam with no listener is a bug, not a placeholder.
