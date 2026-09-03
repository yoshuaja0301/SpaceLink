/**
 * The demo vault.
 *
 * This is the first thing most people ever see in SpaceLink, so it doubles as
 * the product tour: a small but genuinely interlinked knowledge base about
 * personal knowledge management that happens to exercise every feature of the
 * app — frontmatter, wiki links in all four forms, embeds, nested tags, tasks,
 * tables, callouts, footnotes, code fences, math, unresolved links and one
 * deliberate orphan.
 *
 * Two properties are load-bearing and covered by the tests next door:
 *
 * 1. Exactly two link targets are unresolved on purpose — `Note Refactoring`
 *    and `Books/How to Take Smart Notes` — so the graph shows placeholder
 *    nodes and the `is-unresolved` link styling is visible out of the box.
 * 2. `Sandbox/Orphan Note.md` has no links in *or* out, so the graph view's
 *    "orphans" concept has something to point at.
 *
 * The notes are written as plain template literals. Two escaping rules apply
 * when editing them: every literal backtick needs `\``, and every literal
 * backslash (LaTeX, mostly) needs `\\`.
 */
import type { NotePath, VaultAdapter } from '../../types'
import { createMemoryVault } from './memoryVault'

export const DEMO_NOTES: Record<NotePath, string> = {
  /* ------------------------------------------------------------------ *
   * Root
   * ------------------------------------------------------------------ */

  'Start Here.md': `---
title: Start Here
tags: [pkm, tour, meta]
aliases: [Welcome, Read Me First]
---

# Start Here

Welcome to **SpaceLink**, a local-first knowledge base built on nothing more
exotic than a folder of markdown files. Every note you are reading is a plain
\`.md\` file: no database, no lock-in, no account. Open the same folder in any
other editor and everything still works.

> [!note] You are in the demo vault
> This vault lives in memory, so edits disappear when you reload. When you are
> ready to keep something, open the vault picker and choose **a browser vault**
> (stored in IndexedDB, survives reloads) or **open a folder** on disk, which
> writes real files through the File System Access API.

## The tour

Everything below is a real note in this vault. Click through — that is the
point.

- **Guides** — how the app works: [[Markdown Basics]], [[Linking Notes]],
  [[Tags and Metadata]], [[The Graph View]], [[Search Syntax]],
  [[Keyboard Shortcuts]] and [[Daily Notes]].
- **Concepts** — the ideas the guides are in service of: [[Zettelkasten]],
  [[Atomic Notes]], [[Evergreen Notes]], [[Progressive Summarization]],
  [[Maps of Content]] and [[Spaced Repetition]].
- **Projects** — what an ordinary working note looks like:
  [[Projects/Vault Migration]] and [[Projects/Research Notebook]].
- **Daily** — a running log: [[Daily/2026-01-15]],
  [[Daily/2026-01-16|Friday's entry]] and [[Daily/2026-01-19]].
- **Sandbox** — [[Sandbox/Formatting Playground]] renders every syntax the
  preview supports, all on one page.

If you prefer to browse by hand, [[PKM Map of Content]] is the hub note that
links to everything at once.

## Try this

- [x] Open this note. (Done — that is why the checkbox is ticked.)
- [ ] Press \`Ctrl+P\` for the command palette and run **Open graph view**. Drag
      a node around; the layout is a small force simulation.
- [ ] Press \`Ctrl+O\` and type \`zettel\`. The quick switcher fuzzy-matches the
      path too, so \`gkey\` is enough to reach *Guides/Keyboard Shortcuts*.
- [ ] Open [[Atomic Notes]] and look at the **Backlinks** panel on the right.
      More notes lean on it than on anything else here, and each backlink shows
      the line it appears on.
- [ ] Click the unresolved link in [[Linking Notes#Unresolved links]] — it is
      styled differently because the note does not exist yet.
- [ ] Open [[Sandbox/Formatting Playground]] in split view and edit the left
      pane; the preview follows as you type.
- [ ] Find \`Sandbox/Orphan Note.md\` in the file explorer. Nothing links to it,
      which is exactly what [[The Graph View#Orphans]] is about.

## Where to go next

Read [[Markdown Basics]] if you want the syntax first, or
[[Concepts/Zettelkasten]] if you would rather start with the method and pick up
the syntax on the way. The shortcut list lives in
[[Keyboard Shortcuts#Navigation]] and in the command palette, which is always
the authoritative copy.

#pkm/start #status/active
`,

  'PKM Map of Content.md': `---
title: PKM Map of Content
aliases: [Knowledge Map, Vault Map]
tags:
  - pkm
  - moc
  - meta
---

# PKM Map of Content

A map of content is a note whose only job is to point at other notes. This one
is the front door for the whole demo vault: if you forget where something
lives, come back here. See [[Maps of Content]] for why this pattern beats a
folder tree.

![[Concepts/Maps of Content]]

## Learn the tool

| Guide | Covers | Read it when |
| --- | --- | --- |
| [[Markdown Basics]] | Headings, lists, tables, code, math | You are new to markdown |
| [[Linking Notes]] | \`[[wiki links]]\`, aliases, embeds | You want notes to talk to each other |
| [[Tags and Metadata]] | Frontmatter, nested tags, aliases | Your vault outgrows one folder |
| [[The Graph View]] | Nodes, edges, orphans, filters | You want to see the shape of your vault |
| [[Search Syntax]] | \`tag:\`, \`path:\`, phrases, regex | You cannot find that one note |
| [[Keyboard Shortcuts]] | Palette, panes, navigation | You are tired of the mouse |
| [[Daily Notes]] | The dated capture habit | You need somewhere to put loose thoughts |

## Learn the method

- [[Zettelkasten]] — the parent method, and the reason for all the linking.
- [[Atomic Notes]] — one idea per note, the single most useful rule here.
- [[Evergreen Notes]] — notes that get better over time instead of rotting.
- [[Progressive Summarization]] — turning sources into something you will
  actually reread.
- [[Spaced Repetition]] — remembering the small set of things worth memorising.
- [[Maps of Content]] — navigation that scales past a few hundred notes.

## Work in progress

- [[Projects/Vault Migration]] — moving 900 notes out of a proprietary app.
  #status/active
- [[Projects/Research Notebook]] — a literature workflow for the reading
  backlog. #status/active

## Logbook

- [[Daily/2026-01-15]] · [[Daily/2026-01-16]] · [[Daily/2026-01-19]]

## Loose ends

Not everything on a map has to exist yet. [[Note Refactoring]] is a note this
vault keeps promising and never writes — it shows up in the graph as a hollow
placeholder node, and in [[Search Syntax]] you can list every such gap.

---

*Maintained by hand. A map that updates itself is a query, not a map.*

#pkm/method #meta/index
`,

  /* ------------------------------------------------------------------ *
   * Guides
   * ------------------------------------------------------------------ */

  'Guides/Markdown Basics.md': `---
title: Markdown Basics
tags: [guide, markdown]
---

# Markdown Basics

Markdown is a way of writing formatted text that still reads fine as plain
text. That last part matters more than it sounds: it is why these notes will
still open in 2046. This guide covers the syntax the SpaceLink preview
understands; [[Sandbox/Formatting Playground]] shows all of it rendered at once.

## Structure

Headings are one to six \`#\` characters followed by a space. A note should have
exactly one \`#\` heading — its title — and use \`##\` and below for sections. The
outline panel and the heading switcher are both built from these, so headings
are navigation, not decoration.

Paragraphs are separated by a blank line. A horizontal rule is three or more
dashes on their own line:

---

## Inline

| You write | You get |
| --- | --- |
| \`*emphasis*\` | *emphasis* |
| \`**strong**\` | **strong** |
| \`~~struck through~~\` | ~~struck through~~ |
| \`\` \`code\` \`\` | \`code\` |
| \`[a link](https://commonmark.org)\` | [a link](https://commonmark.org) |

## Lists

Unordered lists take \`-\`, ordered lists take \`1.\`, and indenting by two spaces
nests them:

- Capture
  - Inbox note
  - Voice memo
- Process
  1. Split into [[Atomic Notes]]
  2. Link to something older
  3. Tag with a status
- Review

Prefix a list item with \`[ ]\` or \`[x]\` for a task:

- [x] Learn the list syntax
- [ ] Use it in a real project note

## Code

Fence a block with three backticks and name the language:

\`\`\`python
def wordcount(note: str) -> int:
    """Rough parity with the count in the status bar."""
    return len(note.split())
\`\`\`

Anything inside a fence or an inline code span is left alone by the parser,
which is how this guide can print \`[[not a link]]\` and \`#nottag\` without
creating a link or a tag.

## Beyond plain markdown

Blockquotes start with \`>\`, and a quote whose first line is \`[!note]\`,
\`[!tip]\` or \`[!warning]\` becomes a callout:

> [!tip] Learn one thing at a time
> You do not need the whole syntax on day one. Headings, lists and
> [[Linking Notes|links]] will carry you a long way.

Math is written between dollar signs and rendered with KaTeX — inline as
$a^2 + b^2 = c^2$, or as a display block. See
[[Sandbox/Formatting Playground#Math]] for both.

Next: [[Linking Notes]], then [[Tags and Metadata]].

#pkm/reference #status/done
`,

  'Guides/Linking Notes.md': `---
title: Linking Notes
tags: [guide, linking]
---

# Linking Notes

A pile of notes becomes a knowledge base at the moment the notes start pointing
at each other. In SpaceLink that is a wiki link: two square brackets around the
name of another note.

## The four forms

| Form | Example | Renders as |
| --- | --- | --- |
| Plain | \`[[Atomic Notes]]\` | [[Atomic Notes]] |
| Aliased | \`[[Atomic Notes\\|one idea per note]]\` | [[Atomic Notes|one idea per note]] |
| Heading | \`[[Search Syntax#Operators]]\` | [[Search Syntax#Operators]] |
| Embed | \`![[Note]]\` | the note's content, inline |

## How a target is resolved

Link text is matched in a fixed order, case-insensitively:

1. an exact path — \`[[Concepts/Atomic Notes.md]]\`
2. the path plus \`.md\` — \`[[Concepts/Atomic Notes]]\`
3. any note's basename — \`[[Atomic Notes]]\`
4. any \`aliases:\` entry in frontmatter — \`[[Slip-box]]\` finds
   [[Concepts/Zettelkasten]]

The upshot: you almost never type a folder. Move a note between folders and
every plain link to it keeps working, because nothing depended on where it sat.

## Embeds

\`![[Note]]\` transcludes another note where you stand. Add a heading to embed
one section instead of the whole file:

![[Concepts/Atomic Notes#Why atomic]]

Embeds nest up to three levels deep and cycles are broken, so a pair of notes
embedding each other renders rather than hangs.

## Unresolved links

You are encouraged to link to notes that do not exist yet. Writing
[[Note Refactoring]] right now records the intention; the link renders in a
muted style and shows up in the graph as a hollow placeholder node. When you
finally write the note, every link to it lights up at once — no rewiring.

> [!warning] Two links here point at nothing on purpose
> [[Note Refactoring]] and [[Books/How to Take Smart Notes]] are the only
> unresolved targets in this vault. They exist so you can see what a broken
> link looks like before you make one by accident.

## Backlinks

Every link is bidirectional whether you like it or not: the note you point at
records the note that pointed. Open [[Atomic Notes]] and read the backlinks
panel — that list *is* the argument for linking over foldering, because it
shows context you never had to file.

See also [[The Graph View]] and [[Maps of Content]].

#pkm/method #status/done
`,

  'Guides/Tags and Metadata.md': `---
title: Tags and Metadata
tags: [guide, metadata, pkm/method]
aliases: [Frontmatter]
---

# Tags and Metadata

Links say *what a note is about*. Metadata says *what kind of note it is* and
*what state it is in*. Keeping the two jobs separate is most of the trick.

## Frontmatter

A note may open with a YAML block fenced by \`---\`, and it only counts when it
is the very first line of the file:

\`\`\`yaml
---
title: Tags and Metadata
aliases: [Frontmatter]
tags:
  - guide
  - pkm/method
status: done
---
\`\`\`

Three keys are special. \`title\` overrides the filename everywhere in the UI.
\`aliases\` gives the note extra names that wiki links resolve against.
\`tags\` merges with the inline \`#tags\` in the body. Everything else is yours;
unknown keys are kept, shown in the little property table at the top of the
preview, and never thrown away.

Both list styles work — the block form above, or the inline form
\`tags: [guide, metadata]\` used by [[Markdown Basics]].

## Inline tags

Anywhere in the body, \`#tag\` marks the note. A tag may contain letters,
digits, \`-\`, \`_\` and \`/\`, but never only digits — so \`#2026\` is not a tag,
which keeps dates and \`#1\` style references out of your tag list. Tags are
ignored inside code, which is why this sentence can mention \`#nottag\` safely.

## Nested tags

A slash makes a hierarchy, and the tag panel renders it as a tree:

- \`#status/active\`, \`#status/done\`, \`#status/parked\` — where a note is in its
  life cycle
- \`#pkm/method\`, \`#pkm/reference\`, \`#pkm/start\` — what kind of note it is
- \`#meta/index\` — notes about the vault itself

Clicking \`#status\` in the panel matches every child. That is the whole reason
to nest: one click for the family, one click for the member.

> [!tip] Tag states, not topics
> Topics are what links are for. A \`#pkm\` tag on 400 notes tells you nothing;
> \`#status/active\` on nine notes tells you what to do next.

## A worked convention

| Facet | Values | Where it goes |
| --- | --- | --- |
| Kind | method, reference, project, daily | frontmatter \`tags\` |
| State | active, done, parked | inline, near the top |
| Source | book, paper, talk | frontmatter, with a \`url\` key |

See [[Search Syntax]] for querying all of this, and
[[Projects/Research Notebook]] for the convention in real use.

#pkm/reference #status/done
`,

  'Guides/The Graph View.md': `---
title: The Graph View
tags: [guide, graph]
---

# The Graph View

The graph draws your vault as a network: one node per note, one edge per link.
It is not decoration — it answers questions a file tree cannot, like *what is
this vault actually about* and *which of my notes is a dead end*.

## Reading it

- **Node size** grows with degree, the number of links touching a note. Formally
  the radius is $4 + \\min(10, 3\\sqrt{d})$ for degree $d$, so hubs stand out
  without swallowing the screen.
- **Hollow nodes** are unresolved links — a target somebody wrote in brackets
  that has no file behind it. See [[Linking Notes#Unresolved links]].
- **Isolated dots** at the edge are orphans.
- **Tag nodes**, off by default, add one node per tag and connect every note
  carrying it. Useful once, then usually noise.

## The controls

| Control | Default | What it does |
| --- | --- | --- |
| Show unresolved | on | Placeholder nodes for links with no file |
| Show tags | off | Adds \`#tag\` nodes to the layout |
| Link distance | 70 | Rest length of each spring |
| Repel strength | -180 | How hard nodes push each other apart |
| Local graph | — | Only the current note and its neighbours, N hops out |

The layout is a plain force simulation: springs on the edges, repulsion between
nodes, weak pull toward the centre, velocity damped each tick. Node starting
positions come from a golden-angle spiral rather than a random scatter, so the
same vault always draws the same picture.

## Orphans

An orphan is a note nothing links to and which links nowhere itself. A handful
is normal — inbox scraps, one-off logs. A drift of them means capture is
outrunning processing.

The cure is not deleting them. It is spending five minutes with
[[Atomic Notes]] and [[Maps of Content]]: split the scrap into ideas, then link
each idea to one older note. This vault ships exactly one orphan,
\`Sandbox/Orphan Note.md\`, so you can watch it sit there alone.

> [!note] Local graph beats global graph
> The whole-vault view is impressive at 50 notes and unreadable at 5,000. The
> local graph — this note, one or two hops out — is the one you will use daily.

Related: [[Linking Notes]], [[Zettelkasten]], [[Evergreen Notes]],
[[PKM Map of Content]].

#pkm/reference #status/done
`,

  'Guides/Search Syntax.md': `---
title: Search Syntax
tags: [guide, search]
---

# Search Syntax

Search runs over the whole vault as you type and returns matching lines, not
just matching files. The query language is small on purpose — six operators you
can hold in your head.

## Operators

| Query | Meaning |
| --- | --- |
| \`atomic notes\` | Both words appear, in any order |
| \`"atomic notes"\` | That exact phrase |
| \`-draft\` | Exclude notes containing *draft* |
| \`tag:status/active\` | Has that tag, from frontmatter or the body |
| \`path:Concepts\` | Path contains *Concepts* |
| \`file:2026-01\` | Filename contains *2026-01* |
| \`/^#{2}\\s+Why/\` | Regular expression |

Operators combine, and everything is case-insensitive unless you turn on the
match-case toggle:

\`\`\`text
tag:pkm/method path:Concepts "one idea" -deprecated
\`\`\`

A regex that fails to compile is treated as literal text rather than throwing —
typing \`/foo(\` mid-thought never breaks the results list.

## Ranking

Hits are ordered title first, then heading, then body; more matches beats fewer,
and a shorter path breaks the tie. So \`atomic\` puts [[Atomic Notes]] above the
nine notes that merely mention it.

## The quick switcher

Search is for finding text; the quick switcher is for finding *a note you
already have in mind*. It fuzzy-matches the basename first and the full path
second, so \`cazn\` reaches \`Concepts/Atomic Notes.md\`. If nothing matches, the
top row offers to create a note with the name you typed — capture without
leaving the keyboard.

## Recipes

- \`tag:status/active\` — the working set. Start every session here.
- \`path:Daily "next actions"\` — what past-you promised.
- \`tag:pkm/method path:Concepts\` — the method notes, without the guides that
  reference them.
- \`/\\[\\[[^\\]]+\\]\\]/\` — every wiki link, when auditing after a rename.

See [[Tags and Metadata]] for the tag conventions these queries assume, and
[[Keyboard Shortcuts#Navigation]] for how to open all of this without a mouse.

#pkm/reference #status/done
`,

  'Guides/Keyboard Shortcuts.md': `---
title: Keyboard Shortcuts
tags: [guide, shortcuts]
---

# Keyboard Shortcuts

The fastest way to learn the app is to stop reaching for the mouse. On macOS
read \`Ctrl\` as \`Cmd\`.

> [!note] The palette is the source of truth
> Every command shows its own shortcut next to its name in the command palette.
> If a binding here ever disagrees with the palette, the palette is right.

## Navigation

| Keys | Command |
| --- | --- |
| \`Ctrl+P\` | Command palette — every action, searchable |
| \`Ctrl+O\` | Quick switcher — jump to a note by name |
| \`Ctrl+Shift+F\` | Search the whole vault |
| \`Ctrl+G\` | Open the graph view |
| \`Ctrl+Shift+O\` | Jump to a heading in this note |
| \`Alt+Left\` / \`Alt+Right\` | Back and forward through history |

## Editing

| Keys | Command |
| --- | --- |
| \`Ctrl+S\` | Save now (autosave already fires after ~800 ms of quiet) |
| \`Ctrl+B\` / \`Ctrl+I\` | Bold, italic |
| \`Ctrl+K\` | Wrap the selection in a link |
| \`Ctrl+Enter\` | Toggle the task on the current line |
| \`Ctrl+N\` | New note |

## Views and panels

| Keys | Command |
| --- | --- |
| \`Ctrl+E\` | Cycle edit → preview → split |
| \`Ctrl+\\\` | Split the workspace into two panes |
| \`Ctrl+W\` | Close the current tab |
| \`Ctrl+,\` | Settings |

## Learning them

Do not memorise the table. Pick the three commands you reach for most this week
— for most people that is the palette, the quick switcher and
[[Daily Notes|the daily note]] — and use the keys until they are automatic. The
rest arrive on their own, which is [[Spaced Repetition]] applied to your own
hands.

Related: [[Search Syntax]], [[The Graph View]], [[Start Here]].

#pkm/reference #status/done
`,

  'Guides/Daily Notes.md': `---
title: Daily Notes
tags: [guide, daily, pkm/method]
---

# Daily Notes

A daily note is one file per day, named after the date, that you open without
deciding anything first. It is the cheapest possible capture surface: no title
to invent, no folder to choose, no filing decision at the moment you are least
willing to make one.

## How it works here

The daily note command creates or opens \`Daily/YYYY-MM-DD.md\` — folder and
date format are both settings, so \`Journal/2026-01-15\` or \`Daily/15-01-2026\`
work just as well. If today's file already exists it simply opens; you can hit
the command five times a day safely.

See [[Daily/2026-01-15]], [[Daily/2026-01-16]] and [[Daily/2026-01-19]] for
three real ones.

## A shape that survives contact with real days

\`\`\`markdown
## Log
- 09:40 stand-up: shipped the importer
## Notes
- Linking is cheap, filing is expensive -> [[Atomic Notes]]
## Next actions
- [ ] Reply to the review comments
\`\`\`

Three headings, in that order. **Log** is timestamped and disposable. **Notes**
is where an idea gets one line and a link — that line is the seed of a real
note later. **Next actions** is the only part you reread tomorrow.

## The rule that makes it work

The daily note is a *buffer*, not an archive. Anything still interesting after
a week gets promoted into an [[Atomic Notes|atomic note]] and linked from a
[[Maps of Content|map of content]]; the rest is allowed to die where it lies.
Without that rule you get a diary — pleasant, unsearchable, and not a knowledge
base. With it you get [[Evergreen Notes]] and a diary for free.

> [!tip] Link forward, not just back
> When a log line mentions a project, link it: \`[[Projects/Vault Migration]]\`.
> The project note then collects every day it was touched in its backlinks
> panel, and you have a timeline nobody had to maintain.

## Weekly review

Search \`path:Daily "next actions"\` on Friday, promote what survived, and close
the loop with [[Progressive Summarization]].

#pkm/method #status/active
`,

  /* ------------------------------------------------------------------ *
   * Concepts
   * ------------------------------------------------------------------ */

  'Concepts/Zettelkasten.md': `---
title: Zettelkasten
aliases: [Slip-box, Zettelkasten Method]
tags:
  - concept
  - pkm/method
---

# Zettelkasten

*Zettelkasten* is German for "slip box": a box of index cards, each holding one
idea, each numbered so it can point at the others. The sociologist Niklas
Luhmann kept one for thirty years and credited it — not his memory — with the
seventy books and hundreds of papers he published from it.[^luhmann]

The mechanism is unglamorous. You cannot hold a hundred thousand ideas in your
head, but you can hold one idea and ask *what does this remind me of?* A slip
box turns that question into a physical act, and the answers accumulate.

## The three kinds of note

1. **Fleeting notes** — whatever you scribble during the day. Written to be
   thrown away within a week. This is what [[Daily Notes]] are for.
2. **Literature notes** — one per source, in your own words, with the page
   numbers. Never copy-paste; the translation *is* the reading. See
   [[Progressive Summarization]] and [[Projects/Research Notebook]].
3. **Permanent notes** — one idea, written as a full sentence, linked to at
   least one note that already exists. These are the box.

Only the third kind compounds. See [[Atomic Notes]] for what "one idea" means
in practice and [[Evergreen Notes]] for how a permanent note is maintained.

## Why linking beats filing

A folder forces one answer to "where does this belong". A link lets a note
belong to every context that ever asked for it, and the contexts are discovered
rather than declared. Once the box is big enough, the links you did not plan
are the interesting ones — that is the whole payoff, and
[[The Graph View]] is how you see it happening.

## Starting one

- Write notes for yourself, not for an imagined reader.
- Every new note must link to an old one. If it links to nothing, either it is
  not atomic yet or your box has a gap.
- Do not sort into categories up front; grow [[Maps of Content]] once the
  clusters exist.
- Never rewrite a note into blandness. Disagreeing with your past self is the
  system working.

> [!note] Tools are downstream of the habit
> Luhmann used paper and did fine. What SpaceLink adds is search, backlinks and
> a graph — see [[Linking Notes]] — not the method.

[^luhmann]: Luhmann described the box as a conversation partner: "Ohne zu
schreiben, kann man nicht denken." The standard modern introduction is
[[Books/How to Take Smart Notes]], a note this vault has not written yet.

#pkm/method #status/active
`,

  'Concepts/Atomic Notes.md': `---
title: Atomic Notes
aliases: [One Idea Per Note]
tags: [concept, pkm/method]
---

# Atomic Notes

An atomic note holds exactly one idea, stated in its title, and is understandable
without the note it came from.

## Why atomic

A note that contains three ideas can only be linked as a lump. When a future
note wants the second idea, it has to point at the whole thing and hope you
reread it. Split those three ideas apart and each one becomes addressable: it
can be linked, embedded, refuted, or promoted into a [[Maps of Content|map]] on
its own terms. Granularity is what makes a link precise, and precision is what
makes the network worth having.

The counter-pressure is real. Splitting costs effort now for a benefit that
arrives months later, which is why most vaults are full of 2,000-word dumps
nobody reopens.

## Writing one

- **Title it with the claim, not the topic.** "Linking beats filing because
  filing forces one answer" is a note. "Linking" is a folder.
- **Write full sentences.** Bullet fragments make sense today and are opaque in
  March; see [[Evergreen Notes]].
- **Link on the way out.** Before saving, connect the note to one older note.
  In this vault that is a \`[[wiki link]]\` — [[Linking Notes]] has the forms.
- **Keep it under a screen.** If it will not fit, it was two ideas.

## How small is too small

Atomic does not mean tiny. A note so small it has no argument — a bare
definition, a lone date — has nothing to link *about* and clutters
[[The Graph View]]. The working test: could this note be cited in an argument
you have not had yet? If yes, it is the right size.

## In practice

Fleeting material arrives through [[Daily Notes]], gets processed with
[[Progressive Summarization]], and is promoted into atomic notes during a weekly
review. The stock of atomic notes is what makes [[Zettelkasten|the slip box]]
productive rather than merely large, and the handful worth memorising go into
[[Spaced Repetition]].

#pkm/method #status/active
`,

  'Concepts/Progressive Summarization.md': `---
title: Progressive Summarization
aliases: [Layered Highlighting]
tags: [concept, pkm/method, reading]
---

# Progressive Summarization

A technique from Tiago Forte for making a source note re-readable: instead of
summarising once, you compress it in layers, and only on the passes you
actually make.

## The layers

| Layer | What you do | When |
| --- | --- | --- |
| 1 | Save the excerpt, with the citation | On capture |
| 2 | **Bold** the passages that carried the argument | First reread |
| 3 | ==Highlight== the best of the bold | Second reread |
| 4 | Write a summary in your own words at the top | When you need it |
| 5 | Remix into your own [[Atomic Notes]] | When you write |

The discipline is that each layer only happens *on demand*. A source you never
return to stays at layer one, costing you nothing — which is the point. Most
capture systems fail because they charge full price for every item on the way
in.

## Why it works

Compression at read time is retrieval practice: deciding what mattered forces
you to reconstruct the argument, which is the same mechanism behind
[[Spaced Repetition]]. Layers also survive interruption. A half-processed note
is still useful, unlike a half-written summary.

> [!warning] Highlighting is not reading
> Layer two is cheap enough to do mindlessly, and mindless bolding produces a
> note where 60% of the text is bold — the same as no bold at all. If you
> cannot cut to a fifth, do layer four instead and write the thing in your own
> words.

## In this vault

[[Projects/Research Notebook]] runs sources through the ladder and keeps them in
one folder per source. Layer five is where a source note stops being a source
note and turns into [[Evergreen Notes|evergreen]] material — the handoff from
reading to thinking, and the same handoff [[Zettelkasten]] calls the move from
literature note to permanent note.

Related: [[Daily Notes]], [[Maps of Content]].

#pkm/method #status/active
`,

  'Concepts/Evergreen Notes.md': `---
title: Evergreen Notes
tags: [concept, pkm/method]
---

# Evergreen Notes

Andy Matuschak's term for notes written to be *developed over time*, rather than
recorded once and abandoned. A meeting log is a snapshot. An evergreen note is
a position you keep revising as you learn more, and it is the only kind of note
that gets more valuable the older your vault gets.

## The four properties

1. **Atomic** — one idea, so it can be linked precisely. See [[Atomic Notes]].
2. **Concept-oriented** — titled by the idea, not the source or the date. The
   same note can then be reached from a paper, a conversation and a project.
3. **Densely linked** — an evergreen note that links nowhere is a diary entry
   with good posture. [[Linking Notes]] covers the mechanics.
4. **Written for yourself** — future-you is the reader, and future-you has
   forgotten the context but kept the vocabulary.

## Maintenance is the point

Notes rot. A claim you wrote in January contradicts what you learned in June,
and the honest move is to edit the January note rather than write a second one
next to it. That editing pass — merging duplicates, splitting overloaded notes,
retitling to the claim — is the practice this vault keeps calling
[[Note Refactoring]], a note that is deliberately still unwritten so you can
see how an unresolved link behaves.

> [!tip] A retitle is a rethink
> If you cannot state the note's claim in its title, you do not yet know what
> the note says. Retitling is the cheapest thinking available.

## Signals a note has gone evergreen

- Something links to it that you did not write in the same week.
- It shows up in [[The Graph View]] with a fat radius, meaning others lean on it.
- You have edited it more than once *without* growing it.

## Against completeness

Evergreen does not mean finished. A note holding a single sharp claim beats an
essay covering everything, because only the claim can be cited by a future note.
Save the essay for the output; see [[Maps of Content]] and
[[Progressive Summarization]] for how the material gets there.

#pkm/method #status/active
`,

  'Concepts/Maps of Content.md': `---
title: Maps of Content
aliases: [MOC, MOCs]
tags: [concept, pkm/method, navigation]
---

# Maps of Content

A map of content is a note whose body is a curated list of links to other notes.
It is a table of contents you wrote by hand, for a subject rather than a book.

## Why not folders

A folder tree makes you answer "where does this belong" once, permanently, and
for one hierarchy only. A map lets the same note appear on three maps under
three framings, and it costs one line of markdown to add. Notes stay flat and
[[Linking Notes|linkable]]; navigation lives in notes that are themselves
searchable, versionable and linkable.

## Why not search alone

Search only finds what you can already name. A map is for the middle case:
knowing a region exists without remembering what is in it. It also carries what
search cannot — sequence, emphasis, and a sentence of context per entry.

## Growing one

Do not create maps up front. The sequence that works:

1. Write [[Atomic Notes]] until a cluster is obvious — usually 8-12 notes.
2. Make a map, list them, and add a line explaining *why* each belongs.
3. When a map passes roughly thirty entries, split a section into its own map
   and link down to it.
4. Prune. A map linking to everything is a file listing.

## Levels

| Kind | Scope | Example |
| --- | --- | --- |
| Home map | The whole vault | [[PKM Map of Content]] |
| Subject map | One domain | this note's subject cluster |
| Project map | One outcome | [[Projects/Vault Migration]] |

## The failure mode

Maps are seductive because organising *feels* like thinking. A vault of twelve
beautiful maps over forty thin notes is upside down: the notes are the asset.
Write [[Evergreen Notes]] first and let the maps trail behind, roughly one map
per fifty notes.

Related: [[Zettelkasten]], [[The Graph View]], [[Daily Notes]].

#pkm/method #status/active
`,

  'Concepts/Spaced Repetition.md': `---
title: Spaced Repetition
tags: [concept, memory, pkm/method]
---

# Spaced Repetition

Reviewing material at increasing intervals, timed to land just before you would
have forgotten it. It is the best-evidenced technique in the learning
literature, and the one most people skip because it is boring.

## The forgetting curve

Retention decays roughly exponentially after a single exposure:

$$
R = e^{-\\frac{t}{S}}
$$

where $R$ is the probability of recall, $t$ the time since the last review and
$S$ the current strength of the memory. Each successful recall raises $S$, which
flattens the curve — so the intervals can grow, typically 1 day, 3 days, a week,
three weeks, and on. The famous $e^{i\\pi}+1=0$ is easier to keep than that,
because it is one fact rather than a system.

## Why *just before* forgetting

Recall that costs effort strengthens the memory; recall that is instant does
almost nothing. Reviewing too early wastes the repetition, reviewing too late
turns it into relearning. The scheduling algorithm exists to keep you in the
narrow band between the two.

## What actually deserves a card

Very little. Spaced repetition is for facts you need *without lookup*:
vocabulary, notation, API surfaces, key dates, the shape of a proof. Anything
you can look up in five seconds belongs in a note, not a card.

- [x] Make cards from things you have already understood
- [ ] Make cards from things you hope to understand by drilling them

The second one is how people end up with 4,000 cards and no comprehension.

## The relationship to notes

Notes and cards are different tools for different failures. A note fixes *I
cannot find it*; a card fixes *I cannot produce it*. Write the
[[Atomic Notes|atomic note]] first — a card written from an idea you have not
yet stated clearly is a card you will get wrong forever. The compression pass
in [[Progressive Summarization]] is a good moment to notice the two or three
facts worth carding.

Related: [[Evergreen Notes]], [[Keyboard Shortcuts]] — the shortcuts you drill
this week are spaced repetition for your hands.

#pkm/method #status/parked
`,

  /* ------------------------------------------------------------------ *
   * Projects
   * ------------------------------------------------------------------ */

  'Projects/Vault Migration.md': `---
title: Vault Migration
tags: [project, migration]
status: active
started: "2026-01-08"
---

# Vault Migration

Move roughly 900 notes out of a hosted app that exports "markdown" with
proprietary link syntax, and land them in a plain folder this app can open
directly. #status/active

## Why bother

The export is the product. If getting my notes out takes a weekend of scripting,
the notes were never really mine — and everything in [[Evergreen Notes]] assumes
a decade-long horizon that no hosted format has survived.

## Plan

| Phase | Work | State |
| --- | --- | --- |
| 1 | Export, unzip, commit raw dump to git | done |
| 2 | Rewrite links to \`[[wiki]]\` form | in progress |
| 3 | Normalise frontmatter | not started |
| 4 | Split the 30 biggest notes | not started |
| 5 | Build the maps | not started |

## Link rewriting

The exporter emits \`[title](note-id-4f2a.md)\`. Since resolution here falls back
to basenames (see [[Linking Notes]]), the fix is to map ids to titles once and
rewrite in place:

\`\`\`bash
# dry run first — always
rg -o '\\(note-[a-z0-9]+\\.md\\)' vault/ | sort -u | wc -l
node scripts/rewrite-links.mjs --map ids.json --dry-run vault/
\`\`\`

\`\`\`javascript
// scripts/rewrite-links.mjs — the core of it
const LINK = /\\[([^\\]]+)\\]\\((note-[a-z0-9]+)\\.md\\)/g
export function rewrite(text, titles) {
  return text.replace(LINK, (raw, label, id) => {
    const title = titles[id]
    if (!title) return raw           // leave unknown ids alone, fix by hand
    return label === title ? '[[' + title + ']]' : '[[' + title + '|' + label + ']]'
  })
}
\`\`\`

## Next actions

- [x] Export the archive and commit it untouched
- [x] Count distinct link targets (1,412 links across 900 notes)
- [ ] Rewrite links, then diff the unresolved list against the old app
- [ ] Normalise \`tags:\` to the scheme in [[Tags and Metadata]]
- [ ] Split the ten worst offenders into [[Atomic Notes]]
- [ ] Draft [[PKM Map of Content|the home map]] for the merged vault

## Open questions

> [!warning] Attachments are the hard part
> 240 images live under content-hashed names with no extension. Decide whether
> to rename on import or keep the hashes and fix the embeds.

The 900 notes include maybe 60 worth keeping evergreen; the rest is log. Rather
than migrating everything twice, triage during phase 4 using
[[Progressive Summarization]]. Daily progress is in [[Daily/2026-01-15]] and
[[Daily/2026-01-19]].

#pkm/method
`,

  'Projects/Research Notebook.md': `---
title: Research Notebook
tags:
  - project
  - reading
status: active
---

# Research Notebook

A working system for the reading backlog: 40-odd papers and 6 books that keep
getting saved and never processed. #status/active

## The pipeline

1. **Capture** — anything interesting lands as one line in today's
   [[Daily Notes|daily note]] with a link.
2. **Source note** — one note per source, in \`Sources/\`, with frontmatter:
   - \`title\`, \`author\`, \`year\`, \`url\`
   - \`tags: [source/paper]\` or \`source/book\`
   - a one-paragraph "why I opened this"
3. **Layered reading** — the ladder in [[Progressive Summarization]], no more
   than layer two on the first pass.
4. **Extraction** — every claim I would cite becomes an
   [[Atomic Notes|atomic note]] outside \`Sources/\`, linked back to the source.
5. **Map** — when a subject reaches ten extracted notes, it earns a
   [[Maps of Content|map of content]].

## Rules that keep it honest

- A source note never contains original thinking. If I have an opinion, that
  opinion is its own note. This is the literature/permanent split from
  [[Zettelkasten]].
- No highlighting without a sentence of my own on the same pass.
- If a paper survives two weeks in the backlog untouched, it gets dropped. The
  backlog is a queue, not a museum.

## Current queue

- [x] Set up \`Sources/\` and the frontmatter template
- [x] Process the three papers from the December seminar
- [ ] Read [[Books/How to Take Smart Notes]] properly and write the source note
      — this link is intentionally unresolved until the note exists
- [ ] Extract the argument about interleaving into its own note, link from
      [[Spaced Repetition]]
- [ ] Decide whether \`Sources/\` should be excluded from
      [[The Graph View]] — 40 leaf nodes crowd the picture

## Metrics

| Week | Captured | Processed | Extracted notes |
| --- | --- | --- | --- |
| 2026-W01 | 11 | 3 | 7 |
| 2026-W02 | 6 | 5 | 12 |
| 2026-W03 | 4 | 4 | 9 |

Processed is trending toward captured, which is the only number that matters:
a backlog that shrinks is a system, and one that grows is a shelf.

See also [[Evergreen Notes]], [[Search Syntax]], [[PKM Map of Content]].

#pkm/method #status/active
`,

  /* ------------------------------------------------------------------ *
   * Daily
   * ------------------------------------------------------------------ */

  'Daily/2026-01-15.md': `---
title: 2026-01-15
tags: [daily]
---

# Thursday, 15 January 2026

## Log

- 08:50 Inbox zero-ish. Two papers saved to the queue in
  [[Projects/Research Notebook]].
- 10:15 Started phase 2 of [[Projects/Vault Migration]]. The id-to-title map
  came out cleanly; 1,412 links to rewrite.
- 14:00 Long detour reading about [[Zettelkasten|the slip-box method]]. Luhmann
  numbered his cards so a new one could be slotted *between* two old ones —
  branching, not appending. Worth a note of its own.
- 16:30 Wrote three [[Atomic Notes]] out of last week's meeting dump. The dump
  is now four lines and I do not miss the rest.

## Notes

- Filing forces one answer; linking allows many. Promote this into a real note
  and link it from [[Maps of Content]].
- The migration's unresolved-link list is basically a to-do list for the vault.
  Cross-check against [[Search Syntax#Operators]].

## Next actions

- [x] Commit the raw export untouched
- [x] Write the id map script
- [ ] Dry-run the link rewrite over \`vault/Concepts\`
- [ ] Ask about the attachment naming in [[Projects/Vault Migration]]

![[Projects/Vault Migration#Next actions]]

#status/done
`,

  'Daily/2026-01-16.md': `---
title: 2026-01-16
tags: [daily]
---

# Friday, 16 January 2026

## Log

- 09:10 Weekly review. Ran \`tag:status/active\` and got eleven notes, which is
  about eight more than I can actually work on.
- 11:40 Rewrote the link script after it mangled links inside code fences.
  Lesson learned twice now: parse, do not regex — except when you regex, in
  which case skip fenced blocks first. Same rule the app itself follows,
  see [[Markdown Basics]].
- 15:00 Read [[Progressive Summarization]] again and finally did layer four on
  the interleaving paper. Took eleven minutes; I had been avoiding it for three
  weeks.

## Notes

- A daily note is a buffer, not an archive — [[Daily Notes]] says this and I
  keep not believing it until Friday.
- Backlinks made the review trivial: opening [[Atomic Notes]] showed every note
  that leaned on it this week, without me maintaining a single index.
- Still owe the vault a note on refactoring: [[Note Refactoring]].

## Next actions

- [x] Weekly review
- [x] Fix the fenced-code bug in the rewriter
- [ ] Promote yesterday's "filing vs linking" line into a real note
- [ ] Skim [[Vault Map]] and prune the three dead entries

#status/done
`,

  'Daily/2026-01-19.md': `---
title: 2026-01-19
tags: [daily]
---

# Monday, 19 January 2026

## Log

- 08:30 Phase 2 of [[Projects/Vault Migration]] finished over the weekend.
  Unresolved links dropped from 340 to 61, and most of the remainder are real
  gaps rather than broken syntax.
- 10:00 Turned the graph on with tags enabled for the first time since the
  import. \`#status\` is doing all the clustering work; topic tags are noise, as
  [[Tags and Metadata]] warned.
- 13:20 Split the biggest surviving note (2,900 words on note-taking systems)
  into six [[Atomic Notes]]. Five of them immediately linked to something older.
- 17:00 Set up a card deck for the notation I keep re-looking-up. See
  [[Spaced Repetition]] — twelve cards, no more.

## Notes

- The graph is a diagnostic, not a dashboard. Today it showed one dense cluster
  and a fringe of orphans, and the fringe was the useful half. See
  [[The Graph View#Orphans]].
- Every note I split gained a backlink within an hour. Granularity really does
  buy connectivity, exactly as [[Atomic Notes#Why atomic]] claims.

## Next actions

- [x] Finish the link rewrite
- [x] Split the note-taking mega-note
- [ ] Normalise frontmatter across \`Concepts/\`
- [ ] Start the subject maps, beginning from [[PKM Map of Content]]
- [ ] Write the refactoring note already

#status/active
`,

  /* ------------------------------------------------------------------ *
   * Sandbox
   * ------------------------------------------------------------------ */

  'Sandbox/Formatting Playground.md': `---
title: Formatting Playground
tags: [sandbox, reference]
aliases: [Kitchen Sink]
draft: true
weight: 42
---

# Formatting Playground

Every syntax the renderer supports, on one page. Open this in split view and
edit the left side — the preview follows. The property table above comes from
this note's frontmatter, including the non-standard \`draft\` and \`weight\` keys.

## Inline

*Emphasis*, **strong**, ***both***, ~~struck through~~, \`inline code\`, and a
[external link](https://commonmark.org) that opens in a new tab.

Code spans are inert: \`[[not a link]]\` stays text, \`#nottag\` stays text, and
\`$x^2$\` is not typeset. That is the parser refusing to look inside code, which
is what makes [[Markdown Basics]] possible to write at all.

## Lists

- Top level
  - Second level
    - Third level, still readable
- Back to the top
  1. Ordered inside unordered
  2. Second
     - and unordered again

- [ ] Unchecked task
- [x] Checked task
- [ ] Task with a link to [[Atomic Notes]]

## Tables

| Feature | Syntax | Supported |
| --- | :---: | ---: |
| Wiki link | \`[[Note]]\` | yes |
| Aliased link | \`[[Note\\|shown]]\` | yes |
| Heading link | \`[[Note#Heading]]\` | yes |
| Embed | \`![[Note]]\` | yes |
| Callout | \`> [!note]\` | yes |
| Footnote | \`[^1]\` | yes |

Column three is right-aligned and column two centred, via the \`:---:\` markers
in the divider row.

## Quotes and callouts

> A plain blockquote. Nothing special, quoted verbatim.
> — somebody, probably

> [!note] Note callout
> For context the reader can skip.

> [!tip] Tip callout
> For the thing you wish you had known earlier.

> [!warning] Warning callout
> For the thing that will bite. Callouts nest ordinary markdown, including
> [[Linking Notes|links]] and \`code\`.

## Code

\`\`\`typescript
export interface WikiLink {
  target: string
  heading?: string
  alias?: string
  embed: boolean
}
\`\`\`

\`\`\`python
tags = [t for t in note.tags if t.startswith("status/")]
print(sorted(set(tags)))
\`\`\`

\`\`\`css
.internal-link.is-unresolved {
  color: var(--text-faint);
  text-decoration-style: dashed;
}
\`\`\`

\`\`\`
A fence with no language at all still renders as a block.
\`\`\`

## Math

Inline: Euler's identity is $e^{i\\pi}+1=0$, and the golden angle used by the
graph layout is $\\theta = \\pi(3-\\sqrt{5})$.

Display:

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$

Broken math like $\\notacommand{x}$ degrades to raw text instead of throwing.

## Links

Plain [[Evergreen Notes]], aliased [[Evergreen Notes|notes that keep growing]],
heading-anchored [[Search Syntax#Operators]], same-note [[#Tables]], and one
that resolves through an alias, [[Slip-box]].

## Embed

![[Concepts/Atomic Notes#Why atomic]]

---

Footnotes go at the bottom.[^1] They can hold links too.[^ref]

[^1]: A footnote. The marker is a link in the rendered output.
[^ref]: Another one, pointing at [[Progressive Summarization]].

#sandbox #status/parked
`,

  'Sandbox/Orphan Note.md': `---
title: Orphan Note
tags: [sandbox, orphan]
---

# Orphan Note

This note is deliberately disconnected. Nothing in the vault links to it, and it
links to nothing — every note name below is written in code formatting precisely
so that it does *not* become a link.

That makes it an orphan, and it is the only one here. Open the graph view and
look at the outer ring: this is the lonely dot.

## Why orphans matter

An orphan is not a bug. It is a note that has not been connected *yet*, and a
small number of them is the normal residue of capturing faster than you process.
What matters is the trend. A handful means an active inbox; a hundred means
capture has quietly become the whole system, and nothing is being thought about.

## How this one would be rescued

1. Read it and decide whether it holds an idea worth keeping. Most orphans do
   not, and deleting is a legitimate outcome.
2. If it does, split that idea out following \`Concepts/Atomic Notes.md\`.
3. Link the result to one older note — the rule from \`Concepts/Zettelkasten.md\`
   that every new note must attach to an existing one.
4. If a cluster is forming, list it on a map, per \`Concepts/Maps of Content.md\`.

Try it: add a link from here to any note and watch this dot snap into the
cluster on the next re-index. Then undo, and it drifts back out.

#sandbox #status/parked
`,
}

/**
 * The read-write in-memory vault shipped as the first-run experience.
 *
 * Edits are kept for the lifetime of the tab and then thrown away — the vault
 * picker offers a browser or on-disk vault when the user wants persistence.
 */
/** How far back the oldest demo note is stamped, so the list has some spread. */
const DEMO_AGE_SPREAD_MS = 1000 * 60 * 60 * 24 * 30

export function createDemoVault(): VaultAdapter {
  // Stamped from "now" rather than the memory vault's fixed test epoch, so the
  // demo does not open claiming every note was last modified years ago.
  return createMemoryVault(DEMO_NOTES, { name: 'Demo vault', baseMtime: Date.now() - DEMO_AGE_SPREAD_MS })
}
