/**
 * SpaceLink — the status bar.
 *
 * Vault identity on the left (and the way back to the vault picker), readouts
 * for the note in the active pane on the right. With no note open the right
 * half simply disappears rather than showing a row of zeroes.
 */
import type { JSX } from 'react'
import { useMemo } from 'react'

import type { ViewMode } from '../types'
import { useAppStore } from '../state/store'
import { Icon } from './Icon'

const MODE_LABELS: Record<ViewMode, string> = { edit: 'Edit', split: 'Split', preview: 'Preview' }

function plural(count: number, singular: string): string {
  return `${count.toLocaleString()} ${singular}${count === 1 ? '' : 's'}`
}

/** Ask the shell to show the vault picker. App listens for this on `window`. */
export function requestVaultPicker(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent('spacelink:open-vault-picker'))
}

export function StatusBar(): JSX.Element {
  const panes = useAppStore((s) => s.panes)
  const activePaneId = useAppStore((s) => s.activePaneId)
  const notes = useAppStore((s) => s.notes)
  const index = useAppStore((s) => s.index)
  const dirty = useAppStore((s) => s.dirty)
  const saving = useAppStore((s) => s.saving)
  const vaultName = useAppStore((s) => s.vaultName)

  const pane = panes.find((candidate) => candidate.id === activePaneId) ?? panes[0]
  const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? null
  const path = tab && tab.kind === 'note' ? tab.path : null
  const note = path ? (notes.get(path) ?? null) : null

  // Backlinks are derived, not stored: recompute only when the note or the
  // link index changes (every edit anywhere rebuilds the index).
  const backlinks = useMemo(() => {
    if (!path) return 0
    return useAppStore
      .getState()
      .backlinksFor(path)
      .reduce((total, group) => total + group.edges.length, 0)
  }, [path, index])

  const isSaving = path !== null && saving.has(path)
  const isDirty = path !== null && dirty.has(path)
  const saveLabel = isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Saved'

  return (
    <footer className="statusbar">
      <button
        type="button"
        className="statusbar-item"
        aria-label={`Vault: ${vaultName || 'none'}. Open the vault picker`}
        title="Open the vault picker"
        onClick={requestVaultPicker}
      >
        <Icon name="folder" size={12} />
        <span>{vaultName || 'No vault'}</span>
      </button>
      <span className="statusbar-item is-secondary">{plural(notes.size, 'note')}</span>

      <span className="statusbar-spacer" />

      {note && tab && (
        <>
          {/* Everything from here to the save state is `is-secondary`: on a
              phone the bar cannot hold it all, and what must survive is
              whether the note is saved. See the media query in app.css. */}
          <span className="statusbar-item is-secondary" title="Current view mode">
            {MODE_LABELS[tab.mode]}
          </span>
          <span className="statusbar-item is-secondary">{plural(note.parsed.wordCount, 'word')}</span>
          <span className="statusbar-item is-secondary">{plural(note.content.length, 'character')}</span>
          <span className="statusbar-item is-secondary" title="Links pointing at this note">
            {plural(backlinks, 'backlink')}
          </span>
          <span
            className={isDirty || isSaving ? 'statusbar-item is-dirty' : 'statusbar-item'}
            role="status"
            aria-live="polite"
          >
            {!isSaving && !isDirty && <Icon name="check" size={12} />}
            {saveLabel}
          </span>
        </>
      )}
    </footer>
  )
}

export default StatusBar
