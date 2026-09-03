# SpaceLink

A local-first, plain-text knowledge base in the browser — in the spirit of
[Obsidian](https://obsidian.md). Your notes are ordinary Markdown files in a
folder you control; SpaceLink adds the connective tissue: `[[wiki-links]]`,
backlinks, a live graph of your vault, instant search and a command palette.

No cloud service, no telemetry. Everything runs in the tab, against a folder you
control — and when you want the same notes on several devices, you run the server
yourself and sign in to it.

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
  and writes the same folder, live. Sign in with an email and password, or paste
  the server's access token. See [docs/SERVER.md](docs/SERVER.md)
- **Demo vault** — a ready-made 20-note knowledge base that doubles as the
  product tour
- **Paste or drop a file into a note** — a screenshot goes in as
  `![[Pasted image …]]`, a dropped file keeps its own name, and both land in a
  folder you choose
- Export the whole vault as one JSON file — notes *and* attachments — export a
  note as Markdown, import either back

## Installing it

Two ways, depending on whether you want a Mac application or a browser one.

### As a Mac app

```bash
open macos/SpaceLink.xcodeproj      # then ⌘R
```

...or without opening Xcode at all:

```bash
./macos/build.sh --install
open /Applications/SpaceLink.app
```

A real `SpaceLink.app`: double-click it, choose your notes folder, done. It
starts its own server and shuts it down when you quit; there is no terminal to
keep open. Needs Xcode's command line tools (`xcode-select --install`) and Node.

It was written without a Mac, so `macos/Tests/run.sh` does what it can from
anywhere: it compiles and runs the half that starts and stops the notes server,
and typechecks the AppKit half against stubs taken from Apple's documentation.
[macos/README.md](macos/README.md) sets out exactly which is which before you
build it.

### As a web app

There is no installer to download. SpaceLink is built from source in about
fifteen seconds, and then installs itself from the browser — it is a progressive
web app, so the "install" is your browser's, not a package manager's.

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else.

```bash
git clone <this repository> spacelink
cd spacelink
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
remembers which vault it was on. What survives losing the network is the app
itself and any vault held on the device — the demo vault, and a browser vault in
IndexedDB. A vault that lives on a **sync server** still needs the server:
`/api/` is deliberately never cached, because a cached note could be one the
vault no longer has, and a cached response could carry an access token.

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
npm test         # vitest — 1750 unit and component tests
npm run e2e      # drive the built app in a real browser (needs `npm run build` first)
```

### Continuous integration

`.github/workflows/ci.yml` runs the same two commands on every pull request:
`npm run build` (which typechecks first) with `npm test`, and the end-to-end
suites in Chromium. Both on Linux.

A third job typechecks the Swift half of the macOS wrapper, and runs **only when
asked for** from the Actions tab. That is deliberate rather than an oversight:
this repository is private, where GitHub bills a macOS runner at ten times the
Linux rate, and the rest of the wrapper — the Xcode project, the resources it
copies, the macOS versions its APIs need — is already checked by the unit suite
on Linux.

`build/ci.test.mjs` checks the workflow against the project it is meant to
check: that every `npm run` in it names a script that still exists, that the
build comes before the suites that refuse a stale `dist/`, that it installs from
the lockfile, that it asks for no write permission, and that the expensive job
is still gated. A workflow is the one file nothing runs locally, so it is also
the one that rots without anybody noticing.

### End-to-end tests

`npm run e2e` starts the preview server, opens a real browser and walks 149 real
user flows — 117 of them in Chromium alone, the rest in the other two engines.
They expand folders, type, format, complete wiki-links, click links and tags,
tick a task inside a transclusion, use the search operators and the command
palette, open the graph, rename a note and watch the links follow it, delete,
switch vaults, reload, and navigate by keyboard alone. Any step that fails, and
any error the page logs, fails the run.

One suite covers the folder-on-disk vault against the browser's **real**
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

It also pastes a real PNG into a note and drops another one on it, then reads
both back off disk, checks the bytes, and confirms the pasted image decodes in
the preview — because until this existed the app could *show* an image a folder
already contained but never add one, which is most of what attachments are for.

It finishes by exporting that folder as JSON and importing it into a **browser
vault**, then reading the result out of IndexedDB and comparing the attachment
byte for byte. That is how "Export vault as JSON" turned out to write
`state.notes` and nothing else: a folder of notes and images came back as a
folder of notes and broken links, silently, from the one button whose purpose is
not losing anything.

Another starts a real sync server over a real folder and pairs **two
independent browser contexts** with it — a stand-in for a laptop and a phone —
then checks that an edit on one appears on the other without a reload, that
creating and deleting propagate, that a file changed on the host reaches both,
and that two devices editing the same note end up with both versions. It also
makes an **account** the only way one can be made — running `--add-account` as a
child process before the server starts — then signs a third device in with that
email and password, checks it lands on the same notes and stays signed in across
a reload, that signing out kills the session on the *server* and not merely in
the browser, and that a wrong password is refused and remembered nowhere.

They exist because a whole class of defect passes every unit test and still
breaks the app: a keymap CodeMirror swallows before the app sees it, a panel
that never receives a height, a dialog the browser blocks outright. Each of
those was found here, not by the unit suite.

One reads the built bundle off disk and fails if the editor, KaTeX or
the graph reappear in the chunk the first screen has to download, or if it grows
past its stated budget — one ordinary looking import would otherwise undo the
code splitting silently. It then opens a note for editing, opens the graph, and
renders an equation, each of which has to wait for a chunk to arrive.

Two suites leave Chromium. One runs the core journey in **Firefox and WebKit**,
because the paragraph on browser support below was a claim with nothing behind
it. The other runs at **phone metrics with touch** — an iPhone 14 in WebKit, a
Pixel 7 in Chromium — which is how the narrow layout turned out to be broken:
both sidebars opened as overlays over the note, one on top of the other, so the
first thing a reader met was a panel they could not dismiss covering a note they
could not reach. Neither suite fails when its engine is absent; it says so and
moves on.

The last one pulls the network out. It checks the manifest and its icons, that a
service worker takes charge, and then — with the network genuinely off — that
the app opens from cache, the vault is there, a note opens and takes keystrokes,
and that nothing from `/api/` was ever cached, since a stale note or a cached
token would both be worse than no cache at all. This one found that the offline
promise below was false: a worker is not in charge of the page that installs it,
so on a first visit it cached precisely nothing and the app needed three visits
before it survived losing the network. It now precaches during `install`, from a
list `build/precache.mjs` writes out of the finished build.

`npm run e2e` refuses to run against a `dist/` older than the source, because
`npm run build` typechecks first: a type error leaves the *previous* bundle in
place, and every check would then quietly run against code that no longer
exists. That is worse than a failure — a fix appears not to work, and something
deliberately broken appears to pass.

Playwright needs its browsers once:

```bash
npx playwright install chromium          # suites 1-9
npx playwright install firefox webkit    # suites 10-11, optional
```

Point `PLAYWRIGHT_CHROMIUM_PATH` at a Chromium you already have to skip the
first. A container that ships one at the root of `PLAYWRIGHT_BROWSERS_PATH` is
found without being told.

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
    vault/              memory / IndexedDB / File System Access / sync-server adapters
  ui/                   editor, preview, graph, explorer, panels, palette, shell
  styles/               design tokens and theme, one dark-first system
```

The app was called **SpaceFore** until it was renamed. Everything visible moved;
two storage addresses deliberately did not. The browser vault's IndexedDB
database is still named `spacefore`, because a database name is an address
rather than a brand and renaming it would point the app at an empty one while
every note stayed in the old. Settings kept in `localStorage` *did* move, and
`src/core/renamedStorage.ts` copies the old keys across on first boot, so a
reader keeps their theme, their starred notes, their pane sizes and the server
they were signed in to. On the server side, `~/.spacefore` is still read when
`~/.spacelink` does not exist, so an existing access token and accounts file
survive.

```
server/                 the sync server: one folder per account, an HTTP API,
                        a change feed, and passwords hashed with scrypt
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

There are two ways in. Make yourself an account on the host —

```bash
npm run server -- --vault ~/Notes --add-account you@example.com
```

— and then sign in with that email and password on the Mac, the PC and the
phone: the same account reaches the same notes everywhere, and each device gets
its own session that can be ended without changing the password. Accounts are
made with that command and nowhere else; the server has no sign-up page, so
there is no sign-up page to attack.

Or paste the access token the server prints, which is what a single machine
needs and what the macOS app pairs itself with.

It binds to loopback unless you ask otherwise, and `docs/SERVER.md` covers
reaching it from outside your network (Tailscale or a Cloudflare tunnel — not a
forwarded router port), keeping it running on a Mac, and what each credential
does and does not protect.

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

All three engines are exercised by the suites above: the core journey — loading,
the quick switcher, typing, preview, mathematics, search and the graph — runs in
Chromium, Gecko and WebKit, and the phone layout runs at real device metrics
with touch on an iPhone 14 (WebKit) and a Pixel 7 (Chromium).

Two caveats worth stating plainly. Playwright's WebKit is the engine behind
Safari, not Safari itself, so it will not catch everything Safari does — it does
catch the class of thing that actually differs between engines. And the macOS
app has never been built on a Mac; what has and has not been checked there is
set out in [macos/README.md](macos/README.md).

## Licence

MIT.
