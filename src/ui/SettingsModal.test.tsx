import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { JSX } from 'react'

import type { Note, NotePath } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { createMemoryVault } from '../core/vault/memoryVault'
import { DEFAULT_SETTINGS, formatDate, makeNote, useAppStore } from '../state/store'
import { Modal } from './Modal'
import { SettingsModal, parseImport, vaultFolders } from './SettingsModal'
import { Toasts } from './Toasts'
import { resolveTheme, useTheme } from './useTheme'

/** The store as it was at import time — actions included, so spies are undone. */
const PRISTINE = useAppStore.getState()

const VAULT: Record<NotePath, string> = {
  'Home.md': '# Home\n\nLinks to [[Projects/Alpha]].\n',
  'Projects/Alpha.md': '# Alpha\n',
  'Projects/Deep/Beta.md': '# Beta\n',
  'Daily/2026-01-01.md': '# 2026-01-01\n',
}

function seed(files: Record<NotePath, string> = VAULT): Map<NotePath, Note> {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes) })
  return notes
}

function noop(): void {
  /* intentionally empty */
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      vaultName: '',
      dirty: new Set(),
      saving: new Set(),
      settings: { ...DEFAULT_SETTINGS },
      toasts: [],
      recent: [],
      starred: [],
      panes: [{ id: 'pane-a', tabs: [], activeTabId: null }],
      activePaneId: 'pane-a',
    },
    true,
  )
  document.documentElement.removeAttribute('data-theme')
  document.head.querySelector('meta[name="theme-color"]')?.remove()
  document.body.style.overflow = ''
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

