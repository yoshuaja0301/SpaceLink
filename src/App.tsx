/**
 * SpaceLink — application shell.
 *
 * Owns first-run vault selection, global keyboard handling and the overall
 * layout: ribbon | sidebar | workspace | right sidebar, with the status bar
 * underneath and the palette / modals / toasts layered on top.
 */
import { useCallback, useEffect, useState } from 'react'

import type { VaultKind } from './types'

import { LAST_VAULT_KEY, useAppStore } from './state/store'
import { createBrowserVault } from './core/vault/browserVault'
import { createDemoVault } from './core/vault/demoVault'
import { createDirectoryVault, restoreVaultHandle } from './core/vault/directoryVault'
import { loadRemoteConnection, saveRemoteConnection, takeHandoffConnection } from './core/vault/remoteConnection'
import { createRemoteVault } from './core/vault/remoteVault'
import { CommandPalette } from './ui/CommandPalette'
import { DialogHost } from './ui/DialogHost'
import { Ribbon } from './ui/Ribbon'
import { RightSidebar } from './ui/RightSidebar'
import { SettingsModal } from './ui/SettingsModal'
import { Sidebar } from './ui/Sidebar'
import { StatusBar } from './ui/StatusBar'
import { Toasts } from './ui/Toasts'
import { VaultPicker } from './ui/VaultPicker'
import { Workspace } from './ui/Workspace'
import { useCommands } from './ui/commands'
import { useHotkeys } from './ui/useHotkeys'
import { useTheme } from './ui/useTheme'
import { usePrefetchHeavyViews } from './ui/lazy'
import { useNarrowLayout } from './ui/useNarrowLayout'

