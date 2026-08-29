import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { Command } from '../types'
import { useAppStore } from '../state/store'
import { formatShortcut, isMacPlatform, matchesShortcut, parseShortcut, resetPlatformCache, useHotkeys } from './useHotkeys'

const PRISTINE = useAppStore.getState()

/** jsdom's `navigator.platform` is a prototype getter; an own property shadows it. */
function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
  resetPlatformCache()
}

function restorePlatform(): void {
  Reflect.deleteProperty(window.navigator, 'platform')
  resetPlatformCache()
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function command(over: Partial<Command> = {}): Command {
  return { id: 'test', title: 'Test command', section: 'File', shortcut: 'Ctrl+S', run: vi.fn(), ...over }
}

beforeEach(() => {
  restorePlatform()
  useAppStore.setState(PRISTINE, true)
})

afterEach(() => {
  cleanup()
  restorePlatform()
  useAppStore.setState(PRISTINE, true)
})

describe('parseShortcut', () => {
  it('reads the canonical Mod+… form', () => {
    expect(parseShortcut('Mod+Shift+D')).toEqual({ mod: true, shift: true, alt: false, key: 'd' })
  })

  it('reads the Windows/Linux spelling', () => {
    expect(parseShortcut('Ctrl+Shift+D')).toEqual({ mod: true, shift: true, alt: false, key: 'd' })
  })

  it('reads Mac symbols written without separators', () => {
    expect(parseShortcut('⇧⌘D')).toEqual({ mod: true, shift: true, alt: false, key: 'd' })
    expect(parseShortcut('⌥⇧⌘D')).toEqual({ mod: true, shift: true, alt: true, key: 'd' })
    expect(parseShortcut('⌘,')).toEqual({ mod: true, shift: false, alt: false, key: ',' })
  })

  it('handles alt without the mod key', () => {
    expect(parseShortcut('Alt+Left')).toEqual({ mod: false, shift: false, alt: true, key: 'arrowleft' })
  })

  it('handles bare keys and function keys', () => {
    expect(parseShortcut('F2')).toEqual({ mod: false, shift: false, alt: false, key: 'f2' })
    expect(parseShortcut('Escape')).toEqual({ mod: false, shift: false, alt: false, key: 'escape' })
    expect(parseShortcut('Esc').key).toBe('escape')
  })

  it('keeps punctuation keys intact', () => {
    expect(parseShortcut('Mod+,').key).toBe(',')
    expect(parseShortcut('Mod+\\').key).toBe('\\')
    expect(parseShortcut('Mod+=').key).toBe('=')
    expect(parseShortcut('Mod+-').key).toBe('-')
    // A trailing '+' is the key, not a separator.
    expect(parseShortcut('Ctrl++')).toEqual({ mod: true, shift: false, alt: false, key: '+' })
  })

  it('normalises aliases and is case insensitive', () => {
    expect(parseShortcut('CTRL+SHIFT+tab')).toEqual({ mod: true, shift: true, alt: false, key: 'tab' })
    expect(parseShortcut('Option+Space')).toEqual({ mod: false, shift: false, alt: true, key: ' ' })
  })

  it('yields an unmatchable shortcut for junk', () => {
    expect(parseShortcut('').key).toBe('')
    expect(parseShortcut('Ctrl+').key).toBe('')
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'a' }), parseShortcut(''))).toBe(false)
  })
})

describe('formatShortcut', () => {
  it('spells bindings out on Windows/Linux', () => {
    expect(formatShortcut('Mod+Shift+D')).toBe('Ctrl+Shift+D')
    expect(formatShortcut('Mod+\\')).toBe('Ctrl+\\')
    expect(formatShortcut('Alt+Left')).toBe('Alt+Left')
    expect(formatShortcut('F2')).toBe('F2')
  })

  it('uses the Mac symbols in Apple order', () => {
    setPlatform('MacIntel')
    expect(isMacPlatform()).toBe(true)
    expect(formatShortcut('Mod+Shift+D')).toBe('⇧⌘D')
    expect(formatShortcut('Mod+Alt+Shift+D')).toBe('⌥⇧⌘D')
    expect(formatShortcut('Mod+,')).toBe('⌘,')
    expect(formatShortcut('F2')).toBe('F2')
  })

  it('round-trips through parseShortcut on both platforms', () => {
    const canonical = parseShortcut('Mod+Shift+D')
    expect(parseShortcut(formatShortcut('Mod+Shift+D'))).toEqual(canonical)
    setPlatform('MacIntel')
    expect(parseShortcut(formatShortcut('Mod+Shift+D'))).toEqual(canonical)
  })
})

