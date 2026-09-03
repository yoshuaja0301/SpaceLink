import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { NotePath, VaultAdapter } from '../types'
import { emptyIndex } from '../core/graph/index'
import { createMemoryVault } from '../core/vault/memoryVault'
import { DEFAULT_SETTINGS, useAppStore } from '../state/store'
import { VaultPicker } from './VaultPicker'

// The browser and directory backends are stubbed: one needs IndexedDB and the
// other needs a user gesture plus the File System Access API, neither of which
// jsdom has. The demo vault is left real — it is pure in-memory.
vi.mock('../core/vault/browserVault', () => ({
  createBrowserVault: vi.fn(),
  hasStoredVault: vi.fn(),
  seedVault: vi.fn(),
}))
vi.mock('../core/vault/directoryVault', () => ({
  isDirectoryVaultSupported: vi.fn(),
  pickDirectoryVault: vi.fn(),
}))
// The sync client is stubbed for the same reason: it wants a server. What is
// under test here is what the form does with the answer, not the HTTP.
vi.mock('../core/vault/remoteVault', () => ({
  createRemoteVault: vi.fn(),
  openWithAccount: vi.fn(),
  signOut: vi.fn(),
}))

import { createBrowserVault, hasStoredVault, seedVault } from '../core/vault/browserVault'
import { isDirectoryVaultSupported, pickDirectoryVault } from '../core/vault/directoryVault'
import { createRemoteVault, openWithAccount, signOut } from '../core/vault/remoteVault'

const PRISTINE = useAppStore.getState()

const STORED_NOTES: Record<NotePath, string> = {
  'Kept.md': '# Kept\n',
  'Notes/Other.md': '# Other\n',
  'Notes/Third.md': '# Third\n',
}

function browserAdapter(files: Record<NotePath, string> = {}): VaultAdapter {
  return { ...createMemoryVault(files, { name: 'SpaceLink' }), kind: 'browser' }
}

/** Render and let the "what is in browser storage?" probe settle. */
async function show(onReady?: () => void): Promise<void> {
  await act(async () => {
    render(<VaultPicker onReady={onReady} />)
  })
}

function card(choice: 'demo' | 'browser' | 'directory' | 'remote'): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(`.vault-picker-option[data-choice="${choice}"]`)
  if (!node) throw new Error(`No ${choice} card rendered`)
  return node
}

