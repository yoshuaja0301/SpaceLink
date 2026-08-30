/**
 * SpaceFore — first-run / switch-vault screen.
 *
 * Three ways in, in the order most people want them:
 *
 *   1. the demo vault — read the feature tour without committing anything,
 *   2. the browser vault — IndexedDB, survives a reload, no permission prompt,
 *   3. a real folder on disk — File System Access API, Chromium only,
 *   4. a sync server — the same vault on every device you own.
 *
 * Whichever is chosen ends the same way: build a `VaultAdapter`, hand it to
 * `openVault`, then tell the shell we are done. Failures stay on this screen
 * (with a retry) *and* raise a toast, because the picker is sometimes opened
 * over an already-working vault.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { JSX } from 'react'

import type { NotePath } from '../types'
import { useAppStore } from '../state/store'
import { createBrowserVault, hasStoredVault, seedVault } from '../core/vault/browserVault'
import { createDemoVault, DEMO_NOTES } from '../core/vault/demoVault'
import { isDirectoryVaultSupported, pickDirectoryVault } from '../core/vault/directoryVault'
import { createRemoteVault } from '../core/vault/remoteVault'
import { loadRemoteConnection, saveRemoteConnection } from '../core/vault/remoteConnection'
import { Icon } from './Icon'
import type { IconName } from './Icon'

type Choice = 'demo' | 'browser' | 'directory' | 'remote'

/** The single note a brand-new browser vault starts with. */
const WELCOME_NOTE: Record<NotePath, string> = {
  'Welcome.md': `# Welcome

This vault lives in your browser's storage, so it is still here after a reload —
no account, no server, nothing leaves this tab.

Some things to try:

- Type \`[[\` anywhere to link to another note. Linking to a note that does not
  exist yet creates it when you follow the link.
- Add a #tag inline, or a \`tags:\` list in the frontmatter.
- Press the graph button in the left rail to watch the vault take shape.

When you outgrow the browser, open a real folder from the vault picker in the
status bar and keep your notes as ordinary Markdown files.
`,
}

const DEMO_NOTE_COUNT = Object.keys(DEMO_NOTES).filter((path) => path.toLowerCase().endsWith('.md')).length

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const text = String(error)
  return text && text !== 'undefined' ? text : 'Something went wrong opening that vault.'
}

/** Plural-safe "3 notes" / "1 note". */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

interface CardProps {
  choice: Choice
  icon: IconName
  title: string
  description: string
  disabled: boolean
  busy: boolean
  onPick: (choice: Choice) => void
}

function VaultCard({ choice, icon, title, description, disabled, busy, onPick }: CardProps): JSX.Element {
  return (
    <button
      type="button"
      className="vault-picker-option"
      data-choice={choice}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={() => onPick(choice)}
    >
      <Icon name={icon} size={20} />
      <span>
        <span className="vault-picker-option-title">{title}</span>
        <span className="vault-picker-option-description">{busy ? 'Opening…' : description}</span>
      </span>
    </button>
  )
}

