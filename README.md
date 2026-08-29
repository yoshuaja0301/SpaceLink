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
- **Demo vault** — a ready-made 20-note knowledge base that doubles as the
  product tour
- Export the vault as JSON, export a note as Markdown, import from JSON

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the built bundle
npm test         # vitest
```

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

`docs/CONTRACTS.md` is the binding module surface — every module is written
against it.

The design principle throughout: **the core is pure and testable**, the store
owns all mutation, and the UI only reads state and dispatches actions.

## Browser support

Chrome / Edge / Opera get the full experience including opening a real folder.
Firefox and Safari lack the File System Access API, so the folder option is
disabled there — the browser vault and demo vault work everywhere.

## Licence

MIT.