describe('Modal', () => {
  function dialog(): HTMLElement {
    return screen.getByRole('dialog')
  }

  it('renders nothing at all while closed', () => {
    const { container } = render(
      <Modal open={false} title="Settings" onClose={noop}>
        <button type="button">Inside</button>
      </Modal>,
    )
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a labelled modal dialog and moves focus inside on open', () => {
    render(
      <Modal open title="Settings" onClose={noop}>
        <button type="button">Inside</button>
      </Modal>,
    )
    const node = dialog()
    expect(node.getAttribute('aria-modal')).toBe('true')
    // The accessible name has to come from the header, via aria-labelledby.
    const labelledBy = node.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Settings')
    expect(document.activeElement).toBe(node)
  })

  it('closes on Escape, and swallows the event so global hotkeys do not see it', () => {
    const onClose = vi.fn()
    const bubbled = vi.fn()
    window.addEventListener('keydown', bubbled)
    render(
      <Modal open title="Settings" onClose={onClose}>
        <button type="button">Inside</button>
      </Modal>,
    )

    fireEvent.keyDown(screen.getByText('Inside'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(bubbled).not.toHaveBeenCalled()
    window.removeEventListener('keydown', bubbled)
  })

  it('closes on a backdrop click but not on a click inside the dialog', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Modal open title="Settings" onClose={onClose}>
        <button type="button">Inside</button>
      </Modal>,
    )

    fireEvent.click(screen.getByText('Inside'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(container.querySelector('.modal-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a backdrop click whose press started inside the dialog (text selection)', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Modal open title="Settings" onClose={onClose}>
        <button type="button">Inside</button>
      </Modal>,
    )
    const backdrop = container.querySelector('.modal-backdrop')!

    fireEvent.mouseDown(screen.getByText('Inside'))
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()

    // A press that really starts on the backdrop still dismisses.
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps Tab inside the dialog, in both directions', () => {
    render(
      <Modal open title="Settings" onClose={noop} footer={<button type="button">Done</button>}>
        <button type="button">One</button>
        <button type="button">Two</button>
      </Modal>,
    )
    const close = screen.getByRole('button', { name: 'Close' })
    const done = screen.getByRole('button', { name: 'Done' })

    // Forward off the last stop wraps to the first.
    done.focus()
    fireEvent.keyDown(done, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    // Backward off the first stop wraps to the last.
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(done)

    // Focus parked on the dialog itself is pulled onto a real stop.
    screen.getByRole('dialog').focus()
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
  })

  it('leaves interior Tab presses to the browser', () => {
    render(
      <Modal open title="Settings" onClose={noop}>
        <button type="button">One</button>
        <button type="button">Two</button>
      </Modal>,
    )
    const one = screen.getByRole('button', { name: 'One' })
    one.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    one.dispatchEvent(event)
    // Not our business: the native focus order already does the right thing.
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(one)
  })

  it('locks body scroll while open and restores focus to the opener on close', () => {
    function Harness({ open }: { open: boolean }): JSX.Element {
      return (
        <>
          <button type="button">Open settings</button>
          <Modal open={open} title="Settings" onClose={noop}>
            <button type="button">Inside</button>
          </Modal>
        </>
      )
    }

    document.body.style.overflow = 'scroll'
    const { rerender } = render(<Harness open={false} />)
    const opener = screen.getByRole('button', { name: 'Open settings' })
    opener.focus()

    rerender(<Harness open />)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    rerender(<Harness open={false} />)
    // The previous inline value comes back, not a blanket reset.
    expect(document.body.style.overflow).toBe('scroll')
    expect(document.activeElement).toBe(opener)
  })
})

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

/**
 * A controllable `prefers-color-scheme: dark` media query list. This jsdom
 * exposes `window.matchMedia` as an accessor that answers `undefined`, so the
 * whole function has to be stubbed rather than spied on.
 */
function stubMatchMedia(matches: boolean): { set: (value: boolean) => void } {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  let current = matches
  const list = {
    get matches() {
      return current
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => false,
  }
  vi.stubGlobal('matchMedia', () => list as unknown as MediaQueryList)
  return {
    set(value: boolean) {
      current = value
      act(() => {
        listeners.forEach((listener) => listener({ matches: value } as MediaQueryListEvent))
      })
    },
  }
}

function ThemeProbe(): null {
  useTheme()
  return null
}

function themeColor(): string | null {
  return document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
}

describe('resolveTheme', () => {
  it('passes an explicit choice straight through', () => {
    stubMatchMedia(true)
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('asks the OS for "system"', () => {
    const media = stubMatchMedia(true)
    expect(resolveTheme('system')).toBe('dark')
    media.set(false)
    expect(resolveTheme('system')).toBe('light')
  })

  it('falls back to light when the browser cannot answer', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported')
    })
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('useTheme', () => {
  it('pins data-theme for an explicit choice and removes it for system', () => {
    stubMatchMedia(false)
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } })
    const { rerender } = render(<ThemeProbe />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    act(() => useAppStore.getState().updateSettings({ theme: 'light' }))
    rerender(<ThemeProbe />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    act(() => useAppStore.getState().updateSettings({ theme: 'system' }))
    rerender(<ThemeProbe />)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('keeps the theme-color meta tag in sync, creating it when absent', () => {
    stubMatchMedia(false)
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } })
    render(<ThemeProbe />)
    const light = themeColor()
    expect(light).toBeTruthy()

    act(() => useAppStore.getState().updateSettings({ theme: 'dark' }))
    expect(themeColor()).toBeTruthy()
    expect(themeColor()).not.toBe(light)
    // One tag, however many times the theme changes.
    expect(document.head.querySelectorAll('meta[name="theme-color"]').length).toBe(1)
  })

  it('follows the OS while on system, and stops once a theme is pinned', () => {
    const media = stubMatchMedia(false)
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'system' } })
    render(<ThemeProbe />)
    const lightColor = themeColor()

    media.set(true)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    const darkColor = themeColor()
    expect(darkColor).not.toBe(lightColor)

    // Pinning light must win over the dark OS preference.
    act(() => useAppStore.getState().updateSettings({ theme: 'light' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    media.set(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('survives a browser with no matchMedia at all', () => {
    // Unstubbed, this jsdom answers `undefined` — exactly the case the hook
    // feature-detects, so nothing has to be removed to reach it.
    expect(typeof window.matchMedia).not.toBe('function')
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'system' } })
    expect(() => render(<ThemeProbe />)).not.toThrow()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(resolveTheme('system')).toBe('light')
  })
})

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('vaultFolders', () => {
  it('lists every folder, including intermediate ones, sorted and deduped', () => {
    expect(vaultFolders(['Home.md', 'Projects/Alpha.md', 'Projects/Deep/Beta.md', 'Daily/x.md'])).toEqual([
      'Daily',
      'Projects',
      'Projects/Deep',
    ])
  })

  it('returns nothing for a flat vault', () => {
    expect(vaultFolders(['a.md', 'b.md'])).toEqual([])
  })
})

describe('parseImport', () => {
  it('reads the shape the export button writes', () => {
    expect(parseImport({ vault: 'v', notes: { 'a.md': 'A', 'b/c.md': 'C' } })).toEqual([
      ['a.md', 'A'],
      ['b/c.md', 'C'],
    ])
  })

  it('reads a bare path→content map and an array of records', () => {
    expect(parseImport({ 'a.md': 'A' })).toEqual([['a.md', 'A']])
    expect(parseImport([{ path: 'a.md', content: 'A' }])).toEqual([['a.md', 'A']])
    expect(parseImport({ notes: [{ path: 'a.md', content: 'A' }] })).toEqual([['a.md', 'A']])
  })

  it('skips junk entries instead of throwing, and rejects non-objects', () => {
    expect(parseImport({ 'a.md': 'A', 'b.md': 42, '': 'x', '  ': 'y' })).toEqual([['a.md', 'A']])
    expect(parseImport([{ path: 'a.md' }, null, 7, { path: 'b.md', content: 'B' }])).toEqual([['b.md', 'B']])
    expect(parseImport(null)).toEqual([])
    expect(parseImport('nope')).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * SettingsModal
 * ------------------------------------------------------------------ */

describe('SettingsModal', () => {
  function open(): void {
    render(<SettingsModal open onClose={noop} />)
  }

  it('renders nothing while closed', () => {
    const { container } = render(<SettingsModal open={false} onClose={noop} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders every section', () => {
    open()
    for (const title of ['Appearance', 'Editor', 'Notes', 'Graph', 'Vault', 'About']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    }
  })

  it('writes the theme through updateSettings as soon as a segment is clicked', () => {
    const updateSettings = vi.fn()
    useAppStore.setState({ updateSettings })
    open()

    const dark = screen.getByRole('button', { name: 'Dark' })
    expect(dark.getAttribute('aria-pressed')).toBe('false')
    // 'system' is the default, so its segment is the pressed one.
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(dark)
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('reflects the stored theme in the pressed segment', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } })
    open()
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('has no Save button — sliders and switches write immediately', () => {
    const updateSettings = vi.fn()
    useAppStore.setState({ updateSettings })
    open()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()

    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '21' } })
    expect(updateSettings).toHaveBeenCalledWith({ fontSize: 21 })

    fireEvent.click(screen.getByLabelText('Show line numbers'))
    expect(updateSettings).toHaveBeenCalledWith({ showLineNumbers: true })

    fireEvent.change(screen.getByLabelText('Autosave delay'), { target: { value: '2500' } })
    expect(updateSettings).toHaveBeenCalledWith({ autosaveDelay: 2500 })

    fireEvent.change(screen.getByLabelText('Editor font'), { target: { value: 'Georgia, serif' } })
    expect(updateSettings).toHaveBeenCalledWith({ editorFont: 'Georgia, serif' })
  })

  it('shows the live value next to each slider', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, fontSize: 19, autosaveDelay: 1500 } })
    open()
    expect(screen.getByText('19px')).toBeTruthy()
    expect(screen.getByText('1.5 s')).toBeTruthy()
  })

  it('stores the graph repulsion slider as a negative charge', () => {
    const updateSettings = vi.fn()
    useAppStore.setState({ updateSettings })
    open()
    fireEvent.change(screen.getByLabelText('Repulsion'), { target: { value: '300' } })
    expect(updateSettings).toHaveBeenCalledWith({ graphChargeStrength: -300 })
  })

  it('builds the new-note folder select from the vault, plus the root', () => {
    seed()
    const updateSettings = vi.fn()
    useAppStore.setState({ updateSettings })
    open()
    const select = screen.getByLabelText('Default folder for new notes') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Vault root',
      'Daily',
      'Projects',
      'Projects/Deep',
    ])

    fireEvent.change(select, { target: { value: 'Projects/Deep' } })
    expect(updateSettings).toHaveBeenCalledWith({ newNoteFolder: 'Projects/Deep' })
  })

  it('keeps a saved folder selectable after its notes are gone', () => {
    seed({ 'Home.md': '# Home\n' })
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, newNoteFolder: 'Archive' } })
    open()
    const select = screen.getByLabelText('Default folder for new notes') as HTMLSelectElement
    expect(select.value).toBe('Archive')
  })

  it('previews today’s daily note filename from the format', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, dailyNoteFolder: 'Journal', dailyNoteFormat: 'YYYY-MM-DD' },
    })
    open()
    const expected = `Journal/${formatDate('YYYY-MM-DD', new Date())}.md`
    expect(screen.getByTestId('daily-preview').textContent).toBe(expected)
  })

  it('re-previews when the format changes', () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, dailyNoteFolder: '', dailyNoteFormat: 'YYYY-MM-DD' } })
    open()
    act(() => useAppStore.getState().updateSettings({ dailyNoteFormat: 'DDDD, MMMM DD' }))
    expect(screen.getByTestId('daily-preview').textContent).toBe(`${formatDate('DDDD, MMMM DD', new Date())}.md`)
  })

  it('reports the open vault and asks the shell for the picker', () => {
    const notes = seed()
    useAppStore.setState({ adapter: createMemoryVault({}, { name: 'Notebook' }), vaultName: 'Notebook' })
    const onClose = vi.fn()
    const heard = vi.fn()
    window.addEventListener('spacefore:open-vault-picker', heard)
    render(<SettingsModal open onClose={onClose} />)

    expect(screen.getByText('Notebook')).toBeTruthy()
    expect(screen.getByText(`${notes.size} notes`)).toBeTruthy()
    expect(screen.getByText('Demo vault — nothing is saved')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /switch vault/i }))
    expect(heard).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    window.removeEventListener('spacefore:open-vault-picker', heard)
  })

  it('disables the export button for an empty vault and downloads otherwise', () => {
    open()
    const button = () => screen.getByRole('button', { name: /export/i }) as HTMLButtonElement
    expect(button().disabled).toBe(true)

    cleanup()
    seed()
    useAppStore.setState({ vaultName: 'My Vault' })
    const clicks: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      clicks.push(this)
    })
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    open()

    fireEvent.click(button())
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clicks).toHaveLength(1)
    expect(clicks[0]!.download).toBe('My Vault.json')
    expect(useAppStore.getState().toasts.map((toast) => toast.kind)).toEqual(['success'])
    vi.unstubAllGlobals()
  })

  it('reports an error when the browser refuses downloads', () => {
    seed()
    vi.stubGlobal('URL', {})
    open()
    fireEvent.click(screen.getByRole('button', { name: /export/i }))
    expect(useAppStore.getState().toasts.map((toast) => toast.kind)).toEqual(['error'])
    vi.unstubAllGlobals()
  })

  it('imports every note in a JSON file through createNote', async () => {
    const createNote = vi.fn(async (path: NotePath) => path)
    const pushToast = vi.fn()
    useAppStore.setState({ createNote, pushToast })
    open()

    const json = JSON.stringify({ notes: { 'Imported.md': '# Imported\n', 'sub/Two.md': 'two' } })
    const file = new File([json], 'vault.json', { type: 'application/json' })
    const input = screen.getByLabelText('Import notes from JSON') as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })

    expect(createNote.mock.calls).toEqual([
      ['Imported.md', '# Imported\n'],
      ['sub/Two.md', 'two'],
    ])
    expect(pushToast).toHaveBeenCalledWith('Imported 2 notes', 'success')
    // The input is cleared so the same file can be picked again.
    expect(input.value).toBe('')
  })

  it('surfaces a broken import file as an error toast', async () => {
    const createNote = vi.fn(async (path: NotePath) => path)
    const pushToast = vi.fn()
    useAppStore.setState({ createNote, pushToast })
    open()

    const file = new File(['{not json'], 'vault.json', { type: 'application/json' })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Import notes from JSON'), { target: { files: [file] } })
    })

    expect(createNote).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(pushToast.mock.calls[0]![1]).toBe('error')
  })

  it('lists the app version, a source link and a shortcut cheat sheet', () => {
    open()
    expect(screen.getByText(/^v\d+\.\d+\.\d+$/)).toBeTruthy()
    const link = screen.getByRole('link', { name: /source/i }) as HTMLAnchorElement
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')

    const table = document.querySelector('.settings-shortcuts')!
    expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(8)
    expect(screen.getByRole('rowheader', { name: 'Go to file' })).toBeTruthy()
    // Rendered per platform by `formatShortcut`, never as the raw "Mod+" spec.
    expect(table.textContent).not.toContain('Mod+')
  })
})

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

