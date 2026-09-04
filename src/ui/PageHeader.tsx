/**
 * SpaceLink — the page header: icon, cover, and editable properties.
 *
 * A note's frontmatter has always been readable — the parser reads it, the
 * reading view prints it as a table, the note card lists it. None of it could
 * be *changed* without opening the YAML and editing it by hand, which is a
 * strange thing to ask of somebody who just wants to mark a note as done.
 *
 * ## Everything here is a property, and nothing here is a database
 *
 * The icon is `icon:` and the cover is `cover:`. They are ordinary frontmatter
 * keys, so they travel with the file, sync with the file, survive being read by
 * anything else that opens the vault, and can be typed by hand by somebody who
 * never opens this panel. They are drawn as the header rather than listed as
 * rows only because showing them twice is noise.
 *
 * ## Types are kept, not guessed
 *
 * Editing a value never changes what kind of value it is. A list stays a list,
 * split on commas; a number stays a number as long as the new text still reads
 * as one, and becomes text when it does not; everything else is text. A new
 * property is text, except `tags` and `aliases`, which the parser normalises
 * into lists — writing either of those as text would be undone on the next
 * read, and the file would churn on every save.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { renameProperty, setProperty } from '../core/markdown/frontmatter'
import type { PropertyValue } from '../core/markdown/frontmatter'
import { basename, useAppStore } from '../state/store'
import type { NotePath } from '../types'
import { useRenderContext } from './useRenderContext'

/** Frontmatter keys the header draws itself, so they are not listed as rows. */
const HEADER_KEYS = new Set(['icon', 'cover'])

/** Keys the parser always reads back as a list, whatever was written. */
const ALWAYS_A_LIST = new Set(['tags', 'aliases'])

/**
 * Enough emoji to pick one without a picker library.
 *
 * Anything can be typed into the field beside them; this is the shortcut, not
 * the whole alphabet.
 */
const ICONS = [
  '📘', '📗', '📕', '📓', '📔', '📝', '🗒️', '📄',
  '💡', '🔧', '⚙️', '🧪', '🔬', '🧭', '🗺️', '🧩',
  '🌱', '🌳', '🔥', '⭐', '🎯', '🚀', '🏁', '⏳',
  '✅', '❗', '❓', '🔒', '🔑', '📌', '🔖', '🏷️',
  '👤', '👥', '🏠', '🏢', '💬', '📅', '📊', '💰',
]

/* ------------------------------------------------------------------ *
 * Values as text, and back
 * ------------------------------------------------------------------ */

/** A property value as one line somebody can edit. */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  if (typeof value === 'object') return ''
  return String(value)
}

/**
 * Edited text back into a value, keeping the kind the property already was.
 *
 * `previous` is what the property held before the edit — the only thing that
 * says whether "1, 2" is a list of two or a string with a comma in it.
 */
export function textToValue(text: string, previous: unknown, key: string): PropertyValue {
  if (Array.isArray(previous) || ALWAYS_A_LIST.has(key)) {
    return text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  if (typeof previous === 'number') {
    const n = Number(text.trim())
    // Only when it still reads as one. `Number('')` is 0, which would turn a
    // cleared field into a zero rather than an empty value.
    if (text.trim() !== '' && Number.isFinite(n)) return n
  }
  if (typeof previous === 'boolean') {
    const lowered = text.trim().toLowerCase()
    if (lowered === 'true' || lowered === 'false') return lowered === 'true'
  }
  return text
}

/* ------------------------------------------------------------------ *
 * The header
 * ------------------------------------------------------------------ */

interface RowProps {
  name: string
  value: unknown
  onRename: (to: string) => void
  onChange: (text: string) => void
  onRemove: () => void
}

/**
 * One property.
 *
 * Both fields commit on blur and on Enter, and Escape puts back what was there
 * — a half-typed name must not be written to the file on every keystroke, which
 * would rewrite the frontmatter once per character and fill the undo history.
 */
function PropertyRow({ name, value, onRename, onChange, onRemove }: RowProps): JSX.Element {
  const [draftName, setDraftName] = useState(name)
  const [draftValue, setDraftValue] = useState(() => valueToText(value))

  // The note can change underneath this row — an edit in the editor, a sync
  // from another device — and the field has to follow unless it is being typed
  // into. `document.activeElement` is the only honest test of that.
  const nameRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (document.activeElement !== nameRef.current) setDraftName(name)
  }, [name])
  useEffect(() => {
    if (document.activeElement !== valueRef.current) setDraftValue(valueToText(value))
  }, [value])

  return (
    <div className="page-property">
      <input
        ref={nameRef}
        className="page-property-name"
        value={draftName}
        aria-label={`Name of the property ${name}`}
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={() => {
          const next = draftName.trim()
          if (next === name) return
          if (next === '') setDraftName(name)
          else onRename(next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setDraftName(name)
            event.currentTarget.blur()
          }
        }}
      />
      <input
        ref={valueRef}
        className="page-property-value"
        value={draftValue}
        aria-label={name}
        placeholder="Empty"
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={() => {
          if (draftValue !== valueToText(value)) onChange(draftValue)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setDraftValue(valueToText(value))
            event.currentTarget.blur()
          }
        }}
      />
      <button type="button" className="page-property-remove" aria-label={`Remove ${name}`} onClick={onRemove}>
        ×
      </button>
    </div>
  )
}

