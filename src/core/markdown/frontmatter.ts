/**
 * SpaceLink — writing frontmatter back into a note.
 *
 * `parseFrontmatter` has always read the block at the top of a note; nothing
 * has ever written one. That is the whole reason properties were something you
 * could look at and not something you could edit: the panel that shows them had
 * no way to put a change back.
 *
 * ## What is preserved, and what is not
 *
 * The body is preserved byte for byte. Everything below the closing `---` is
 * sliced out and put back untouched, so editing a property can never disturb a
 * single character of what was written.
 *
 * The frontmatter block itself is rewritten from the values it is given, and
 * that has a cost worth stating: comments and hand-formatting inside the block
 * do not survive. `# set by a script` above a key is gone the first time
 * somebody edits a property. This is the same trade Obsidian's own properties
 * editor makes, and the alternative — editing YAML in place, preserving
 * unrelated lines — is a far larger machine than a folder of notes needs.
 *
 * Key order is the order of the object it is handed. Callers build that from
 * the parsed frontmatter, so an edit to one property leaves the rest where they
 * were rather than reshuffling the file.
 */
import type { NoteFrontmatter } from '../../types'
import { parseFrontmatter } from './parse'

/** A property value this can write. Anything else is dropped. */
export type PropertyValue = string | number | boolean | null | readonly string[]

/**
 * Characters that make a scalar mean something other than itself in YAML.
 *
 * Anything matching goes in quotes. The list is deliberately wide — a quoted
 * string always reads back as the same string, so over-quoting costs nothing
 * but a pair of characters, while under-quoting silently changes a value.
 */
const NEEDS_QUOTES =
  /^$|^[\s>|*&!%@`'"[{#-]|[:#]\s|\s$|^(?:true|false|yes|no|on|off|null|~)$|^[+-]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/i

/** A scalar, quoted when it would not read back as itself. */
function scalar(value: string): string {
  if (!NEEDS_QUOTES.test(value)) return value
  // Double quotes, because a value may hold an apostrophe and escaping inside
  // single quotes means doubling it — one rule is easier to be right about.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** One `key: value` entry, or a key with a block list under it. */
function entry(key: string, value: PropertyValue): string | null {
  if (value === undefined) return null
  if (value === null) return `${key}:`
  if (typeof value === 'boolean' || typeof value === 'number') {
    // A number that is not finite has no YAML spelling that reads back.
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    return `${key}: ${String(value)}`
  }
  if (typeof value === 'string') return `${key}: ${scalar(value)}`
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string')
    if (items.length === 0) return `${key}: []`
    return [`${key}:`, ...items.map((item) => `  - ${scalar(item)}`)].join('\n')
  }
  return null
}

/** The YAML for a set of properties, without the `---` fences. */
export function serializeFrontmatter(properties: Readonly<Record<string, unknown>>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    // A key that would not survive the round trip is not written at all: a
    // half-written key is worse than a missing one, because it reads back as
    // something else.
    if (key === '' || /[\s:#]/.test(key)) continue
    const line = entry(key, value as PropertyValue)
    if (line !== null) lines.push(line)
  }
  return lines.join('\n')
}

/**
 * `source` with its frontmatter replaced by `properties`.
 *
 * An empty set of properties removes the block entirely, along with the blank
 * line that separated it from the body — a note whose properties were all
 * deleted should look like a note that never had any.
 */
export function withFrontmatter(source: string, properties: Readonly<Record<string, unknown>>): string {
  const { body } = parseFrontmatter(source)
  const yaml = serializeFrontmatter(properties)
  if (yaml === '') return body.replace(/^\r?\n/, '')
  // One blank line between the block and the body, unless the body already
  // starts with one — repeated edits must not push the note further down.
  const separator = body === '' || body.startsWith('\n') || body.startsWith('\r\n') ? '' : '\n'
  return `---\n${yaml}\n---\n${separator}${body}`
}

/**
 * `source` with one property set, added or removed.
 *
 * `undefined` removes it. The key keeps its place when it was already there and
 * goes last when it is new, which is what someone watching the file expects.
 */
export function setProperty(source: string, key: string, value: PropertyValue | undefined): string {
  const { frontmatter } = parseFrontmatter(source)
  const next: Record<string, unknown> = { ...frontmatter }
  if (value === undefined) delete next[key]
  else next[key] = value
  return withFrontmatter(source, next)
}

/**
 * `source` with a property renamed, keeping its place among the others.
 *
 * Renaming by delete-then-add would send the property to the end of the block,
 * which reads as the property having moved rather than been renamed.
 */
export function renameProperty(source: string, from: string, to: string): string {
  const { frontmatter } = parseFrontmatter(source)
  if (!(from in frontmatter) || from === to) return source
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === from) {
      if (to !== '') next[to] = value
    } else if (key !== to) {
      next[key] = value
    }
  }
  return withFrontmatter(source, next)
}

/** The properties of a note, in the order the file holds them. */
export function readProperties(source: string): NoteFrontmatter {
  return parseFrontmatter(source).frontmatter
}
