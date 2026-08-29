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

/** Every whole-word, prose-only occurrence of `names` inside one note. */
function mentionsIn(note: Note, names: readonly string[]): UnlinkedMention[] {
  const content = note.content
  const offset = note.parsed.bodyOffset
  // Frontmatter is skipped entirely: an alias listed there is not a mention.
  const masked = maskNonProse(note.parsed.body)
  const haystack = masked.toLowerCase()
  const starts = lineTable(content)
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

export interface BacklinksPanelProps {
  path: NotePath
}

export function BacklinksPanel({ path }: BacklinksPanelProps): JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const index = useAppStore((state) => state.index)
  const openPath = useAppStore((state) => state.openPath)
  const reveal = useReveal()

  const [collapse, setCollapse] = useState<BacklinksCollapse>(loadCollapse)

  // Backlinks are derived, not stored: recompute when the note or the link
  // index changes (every edit anywhere in the vault rebuilds the index).
  const linked = useMemo<BacklinkGroup[]>(() => useAppStore.getState().backlinksFor(path), [path, index])

  // The expensive half. Memoised on the note map, so typing in an unrelated
  // note is the only thing that can trigger a rescan.
  const unlinked = useMemo<UnlinkedGroup[]>(() => {
    const linkedSources = new Set(linked.map((group) => group.source))
    return findUnlinkedMentions(path, notes, linkedSources)
  }, [path, notes, linked])

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
              {group.edges.map((edge, position) => {
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
              {group.mentions.map((mention) => {
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
            </div>
          ))
        )}
      </Section>
    </div>
  )
}

export default BacklinksPanel
