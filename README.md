# SpaceFore

A local-first, plain-text knowledge base in the browser — in the spirit of
[Obsidian](https://obsidian.md). Your notes are ordinary Markdown files in a
folder you control; SpaceFore adds the connective tissue: `[[wiki-links]]`,
backlinks, a live graph of your vault, instant search and a command palette.

No account, no server, no telemetry. Everything runs in the tab.

## Features

**Writing**
- CodeMirror 6 Markdown editor with live syntax styling and syntax hiding as
  you type — the markers reveal themselves when the cursor enters them
- Edit / split / preview modes per tab, with synchronised scrolling in split
- `[[` autocomplete over note names and aliases, `#` autocomplete over tags
- Formatting commands (bold, italic, code, highlight, callouts, tables, task
  checkboxes, heading cycling, line move/duplicate) on standard shortcuts

**Linking**
- `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]` and
  `![[Note]]` transclusion
- Backlinks panel with source context, plus **unlinked mentions** you can
  convert into real links with one click
- Renaming a note rewrites every link that pointed at it
- Clicking an unresolved link creates the note

**Seeing the whole vault**
- Force-directed graph view — pan, zoom, drag, pin, focus on a local
  neighbourhood at any depth, with unresolved links and tags as optional nodes
- Outline panel, note info panel (word count, reading time, link counts,
  frontmatter properties)
- Tag tree with nested tags and counts

**Finding things**
- Full-text search with operators: `tag:`, `path:`, `file:`, `"exact phrase"`,
  `-excluded`, `/regex/`
- `Ctrl+P` quick switcher with fuzzy matching, `Ctrl+Shift+P` command palette,
  `Ctrl+Shift+O` go-to-heading

**Your vault, your files**
- **Open a folder** — reads and writes real `.md` files on disk through the
  File System Access API (Chrome, Edge, Opera)
- **Browser vault** — persisted in IndexedDB, survives reloads, works anywhere
- **Sync server** — run one machine as the host and every device you own reads
  and writes the same folder, live. See [docs/SERVER.md](docs/SERVER.md)
- **Demo vault** — a ready-made 20-note knowledge base that doubles as the
  product tour
- Export the vault as JSON, export a note as Markdown, import from JSON

## Installing it

Two ways, depending on whether you want a Mac application or a browser one.

### As a Mac app

```bash
open macos/SpaceFore.xcodeproj      # then ⌘R
```

...or without opening Xcode at all:

```bash
./macos/build.sh --install
open /Applications/SpaceFore.app
```

A real `SpaceFore.app`: double-click it, choose your notes folder, done. It
starts its own server and shuts it down when you quit; there is no terminal to
keep open. Needs Xcode's command line tools (`xcode-select --install`) and Node.

The Swift for it has never been compiled — it was written without a Mac — so
[macos/README.md](macos/README.md) sets out exactly what was verified and what
was not before you build it.

### As a web app

There is no installer to download. SpaceFore is built from source in about
fifteen seconds, and then installs itself from the browser — it is a progressive
web app, so the "install" is your browser's, not a package manager's.

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else.

```bash
git clone <this repository> spacefore
cd spacefore
npm install
npm start -- --vault ~/Notes
```

`npm start` builds the app and serves it, printing the address to open and the
access token your other devices will need. Open that address, and install it:

- **macOS / Windows / Linux** — Chrome or Edge, the install icon in the address
  bar, or menu → *Cast, save and share* → *Install page as app*
- **iPhone / iPad** — Safari, Share, *Add to Home Screen*
- **Android** — Chrome, menu, *Install app*

Installed, it opens in its own window, keeps working with the network down, and
remembers which vault it was on.

The vault folder is created if it is not there. Point it at notes you already
have and it reads every `.md` file in the folder — nothing is converted, moved
or rewritten on the way in. If you would rather prove that to yourself first,
[docs/SERVER.md](docs/SERVER.md#try-it-on-a-copy-first) walks through doing it
on a copy.

> **To install on another device**, the server needs HTTPS — browsers only
> treat a page as an app over `https://` or `http://localhost`. Over plain HTTP
> on your Wi-Fi the app still works and still syncs; it just cannot be
> installed. [docs/SERVER.md](docs/SERVER.md#reaching-it-from-anywhere) sets up
> HTTPS with Tailscale in three commands.

### Without a server

You do not need one. `npm run dev` opens the app on `http://localhost:5173`,
and from there **Open a folder** reads and writes real files on disk through
the File System Access API (Chrome, Edge, Opera). The server exists so that
*several* devices can share one folder.

## Working on it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the built bundle
npm start        # build, then serve it — add -- --vault ~/Notes
npm run server -- --vault ~/Notes   # serve an existing build
npm test         # vitest — 1290+ unit and component tests
npm run e2e      # drive the built app in a real browser (needs `npm run build` first)
```

### End-to-end tests

`npm run e2e` starts the preview server, opens Chromium and walks 100 real user
flows — expanding folders, typing, formatting, wiki-link autocomplete, clicking
links and tags, ticking a task inside a transclusion, search operators, the
command palette, the graph, renaming with link rewriting, deleting, switching
vaults, reloading, and keyboard navigation. Any step that fails, and any error
the page logs, fails the run.

The last suite covers the folder-on-disk vault against the browser's **real**
File System Access implementation. `showDirectoryPicker()` opens a native dialog
no automation can click, so that one call is stubbed — but it hands back a
genuine `FileSystemDirectoryHandle` from the origin private file system, and
every assertion about what is on disk reads through a *fresh* handle rather than
the adapter's cache. It checks that edits land in the file, that renaming moves
it and rewrites the links inside other files, that deleting removes it, that
`.obsidian` and `node_modules` are never walked or written to, that a file
changed by another editor is picked up on reload, that switching vaults mid-edit
leaves the folder untouched, and that a dropped directory permission falls back
without losing the folder.

The suite after it starts a real sync server over a real folder and pairs **two
independent browser contexts** with it — a stand-in for a laptop and a phone —
then checks that an edit on one appears on the other without a reload, that
creating and deleting propagate, that a file changed on the host reaches both,
and that two devices editing the same note end up with both versions.

They exist because a whole class of defect passes every unit test and still
breaks the app: a keymap CodeMirror swallows before the app sees it, a panel
that never receives a height, a dialog the browser blocks outright. Each of
those was found here, not by the unit suite.

A last suite reads the built bundle off disk and fails if the editor, KaTeX or
the graph reappear in the chunk the first screen has to download, or if it grows
past its stated budget — one ordinary looking import would otherwise undo the
code splitting silently. It then opens a note for editing, opens the graph, and
renders an equation, each of which has to wait for a chunk to arrive.

Playwright needs a browser once: `npx playwright install chromium` (or point
`PLAYWRIGHT_CHROMIUM_PATH` at one you already have).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ P` | Quick switcher |
| `Ctrl/⌘ Shift P` | Command palette |
| `Ctrl/⌘ Shift F` | Search in vault |
| `Ctrl/⌘ Shift O` | Go to heading |
| `Ctrl/⌘ N` | New note |
| `Ctrl/⌘ Shift D` | Today's daily note |
| `Ctrl/⌘ S` | Save now |
| `Ctrl/⌘ E` | Toggle edit / preview |
| `Ctrl/⌘ G` | Graph view |
| `Ctrl/⌘ Alt B` | Toggle sidebar |
| `Ctrl/⌘ B` / `Ctrl/⌘ I` | Bold / italic |
| `Ctrl/⌘ K` | Insert link |
| `Ctrl/⌘ Enter` | Toggle task checkbox |
| `Ctrl/⌘ \` | Split right |
| `Ctrl/⌘ W` | Close tab |
| `Ctrl/⌘ ,` | Settings |

## How it is put together

```
src/
  types.ts              domain vocabulary — notes, links, graph, vault, search
  state/store.ts        the single zustand store: vault, workspace, UI, autosave
  core/
    markdown/parse.ts   frontmatter, wiki-links, tags, headings, tasks (offset-exact)
    markdown/render.ts  markdown-it pipeline + wiki-links, embeds, callouts, math,
                        sanitised with DOMPurify
    graph/index.ts      link index, resolution, backlinks, tag tree, graph data
    graph/layout.ts     deterministic force-directed simulation
    search/engine.ts    query parsing, ranking, quick switcher
    search/fuzzy.ts     fuzzy matcher + highlighter
    vault/              memory / IndexedDB / File System Access adapters
  ui/                   editor, preview, graph, explorer, panels, palette, shell
  styles/               design tokens and theme, one dark-first system
```

```
server/                 the sync server: one folder, an HTTP API, a change feed
e2e/                    browser-driven suites; see "End-to-end tests" above
```

`docs/CONTRACTS.md` is the binding module surface — every module is written
against it, including the window-event contract the panels talk over.

The design principle throughout: **the core is pure and testable**, the store
owns all mutation, and the UI only reads state and dispatches actions.

## Syncing across devices

One machine holds the notes and serves the app; every other device opens its
address, installs the app and syncs against it. Edits appear on the other
devices within moments, a file changed by any other program on the host is
picked up too, and two devices editing the same note at once keep both versions
rather than one silently winning.

```bash
npm run build
npm run server -- --vault ~/Notes --host 0.0.0.0
```

The server prints an address and an access token; paste both into **Connect to a
server** on the other device. It binds to loopback unless you ask otherwise, and
`docs/SERVER.md` covers reaching it from outside your network (Tailscale or a
Cloudflare tunnel — not a forwarded router port), keeping it running on a Mac,
and what the token does and does not protect.

Opening a vault is one request rather than one per note, so a folder of five
thousand notes appears in a few seconds rather than queueing behind the
browser's connection limit, and the splash counts them as they land.

The vault stays an ordinary folder of Markdown files. Time Machine, git and any
other backup you already have keep working.

## Browser support

Chrome / Edge / Opera get the full experience including opening a real folder.
Firefox and Safari lack the File System Access API, so the folder option is
disabled there — the browser vault, the demo vault and the sync server work
everywhere.

Installing it as an app needs `https://` or `http://localhost`, which is a
browser rule rather than one of ours. Over plain HTTP on a local network the app
runs and syncs normally but stays a page.

Only Chromium has actually been exercised, by the test suites above. Firefox and
Safari are untested, and nothing here has been run on macOS itself.

## Licence

MIT.