export function VaultPicker({ onReady }: { onReady?: () => void }): JSX.Element {
  const openVault = useAppStore((s) => s.openVault)
  const pushToast = useAppStore((s) => s.pushToast)

  const titleId = useId()
  const [busy, setBusy] = useState<Choice | null>(null)
  const [error, setError] = useState<{ choice: Choice; message: string } | null>(null)
  /** `null` until the IndexedDB probe below has answered. */
  const [stored, setStored] = useState<{ present: boolean; count: number } | null>(null)
  /** The connect-to-a-server form, opened by its card. */
  const [connecting, setConnecting] = useState(false)
  const remembered = loadRemoteConnection()
  const [serverUrl, setServerUrl] = useState(remembered?.url ?? '')
  const [serverToken, setServerToken] = useState(remembered?.token ?? '')

  const directorySupported = isDirectoryVaultSupported()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Look up what is already in browser storage so the second card can offer to
  // continue rather than to start over. Failures are not worth reporting — the
  // card simply falls back to its "start empty" wording.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const present = await hasStoredVault()
        if (!present) {
          if (!cancelled) setStored({ present: false, count: 0 })
          return
        }
        const adapter = await createBrowserVault()
        const files = await adapter.list()
        if (!cancelled) {
          setStored({ present: true, count: files.filter((file) => file.isMarkdown).length })
        }
      } catch {
        if (!cancelled) setStored({ present: false, count: 0 })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** Build the adapter for a choice. `null` means the user backed out. */
  const buildAdapter = useCallback(
    async (choice: Choice) => {
    if (choice === 'demo') return createDemoVault()
    if (choice === 'directory') return pickDirectoryVault()
    if (choice === 'remote') {
      const adapter = await createRemoteVault({ url: serverUrl, token: serverToken })
      // Only remembered once the server has actually accepted the pairing, so a
      // typo never becomes the connection this device retries on every load.
      saveRemoteConnection({ url: serverUrl.trim(), token: serverToken.trim(), name: adapter.name })
      return adapter
    }

    // Seeding is skipped for a vault that already has content, so a returning
    // user never gets a second copy of the welcome note.
    const existing = await hasStoredVault()
    const adapter = await createBrowserVault()
    if (!existing) await seedVault(adapter, WELCOME_NOTE)
    return adapter
    },
    [serverToken, serverUrl],
  )

  const pick = useCallback(
    async (choice: Choice) => {
      setBusy(choice)
      setError(null)
      try {
        const adapter = await buildAdapter(choice)
        // The directory picker resolves null when the dialog is dismissed:
        // that is not an error, so leave the screen exactly as it was.
        if (!adapter) return
        await openVault(adapter)
        // `openVault` swallows its own failures into `state.error`.
        const failure = useAppStore.getState().error
        if (failure) throw new Error(failure)
        onReady?.()
      } catch (caught) {
        const message = describeError(caught)
        if (mountedRef.current) setError({ choice, message })
        pushToast(message, 'error')
      } finally {
        if (mountedRef.current) setBusy(null)
      }
    },
    [buildAdapter, onReady, openVault, pushToast],
  )

  const onPick = useCallback(
    (choice: Choice) => {
      void pick(choice)
    },
    [pick],
  )

  const browserDescription = stored?.present
    ? `Continue where you left off — ${plural(stored.count, 'note')} saved in this browser.`
    : 'Start empty. Notes are kept in this browser’s storage and survive a reload.'

  return (
    <section className="vault-picker" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div>
        <h1 id={titleId}>Open a vault</h1>
        <p>
          A vault is just a folder of Markdown files. Pick where SpaceFore should keep yours — you can switch at any
          time from the status bar.
        </p>
      </div>

      <div className="vault-picker-options">
        <VaultCard
          choice="demo"
          icon="star"
          title="Try the demo vault"
          description={`Recommended — ${plural(DEMO_NOTE_COUNT, 'note')} covering links, tags, search and the graph. Nothing is saved.`}
          disabled={busy !== null}
          busy={busy === 'demo'}
          onPick={onPick}
        />

        <VaultCard
          choice="browser"
          icon="files"
          title={stored?.present ? 'Continue where you left off' : 'Start empty'}
          description={browserDescription}
          disabled={busy !== null}
          busy={busy === 'browser'}
          onPick={onPick}
        />

        <VaultCard
          choice="directory"
          icon="folder-open"
          title="Open a folder"
          description={
            directorySupported
              ? 'Read and write real Markdown files on your machine. You choose the folder; nothing else is touched.'
              : 'Unavailable: this browser has no File System Access API, so a local folder cannot be opened.'
          }
          disabled={busy !== null || !directorySupported}
          busy={busy === 'directory'}
          onPick={onPick}
        />
        <VaultCard
          choice="remote"
          icon="link"
          title={remembered ? `Reconnect to ${remembered.name ?? 'your server'}` : 'Connect to a server'}
          description="Sync the same vault across every device you own. Run the server on the machine that holds your notes, then paste its address and token here."
          disabled={busy !== null}
          busy={busy === 'remote'}
          onPick={() => setConnecting((open) => !open)}
        />
      </div>

      {connecting && (
        <form
          className="vault-connect"
          onSubmit={(event) => {
            event.preventDefault()
            onPick('remote')
          }}
        >
          <label className="dialog-field" htmlFor={`${titleId}-url`}>
            <span>Server address</span>
            <input
              id={`${titleId}-url`}
              className="input"
              value={serverUrl}
              placeholder="http://192.168.1.20:4899"
              autoComplete="url"
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </label>
          <label className="dialog-field" htmlFor={`${titleId}-token`}>
            <span>Access token</span>
            <input
              id={`${titleId}-token`}
              className="input"
              value={serverToken}
              type="password"
              placeholder="Printed by the server when it starts"
              autoComplete="off"
              onChange={(event) => setServerToken(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConnecting(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy !== null || serverUrl.trim() === '' || serverToken.trim() === ''}
            >
              {busy === 'remote' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      )}

      <p className="vault-picker-status" role="status">
        {busy !== null && 'Opening vault…'}
        {busy === null && error === null && stored === null && 'Checking browser storage…'}
      </p>

      {error !== null && (
        <div className="vault-picker-error" role="alert">
          <p>{error.message}</p>
          <button type="button" className="btn btn-primary" onClick={() => onPick(error.choice)}>
            Try again
          </button>
        </div>
      )}
    </section>
  )
}

export default VaultPicker
