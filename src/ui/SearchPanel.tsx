/**
 * SpaceLink — full-text search.
 *
 * The query lives in the store (`searchQuery`), not in this component, so that
 * anything else can drive it: clicking a tag in the tag panel writes
 * `tag:project` and flips the sidebar over here, and the same query is shared
 * by the compact sidebar panel and the wide full-tab view.
 *
 * Both inputs to the search are debounced by {@link DEBOUNCE_MS} — the query
 * *and* the note map, which the store replaces on every keystroke anywhere in
 * the app. Debouncing only the query would leave a full-vault re-scan on the
 * editor's input path for as long as the panel holds a query. The search itself
 * runs inside a `useMemo`, and not at all while the panel is not the visible
 * one. Results are a flat, keyboard-navigable list of rows — one per note plus
 * one per shown line match — which keeps ArrowUp/ArrowDown honest about what is
 * actually on screen (a collapsed note contributes no match rows).
 *
 * Opening a line match fires a `spacelink:reveal-line` CustomEvent that the
 * editor listens for; see {@link useReveal} for why it is fired twice.
 */
import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Note, NotePath, SearchHit, SearchLineMatch } from '../types'
import { useAppStore } from '../state/store'
import { searchNotes } from '../core/search/engine'
import { highlight } from '../core/search/fuzzy'
import { Icon } from './Icon'

/** How long the input has to be quiet before the vault is searched. */
export const DEBOUNCE_MS = 120
/** Hard cap on notes returned, mirroring `searchNotes`' own default. */
export const RESULT_LIMIT = 200
/** Line matches rendered per note before the rest are summarised in the badge. */
export const MATCHES_PER_NOTE = 5

const RECENT_KEY = 'spacelink.recentSearches'
const RECENT_MAX = 8

/* ------------------------------------------------------------------ *
 * Query helpers
 * ------------------------------------------------------------------ */

/** One quick-filter chip: clicking it appends `operator` to the query. */
export interface QueryChip {
  label: string
  operator: string
  hint: string
}

export const QUERY_CHIPS: readonly QueryChip[] = [
  { label: 'tag:', operator: 'tag:', hint: 'Only notes carrying a tag' },
  { label: 'path:', operator: 'path:', hint: 'Only notes whose path contains this' },
  { label: 'file:', operator: 'file:', hint: 'Only notes whose file name contains this' },
  { label: '-', operator: '-', hint: 'Exclude notes containing a term' },
  { label: '"', operator: '"', hint: 'Match an exact phrase' },
]

/**
 * The query language, written out exactly as `parseQuery` implements it.
 * Kept next to the chips so the two never drift apart.
 */
const SYNTAX: readonly { example: string; description: string }[] = [
  { example: 'zettel note', description: 'Bare terms. Every one must appear in the note, its title or its path.' },
  { example: '"exact phrase"', description: 'Matched literally, spaces included.' },
  { example: '-draft', description: 'Drops notes containing the term. A lone - is just a term.' },
  { example: 'tag:project', description: 'Notes tagged #project, nested tags such as project/alpha included.' },
  { example: '#project', description: 'Shorthand for tag:project.' },
  { example: 'path:daily/', description: 'Substring of the note’s vault path.' },
  { example: 'file:index', description: 'Substring of the file name.' },
  { example: '/^#{1,2}\\s/i', description: 'A regular expression. Flags are honoured, ^ and $ mean line edges, and a pattern that does not compile is searched for literally.' },
  { example: 'tag:"my tag"', description: 'Quotes work after a field prefix. A token that starts with a quote is always a phrase, never a field.' },
]

/**
 * A note name to offer when a search finds nothing.
 *
 * The operators are stripped out of the *raw* query rather than rebuilt from
 * `parseQuery`, because the parser lowercases what it extracts and a note title
 * should keep the capitals the user typed.
 */
