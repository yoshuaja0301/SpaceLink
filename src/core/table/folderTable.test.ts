import { describe, expect, it } from 'vitest'

import { makeNote } from '../../state/store'
import type { Note, NotePath } from '../../types'
import {
  buildFolderTable,
  cellText,
  compareCells,
  filterRows,
  foldersWithNotes,
  inFolder,
  sortRows,
} from './folderTable'

/** A vault of notes, given as path → frontmatter. */
function vault(entries: Record<string, string>): Map<NotePath, Note> {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(entries)) {
    notes.set(path as NotePath, makeNote(path as NotePath, content, 0))
  }
  return notes
}

const PROJECT = vault({
  'Projects/Alpha.md': '---\nstatus: doing\nowner: me\ndue: 3\n---\n# Alpha\n',
  'Projects/Beta.md': '---\nstatus: done\nowner: you\n---\n# Beta\n',
  'Projects/Deep/Gamma.md': '---\nstatus: doing\nonlyhere: yes\n---\n# Gamma\n',
  'Elsewhere/Other.md': '---\nstatus: doing\n---\n# Other\n',
})

describe('reading a folder as a table', () => {
  it('takes every note under the folder, subfolders included', () => {
    // A project with `Tasks/2024/` under it is still the project. A table that
    // stopped at the first level would show a fraction of it with no sign the
    // rest existed.
    const table = buildFolderTable(PROJECT, 'Projects')
    expect(table.rows.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(table.rows.map((row) => row.path)).not.toContain('Elsewhere/Other.md')
  })

  it('takes the whole vault for the root', () => {
    expect(buildFolderTable(PROJECT, '').rows).toHaveLength(4)
  })

  it('orders columns by how many notes actually use them', () => {
    // The properties the folder is organised around come first; a key one
    // stray note carries goes last.
    const table = buildFolderTable(PROJECT, 'Projects')
    expect(table.columns.map((column) => column.key)).toEqual(['status', 'owner', 'due', 'onlyhere'])
    expect(table.columns[0]).toEqual({ key: 'status', used: 3 })
  })

  it('leaves the icon and the cover out, since the header draws them', () => {
    const table = buildFolderTable(vault({ 'A/One.md': '---\nicon: 📘\ncover: c.png\nreal: 1\n---\n' }), 'A')
    expect(table.columns.map((column) => column.key)).toEqual(['real'])
  })

  it('names a row by its title, falling back to the file name', () => {
    const table = buildFolderTable(
      vault({ 'A/One.md': '---\ntitle: A Better Name\n---\n', 'A/Two.md': 'no heading here\n' }),
      'A',
    )
    expect(table.rows.map((row) => row.name)).toEqual(['A Better Name', 'Two'])
  })

  it('has no columns for a folder whose notes carry no properties', () => {
    const table = buildFolderTable(vault({ 'A/One.md': '# Plain\n' }), 'A')
    expect(table.columns).toEqual([])
    expect(table.rows).toHaveLength(1)
  })
})

describe('which folders can be a table', () => {
  it('lists every folder holding a note, at any depth', () => {
    expect(foldersWithNotes(PROJECT)).toEqual(['Elsewhere', 'Projects', 'Projects/Deep'])
  })

  it('does not offer the root as a folder', () => {
    expect(foldersWithNotes(vault({ 'Loose.md': '# x\n' }))).toEqual([])
  })
})

describe('what belongs to a folder', () => {
  it('matches a path inside it, and not one that merely starts the same way', () => {
    expect(inFolder('Projects/Alpha.md', 'Projects')).toBe(true)
    expect(inFolder('Projects/Deep/Gamma.md', 'Projects')).toBe(true)
    // The trap: `ProjectsOld/` is not inside `Projects/`.
    expect(inFolder('ProjectsOld/Alpha.md', 'Projects')).toBe(false)
    expect(inFolder('Alpha.md', 'Projects')).toBe(false)
    expect(inFolder('anything.md', '')).toBe(true)
  })
})

describe('a cell as text', () => {
  it('reads a list as a line, and an object as nothing', () => {
    expect(cellText(['a', 'b'])).toBe('a, b')
    expect(cellText(3)).toBe('3')
    expect(cellText(true)).toBe('true')
    expect(cellText(null)).toBe('')
    expect(cellText(undefined)).toBe('')
    expect(cellText({ nested: 1 })).toBe('')
  })
})

describe('sorting', () => {
  const rows = buildFolderTable(PROJECT, 'Projects').rows

  it('compares numbers as numbers, not as text', () => {
    // Sorted as text, 10 comes before 9.
    expect(compareCells(9, 10)).toBeLessThan(0)
    expect(compareCells('9', '10')).toBeLessThan(0)
    expect(compareCells('10', '9')).toBeGreaterThan(0)
  })

  it('compares everything else as text, ignoring case', () => {
    expect(compareCells('apple', 'Banana')).toBeLessThan(0)
    expect(compareCells('Apple', 'apple')).toBe(0)
  })

  it('puts an empty cell last, in both directions', () => {
    // Sorting by a column is how somebody asks to see what is *in* it. A
    // column of blanks at the top answers a different question.
    const up = sortRows(rows, 'due', 'asc').map((row) => row.name)
    const down = sortRows(rows, 'due', 'desc').map((row) => row.name)
    expect(up[0]).toBe('Alpha')
    expect(down[0]).toBe('Alpha')
    expect(up.slice(1)).toEqual(['Beta', 'Gamma'])
  })

  it('sorts by name when no column is chosen', () => {
    expect(sortRows(rows, null, 'asc').map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(sortRows(rows, null, 'desc').map((row) => row.name)).toEqual(['Gamma', 'Beta', 'Alpha'])
  })

  it('breaks ties by name, so the same sort twice looks the same', () => {
    // Alpha and Gamma both have `status: doing`.
    expect(sortRows(rows, 'status', 'asc').map((row) => row.name)).toEqual(['Alpha', 'Gamma', 'Beta'])
  })

  it('does not modify the rows it was given', () => {
    const before = rows.map((row) => row.name)
    sortRows(rows, 'status', 'desc')
    expect(rows.map((row) => row.name)).toEqual(before)
  })
})

describe('filtering', () => {
  const rows = buildFolderTable(PROJECT, 'Projects').rows

  it('matches a note by name, by path, or by any value it holds', () => {
    expect(filterRows(rows, 'alph').map((row) => row.name)).toEqual(['Alpha'])
    expect(filterRows(rows, 'deep').map((row) => row.name)).toEqual(['Gamma'])
    expect(filterRows(rows, 'done').map((row) => row.name)).toEqual(['Beta'])
  })

  it('ignores case, and an empty query keeps everything', () => {
    expect(filterRows(rows, 'ALPHA')).toHaveLength(1)
    expect(filterRows(rows, '   ')).toHaveLength(3)
  })

  it('is a substring, not the fuzzy match the quick switcher uses', () => {
    // Fuzzy is right for picking one note out of a thousand by memory. In a
    // list somebody can already see, "ah" quietly matching "Alpha" is noise.
    expect(filterRows(rows, 'ah')).toHaveLength(0)
  })
})
