/**
 * SpaceFore — the command palette.
 *
 * One modal serves three jobs, chosen by `store.palette`:
 *
 * - `commands`    fuzzy-search every registered command, grouped by section
 * - `quickswitch` fuzzy-search notes by name/path, with a create-new fallback
 * - `headings`    jump around inside the note you are already reading
 *
 * They differ only in how the rows are built, so everything below the row model
 * — keyboard navigation, the focus trap, the announcement, the scrolling — is
 * written once. Rows are a flat list; section headers are derived from the
 * `section` a row carries, which keeps the selected index and the rendered list
 * from ever disagreeing.
 */
import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { headingElementId } from '../core/markdown/parse'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import type { Command, HeadingRef, MatchRange, Note, NotePath } from '../types'
import type { AppState } from '../state/store'
import { dirname, useAppStore } from '../state/store'
import { fuzzyMatch, highlight } from '../core/search/fuzzy'
import { quickSwitch } from '../core/search/engine'
import { getActiveEditor } from './editor/activeEditor'
import { selectActivePath, useCommands } from './commands'
import { runCommand } from './useHotkeys'

type PaletteMode = NonNullable<AppState['palette']>

/** How far PageUp / PageDown move. */
const PAGE_JUMP = 8
const QUICK_SWITCH_LIMIT = 50

interface RunModifiers {
  /** Cmd/Ctrl+Enter — open in a new tab. */
  newTab: boolean
  /** Shift+Enter — open in a split. */
  split: boolean
}

interface Row {
  /** Stable React key. */
  key: string
  /** Section header to render immediately above this row. */
  section?: string
  /** Escaped HTML — `highlight()` marks the fuzzy ranges. */
  titleHtml: string
  subtitle?: string
  shortcut?: string
  /** Heading depth, for the indent in `headings` mode. */
  indent?: number
  run: (modifiers: RunModifiers) => void
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: 'Type a command…',
  quickswitch: 'Find or create a note…',
  headings: 'Go to heading…',
}

const LABELS: Record<PaletteMode, string> = {
  commands: 'Command palette',
  quickswitch: 'Quick switcher',
  headings: 'Go to heading',
}

const EMPTY_TEXT: Record<PaletteMode, string> = {
  commands: 'No matching commands',
  quickswitch: 'No matching notes',
  headings: 'This note has no headings',
}

/* ------------------------------------------------------------------ *
 * Row builders
 * ------------------------------------------------------------------ */

interface ScoredCommand {
  command: Command
  /** Position in the original table; the tie-breaker so order stays stable. */
  order: number
  score: number
  ranges: MatchRange[]
}

/**
 * Commands are matched against `"Section: Title"` so that typing "view split"
 * or "editor bold" works. The resulting ranges are shifted back onto the title
 * alone, since that is all the row shows.
 */
function commandRows(commands: Command[], query: string): Row[] {
  const scored: ScoredCommand[] = []
  commands
    .filter((command) => command.enabled?.() !== false)
    .forEach((command, order) => {
      if (!query) {
        scored.push({ command, order, score: 0, ranges: [] })
        return
      }
      const match = fuzzyMatch(query, `${command.section}: ${command.title}`)
      if (!match) return
      const offset = command.section.length + 2
      const ranges: MatchRange[] = []
      for (const [from, to] of match.ranges) {
        const start = Math.max(0, from - offset)
        const end = to - offset
        if (end > start) ranges.push([start, end])
      }
      scored.push({ command, order, score: match.score, ranges })
    })

  // Group by section, keeping the sections in the order they first appear.
  const groups = new Map<string, ScoredCommand[]>()
  for (const item of scored) {
    const list = groups.get(item.command.section)
    if (list) list.push(item)
    else groups.set(item.command.section, [item])
  }

  const rows: Row[] = []
  for (const [section, items] of groups) {
    items.sort((a, b) => b.score - a.score || a.order - b.order)
    items.forEach((item, index) => {
      rows.push({
        key: item.command.id,
        section: index === 0 ? section : undefined,
        titleHtml: highlight(item.command.title, item.ranges),
        shortcut: item.command.shortcut,
        run: () => runCommand(item.command),
      })
    })
  }
  return rows
}