export function noteNameFromQuery(query: string): string {
  const cleaned = query
    .replace(/\/(?:\\.|[^/\\])+\/[a-zA-Z]*/g, ' ')
    .replace(/(^|\s)-\S+/g, ' ')
    .replace(/(^|\s)(?:tag|path|file):(?:"[^"]*"|\S*)/gi, ' ')
    .replace(/(^|\s)#\S+/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || query.trim()
}

/** Append an operator, inserting a separating space only when one is needed. */
export function appendOperator(query: string, operator: string): string {
  if (query.length === 0 || /\s$/.test(query)) return query + operator
  return `${query} ${operator}`
}

/* ------------------------------------------------------------------ *
 * Recent searches
 * ------------------------------------------------------------------ */

export function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, RECENT_MAX)
  } catch {
    // Private mode, quota, or a value written by an older build.
    return []
  }
}

function saveRecentSearches(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* nothing to do — recent searches are a convenience, not data */
  }
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** One navigable line in the result list. */
export interface ResultRow {
  key: string
  kind: 'note' | 'match'
  hit: SearchHit
  /** Set for `kind === 'match'`. */
  match: SearchLineMatch | null
}

/** A row plus its position in the flat, keyboard-navigable list. */
export interface PlacedRow {
  row: ResultRow
  index: number
}

/** Flatten hits into the rows the keyboard walks; collapsed notes hide theirs. */
export function buildRows(results: readonly SearchHit[], collapsed: ReadonlySet<NotePath>): ResultRow[] {
  const rows: ResultRow[] = []
  for (const hit of results) {
    rows.push({ key: hit.path, kind: 'note', hit, match: null })
    if (collapsed.has(hit.path)) continue
    for (const match of hit.matches.slice(0, MATCHES_PER_NOTE)) {
      rows.push({ key: `${hit.path}:${match.line}`, kind: 'match', hit, match })
    }
  }
  return rows
}

/* ------------------------------------------------------------------ *
 * Misc helpers
 * ------------------------------------------------------------------ */

function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** `performance` is absent in a few embedded runtimes; the clock still has to tick. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** `1 note` / `2 notes`, with an explicit plural for words `+s` gets wrong. */
function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/**
 * Ask the editor to scroll a note to a line. `line` is 0-based, as the window
 * event contract requires — search matches count from 1, so callers subtract.
 *
 * The event goes out twice on purpose. The immediate one reaches an editor that
 * is already showing the note; the deferred one reaches the editor React mounts
 * for a note that was not open yet. Listeners check `detail.path`, so an editor
 * still showing the previous note ignores the early event, and scrolling to the
 * same line twice is a no-op.
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
      window.dispatchEvent(new CustomEvent('spacelink:reveal-line', { detail: { path, line } }))
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
 * Component
 * ------------------------------------------------------------------ */

export interface SearchPanelProps {
  /** `tab` is the wide, centred full-tab view; `sidebar` (the default) is compact. */
  variant?: 'sidebar' | 'tab'
}

