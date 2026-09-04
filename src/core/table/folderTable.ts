/**
 * SpaceLink — a folder read as a table.
 *
 * Every note in a folder is a row; every frontmatter key any of them uses is a
 * column. That is the whole idea, and it is why this needs no database: the
 * notes were already the records and the properties were already the fields,
 * and nothing here is stored anywhere. Sorting and filtering are computed from
 * the notes each time; editing a cell writes to that note's own frontmatter.
 *
 * Kept apart from the component that draws it because the interesting parts —
 * which columns exist, in what order, and how two values of different kinds
 * compare — are decisions worth testing without a DOM.
 */
import type { Note, NotePath } from '../../types'

/** A column, and how many notes in the folder actually use it. */
export interface TableColumn {
  key: string
  used: number
}

export interface TableRow {
  path: NotePath
  /** What the note is called: its title, else its file name. */
  name: string
  values: Readonly<Record<string, unknown>>
}

export interface FolderTable {
  columns: TableColumn[]
  rows: TableRow[]
}

/** Drawn as the page header, so they are not columns. */
const HEADER_KEYS = new Set(['icon', 'cover'])

/** The folder a path lives in, `''` for the vault root. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** Whether `path` is inside `folder`, at any depth. */
export function inFolder(path: string, folder: string): boolean {
  if (folder === '') return true
  return path.startsWith(`${folder}/`)
}

/**
 * The table for one folder, including its subfolders.
 *
 * Subfolders are included because that is what somebody means by "this folder":
 * a project with `Tasks/2024/` under it is still the project, and a table that
 * stopped at the first level would show a fraction of it with no sign that the
 * rest existed.
 *
 * Columns are ordered by how many notes use them, so the properties the folder
 * is actually organised around come first and a key one stray note carries goes
 * last. Ties are alphabetical, so the order is stable rather than incidental.
 */
export function buildFolderTable(notes: ReadonlyMap<NotePath, Note>, folder: string): FolderTable {
  const rows: TableRow[] = []
  const used = new Map<string, number>()

  for (const [path, note] of notes) {
    if (!inFolder(path, folder)) continue
    const values = note.parsed.frontmatter as Record<string, unknown>
    rows.push({
      path,
      name: note.parsed.title || (path.split('/').pop() ?? path).replace(/\.md$/i, ''),
      values,
    })
    for (const key of Object.keys(values)) {
      if (HEADER_KEYS.has(key)) continue
      used.set(key, (used.get(key) ?? 0) + 1)
    }
  }

  const columns = [...used.entries()]
    .map(([key, count]) => ({ key, used: count }))
    .sort((a, b) => b.used - a.used || a.key.localeCompare(b.key))

  rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return { columns, rows }
}

/** Every folder that holds at least one note, deepest paths included. */
export function foldersWithNotes(notes: ReadonlyMap<NotePath, Note>): string[] {
  const seen = new Set<string>()
  for (const path of notes.keys()) {
    let folder = folderOf(path)
    while (folder !== '') {
      seen.add(folder)
      folder = folderOf(folder)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** A cell as one line of text — what is shown, sorted and searched. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  if (typeof value === 'object') return ''
  return String(value)
}

/**
 * Compare two cells for sorting.
 *
 * Numbers compare as numbers — `10` after `9`, which sorting them as text gets
 * backwards. Everything else compares as text, case-insensitively.
 *
 * An empty cell always sorts last, in both directions. Sorting by a column is
 * how somebody asks to see what is *in* it; a column full of blanks at the top
 * of ascending order answers a different question.
 */
export function compareCells(a: unknown, b: unknown): number {
  const left = cellText(a)
  const right = cellText(b)
  if (left === '' || right === '') {
    if (left === right) return 0
    return left === '' ? 1 : -1
  }
  const na = Number(left)
  const nb = Number(right)
  if (left.trim() !== '' && right.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb
  }
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

export type SortDirection = 'asc' | 'desc'

/**
 * `rows` sorted by one column, or by name when `key` is null.
 *
 * Rows that tie are ordered by name, so a sort never shuffles rows it has
 * nothing to say about — the same table sorted the same way twice looks the
 * same both times.
 */
export function sortRows(rows: readonly TableRow[], key: string | null, direction: SortDirection): TableRow[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    if (key === null) return sign * (a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
    const by = compareCells(a.values[key], b.values[key])
    // The empty-last rule is not reversed by sorting descending: a blank is
    // still the absence of an answer, whichever end the answers are at.
    const bothFilled = cellText(a.values[key]) !== '' && cellText(b.values[key]) !== ''
    if (by !== 0) return bothFilled ? sign * by : by
    return a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  })
}

/**
 * `rows` narrowed to those matching `query`.
 *
 * A plain case-insensitive substring, over the note's name and every cell —
 * not the fuzzy match the quick switcher uses. Fuzzy is right for picking one
 * note out of a thousand by memory; a table filter is somebody narrowing a list
 * they can see, where "dr" quietly matching "Dashboard" is noise rather than
 * help.
 */
export function filterRows(rows: readonly TableRow[], query: string): TableRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) => {
    if (row.name.toLowerCase().includes(needle)) return true
    if (row.path.toLowerCase().includes(needle)) return true
    return Object.values(row.values).some((value) => cellText(value).toLowerCase().includes(needle))
  })
}