function quickSwitchRows(query: string, notes: Map<NotePath, Note>): Row[] {
  return quickSwitch(query, notes, QUICK_SWITCH_LIMIT).map((item) => ({
    key: item.create ? `create:${item.path}` : item.path,
    titleHtml: highlight(item.title, item.ranges),
    subtitle: item.create ? 'Create new note' : dirname(item.path) || 'Vault root',
    run: (modifiers: RunModifiers) => {
      const state = useAppStore.getState()
      if (item.create) {
        void state.createNoteFromTitle(item.title)
        return
      }
      if (modifiers.split) {
        state.splitPane()
        // `splitPane` makes the new pane active — target it explicitly so the
        // note lands in the split even if that ever changes.
        state.openPath(item.path, { paneId: useAppStore.getState().activePaneId })
        return
      }
      state.openPath(item.path, { newTab: modifiers.newTab })
    },
  }))
}

/**
 * Put the caret on the heading in the editor and scroll the preview to the
 * matching anchor (`render.ts` gives every heading `headingElementId(slug)` as its id).
 */
function goToHeading(path: NotePath, heading: HeadingRef): void {
  const state = useAppStore.getState()
  state.openPath(path, { heading: heading.slug })

  const view = getActiveEditor()
  if (view) {
    const anchor = Math.min(heading.start, view.state.doc.length)
    view.dispatch({ selection: { anchor }, scrollIntoView: true })
    view.focus()
  }

  if (typeof document === 'undefined') return
  const anchor = document.getElementById(headingElementId(heading.slug))
  if (anchor && typeof anchor.scrollIntoView === 'function') anchor.scrollIntoView({ block: 'start' })
}

function headingRows(query: string, note: Note | null): Row[] {
  if (!note) return []
  const headings = note.parsed.headings
  const scored = headings
    .map((heading, order) => ({ heading, order, match: query ? fuzzyMatch(query, heading.text) : null }))
    .filter((item) => !query || item.match !== null)
  if (query) scored.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0) || a.order - b.order)

  return scored.map((item) => ({
    key: `${item.heading.line}:${item.heading.slug}`,
    titleHtml: highlight(item.heading.text, item.match?.ranges ?? []),
    subtitle: `H${item.heading.level}`,
    indent: Math.max(0, item.heading.level - 1),
    run: () => goToHeading(note.path, item.heading),
  }))
}

/* ------------------------------------------------------------------ *
 * Focus trap
 * ------------------------------------------------------------------ */

const FOCUSABLE = 'input, button, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'

/** Cycle focus inside the dialog. With a single field that means: stay put. */
function trapFocus(container: HTMLElement | null, backwards: boolean): void {
  if (!container) return
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  )
  if (focusable.length === 0) return
  const current = document.activeElement as HTMLElement | null
  const index = current ? focusable.indexOf(current) : -1
  const next = backwards
    ? index <= 0
      ? focusable.length - 1
      : index - 1
    : index === -1 || index === focusable.length - 1
      ? 0
      : index + 1
  focusable[next]?.focus()
}

/* ------------------------------------------------------------------ *
 * The modal
 * ------------------------------------------------------------------ */