describe('matchesShortcut', () => {
  it('maps mod to Ctrl off the Mac', () => {
    const parsed = parseShortcut('Mod+P')
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }), parsed)).toBe(true)
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p', metaKey: true }), parsed)).toBe(false)
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p' }), parsed)).toBe(false)
  })

  it('maps mod to Command on the Mac', () => {
    setPlatform('MacIntel')
    const parsed = parseShortcut('Mod+P')
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p', metaKey: true }), parsed)).toBe(true)
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }), parsed)).toBe(false)
  })

  it('requires every modifier to agree', () => {
    const plain = parseShortcut('Mod+P')
    const shifted = parseShortcut('Mod+Shift+P')
    const event = new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(event, plain)).toBe(false)
    expect(matchesShortcut(event, shifted)).toBe(true)
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, altKey: true }), plain)).toBe(false)
  })

  it('ignores the shift-induced case of the key', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey: true }), parseShortcut('Mod+Shift+D'))).toBe(true)
  })

  it('falls back to the physical key when the layout reports nothing', () => {
    const event = new KeyboardEvent('keydown', { key: 'Unidentified', code: 'KeyS', ctrlKey: true })
    expect(matchesShortcut(event, parseShortcut('Mod+S'))).toBe(true)
  })

  it('matches arrows and function keys', () => {
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }), parseShortcut('Alt+Left'))).toBe(true)
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'F2' }), parseShortcut('F2'))).toBe(true)
  })
})

describe('useHotkeys', () => {
  it('runs a matching command and claims the event', () => {
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run })]))
    const event = press({ key: 's', ctrlKey: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves unmatched keystrokes alone', () => {
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run })]))
    const event = press({ key: 'k', ctrlKey: true })
    expect(run).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('skips disabled commands', () => {
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run, enabled: () => false })]))
    const event = press({ key: 's', ctrlKey: true })
    expect(run).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('lets chorded shortcuts through while typing in an input', () => {
    // Ctrl+S has to save while the caret is in a field, otherwise the
    // shortcut is useless exactly where it matters most.
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run })]))
    const input = document.createElement('input')
    document.body.appendChild(input)

    const typed = press({ key: 's', ctrlKey: true }, input)
    expect(run).toHaveBeenCalledTimes(1)
    expect(typed.defaultPrevented).toBe(true)

    const palette = press({ key: 'p', ctrlKey: true }, input)
    expect(useAppStore.getState().palette).toBe('quickswitch')
    expect(palette.defaultPrevented).toBe(true)

    input.remove()
  })

  it('suppresses bare-key shortcuts while typing', () => {
    // F2 renames a note — but inside a field it is just a keystroke.
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run, shortcut: 'F2' })]))
    const input = document.createElement('input')
    document.body.appendChild(input)

    const typed = press({ key: 'F2' }, input)
    expect(run).not.toHaveBeenCalled()
    expect(typed.defaultPrevented).toBe(false)

    // …and still fires when focus is anywhere else.
    press({ key: 'F2' })
    expect(run).toHaveBeenCalledTimes(1)

    input.remove()
  })

  it('lets chorded shortcuts through inside a contenteditable surface', () => {
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run })]))
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    host.appendChild(inner)
    document.body.appendChild(host)

    press({ key: 's', ctrlKey: true }, inner)
    expect(run).toHaveBeenCalledTimes(1)

    host.remove()
  })

  it('suppresses a Shift-only shortcut while typing in a contenteditable', () => {
    const run = vi.fn()
    renderHook(() => useHotkeys([command({ run, shortcut: 'Shift+F3' })]))
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'true')
    document.body.appendChild(host)

    press({ key: 'F3', shiftKey: true }, host)
    expect(run).not.toHaveBeenCalled()

    host.remove()
  })

  it('binds the palette modes and Escape', () => {
    renderHook(() => useHotkeys([]))

    press({ key: 'o', ctrlKey: true })
    expect(useAppStore.getState().palette).toBe('quickswitch')

    press({ key: 'P', ctrlKey: true, shiftKey: true })
    expect(useAppStore.getState().palette).toBe('commands')

    const closing = press({ key: 'Escape' })
    expect(useAppStore.getState().palette).toBe(null)
    expect(closing.defaultPrevented).toBe(true)
  })

  it('does not claim Escape when no palette is open', () => {
    renderHook(() => useHotkeys([]))
    const event = press({ key: 'Escape' })
    expect(event.defaultPrevented).toBe(false)
  })

  it('sees the latest command list without re-subscribing', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ commands }: { commands: Command[] }) => useHotkeys(commands), {
      initialProps: { commands: [command({ run: first })] },
    })
    rerender({ commands: [command({ id: 'other', run: second })] })

    press({ key: 's', ctrlKey: true })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('reports a failing command instead of throwing at the listener', () => {
    const run = vi.fn(() => {
      throw new Error('boom')
    })
    renderHook(() => useHotkeys([command({ run })]))
    expect(() => press({ key: 's', ctrlKey: true })).not.toThrow()
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain('boom')
  })

  it('removes its listener on unmount', () => {
    const run = vi.fn()
    const { unmount } = renderHook(() => useHotkeys([command({ run })]))
    unmount()
    press({ key: 's', ctrlKey: true })
    expect(run).not.toHaveBeenCalled()
  })
})
