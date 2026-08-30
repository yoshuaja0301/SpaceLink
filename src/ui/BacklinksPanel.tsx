/**
 * SpaceFore — the backlinks pane.
 *
 * Two sections, both about the same question: what else in the vault talks
 * about this note?
 *
 * *Linked mentions* come straight from the link index (`backlinksFor`), grouped
 * by source note. *Unlinked mentions* are computed here, because nothing else
 * needs them: every other note is scanned for the target's title, filename or
 * an alias appearing as a whole word, and each hit is offered with a "Link"
 * button that rewrites exactly that occurrence into a wiki link.
 *
 * The scan deliberately ignores text that is not prose — fenced code, inline
 * code spans, HTML comments, and anything already inside a link — so the panel
 * never suggests linking a code sample or double-linking an existing link. It
 * also skips notes that already link here: those are linked mentions, and
 * showing them twice would be noise.
 *
 * Offsets recorded for a mention index the source note's *full* content
 * (frontmatter included), which is what `setNoteContent` expects. They are
 * re-verified at click time, so a mention that has drifted since the last
 * render fails safely instead of corrupting the note.
 *
 * The scan reads the whole vault, so it is kept off the typing path three ways:
 * the per-note masking it needs is cached on the note object, the rescan trails
 * a typing burst on a timer, and it does not run at all while the panel is off
 * screen.
 */
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BacklinkGroup, Note, NotePath } from '../types'
import { useAppStore } from '../state/store'
import { Icon } from './Icon'

/* ------------------------------------------------------------------ *
 * Masking — what the unlinked scan is allowed to see
 * ------------------------------------------------------------------ */

/** Blank out every character except newlines, so offsets and line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

/** Opening/closing fence for a code block, with up to three spaces of indent. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Runs masked inside a single line. Order matters: code spans first, so a link
 * written inside backticks is already gone by the time the link patterns run.
 */