async function click(choice: 'demo' | 'browser' | 'directory'): Promise<void> {
  await act(async () => {
    fireEvent.click(card(choice))
  })
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
      loading: false,
      error: null,
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

  vi.mocked(hasStoredVault).mockResolvedValue(false)
  vi.mocked(createBrowserVault).mockImplementation(async () => browserAdapter())
  vi.mocked(seedVault).mockResolvedValue(undefined)
  vi.mocked(isDirectoryVaultSupported).mockReturnValue(false)
  vi.mocked(pickDirectoryVault).mockResolvedValue(null)
  vi.mocked(openWithAccount).mockImplementation(async () => ({
    adapter: await vi.mocked(createRemoteVault)({ url: '', token: '' }),
    token: 'session-token',
    email: 'me@example.com',
  }))
  vi.mocked(signOut).mockResolvedValue(undefined)
  vi.mocked(createRemoteVault).mockImplementation(async () => ({
    ...createMemoryVault({ 'Synced.md': '# Synced\n' }, { name: 'Notebook' }),
    kind: 'remote',
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('VaultPicker', () => {
  it('offers four keyboard-reachable cards, demo first', async () => {
    await show()

    const cards = [...document.querySelectorAll<HTMLButtonElement>('.vault-picker-option')]
    expect(cards).toHaveLength(4)
    expect(cards.every((node) => node.tagName === 'BUTTON' && node.type === 'button')).toBe(true)
    expect(cards.map((node) => node.dataset.choice)).toEqual(['demo', 'browser', 'directory', 'remote'])
    expect(screen.getByText('Try the demo vault')).toBeTruthy()
    // The recommendation, and the size of what you are about to open.
    expect(card('demo').textContent).toMatch(/Recommended — \d+ notes/)
  })

  it('asks for an address and a token before it will connect to a server', async () => {
    await show()

    // The form is not in the way until the card asks for it.
    expect(screen.queryByLabelText('Server address')).toBeNull()

    await act(async () => {
      fireEvent.click(card('remote'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Access token' }))
    })

    const address = screen.getByLabelText('Server address') as HTMLInputElement
    const token = screen.getByLabelText('Access token') as HTMLInputElement
    expect(token.type).toBe('password')

    // Connecting stays disabled until both halves are there — a half-filled
    // pairing would only fail against the server.
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)

    await act(async () => {
      fireEvent.change(address, { target: { value: 'http://192.168.1.20:4899' } })
    })
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      fireEvent.change(token, { target: { value: 'a-token' } })
    })
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('opens the demo vault into the store and tells the shell it is done', async () => {
    const onReady = vi.fn()
    await show(onReady)
    await click('demo')

    const state = useAppStore.getState()
    expect(state.vaultName).toBe('Demo vault')
    expect(state.adapter?.kind).toBe('demo')
    expect(state.notes.size).toBeGreaterThan(0)
    expect(state.error).toBeNull()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('offers an empty browser vault and seeds it with a single welcome note', async () => {
    await show()

    expect(card('browser').textContent).toContain('Start empty')
    await click('browser')

    expect(vi.mocked(seedVault)).toHaveBeenCalledTimes(1)
    const [, files] = vi.mocked(seedVault).mock.calls[0]!
    expect(Object.keys(files)).toEqual(['Welcome.md'])
    expect(useAppStore.getState().adapter?.kind).toBe('browser')
  })

  it('offers to continue an existing browser vault, with its note count, and does not reseed', async () => {
    vi.mocked(hasStoredVault).mockResolvedValue(true)
    vi.mocked(createBrowserVault).mockImplementation(async () => browserAdapter(STORED_NOTES))
    await show()

    expect(screen.getByText('Continue where you left off')).toBeTruthy()
    expect(card('browser').textContent).toContain('3 notes')

    await click('browser')
    expect(vi.mocked(seedVault)).not.toHaveBeenCalled()
    expect([...useAppStore.getState().notes.keys()].sort()).toEqual(['Kept.md', 'Notes/Other.md', 'Notes/Third.md'])
  })

  it('falls back to the empty wording when the storage probe fails', async () => {
    vi.mocked(hasStoredVault).mockRejectedValue(new Error('storage blocked'))
    await show()
    expect(card('browser').textContent).toContain('Start empty')
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('disables the folder card and says why when the browser lacks the API', async () => {
    await show()

    const folder = card('directory')
    expect(folder.disabled).toBe(true)
    expect(folder.textContent).toContain('File System Access API')

    fireEvent.click(folder)
    expect(vi.mocked(pickDirectoryVault)).not.toHaveBeenCalled()
  })

  it('enables the folder card where the API exists', async () => {
    vi.mocked(isDirectoryVaultSupported).mockReturnValue(true)
    const adapter: VaultAdapter = { ...createMemoryVault({ 'Note.md': '# Note\n' }, { name: 'my-vault' }), kind: 'directory' }
    vi.mocked(pickDirectoryVault).mockResolvedValue(adapter)
    const onReady = vi.fn()
    await show(onReady)

    expect(card('directory').disabled).toBe(false)
    await click('directory')

    expect(useAppStore.getState().vaultName).toBe('my-vault')
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('treats a cancelled folder picker as a no-op', async () => {
    vi.mocked(isDirectoryVaultSupported).mockReturnValue(true)
    vi.mocked(pickDirectoryVault).mockResolvedValue(null)
    const onReady = vi.fn()
    await show(onReady)

    await click('directory')

    expect(onReady).not.toHaveBeenCalled()
    expect(useAppStore.getState().adapter).toBeNull()
    expect(useAppStore.getState().toasts).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
    // Still usable: the cards are not left in their loading state.
    expect(card('demo').disabled).toBe(false)
  })

  it('shows an error with a retry, and toasts it, when opening fails', async () => {
    vi.mocked(isDirectoryVaultSupported).mockReturnValue(true)
    vi.mocked(pickDirectoryVault).mockRejectedValue(new Error('Permission was not granted.'))
    const onReady = vi.fn()
    await show(onReady)

    await click('directory')

    expect(onReady).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Permission was not granted.')
    expect(useAppStore.getState().toasts.map((toast) => [toast.kind, toast.message])).toEqual([
      ['error', 'Permission was not granted.'],
    ])

    // Retrying re-runs the same choice, and a success clears the error.
    const adapter: VaultAdapter = { ...createMemoryVault({ 'A.md': '# A\n' }, { name: 'second-try' }), kind: 'directory' }
    vi.mocked(pickDirectoryVault).mockResolvedValue(adapter)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })

    expect(vi.mocked(pickDirectoryVault)).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(useAppStore.getState().vaultName).toBe('second-try')
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('reports a vault that fails to load rather than silently opening nothing', async () => {
    const broken: VaultAdapter = {
      ...createMemoryVault({}, { name: 'broken' }),
      kind: 'browser',
      list: () => Promise.reject(new Error('Vault is unreadable')),
    }
    vi.mocked(createBrowserVault).mockImplementation(async () => broken)
    const onReady = vi.fn()
    await show(onReady)

    await click('browser')

    expect(onReady).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Vault is unreadable')
  })

  it('locks the other cards while one is opening', async () => {
    let release = (): void => {}
    vi.mocked(createBrowserVault).mockImplementation(
      () =>
        new Promise<VaultAdapter>((resolve) => {
          release = () => resolve(browserAdapter())
        }),
    )
    await show()

    await act(async () => {
      fireEvent.click(card('browser'))
    })
    expect(card('browser').getAttribute('aria-busy')).toBe('true')
    expect(card('browser').textContent).toContain('Opening…')
    expect(card('demo').disabled).toBe(true)

    await act(async () => {
      release()
    })
    expect(card('demo').disabled).toBe(false)
  })

  /**
   * Signing in is the path that makes several devices feel like one app, so
   * what matters is what the form keeps afterwards: the session, never the
   * password.
   */
  describe('signing in to a server', () => {
    /** Open the card and fill the sign-in form. */
    async function fillSignIn(email = 'me@example.com', password = 'a long enough password'): Promise<void> {
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'http://mac.local:4899' } })
      })
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
      })
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
      })
    }

    it('offers an account before a token, because that is the way that works on more than one device', async () => {
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      expect((screen.getByRole('radio', { name: 'Sign in' }) as HTMLElement).getAttribute('aria-checked')).toBe('true')
      expect(screen.getByLabelText('Email')).toBeTruthy()
      expect(screen.queryByLabelText('Access token')).toBeNull()
      // And says where an account comes from, since there is no sign-up form.
      expect(document.querySelector('.vault-connect')?.textContent).toContain('--add-account')
    })

    it('is one tab stop, and the arrows move within it', async () => {
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      const signIn = screen.getByRole('radio', { name: 'Sign in' })
      const token = screen.getByRole('radio', { name: 'Access token' })
      // The selected option is the group's tab stop; the other is skipped.
      expect(signIn.getAttribute('tabindex')).toBe('0')
      expect(token.getAttribute('tabindex')).toBe('-1')

      await act(async () => {
        fireEvent.keyDown(signIn, { key: 'ArrowRight' })
      })
      expect(screen.getByRole('radio', { name: 'Access token' }).getAttribute('aria-checked')).toBe('true')
      expect(screen.getByLabelText('Access token')).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Access token' }))

      // Either direction, since there are only two of them.
      await act(async () => {
        fireEvent.keyDown(screen.getByRole('radio', { name: 'Access token' }), { key: 'ArrowLeft' })
      })
      expect(screen.getByRole('radio', { name: 'Sign in' }).getAttribute('aria-checked')).toBe('true')
    })

    it('will not submit half a sign-in', async () => {
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      const connect = (): HTMLButtonElement => screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
      expect(connect().disabled).toBe(true)
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'http://mac.local:4899' } })
      })
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } })
      })
      expect(connect().disabled).toBe(true)
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough password' } })
      })
      expect(connect().disabled).toBe(false)
    })

    it('opens the account’s vault and remembers the session, never the password', async () => {
      const onReady = vi.fn()
      await show(onReady)
      await fillSignIn()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      })

      // One call, not two: signing in and opening the vault are a pair, and a
      // sign-in that worked with an open that did not would leave a session on
      // the server this device is about to forget.
      expect(vi.mocked(openWithAccount)).toHaveBeenCalledWith(
        'http://mac.local:4899',
        'me@example.com',
        'a long enough password',
      )
      expect(useAppStore.getState().vaultName).toBe('Notebook')
      expect(onReady).toHaveBeenCalledTimes(1)

      const remembered = JSON.parse(localStorage.getItem('spacelink.remote') ?? '{}') as Record<string, unknown>
      expect(remembered).toEqual({
        url: 'http://mac.local:4899',
        token: 'session-token',
        name: 'Notebook',
        email: 'me@example.com',
      })
      // The password is not in storage, and not left in the field either.
      expect(localStorage.getItem('spacelink.remote')).not.toContain('a long enough password')
      expect((screen.queryByLabelText('Password') as HTMLInputElement | null)?.value ?? '').toBe('')
    })

    it('shows what the server said when the password is refused, and remembers nothing', async () => {
      vi.mocked(openWithAccount).mockRejectedValue(new Error('That email and password do not match an account.'))
      const onReady = vi.fn()
      await show(onReady)
      await fillSignIn()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      })

      expect(screen.getByRole('alert').textContent).toContain('do not match an account')
      expect(localStorage.getItem('spacelink.remote'), 'a refused sign-in was remembered').toBeNull()
      expect(onReady).not.toHaveBeenCalled()
    })

    it('starts on the token form for a device that was paired with a token', async () => {
      localStorage.setItem(
        'spacelink.remote',
        JSON.stringify({ url: 'http://mac.local:4899', token: 'the-token', name: 'Notes' }),
      )
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      expect(screen.getByLabelText('Access token')).toBeTruthy()
      expect(screen.queryByLabelText('Password')).toBeNull()
    })

    it('signs out on the server, not only in this browser', async () => {
      // Forgetting the token here would leave the session alive on the server
      // for its full thirty days, which is the opposite of what someone
      // handing a laptop back is asking for.
      localStorage.setItem(
        'spacelink.remote',
        JSON.stringify({ url: 'http://mac.local:4899', token: 'session', name: 'Notebook', email: 'me@example.com' }),
      )
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      })

      expect(vi.mocked(signOut)).toHaveBeenCalledWith('http://mac.local:4899', 'session')
      expect(localStorage.getItem('spacelink.remote')).toBeNull()
      // And the card stops offering a pairing this device no longer has.
      expect(card('remote').textContent).toContain('Connect to a server')
      expect(useAppStore.getState().toasts.map((toast) => toast.message)).toContain('Signed out of me@example.com.')
    })

    it('forgets a token pairing without pretending to sign anything out', async () => {
      // There is no session to end: a token belongs to the server, not to a
      // device, and asking it to revoke one would be a call that means nothing.
      localStorage.setItem(
        'spacelink.remote',
        JSON.stringify({ url: 'http://mac.local:4899', token: 'the-token', name: 'Notes' }),
      )
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Forget this server' }))
      })

      expect(vi.mocked(signOut)).not.toHaveBeenCalled()
      expect(localStorage.getItem('spacelink.remote')).toBeNull()
    })

    it('offers nothing to disconnect on a device that never paired', async () => {
      await show()
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Forget this server' })).toBeNull()
    })

    it('says who a returning device was signed in as', async () => {
      localStorage.setItem(
        'spacelink.remote',
        JSON.stringify({ url: 'http://mac.local:4899', token: 'session', name: 'Notebook', email: 'me@example.com' }),
      )
      await show()
      expect(card('remote').textContent).toContain('me@example.com')
      await act(async () => {
        fireEvent.click(card('remote'))
      })
      expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('me@example.com')
      // The password is asked for again: it was never kept.
      expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
    })
  })
})
