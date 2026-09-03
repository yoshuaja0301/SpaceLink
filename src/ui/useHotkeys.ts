/**
 * SpaceLink — global keyboard shortcuts.
 *
 * A `Command` carries its binding as the *display* string the palette shows:
 * `Ctrl+Shift+D` on Windows/Linux, `⇧⌘D` on a Mac. That keeps one source of
 * truth — there is no second table of "real" bindings that can drift from the
 * labels — so this module has to be able to read those strings back.
 *
 * `parseShortcut` therefore accepts both spellings (word modifiers separated by
 * `+`, and the Mac symbols written with no separator at all) plus the canonical
 * `Mod+…` form the command table is written in.
 */
import { useEffect, useRef } from 'react'

import type { Command } from '../types'
import type { AppState } from '../state/store'
import { useAppStore } from '../state/store'

export interface ParsedShortcut {
  /** ⌘ on a Mac, Ctrl everywhere else. */
  mod: boolean
  shift: boolean
  alt: boolean
  /** Lowercased `KeyboardEvent.key` this binding fires on; `''` when unparseable. */
  key: string
}

/* ------------------------------------------------------------------ *
 * Platform
 * ------------------------------------------------------------------ */

/** Detected once, then cached — the platform cannot change mid-session. */
let macCache: boolean | null = null

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  // jsdom reports an empty platform, so fall through to the UA string there.
  if (platform) return /mac|iphone|ipad|ipod/i.test(platform)
  return /mac os x|macintosh|iphone|ipad|ipod/i.test(nav.userAgent || '')
}

export function isMacPlatform(): boolean {
  if (macCache === null) macCache = detectMac()
  return macCache
}

/** Test seam: forget the cached platform after faking `navigator`. */
export function resetPlatformCache(): void {
  macCache = null
}

/* ------------------------------------------------------------------ *
 * Shortcut strings
 * ------------------------------------------------------------------ */

type ModifierFlag = 'mod' | 'shift' | 'alt'

/** `⌃` never gets emitted by us, but reading it as "the mod key" is friendlier than failing. */
const MOD_SYMBOLS: Record<string, ModifierFlag> = {
  '⌘': 'mod',
  '⌃': 'mod',
  '⇧': 'shift',
  '⌥': 'alt',
}

const MOD_WORDS: Record<string, ModifierFlag> = {
  mod: 'mod',
  cmd: 'mod',
  command: 'mod',
  ctrl: 'mod',
  control: 'mod',
  meta: 'mod',
  super: 'mod',
  win: 'mod',
  shift: 'shift',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  space: ' ',
  spacebar: ' ',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  '←': 'arrowleft',
  '→': 'arrowright',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  return: 'enter',
  '⏎': 'enter',
  '⇥': 'tab',
  '⌫': 'backspace',
  plus: '+',
  minus: '-',
  comma: ',',
}

/**
 * Split a shortcut into tokens. Modifier symbols are single characters and may
 * be written with no separator (`⇧⌘D`); everything else is `+`-separated. A
 * trailing `+` is the key itself, so `Ctrl++` still parses.
 */
function tokenize(spec: string): string[] {
  const tokens: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) {
      tokens.push(buffer)
      buffer = ''
    }
  }
  const chars = [...spec.trim()]
  chars.forEach((ch, i) => {
    if (ch in MOD_SYMBOLS) {
      flush()
      tokens.push(ch)
      return
    }
    if (ch === '+') {
      if (buffer === '' && i === chars.length - 1) {
        tokens.push('+')
        return
      }
      flush()
      return
    }
    buffer += ch
  })
  flush()
  return tokens
}

interface SpecParts {
  mod: boolean
  shift: boolean
  alt: boolean
  /** The key exactly as written, for display. */
  key: string
}

function splitSpec(spec: string): SpecParts {
  const parts: SpecParts = { mod: false, shift: false, alt: false, key: '' }
  for (const token of tokenize(spec)) {
    const flag = MOD_SYMBOLS[token] ?? MOD_WORDS[token.toLowerCase()]
    if (flag) {
      parts[flag] = true
      continue
    }
    parts.key = token
  }
  return parts
}

