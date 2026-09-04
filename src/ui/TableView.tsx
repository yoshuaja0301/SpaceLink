/**
 * SpaceLink — a folder shown as a table.
 *
 * Rows are the notes, columns are the frontmatter keys they use, and a cell is
 * editable: typing in one writes to that note's own frontmatter and nowhere
 * else. There is no database behind it and nothing is stored — the table is
 * computed from the notes each time, which is why it is always right and why a
 * note edited anywhere else shows up here immediately.
 *
 * The decisions worth arguing about — which columns exist, in what order, how
 * two values of different kinds compare — live in `core/table/folderTable.ts`
 * and are tested without a DOM. This draws them.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { setProperty } from '../core/markdown/frontmatter'
import type { SortDirection, TableRow } from '../core/table/folderTable'
import { buildFolderTable, cellText, filterRows, sortRows } from '../core/table/folderTable'
import { useAppStore } from '../state/store'
import type { NotePath } from '../types'
import { textToValue } from './PageHeader'

/** One editable cell. Commits on blur and on Enter, reverts on Escape. */
function Cell({
  row,
  column,
  onCommit,
}: {
  row: TableRow
  column: string
  onCommit: (path: NotePath, key: string, text: string) => void
}): JSX.Element {
  const value = row.values[column]
  const [draft, setDraft] = useState(() => cellText(value))
  const field = useRef<HTMLInputElement>(null)

  // The note can change underneath this cell — an edit in a tab, a sync from
  // another device — and the field has to follow unless it is being typed into.
  useEffect(() => {
    if (document.activeElement !== field.current) setDraft(cellText(value))
  }, [value])

  return (
    <input
      ref={field}
      className="table-cell-input"
      value={draft}
      aria-label={`${column} of ${row.name}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== cellText(value)) onCommit(row.path, column, draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(cellText(value))
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function TableView({ folder, paneId }: { folder: string; paneId: string }): JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const openPath = useAppStore((state) => state.openPath)
  const setNoteContent = useAppStore((state) => state.setNoteContent)

  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [direction, setDirection] = useState<SortDirection>('asc')

  const table = useMemo(() => buildFolderTable(notes, folder), [notes, folder])
  const rows = useMemo(
    () => sortRows(filterRows(table.rows, query), sortKey, direction),
    [table.rows, query, sortKey, direction],
  )

  // A column that disappears — the last note using it lost the property —
  // must not leave the table sorted by something that is no longer there.
  useEffect(() => {
    if (sortKey !== null && !table.columns.some((column) => column.key === sortKey)) setSortKey(null)
  }, [table.columns, sortKey])

  const commit = useCallback(
    (path: NotePath, key: string, text: string) => {
      const note = useAppStore.getState().notes.get(path)
      if (!note) return
      const next = setProperty(note.content, key, textToValue(text, note.parsed.frontmatter[key], key))
      if (next !== note.content) setNoteContent(path, next)
    },
    [setNoteContent],
  )

  const toggleSort = useCallback(
    (key: string) => {
      setSortKey((current) => {
        if (current === key) {
          setDirection((was) => (was === 'asc' ? 'desc' : 'asc'))
          return key
        }
        setDirection('asc')
        return key
      })
    },
    [],
  )

  const sortLabel = (key: string | null): 'ascending' | 'descending' | 'none' =>
    sortKey !== key ? 'none' : direction === 'asc' ? 'ascending' : 'descending'

  return (
    <div className="table-view">
      <div className="table-view-bar">
        <h2>{folder === '' ? 'All notes' : folder}</h2>
        <input
          className="table-view-filter"
          type="search"
          value={query}
          aria-label="Filter the table"
          placeholder="Filter…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="table-view-count">
          {rows.length} of {table.rows.length} {table.rows.length === 1 ? 'note' : 'notes'}
        </span>
      </div>

      {table.rows.length === 0 ? (
        <p className="table-view-empty">No notes in this folder yet.</p>
      ) : (
        <div className="table-view-scroll">
          <table className="table-view-grid">
            <thead>
              <tr>
                <th scope="col" aria-sort={sortLabel(null)}>
                  <button type="button" onClick={() => setSortKey(null)}>
                    Name
                  </button>
                </th>
                {table.columns.map((column) => (
                  <th key={column.key} scope="col" aria-sort={sortLabel(column.key)}>
                    <button type="button" onClick={() => toggleSort(column.key)}>
                      {column.key}
                      {sortKey === column.key && <span aria-hidden="true">{direction === 'asc' ? ' ↑' : ' ↓'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.path}>
                  <th scope="row">
                    <button
                      type="button"
                      className="table-view-open"
                      onClick={() => openPath(row.path, { paneId })}
                    >
                      {row.name}
                    </button>
                  </th>
                  {table.columns.map((column) => (
                    <td key={column.key}>
                      <Cell row={row} column={column.key} onCommit={commit} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="table-view-empty">Nothing matches “{query}”.</p>}
        </div>
      )}
    </div>
  )
}