const INLINE_MASKS: readonly RegExp[] = [
  /(`+)[^\n]*?\1/g, // inline code spans
  /!?\[\[[^\]\n]*\]\]/g, // wiki links and embeds
  /\[[^\]\n]*\]\([^)\n]*\)/g, // markdown links (text and url)
]

/**
 * Replace everything that is not prose with spaces of the same length.
 *
 * The result lines up character-for-character with the input, so an index into
 * the masked text is also an index into the original.
 */
export function maskNonProse(text: string): string {
  // HTML comments can span lines, so they are masked before the line scan.
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, blank)
  let fence: string | null = null
  return withoutComments
    .split('\n')
    .map((line) => {
      const match = FENCE.exec(line)
      if (fence !== null) {
        // A fence closes on a run of the same character that is at least as long.
        if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length) fence = null
        return blank(line)
      }
      if (match) {
        fence = match[1]!
        return blank(line)
      }
      let masked = line
      for (const pattern of INLINE_MASKS) masked = masked.replace(pattern, blank)
      return masked
    })
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * Unlinked mentions
 * ------------------------------------------------------------------ */

/** One occurrence of the target note's name in another note. */
export interface UnlinkedMention {
  /** Offset of the match inside the source note's full content. */
  start: number
  /** Exclusive end offset. */
  end: number
  /** The matched text exactly as it is written in the source. */
  text: string
  /** 1-based line number of the match. */
  line: number
  /** The trimmed source line, for display. */
  context: string
  /** Index of the match inside `context`. */
  contextStart: number
}

export interface UnlinkedGroup {
  source: NotePath
  title: string
  mentions: UnlinkedMention[]
}

/** Letters, digits and `_` — the characters a whole-word match may not touch. */
const WORD_CHAR = /[\p{L}\p{N}_]/u

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

/**
 * Every name that should count as a mention of `note`: its title, its filename
 * and each frontmatter alias, deduped case-insensitively and sorted longest
 * first so "Zettelkasten Method" wins over "Zettelkasten".
 *
 * One-character names are dropped — they match far too much to be useful.
 */
export function mentionNames(note: Note): string[] {
  const candidates: unknown[] = [note.parsed.title, note.name]
  const aliases = note.parsed.frontmatter.aliases
  if (Array.isArray(aliases)) candidates.push(...aliases)

  const seen = new Set<string>()
  const names: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const name = candidate.trim()
    if (name.length < 2) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names.sort((a, b) => b.length - a.length)
}

/** Offsets at which each line of `content` starts. */
function lineTable(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** Index into `starts` of the line containing `offset` (binary search). */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/** Everything the scan needs from one note before it knows what it is looking for. */
interface ScanSource {
  /** Prose only, lined up character-for-character with the note's body. */
  masked: string
  /** `masked` lowercased once, so a case-insensitive sweep costs nothing extra. */
  haystack: string
  /** Offsets at which each line of the note's full content starts. */
  starts: number[]
}

/**
 * Masking a note and walking it for line starts is the entire cost of the scan,
 * and both are pure functions of the note's text — nothing about them depends
 * on which note the panel is describing. `makeNote` builds a fresh `Note`
 * whenever content changes, so a `WeakMap` keyed on the note is exactly as
 * stale as the note is (never), and the entry is collected along with it.
 */
const SCAN_CACHE = new WeakMap<Note, ScanSource>()

function scanSourceOf(note: Note): ScanSource {
  const cached = SCAN_CACHE.get(note)
  if (cached) return cached
  // Frontmatter is skipped entirely: an alias listed there is not a mention.
  const masked = maskNonProse(note.parsed.body)
  const source: ScanSource = { masked, haystack: masked.toLowerCase(), starts: lineTable(note.content) }
  SCAN_CACHE.set(note, source)
  return source
}

/** Every whole-word, prose-only occurrence of `names` inside one note. */
function mentionsIn(note: Note, names: readonly string[]): UnlinkedMention[] {
  const content = note.content
  const offset = note.parsed.bodyOffset
  const { masked, haystack, starts } = scanSourceOf(note)
  const found: UnlinkedMention[] = []

  for (const name of names) {
    const needle = name.toLowerCase()
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const stop = at + needle.length
      if (isWordChar(masked[at - 1]) || isWordChar(masked[stop])) continue

      const start = offset + at
      const end = offset + stop
      // Names are tried longest first, so an overlap means a better name won.
      if (found.some((mention) => start < mention.end && end > mention.start)) continue

      const lineIndex = lineIndexAt(starts, start)
      const lineStart = starts[lineIndex]!
      const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1]! - 1 : content.length
      const raw = content.slice(lineStart, lineEnd)
      const lead = raw.length - raw.trimStart().length

      found.push({
        start,
        end,
        text: content.slice(start, end),
        line: lineIndex + 1,
        context: raw.trim(),
        contextStart: Math.max(0, start - lineStart - lead),
      })
    }
  }

  found.sort((a, b) => a.start - b.start)
  return found
}

/**
 * Notes that name `path` in prose without linking to it.
 *
 * `linkedSources` are the notes that already link here; they are skipped so a
 * note never shows up in both sections.
 */
export function findUnlinkedMentions(
  path: NotePath,
  notes: ReadonlyMap<NotePath, Note>,
  linkedSources: ReadonlySet<NotePath>,
): UnlinkedGroup[] {
  const target = notes.get(path)
  if (!target) return []
  const names = mentionNames(target)
  if (names.length === 0) return []

  const groups: UnlinkedGroup[] = []
  for (const [source, note] of notes) {
    if (source === path || linkedSources.has(source)) continue
    const mentions = mentionsIn(note, names)
    if (mentions.length > 0) {
      groups.push({ source, title: note.parsed.title || note.name, mentions })
    }
  }
  groups.sort(
    (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.source.localeCompare(b.source),
  )
  return groups
}

/** The names a note is searched for, as one comparable value. */
function namesKey(note: Note): string {
  return mentionNames(note).join('\0')
}

/**
 * Whether a new note map can change what the scan for `path` reports.
 *
 * The scan reads every note *except* the one being described, plus that note's
 * names — so the keystroke that replaces the map is usually invisible to it:
 * the panel follows the note the reader is typing in, and its prose is the one
 * thing the scan never looks at. Renaming it, or editing any other note, does
 * matter.
 *
 * Only identities are compared, which is cheap; the notes themselves are
 * immutable, so a note that is the same object holds the same text.
 */
function scanInputsChanged(
  previous: ReadonlyMap<NotePath, Note>,
  next: ReadonlyMap<NotePath, Note>,
  path: NotePath,
): boolean {
  if (previous === next) return false
  if (previous.size !== next.size) return true
  const before = previous.get(path)
  const after = next.get(path)
  if (before !== after && (!before || !after || namesKey(before) !== namesKey(after))) return true
  for (const [source, note] of next) {
    if (source !== path && previous.get(source) !== note) return true
  }
  return false
}

/**
 * The text a new `[[link]]` should carry.
 *
 * The filename — not the title — because that is what link resolution matches
 * first; a frontmatter title that is neither the filename nor an alias would
 * produce a link that does not resolve.
 */
export function linkTargetFor(note: Note): string {
  return note.name
}

/**
 * Rewrite one recorded occurrence into a wiki link.
 *
 * Returns `null` when the source note no longer reads the way it did when the
 * mention was found, so a stale click is a no-op rather than a corruption. When
 * the mention is not spelled exactly like the target (an alias, different case)
 * the original wording is kept as the link's display text.
 */
export function linkMention(content: string, mention: UnlinkedMention, target: string): string | null {
  if (content.slice(mention.start, mention.end) !== mention.text) return null
  const link = mention.text === target ? `[[${target}]]` : `[[${target}|${mention.text}]]`
  return content.slice(0, mention.start) + link + content.slice(mention.end)
}

/* ------------------------------------------------------------------ *
 * Context rendering
 * ------------------------------------------------------------------ */

export interface ContextParts {
  before: string
  /** The part to emphasise. Empty when the link could not be located. */
  match: string
  after: string
}

/**
 * Split a backlink context line around the link that produced it.
 *
 * `LinkEdge` only carries the trimmed source line and the target as written, so
 * the raw `[[…]]` is found by re-scanning the line. Markdown links and links
 * whose text differs from the target fall back to the plain target text.
 */
export function splitContext(context: string, targetText: string): ContextParts {
  const wanted = targetText.trim().toLowerCase()
  const wiki = /!?\[\[([^\]\n]+)\]\]/g
  for (let match = wiki.exec(context); match !== null; match = wiki.exec(context)) {
    const inner = match[1]!
    const pipe = inner.indexOf('|')
    const linkPart = pipe === -1 ? inner : inner.slice(0, pipe)
    const fragment = linkPart.search(/[#^]/)
    const target = (fragment === -1 ? linkPart : linkPart.slice(0, fragment)).trim().toLowerCase()
    if (target === wanted) {
      return {
        before: context.slice(0, match.index),
        match: match[0],
        after: context.slice(match.index + match[0].length),
      }
    }
  }
  if (wanted) {
    const at = context.toLowerCase().indexOf(wanted)
    if (at !== -1) {
      return {
        before: context.slice(0, at),
        match: context.slice(at, at + wanted.length),
        after: context.slice(at + wanted.length),
      }
    }
  }
  return { before: context, match: '', after: '' }
}

/** Split a context line using offsets we already know are correct. */
function splitAt(context: string, start: number, length: number): ContextParts {
  return {
    before: context.slice(0, start),
    match: context.slice(start, start + length),
    after: context.slice(start + length),
  }
}

/* ------------------------------------------------------------------ *
 * Collapse state
 * ------------------------------------------------------------------ */

const COLLAPSE_KEY = 'spacefore.backlinksCollapsed'

export interface BacklinksCollapse {
  linked: boolean
  unlinked: boolean
}

const EXPANDED: BacklinksCollapse = { linked: false, unlinked: false }

export function loadCollapse(): BacklinksCollapse {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return { ...EXPANDED }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...EXPANDED }
    const record = parsed as Record<string, unknown>
    return { linked: record.linked === true, unlinked: record.unlinked === true }
  } catch {
    return { ...EXPANDED }
  }
}

function saveCollapse(state: BacklinksCollapse): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state))
  } catch {
    /* private mode / quota — the sections just reopen next time */
  }
}

/* ------------------------------------------------------------------ *
 * Reveal
 * ------------------------------------------------------------------ */

/**
 * Ask the editor to scroll a note to a line.
 *
 * Fired twice: once for an editor already showing the note, and once on the
 * next tick for the editor React mounts when the note was not open yet.
 */
function useReveal(): (path: NotePath, line: number) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  return useCallback((path: NotePath, line: number): void => {
    if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return
    const fire = (): void => {
      window.dispatchEvent(new CustomEvent('spacefore:reveal-line', { detail: { path, line } }))
    }
    fire()
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      fire()
    }, 0)
  }, [])
}

/* ------------------------------------------------------------------ *
 * Section shell
 * ------------------------------------------------------------------ */

interface SectionProps {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}

function Section({ title, count, collapsed, onToggle, children }: SectionProps): JSX.Element {
  return (
    <section className={collapsed ? 'panel is-collapsed' : 'panel'}>
      <button
        type="button"
        className="panel-header"
        aria-expanded={!collapsed}
        title={collapsed ? `Expand ${title.toLowerCase()}` : `Collapse ${title.toLowerCase()}`}
        onClick={onToggle}
      >
        <span>{title}</span>
        <span className="tag-count">{count}</span>
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
      </button>
      <div className="panel-body">{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

/** Trailing debounce before a typing burst is reflected in the unlinked scan. */
/**
 * How many context lines one source note shows before it asks.
 *
 * A note that a long journal links from every line has thousands of mentions,
 * and rendering all of them puts tens of thousands of elements in the sidebar —
 * enough that typing in the note itself stutters, because every keystroke
 * rebuilds the index this panel is derived from. Showing a page at a time costs
 * the same on a note with three backlinks and bounds what any one click adds.
 */
const CONTEXTS_SHOWN = 20
const CONTEXTS_PER_STEP = 200

interface ShowMoreProps {
  total: number
  showing: number
  onClick: () => void
}

/** The row at the end of a truncated group. Renders nothing when nothing is hidden. */
function ShowMore({ total, showing, onClick }: ShowMoreProps): JSX.Element | null {
  const hidden = total - showing
  if (hidden <= 0) return null
  const step = Math.min(hidden, CONTEXTS_PER_STEP)
  return (
    <button type="button" className="backlink-more" onClick={onClick}>
      {`Show ${step.toLocaleString()} more of ${hidden.toLocaleString()}`}
    </button>
  )
}

const RESCAN_MS = 250

/** Stable identity for "nothing was scanned", so the memos below do not churn. */
const NO_GROUPS: readonly UnlinkedGroup[] = []

export interface BacklinksPanelProps {
  path: NotePath
  /** False while the panel is off screen; the unlinked scan is then skipped entirely. */
  visible?: boolean
}

export function BacklinksPanel({ path, visible = true }: BacklinksPanelProps): JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const index = useAppStore((state) => state.index)
  const openPath = useAppStore((state) => state.openPath)
  const reveal = useReveal()

  const [collapse, setCollapse] = useState<BacklinksCollapse>(loadCollapse)
  // The note map the scan last ran against. It trails `notes`, catching up only
  // once the typing stops, so a burst of keystrokes costs one scan at most
  // instead of one per character.
  const [scanNotes, setScanNotes] = useState<ReadonlyMap<NotePath, Note>>(notes)

  // How much of each source note the reader has asked to see, by section and
  // source. Reset when the note changes: the previous note's groups are gone.
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map())
  useEffect(() => setShown(new Map()), [path])

  const limitOf = useCallback(
    (section: string, source: NotePath): number => shown.get(`${section}:${source}`) ?? CONTEXTS_SHOWN,
    [shown],
  )
  const showMore = useCallback((section: string, source: NotePath): void => {
    setShown((previous) => {
      const key = `${section}:${source}`
      const next = new Map(previous)
      next.set(key, (previous.get(key) ?? CONTEXTS_SHOWN) + CONTEXTS_PER_STEP)
      return next
    })
  }, [])

  // Backlinks are derived, not stored: recompute when the note or the link
  // index changes (every edit anywhere in the vault rebuilds the index).
  const linked = useMemo<BacklinkGroup[]>(() => useAppStore.getState().backlinksFor(path), [path, index])

  const linkedSources = useMemo(() => new Set(linked.map((group) => group.source)), [linked])
  // The same set as a value, because `linked` is a fresh array on every index
  // rebuild and most rebuilds leave the set of linking notes alone.
  const linkedKey = useMemo(() => [...linkedSources].sort().join('\n'), [linkedSources])

  useEffect(() => {
    if (!visible || !scanInputsChanged(scanNotes, notes, path)) return undefined
    const timer = setTimeout(() => setScanNotes(notes), RESCAN_MS)
    return () => clearTimeout(timer)
  }, [visible, notes, scanNotes, path])

  // The expensive half: linear in the vault's prose, and re-run only when the
  // set of notes, this note's names or the notes already linking here change.
  // `linkedKey` stands in for `linkedSources`, which changes identity far more
  // often than it changes content.
  const unlinked = useMemo<readonly UnlinkedGroup[]>(
    () => (visible ? findUnlinkedMentions(path, scanNotes, linkedSources) : NO_GROUPS),
    [visible, path, scanNotes, linkedKey],
  )

  const linkedCount = useMemo(() => linked.reduce((total, group) => total + group.edges.length, 0), [linked])
  const unlinkedCount = useMemo(
    () => unlinked.reduce((total, group) => total + group.mentions.length, 0),
    [unlinked],
  )

  const toggle = useCallback((section: keyof BacklinksCollapse): void => {
    setCollapse((previous) => {
      const next = { ...previous, [section]: !previous[section] }
      saveCollapse(next)
      return next
    })
  }, [])

  const openContext = useCallback(
    (source: NotePath, line: number): void => {
      openPath(source)
      reveal(source, line)
    },
    [openPath, reveal],
  )

  /** Turn one recorded mention into a wiki link inside its source note. */
  const linkUp = useCallback(
    (source: NotePath, mention: UnlinkedMention): void => {
      const state = useAppStore.getState()
      const note = state.notes.get(source)
      const target = state.notes.get(path)
      if (!note || !target) return
      const updated = linkMention(note.content, mention, linkTargetFor(target))
      if (updated === null) {
        state.pushToast(`${note.parsed.title || note.name} changed — that mention has moved`, 'error')
        return
      }
      state.setNoteContent(source, updated)
    },
    [path],
  )

  const targetName = notes.get(path)?.name ?? ''

  return (
    <div className="backlinks-panel">
      <Section
        title="Linked mentions"
        count={linkedCount}
        collapsed={collapse.linked}
        onToggle={() => toggle('linked')}
      >
        {linked.length === 0 ? (
          <div className="empty-state">
            <p>No linked mentions.</p>
            <p>
              Write <code>[[{targetName || 'this note'}]]</code> somewhere to link here.
            </p>
          </div>
        ) : (
          linked.map((group) => (
            <div className="backlink-group" key={group.source}>
              <button
                type="button"
                className="nav-item"
                title={group.source}
                onClick={() => openPath(group.source)}
              >
                <Icon name="file" size={13} />
                <span className="nav-item-title">{group.title}</span>
                <span className="tag-count">{group.edges.length}</span>
              </button>
              {group.edges.slice(0, limitOf('linked', group.source)).map((edge, position) => {
                const parts = splitContext(edge.context, edge.targetText)
                return (
                  <button
                    type="button"
                    className="backlink-context"
                    key={`${edge.line}:${position}`}
                    title={`${group.source}:${edge.line}`}
                    onClick={() => openContext(group.source, edge.line)}
                  >
                    {parts.before}
                    {parts.match && <mark className="backlink-match">{parts.match}</mark>}
                    {parts.after}
                  </button>
                )
              })}
              <ShowMore
                total={group.edges.length}
                showing={limitOf('linked', group.source)}
                onClick={() => showMore('linked', group.source)}
              />
            </div>
          ))
        )}
      </Section>

      <Section
        title="Unlinked mentions"
        count={unlinkedCount}
        collapsed={collapse.unlinked}
        onToggle={() => toggle('unlinked')}
      >
        {unlinked.length === 0 ? (
          <div className="empty-state">
            <p>No unlinked mentions.</p>
            <p>Every note that names this one already links to it.</p>
          </div>
        ) : (
          unlinked.map((group) => (
            <div className="backlink-group" key={group.source}>
              <button
                type="button"
                className="nav-item"
                title={group.source}
                onClick={() => openPath(group.source)}
              >
                <Icon name="file" size={13} />
                <span className="nav-item-title">{group.title}</span>
                <span className="tag-count">{group.mentions.length}</span>
              </button>
              {group.mentions.slice(0, limitOf('unlinked', group.source)).map((mention) => {
                const parts = splitAt(mention.context, mention.contextStart, mention.text.length)
                return (
                  <div className="backlink-mention" key={mention.start}>
                    <button
                      type="button"
                      className="backlink-context"
                      title={`${group.source}:${mention.line}`}
                      onClick={() => openContext(group.source, mention.line)}
                    >
                      {parts.before}
                      {parts.match && <mark className="backlink-match">{parts.match}</mark>}
                      {parts.after}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost backlink-link"
                      aria-label={`Link mention in ${group.title} on line ${mention.line}`}
                      title={`Turn this into [[${targetName}]]`}
                      onClick={() => linkUp(group.source, mention)}
                    >
                      <Icon name="link" size={12} />
                      <span>Link</span>
                    </button>
                  </div>
                )
              })}
              <ShowMore
                total={group.mentions.length}
                showing={limitOf('unlinked', group.source)}
                onClick={() => showMore('unlinked', group.source)}
              />
            </div>
          ))
        )}
      </Section>
    </div>
  )
}

export default BacklinksPanel