function normalizeKey(key: string): string {
  if (!key) return ''
  const lower = key.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

export function parseShortcut(spec: string): ParsedShortcut {
  const parts = splitSpec(spec)
  return { mod: parts.mod, shift: parts.shift, alt: parts.alt, key: normalizeKey(parts.key) }
}

/**
 * Render a canonical spec (`Mod+Shift+D`) the way this platform writes it.
 * Mac order follows Apple's own: ⌥ ⇧ ⌘ then the key.
 */
export function formatShortcut(spec: string): string {
  const parts = splitSpec(spec)
  if (!parts.key && !parts.mod && !parts.shift && !parts.alt) return ''
  const key = parts.key.length === 1 ? parts.key.toUpperCase() : parts.key
  if (isMacPlatform()) {
    return `${parts.alt ? '⌥' : ''}${parts.shift ? '⇧' : ''}${parts.mod ? '⌘' : ''}${key}`
  }
  const out: string[] = []
  if (parts.mod) out.push('Ctrl')
  if (parts.alt) out.push('Alt')
  if (parts.shift) out.push('Shift')
  if (key) out.push(key)
  return out.join('+')
}

/** Parsing is pure and platform independent, so the results cache forever. */
const parseCache = new Map<string, ParsedShortcut>()

function cachedParse(spec: string): ParsedShortcut {
  let parsed = parseCache.get(spec)
  if (!parsed) {
    parsed = parseShortcut(spec)
    parseCache.set(spec, parsed)
  }
  return parsed
}

/**
 * `KeyboardEvent.key`, lowercased. Falls back to the physical key when the
 * layout produced nothing usable (dead keys, IME candidates).
 */
function eventKey(event: KeyboardEvent): string {
  const key = event.key
  const code = event.code || ''
  // With Option held, macOS reports the Option-layer character — `∫` for
  // ⌥B — so no Alt+letter binding could ever match by `key`. The physical
  // key is what the binding names.
  if (event.altKey && /^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (event.altKey && /^Digit\d$/.test(code)) return code.slice(5)
  if (!key || key === 'Unidentified' || key === 'Dead' || key === 'Process') {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
    if (/^Digit\d$/.test(code)) return code.slice(5)
    return ''
  }
  return normalizeKey(key)
}

export function matchesShortcut(event: KeyboardEvent, parsed: ParsedShortcut): boolean {
  if (!parsed.key) return false
  const mac = isMacPlatform()
  const mod = mac ? event.metaKey : event.ctrlKey
  // The *other* platform's modifier must be up, so ⌘P on a Mac never fires for
  // Ctrl+P (which macOS maps to "move up a line") and vice versa.
  const foreign = mac ? event.ctrlKey : event.metaKey
  if (mod !== parsed.mod || foreign) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.altKey !== parsed.alt) return false
  return eventKey(event) === parsed.key
}

/* ------------------------------------------------------------------ *
 * Running commands
 * ------------------------------------------------------------------ */

/**
 * Invoke a command without letting a failure escape into the keydown handler
 * (or into React's render of the palette). Async commands report late failures
 * the same way. Shared with the command palette, which is the other place a
 * command gets run.
 */
export function runCommand(command: Command): void {
  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    useAppStore.getState().pushToast(`${command.title} failed: ${message}`, 'error')
  }
  try {
    const result = command.run()
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch(report)
    }
  } catch (error) {
    report(error)
  }
}

/* ------------------------------------------------------------------ *
 * The listener
 * ------------------------------------------------------------------ */

/** Typing must never trigger a command — except the palette, which is how you escape typing. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const element = target as HTMLElement
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (element.isContentEditable === true) return true
  // jsdom does not implement `isContentEditable`, and CodeMirror's editable
  // surface is a *descendant* of the element carrying the attribute.
  return element.closest('[contenteditable=""], [contenteditable="true"]') !== null
}

/** Is `target` inside a CodeMirror editor, as opposed to some other input? */
function isInsideEditor(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  return (target as Element).closest('.cm-editor') !== null
}

type PaletteMode = NonNullable<AppState['palette']>

function openPalette(mode: PaletteMode): boolean {
  useAppStore.getState().setPalette(mode)
  return true
}

/**
 * Bindings that work everywhere, typing included. Escape only claims the event
 * when there is actually a palette to close, so modals and menus still see it.
 */
const PALETTE_BINDINGS: ReadonlyArray<{ spec: string; run: () => boolean }> = [
  { spec: 'Mod+Shift+P', run: () => openPalette('commands') },
  { spec: 'Mod+P', run: () => openPalette('quickswitch') },
  { spec: 'Mod+O', run: () => openPalette('quickswitch') },
  {
    spec: 'Escape',
    run: () => {
      const state = useAppStore.getState()
      if (state.palette === null) return false
      state.setPalette(null)
      return true
    },
  },
]

/**
 * Bind every command that has a shortcut, plus the palette's own keys.
 *
 * `preventDefault` is called only when something actually matched, so
 * unclaimed keystrokes keep their browser behaviour.
 */
export function useHotkeys(commands: Command[]): void {
  // The listener is installed once; the ref keeps it looking at the current
  // command list instead of re-subscribing on every render.
  const commandsRef = useRef(commands)
  useEffect(() => {
    commandsRef.current = commands
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return

      for (const binding of PALETTE_BINDINGS) {
        if (!matchesShortcut(event, cachedParse(binding.spec))) continue
        if (!binding.run()) break
        event.preventDefault()
        return
      }

      // The palette owns the keyboard while it is open: its own keys were
      // handled above, and what it does not claim (⌘↩ to open in a new tab,
      // for one) must not fall through to a command aimed at the note behind
      // it — which still has an editor registered, with no focus.
      if (useAppStore.getState().palette !== null) return

      const typing = isEditableTarget(event.target)
      const inEditor = typing && isInsideEditor(event.target)

      for (const command of commandsRef.current) {
        if (!command.shortcut) continue
        const parsed = cachedParse(command.shortcut)
        // While the caret is in an editor, only chorded shortcuts fire: a bare
        // key (or a plain Shift+key) belongs to whatever is being typed into.
        if (typing && !parsed.mod && !parsed.alt) continue
        // An editor command aimed from another input — a search box, a rename
        // field — would land in an editor that is not where the caret is.
        if (typing && !inEditor && command.id.startsWith('editor:')) continue
        if (!matchesShortcut(event, parsed)) continue
        if (command.enabled && !command.enabled()) continue
        event.preventDefault()
        runCommand(command)
        return
      }
    }

    // Capture phase on purpose. CodeMirror's own keymaps run on the editor and
    // call preventDefault first — `searchKeymap` claims Mod+G for "find next",
    // for one — which would swallow app shortcuts the moment the caret is in a
    // note. Listening on the way down makes the command palette's bindings
    // authoritative; everything the app does not claim still reaches the
    // editor untouched, and the `typing` guard below keeps plain keystrokes out.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
