// @vitest-environment jsdom
/**
 * The one moment the shell owns on its own: reopening the server this device
 * was paired with, and what it says when that does not work.
 *
 * Everything below that — the layout, the panels, the editor — has its own
 * tests. This file is here for the boot path, which nothing else reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

vi.mock('./core/vault/remoteVault', async () => {
  const actual = await vi.importActual<typeof import('./core/vault/remoteVault')>('./core/vault/remoteVault')
  return { ...actual, createRemoteVault: vi.fn() }
})

import { createMemoryVault } from './core/vault/memoryVault'
import { App } from './App'
import { LAST_VAULT_KEY, useAppStore } from './state/store'
import { REMOTE_KEY } from './core/vault/remoteConnection'
import { createRemoteVault, RemoteRefused } from './core/vault/remoteVault'

/** The state a device is in after it has been paired with a server. */
function pairedWithAServer(): void {
  // Stored as the store writes it: the kind in an object, not a bare string.
  localStorage.setItem(LAST_VAULT_KEY, JSON.stringify({ kind: 'remote' }))
  localStorage.setItem(
    REMOTE_KEY,
    JSON.stringify({ url: 'http://mac.local:4899', token: 'a session', name: 'Notebook', email: 'me@example.com' }),
  )
}

/** The toasts on screen, as the reader would read them. */
const toasts = (): string[] => useAppStore.getState().toasts.map((toast) => toast.message)

/**
 * Render, and let the boot finish.
 *
 * Reopening a vault is a chain of awaits — the remembered kind, the adapter,
 * the whole vault read into the store — and the toast is the last thing in it.
 * Asserting before that lands would pass for the wrong reason: nothing has
 * been said yet, which is not the same as nothing being said.
 */
async function boot(): Promise<void> {
  await act(async () => {
    render(<App />)
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && useAppStore.getState().loading) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20))
    })
  }
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50))
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(createRemoteVault).mockReset()
  // The store is module state and outlives a render: a toast from the last
  // test would otherwise be read as this one's.
  useAppStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('reopening the server this device was paired with', () => {
  it('sends a reader whose sign-in was refused to sign in again', async () => {
    // `--set-password` signs every device out, which is what it is for. The
    // device that was signed out is told the truth about it rather than being
    // told its server is unreachable — the server is up; the credential is not.
    pairedWithAServer()
    vi.mocked(createRemoteVault).mockRejectedValue(
      new RemoteRefused('That sign-in is no longer valid. Sign in again.'),
    )

    await boot()

    expect(toasts().join(' ')).toMatch(/sign in again/i)
    expect(toasts().join(' '), 'a refused sign-in was reported as an unreachable server').not.toMatch(/reload/i)
    // The pairing is kept: it is what pre-fills the address and the email.
    expect(localStorage.getItem(REMOTE_KEY)).toContain('me@example.com')
  })

  it('tells a reader whose server is away to reload once it is back', async () => {
    pairedWithAServer()
    vi.mocked(createRemoteVault).mockRejectedValue(new Error('Could not reach http://mac.local:4899.'))

    await boot()

    expect(toasts().join(' ')).toMatch(/reload once it is back/i)
    expect(toasts().join(' '), 'a server that is away was blamed on the reader').not.toMatch(/sign in again/i)
  })

  it('says nothing at all when the server opens', async () => {
    pairedWithAServer()
    vi.mocked(createRemoteVault).mockResolvedValue({
      ...createMemoryVault({ 'Home.md': '# Home\n' }, { name: 'Notebook' }),
      kind: 'remote',
    })

    await boot()

    // The vault really did open — otherwise "no toast" would pass for a boot
    // that never got that far, which is the failure this is meant to catch.
    expect(useAppStore.getState().vaultName, 'the vault never opened').toBe('Notebook')
    expect(toasts(), 'a vault that opened fine still complained').toEqual([])
  })
})

describe('a boot that never had a server to reopen', () => {
  it('says nothing about a sync server to a device that was never paired with one', async () => {
    // The demo vault, reached because nothing else was remembered. A device
    // that has never seen a sync server must not be told its sync server
    // could not be reached — the sentence would be pure noise, and the reader
    // would go looking for a server that does not exist.
    localStorage.setItem(LAST_VAULT_KEY, JSON.stringify({ kind: 'demo' }))

    await boot()

    expect(vi.mocked(createRemoteVault), 'a device with no pairing called a server').not.toHaveBeenCalled()
    expect(toasts(), 'a device that never had a server was told about one').toEqual([])
  })
})