export function SearchPanel({ variant = 'sidebar' }: SearchPanelProps): JSX.Element {
  const notes = useAppStore((s) => s.notes)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const sidebarPanel = useAppStore((s) => s.sidebarPanel)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const openPath = useAppStore((s) => s.openPath)
  const createNoteFromTitle = useAppStore((s) => s.createNoteFromTitle)

  /** The query *and* note map the visible results were produced from. */
  const [applied, setApplied] = useState<{ query: string; notes: Map<NotePath, Note> }>(() => ({
    query: searchQuery,
    notes,
  }))
  const [collapsed, setCollapsed] = useState<Set<NotePath>>(() => new Set())
  const [selected, setSelected] = useState(0)
  const [recent, setRecent] = useState<string[]>(loadRecentSearches)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  /** Set when a chip click should put the caret back at the end of the input. */
  const caretToEnd = useRef(false)
  const reveal = useReveal()

  /** The sidebar keeps this panel mounted only while it is the chosen one. */
  const visible = variant === 'tab' || sidebarPanel === 'search'

  /* -- debounce ------------------------------------------------------ */

  // Both inputs settle together: an edit somewhere in the vault re-arms the
  // timer exactly as typing in the box does, so a burst of either produces one
  // search rather than one per keystroke.
  useEffect(() => {
    if (!visible) return undefined
    const timer = setTimeout(() => setApplied({ query: searchQuery, notes }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [visible, searchQuery, notes])

  /* -- search -------------------------------------------------------- */

  const { results, elapsed } = useMemo(() => {
    if (!visible || !applied.query.trim()) return { results: [] as SearchHit[], elapsed: 0 }
    const started = now()
    const hits = searchNotes(applied.query, applied.notes, { limit: RESULT_LIMIT })
    return { results: hits, elapsed: now() - started }
  }, [visible, applied])

  const rows = useMemo(() => buildRows(results, collapsed), [results, collapsed])
  const totalMatches = useMemo(() => results.reduce((sum, hit) => sum + hit.total, 0), [results])

  /**
   * The same rows, re-grouped per note for rendering. Keyboard navigation walks
   * the flat list, so every group carries the flat index of each of its rows
   * and the two views can never disagree about what "selected" means.
   */
  const groups = useMemo(() => {
    const out: { hit: SearchHit; note: PlacedRow; matches: PlacedRow[] }[] = []
    rows.forEach((row, index) => {
      if (row.kind === 'note') out.push({ hit: row.hit, note: { row, index }, matches: [] })
      else out[out.length - 1]?.matches.push({ row, index })
    })
    return out
  }, [rows])

  // A fresh result set invalidates the old selection outright.
  useEffect(() => {
    setSelected(0)
  }, [results])

  /* -- focus + scroll ------------------------------------------------ */

  // Becoming the visible sidebar panel means the user asked for search: take
  // the caret. The tab view owns its whole pane, so it focuses on mount.
  useEffect(() => {
    if (variant === 'sidebar' && sidebarPanel !== 'search') return
    inputRef.current?.focus?.()
  }, [variant, sidebarPanel])

  useEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(input.value.length, input.value.length)
    }
  })

  useEffect(() => {
    const row = rows[selected]
    if (!row) return
    const element = rowRefs.current.get(row.key)
    // jsdom has no layout and therefore no `scrollIntoView`.
    if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
  }, [rows, selected])

  const registerRow = useCallback((key: string) => {
    return (element: HTMLElement | null): void => {
      if (element) rowRefs.current.set(key, element)
      else rowRefs.current.delete(key)
    }
  }, [])

  /* -- recent searches ----------------------------------------------- */

  /** Remember a query once the user has actually acted on its results. */
  const remember = useCallback((query: string): void => {
    const trimmed = query.trim()
    if (!trimmed) return
    setRecent((prev) => {
      const next = [trimmed, ...prev.filter((entry) => entry !== trimmed)].slice(0, RECENT_MAX)
      saveRecentSearches(next)
      return next
    })
  }, [])

  const clearRecent = useCallback((): void => {
    setRecent([])
    saveRecentSearches([])
  }, [])

  /* -- actions ------------------------------------------------------- */

  const openRow = useCallback(
    (row: ResultRow, newTab: boolean): void => {
      remember(applied.query)
      openPath(row.hit.path, { newTab })
      // `SearchLineMatch.line` counts from 1; the event contract is 0-based.
      if (row.match) reveal(row.hit.path, row.match.line - 1)
    },
    [applied, openPath, remember, reveal],
  )

  const toggleCollapsed = useCallback((path: NotePath): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const applyChip = useCallback(
    (operator: string): void => {
      caretToEnd.current = true
      setSearchQuery(appendOperator(searchQuery, operator))
    },
    [searchQuery, setSearchQuery],
  )

  const clearQuery = useCallback((): void => {
    caretToEnd.current = true
    setSearchQuery('')
  }, [setSearchQuery])

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        clearQuery()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (rows.length === 0) return
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setSelected((prev) => Math.max(0, Math.min(rows.length - 1, prev + step)))
        return
      }
      if (event.key === 'Enter') {
        // A focused button activates itself on Enter; opening here as well
        // would open the row twice.
        if (event.target instanceof HTMLButtonElement) return
        const row = rows[selected]
        if (!row) return
        event.preventDefault()
        openRow(row, event.metaKey || event.ctrlKey)
      }
    },
    [clearQuery, openRow, rows, selected],
  )

  /* -- render -------------------------------------------------------- */

  const trimmed = searchQuery.trim()
  const searching = applied.query.trim().length > 0
  const createName = noteNameFromQuery(applied.query)

  const summary = searching
    ? `${plural(results.length, 'note')}${results.length >= RESULT_LIMIT ? ` (first ${RESULT_LIMIT})` : ''} · ${plural(totalMatches, 'match', 'matches')} · ${elapsed.toFixed(1)} ms`
    : ''

  const renderMatch = ({ row, index }: PlacedRow): JSX.Element | null => {
    const match = row.match
    if (!match) return null
    return (
      <button
        key={row.key}
        type="button"
        ref={registerRow(row.key)}
        className={classes('search-match', index === selected && 'is-selected')}
        aria-current={index === selected ? true : undefined}
        title={`Line ${match.line}`}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          setSelected(index)
          openRow(row, event.metaKey || event.ctrlKey)
        }}
      >
        {/* `highlight` escapes everything it does not wrap in <mark>. */}
        <span dangerouslySetInnerHTML={{ __html: highlight(match.text, match.ranges) }} />
      </button>
    )
  }

  const renderNote = ({ row, index }: PlacedRow): JSX.Element => {
    const hit = row.hit
    const isCollapsed = collapsed.has(hit.path)
    return (
      <div className="search-result-row" key={row.key}>
        <button
          type="button"
          className={classes('search-result-collapse', isCollapsed && 'is-collapsed')}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand matches in ${hit.title}` : `Collapse matches in ${hit.title}`}
          onClick={() => toggleCollapsed(hit.path)}
        >
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
        </button>
        <button
          type="button"
          ref={registerRow(row.key)}
          className={classes('search-result-title', index === selected && 'is-selected')}
          aria-current={index === selected ? true : undefined}
          title={hit.path}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
            setSelected(index)
            openRow(row, event.metaKey || event.ctrlKey)
          }}
        >
          <span className="search-result-name">{hit.title}</span>
          <span className="search-result-path">{hit.path}</span>
          <span className="nav-file-count">{hit.total}</span>
        </button>
      </div>
    )
  }

  return (
    <div
      className={classes('search-panel', variant === 'tab' ? 'is-tab' : 'is-sidebar')}
      role="search"
      onKeyDown={onKeyDown}
    >
      {variant === 'sidebar' ? (
        <div className="sidebar-header">
          <div className="sidebar-title">Search</div>
        </div>
      ) : null}

      <div className="search-toolbar">
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          value={searchQuery}
          spellCheck={false}
          autoComplete="off"
          placeholder="Search notes…"
          aria-label="Search notes"
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {trimmed.length > 0 ? (
          <button type="button" className="search-clear" aria-label="Clear search" title="Clear search" onClick={clearQuery}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </div>

      <div className="search-chips" role="group" aria-label="Quick filters">
        {QUERY_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className="search-chip"
            title={chip.hint}
            onClick={() => applyChip(chip.operator)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <details className="search-help">
        <summary>Query syntax</summary>
        <dl className="search-help-list">
          {SYNTAX.map((entry) => (
            <div className="search-help-entry" key={entry.example}>
              <dt>
                <code>{entry.example}</code>
              </dt>
              <dd>{entry.description}</dd>
            </div>
          ))}
        </dl>
      </details>

      {searching ? (
        <div className="search-summary" role="status">
          {summary}
        </div>
      ) : null}

      <div className="search-results">
        {!searching ? (
          <div className="search-idle">
            <p className="empty-state">
              Search every note in the vault. Combine terms with <code>tag:</code>, <code>path:</code>, <code>file:</code>,{' '}
              <code>&quot;phrases&quot;</code> and <code>-exclusions</code>.
            </p>
            {recent.length > 0 ? (
              <div className="search-recent">
                <div className="search-recent-header">
                  <span>Recent searches</span>
                  <button type="button" className="search-recent-clear" onClick={clearRecent}>
                    Clear
                  </button>
                </div>
                {recent.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className="search-recent-item"
                    onClick={() => {
                      caretToEnd.current = true
                      setSearchQuery(entry)
                    }}
                  >
                    <Icon name="search" size={12} />
                    <span>{entry}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : results.length === 0 ? (
          <div className="empty-state search-no-results">
            <p>No notes match that query.</p>
            <button
              type="button"
              className="empty-state-action"
              onClick={() => void createNoteFromTitle(createName)}
            >
              Create note named “{createName}”
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <div className="search-result" key={group.hit.path}>
              {renderNote(group.note)}
              {group.matches.map((placed) => renderMatch(placed))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default SearchPanel