describe('Toasts', () => {
  function push(message: string, kind: 'info' | 'error' | 'success' = 'info'): string {
    const id = `toast-${message}`
    act(() => {
      useAppStore.setState((state) => ({ toasts: [...state.toasts, { id, message, kind }] }))
    })
    return id
  }

  it('renders one live region per toast, alert for errors', () => {
    render(<Toasts />)
    push('Saved', 'success')
    push('Could not save', 'error')

    const statuses = screen.getAllByRole('status')
    expect(statuses.map((node) => node.textContent?.replace('Dismiss notification', ''))).toContain('Saved')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not save')
    expect(alert.className).toContain('is-error')
  })

  it('stacks newest last and shows at most four', () => {
    render(<Toasts />)
    for (const message of ['one', 'two', 'three', 'four', 'five']) push(message)

    const live = [...document.querySelectorAll('.toast:not(.is-leaving) .toast-message')].map((n) => n.textContent)
    expect(live).toEqual(['two', 'three', 'four', 'five'])
    // The one pushed out of the window animates away rather than blinking out.
    expect(document.querySelector('.toast.is-leaving')?.textContent).toContain('one')
  })

  it('dismisses a toast through the store and animates it out before unmounting', async () => {
    render(<Toasts />)
    push('Deleted Home.md')
    expect(document.querySelectorAll('.toast')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    // Gone from the store immediately…
    expect(useAppStore.getState().toasts).toHaveLength(0)
    // …but still on screen, marked as leaving, while the exit animation runs.
    const leaving = document.querySelector('.toast.is-leaving')
    expect(leaving).toBeTruthy()
    expect((leaving as HTMLElement).style.animation).toContain('toast-in')

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(document.querySelectorAll('.toast')).toHaveLength(0)
  })

  it('does not strand a leaving toast when another one arrives mid-animation', async () => {
    render(<Toasts />)
    push('first')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    push('second')

    expect(document.querySelectorAll('.toast')).toHaveLength(2)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    const remaining = [...document.querySelectorAll('.toast .toast-message')].map((node) => node.textContent)
    expect(remaining).toEqual(['second'])
  })

  it('renders an empty stack without toasts', () => {
    const { container } = render(<Toasts />)
    expect(container.querySelector('.toast-stack')).toBeTruthy()
    expect(container.querySelectorAll('.toast')).toHaveLength(0)
  })
})