export function App(): React.JSX.Element {
  const adapter = useAppStore((s) => s.adapter)
  const loading = useAppStore((s) => s.loading)
  const progress = useAppStore((s) => s.loadingProgress)
  const sidebarPanel = useAppStore((s) => s.sidebarPanel)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const openVault = useAppStore((s) => s.openVault)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [booting, setBooting] = useState(true)

  useTheme()
  usePrefetchHeavyViews()
  useNarrowLayout()
  const commands = useCommands()
  useHotkeys(commands)

  // Startup: reopen whichever vault was open last. A reader who picked the
  // browser vault or a folder and then reloaded used to land back in the demo
  // with their notes apparently gone, so the kind is remembered and restored;
  // the demo is only the fallback when there is nothing to restore.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Launched by something local that already knows the server and the
      // token — the macOS app does exactly this. It wins over whatever was
      // remembered: the host just told us where the vault is.
      const handoff = takeHandoffConnection(window.location, window.history)
      if (handoff) {
        try {
          const vault = await createRemoteVault(handoff)
          if (cancelled) return
          saveRemoteConnection({ url: handoff.url, token: handoff.token, name: vault.name })
          await openVault(vault)
          return
        } catch {
          // The host is gone or the token was refused. Fall through to whatever
          // this device was doing before rather than showing an empty window.
        }
      }

      let lastKind: VaultKind | null = null
      try {
        const raw = localStorage.getItem(LAST_VAULT_KEY)
        const parsed: unknown = raw ? JSON.parse(raw) : null
        const kind = (parsed as { kind?: unknown } | null)?.kind
        if (kind === 'browser' || kind === 'directory' || kind === 'demo' || kind === 'remote') lastKind = kind
      } catch {
        /* unreadable storage — start from the demo */
      }

      let lostFolder = false
      if (lastKind === 'directory' || lastKind === null) {
        try {
          const handle = await restoreVaultHandle()
          if (cancelled) return
          if (handle) {
            await openVault(createDirectoryVault(handle))
            return
          }
          // A folder was remembered but could not be reopened — the browser
          // drops directory grants after a while. Say so rather than quietly
          // presenting the demo vault as if nothing happened.
          lostFolder = lastKind === 'directory'
        } catch {
          lostFolder = lastKind === 'directory'
        }
      }

      let lostServer = false
      if (lastKind === 'remote') {
        const connection = loadRemoteConnection()
        if (connection) {
          try {
            const vault = await createRemoteVault(connection)
            if (cancelled) return
            await openVault(vault)
            return
          } catch {
            // The server is asleep, the network is elsewhere, or the token was
            // rotated. Fall through to a usable vault and say what happened —
            // the pairing is kept, so it reconnects by itself once it is back.
            lostServer = true
          }
        }
      }

      if (lastKind === 'browser') {
        try {
          const vault = await createBrowserVault()
          if (cancelled) return
          await openVault(vault)
          return
        } catch {
          /* IndexedDB unavailable — fall through to the demo */
        }
      }

      if (cancelled) return
      // `remember: false`: this is a fallback, not a choice. The remembered
      // vault stays remembered, so restoring the grant is enough to get it back.
      await openVault(createDemoVault(), { remember: false })
      if (lostFolder) {
        useAppStore
          .getState()
          .pushToast('Could not reopen your folder — the browser no longer has permission. Open it again from the status bar.', 'error')
      }
      if (lostServer) {
        useAppStore
          .getState()
          .pushToast('Could not reach your sync server. Your pairing is kept — reload once it is back.', 'error')
      }
    })().finally(() => {
      if (!cancelled) setBooting(false)
    })
    return () => {
      cancelled = true
    }
  }, [openVault])

  // The status bar and settings modal ask for the vault picker through an event
  // so they do not need to know about App's local state.
  useEffect(() => {
    const open = (): void => setPickerOpen(true)
    const settings = (): void => setSettingsOpen(true)
    window.addEventListener('spacelink:open-vault-picker', open)
    window.addEventListener('spacelink:open-settings', settings)
    return () => {
      window.removeEventListener('spacelink:open-vault-picker', open)
      window.removeEventListener('spacelink:open-settings', settings)
    }
  }, [])

  // Never lose edits on unload: flush pending autosaves.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (useAppStore.getState().dirty.size === 0) return
      void useAppStore.getState().saveAll()
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const closePicker = useCallback(() => setPickerOpen(false), [])

  if (booting && !adapter) {
    // A big vault takes a moment. Counting the notes as they land is the
    // difference between "it is working" and "it has hung".
    const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null
    return (
      <div className="app app-booting">
        <div className="boot-splash">
          <div className="boot-logo" aria-hidden="true" />
          <p>{progress ? `Opening vault… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} notes` : 'Opening vault…'}</p>
          {pct !== null && (
            <div
              className="boot-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label="Opening vault"
            >
              <div className="boot-progress-bar" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app" style={{ fontSize: `${fontSize}px` }}>
      <Ribbon onOpenSettings={() => setSettingsOpen(true)} />

      {sidebarPanel !== null && (
        <div className="sidebar" style={{ width: `${sidebarWidth}px` }}>
          <Sidebar />
        </div>
      )}

      <main className="workspace-area">
        <Workspace />
      </main>

      {rightSidebarOpen && (
        <div className="right-sidebar" style={{ width: `${rightSidebarWidth}px` }}>
          <RightSidebar />
        </div>
      )}

      {/* Only ever visible under the narrow-width media query, where a sidebar
          floats over the note. Tapping the note is how you dismiss a drawer on
          a phone, and without this there is nothing to tap. */}
      {(sidebarPanel !== null || rightSidebarOpen) && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close the sidebar"
          onClick={() => {
            const state = useAppStore.getState()
            if (state.rightSidebarOpen) state.toggleRightSidebar(false)
            else if (state.sidebarPanel !== null) state.setSidebarPanel(state.sidebarPanel)
          }}
        />
      )}

      <StatusBar />

      <CommandPalette />
      <DialogHost />
      <Toasts />
      {/* Mounted only while it is open. It renders nothing when closed either
          way, but its hooks still ran — including one that walks every path in
          the vault to list the folders — so a closed dialog was doing work
          proportional to the vault on every keystroke. */}
      {settingsOpen && <SettingsModal open onClose={() => setSettingsOpen(false)} />}

      {(pickerOpen || (!adapter && !loading)) && (
        <div className="vault-picker-layer">
          <VaultPicker onReady={closePicker} />
        </div>
      )}
    </div>
  )
}

export default App