function PaletteModal({ mode }: { mode: PaletteMode }): JSX.Element {
  const setPalette = useAppStore((s) => s.setPalette)
  const notes = useAppStore((s) => s.notes)
  const activePath = useAppStore(selectActivePath)
  const commands = useCommands()

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  const activeNote = activePath ? (notes.get(activePath) ?? null) : null

  const rows = useMemo(() => {
    if (mode === 'commands') return commandRows(commands, query.trim())
    if (mode === 'quickswitch') return quickSwitchRows(query, notes)
    return headingRows(query.trim(), activeNote)
  }, [mode, query, commands, notes, activeNote])

  // Deriving rather than clamping in an effect avoids a frame where the
  // selection points past the end of a freshly filtered list.
  const activeIndex = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1)

  useEffect(() => {
    setSelected(0)
  }, [mode, query])

  // Take focus on open, hand it back on close.
  useEffect(() => {
    const previous = document.activeElement
    restoreRef.current = previous instanceof HTMLElement ? previous : null
    inputRef.current?.focus()
    return () => {
      const element = restoreRef.current
      if (element && element.isConnected && typeof element.focus === 'function') element.focus()
    }
  }, [])

  useEffect(() => {
    if (activeIndex < 0) return
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    // jsdom has no scrollIntoView.
    if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, rows])

  const close = (): void => setPalette(null)

  const activate = (index: number, modifiers: RunModifiers): void => {
    const row = rows[index]
    if (!row) return
    // Close first: the modal unmounts, focus goes back where it came from, and
    // only then does the command get to move it somewhere else.
    close()
    row.run(modifiers)
  }

  const move = (delta: number, wrap: boolean): void => {
    if (rows.length === 0) return
    const next = activeIndex + delta
    setSelected(wrap ? (next + rows.length) % rows.length : Math.max(0, Math.min(rows.length - 1, next)))
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        move(1, true)
        break
      case 'ArrowUp':
        move(-1, true)
        break
      case 'Home':
        setSelected(0)
        break
      case 'End':
        setSelected(Math.max(0, rows.length - 1))
        break
      case 'PageDown':
        move(PAGE_JUMP, false)
        break
      case 'PageUp':
        move(-PAGE_JUMP, false)
        break
      case 'Enter':
        activate(activeIndex, { newTab: event.metaKey || event.ctrlKey, split: event.shiftKey })
        break
      case 'Escape':
        close()
        break
      case 'Tab':
        trapFocus(dialogRef.current, event.shiftKey)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close()
  }

  const count = rows.length
  const announcement = count === 0 ? EMPTY_TEXT[mode] : `${count} result${count === 1 ? '' : 's'}`

  return (
    <div className="palette-backdrop" onMouseDown={onBackdropMouseDown}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={LABELS[mode]}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-label={PLACEHOLDERS[mode]}
          aria-activedescendant={activeIndex >= 0 ? `palette-option-${activeIndex}` : undefined}
          placeholder={PLACEHOLDERS[mode]}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="palette-section" role="status" aria-live="polite">
          {announcement}
        </div>

        <ul className="palette-list" id="palette-list" role="listbox" aria-label={LABELS[mode]} ref={listRef}>
          {rows.length === 0 && (
            <li className="palette-empty" role="presentation">
              {EMPTY_TEXT[mode]}
            </li>
          )}
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {row.section && (
                <li className="palette-section" role="presentation">
                  {row.section}
                </li>
              )}
              <li
                id={`palette-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                className={`palette-item${index === activeIndex ? ' is-selected' : ''}`}
                style={row.indent ? { paddingLeft: `calc(var(--space-3) + ${row.indent * 14}px)` } : undefined}
                onClick={(event) =>
                  activate(index, { newTab: event.metaKey || event.ctrlKey, split: event.shiftKey })
                }
              >
                <span className="palette-item-title" dangerouslySetInnerHTML={{ __html: row.titleHtml }} />
                {row.subtitle && <span className="palette-item-subtitle">{row.subtitle}</span>}
                {row.shortcut && <kbd className="palette-shortcut">{row.shortcut}</kbd>}
              </li>
            </Fragment>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function CommandPalette(): JSX.Element | null {
  const palette = useAppStore((s) => s.palette)
  if (palette === null) return null
  // Keyed so switching modes without closing starts from a clean slate.
  return <PaletteModal key={palette} mode={palette} />
}

export default CommandPalette
