/**
 * SpaceLink — the note property card.
 *
 * Everything a reader might want to know about a note that is not the note
 * itself: where it lives, how big it is, how well connected it is, and what its
 * frontmatter claims.
 *
 * All of it is derived on the fly. Nothing here is stored, and nothing here
 * writes — the tag chips are the only interactive part, and they only hand a
 * query to the search panel.
 */
import type { JSX } from 'react'
import { useCallback, useMemo } from 'react'

import type { NotePath } from '../types'
import { useAppStore } from '../state/store'

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** Average adult reading speed, the usual figure for "N min read". */
export const WORDS_PER_MINUTE = 200

function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

/**
 * A relative timestamp: "just now", "2 hours ago", "3 months ago".
 *
 * Times in the future (clock skew between the file system and the browser) read
 * as "just now" rather than as a negative age.
 */
export function formatRelativeTime(time: number, now: number = Date.now()): string {
  if (!Number.isFinite(time) || time <= 0) return 'unknown'
  const diff = now - time
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return ago(Math.floor(diff / MINUTE), 'minute')
  if (diff < DAY) return ago(Math.floor(diff / HOUR), 'hour')
  if (diff < MONTH) return ago(Math.floor(diff / DAY), 'day')
  if (diff < YEAR) return ago(Math.floor(diff / MONTH), 'month')
  return ago(Math.floor(diff / YEAR), 'year')
}

/** Absolute timestamp for the tooltip; falls back to the ISO string. */
export function formatAbsoluteTime(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return 'unknown'
  const date = new Date(time)
  try {
    return date.toLocaleString()
  } catch {
    return date.toISOString()
  }
}

export function readingTime(words: number): string {
  if (!Number.isFinite(words) || words <= 0) return 'under a minute'
  return `${Math.max(1, Math.ceil(words / WORDS_PER_MINUTE))} min read`
}

/** Group digits so 12,481 characters stays readable. */
function formatCount(value: number): string {
  try {
    return value.toLocaleString()
  } catch {
    return String(value)
  }
}

/** Frontmatter values are unknown by type; render scalars, stringify the rest. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A creation time, when the note claims one.
 *
 * The vault only reports a modification time, so "created" can only come from
 * frontmatter. Anything unparseable is treated as absent rather than as 1970.
 */
export function createdFrom(frontmatter: Record<string, unknown>): number | null {
  for (const key of ['created', 'date', 'created_at', 'createdAt']) {
    const value = frontmatter[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

/** Frontmatter keys shown elsewhere in the card, so the table does not repeat them. */
const SHOWN_ELSEWHERE = new Set(['tags'])

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export interface NoteInfoProps {
  path: NotePath
}

export function NoteInfo({ path }: NoteInfoProps): JSX.Element {
  const note = useAppStore((state) => state.notes.get(path))
  const index = useAppStore((state) => state.index)
  const sidebarPanel = useAppStore((state) => state.sidebarPanel)
  const setSearchQuery = useAppStore((state) => state.setSearchQuery)
  const setSidebarPanel = useAppStore((state) => state.setSidebarPanel)

  const links = useMemo(() => {
    const outgoing = index.outgoing.get(path) ?? []
    let resolved = 0
    let unresolved = 0
    for (const edge of outgoing) {
      if (edge.to) resolved += 1
      else unresolved += 1
    }
    const backlinks = useAppStore
      .getState()
      .backlinksFor(path)
      .reduce((total, group) => total + group.edges.length, 0)
    return { resolved, unresolved, backlinks }
  }, [index, path])

  const openTag = useCallback(
    (tag: string): void => {
      setSearchQuery(`tag:${tag}`)
      // `setSidebarPanel` toggles when handed the panel that is already open.
      if (sidebarPanel !== 'search') setSidebarPanel('search')
    },
    [setSearchQuery, setSidebarPanel, sidebarPanel],
  )

  if (!note) {
    return (
      <div className="note-info panel">
        <div className="panel-header">
          <span>Note info</span>
        </div>
        <div className="panel-body">
          <div className="empty-state">
            <p>This note is no longer in the vault.</p>
          </div>
        </div>
      </div>
    )
  }

  const { parsed } = note
  const created = createdFrom(parsed.frontmatter)
  const properties = Object.entries(parsed.frontmatter).filter(([key]) => !SHOWN_ELSEWHERE.has(key))

  return (
    <div className="note-info panel">
      <div className="panel-header">
        <span>Note info</span>
      </div>

      <div className="panel-body">
        <div className="note-info-path" title={path}>
          {path}
        </div>

        <dl className="note-info-stats">
          {created !== null && (
            <div className="note-info-row">
              <dt>Created</dt>
              <dd title={formatAbsoluteTime(created)}>{formatRelativeTime(created)}</dd>
            </div>
          )}
          <div className="note-info-row">
            <dt>Modified</dt>
            <dd title={formatAbsoluteTime(note.mtime)}>{formatRelativeTime(note.mtime)}</dd>
          </div>
          <div className="note-info-row">
            <dt>Words</dt>
            <dd>{formatCount(parsed.wordCount)}</dd>
          </div>
          <div className="note-info-row">
            <dt>Reading time</dt>
            <dd>{readingTime(parsed.wordCount)}</dd>
          </div>
          <div className="note-info-row">
            <dt>Characters</dt>
            <dd>{formatCount(note.content.length)}</dd>
          </div>
          <div className="note-info-row">
            <dt>Outgoing links</dt>
            <dd title={`${links.resolved} resolved, ${links.unresolved} unresolved`}>
              {formatCount(links.resolved)}
              {links.unresolved > 0 && (
                <span className="note-info-unresolved"> · {formatCount(links.unresolved)} unresolved</span>
              )}
            </dd>
          </div>
          <div className="note-info-row">
            <dt>Backlinks</dt>
            <dd>{formatCount(links.backlinks)}</dd>
          </div>
        </dl>

        <div className="note-info-section">
          <div className="note-info-label">Tags</div>
          {parsed.allTags.length === 0 ? (
            <div className="note-info-empty">No tags</div>
          ) : (
            <div className="note-info-chips">
              {parsed.allTags.map((tag) => (
                <button
                  type="button"
                  className="tag"
                  key={tag}
                  title={`Search for #${tag}`}
                  onClick={() => openTag(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}
        </div>

        {properties.length > 0 && (
          <div className="note-info-section">
            <div className="note-info-label">Properties</div>
            <table className="note-info-properties">
              <tbody>
                {properties.map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    <td>
                      {Array.isArray(value) ? (
                        <span className="note-info-chips">
                          {value.length === 0 ? (
                            <span className="note-info-empty">—</span>
                          ) : (
                            value.map((entry, position) => (
                              <span className="note-info-chip" key={`${formatValue(entry)}:${position}`}>
                                {formatValue(entry)}
                              </span>
                            ))
                          )}
                        </span>
                      ) : (
                        formatValue(value)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default NoteInfo