export function PageHeader({ path }: { path: NotePath }): JSX.Element | null {
  const note = useAppStore((state) => state.notes.get(path))
  const setNoteContent = useAppStore((state) => state.setNoteContent)
  const context = useRenderContext(path)

  const [pickingIcon, setPickingIcon] = useState(false)
  const [showProperties, setShowProperties] = useState(false)
  const [addingProperty, setAddingProperty] = useState(false)
  const [coverDraft, setCoverDraft] = useState<string | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  const frontmatter = note?.parsed.frontmatter
  const rows = useMemo(
    () => Object.entries(frontmatter ?? {}).filter(([key]) => !HEADER_KEYS.has(key)),
    [frontmatter],
  )

  const write = useCallback(
    (next: string) => {
      if (note && next !== note.content) setNoteContent(path, next)
    },
    [note, path, setNoteContent],
  )

  const set = useCallback(
    (key: string, value: PropertyValue | undefined) => {
      if (note) write(setProperty(note.content, key, value))
    },
    [note, write],
  )

  useEffect(() => {
    if (addingProperty) newNameRef.current?.focus()
  }, [addingProperty])

  if (!note) return null

  const icon = typeof frontmatter?.icon === 'string' ? frontmatter.icon.trim() : ''
  const cover = typeof frontmatter?.cover === 'string' ? frontmatter.cover.trim() : ''
  const coverUrl = cover === '' ? null : (context.resolveAsset?.(cover, path) ?? null)
  const title = note.parsed.title || basename(path)

  return (
    <header className="page-header">
      {cover !== '' && (
        <div className="page-cover">
          {/* A cover that cannot be resolved says so rather than showing a
              broken image: the path is usually a typo, and the reader is the
              only one who can fix it. */}
          {coverUrl ? (
            <img src={coverUrl} alt="" />
          ) : (
            <p className="page-cover-missing">Cover not found: {cover}</p>
          )}
          <button type="button" className="page-cover-remove" onClick={() => set('cover', undefined)}>
            Remove cover
          </button>
        </div>
      )}

      <div className="page-header-title">
        <button
          type="button"
          className="page-icon"
          aria-label={icon === '' ? 'Add an icon' : 'Change the icon'}
          aria-expanded={pickingIcon}
          onClick={() => setPickingIcon((open) => !open)}
        >
          {icon === '' ? '＋' : icon}
        </button>
        <h1>{title}</h1>
        {/*
          Collapsed by default, and that is not a preference — expanded, the
          header was measured at 257px on a note with five properties, which is
          a quarter of the window spent on chrome above every note and enough to
          hide the top of a scrolled note behind it.
        */}
        <button
          type="button"
          className="page-properties-toggle"
          aria-expanded={showProperties}
          onClick={() => setShowProperties((open) => !open)}
        >
          {rows.length === 0
            ? 'Properties'
            : `${rows.length} ${rows.length === 1 ? 'property' : 'properties'}`}
        </button>
      </div>

      {pickingIcon && (
        <div className="page-icon-picker" role="group" aria-label="Pick an icon">
          {ICONS.map((choice) => (
            <button
              type="button"
              key={choice}
              aria-label={choice}
              onClick={() => {
                set('icon', choice)
                setPickingIcon(false)
              }}
            >
              {choice}
            </button>
          ))}
          <input
            className="page-icon-any"
            defaultValue={icon}
            aria-label="Any icon"
            placeholder="or type one"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const typed = event.currentTarget.value.trim()
              set('icon', typed === '' ? undefined : typed)
              setPickingIcon(false)
            }}
          />
          {icon !== '' && (
            <button
              type="button"
              onClick={() => {
                set('icon', undefined)
                setPickingIcon(false)
              }}
            >
              Remove
            </button>
          )}
        </div>
      )}

      <div className="page-properties" hidden={!showProperties}>
        {rows.map(([key, value]) => (
          <PropertyRow
            key={key}
            name={key}
            value={value}
            onRename={(to) => write(renameProperty(note.content, key, to))}
            onChange={(text) => set(key, textToValue(text, value, key))}
            onRemove={() => set(key, undefined)}
          />
        ))}

        {addingProperty ? (
          <div className="page-property">
            <input
              ref={newNameRef}
              className="page-property-name"
              aria-label="Name of the new property"
              placeholder="Property"
              onBlur={(event) => {
                const key = event.target.value.trim()
                setAddingProperty(false)
                // A name that cannot be written back needs no guard here — the
                // serialiser refuses it, and the note comes back unchanged.
                // A name that is *already there* does: writing it would set the
                // property somebody can see to empty, which reads as the panel
                // having deleted their value.
                if (key in (frontmatter ?? {})) return
                set(key, ALWAYS_A_LIST.has(key) ? [] : '')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  event.currentTarget.value = ''
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
        ) : (
          <div className="page-header-actions">
            <button type="button" onClick={() => setAddingProperty(true)}>
              Add a property
            </button>
            {cover === '' && coverDraft === null && (
              <button type="button" onClick={() => setCoverDraft('')}>
                Add a cover
              </button>
            )}
          </div>
        )}

        {coverDraft !== null && cover === '' && (
          <div className="page-property">
            <label className="page-property-name" htmlFor={`${path}-cover`}>
              cover
            </label>
            <input
              id={`${path}-cover`}
              className="page-property-value"
              autoFocus
              aria-label="Cover image"
              placeholder="An image in the vault, or a URL"
              onBlur={(event) => {
                const target = event.target.value.trim()
                setCoverDraft(null)
                if (target !== '') set('cover', target)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') {
                  event.currentTarget.value = ''
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
        )}
      </div>
    </header>
  )
}
