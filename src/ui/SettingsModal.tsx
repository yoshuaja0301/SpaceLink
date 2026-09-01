/**
 * SpaceFore — settings.
 *
 * Six grouped sections in the shared `Modal`. There is no Save button on
 * purpose: every control writes straight through `updateSettings`, which
 * persists to localStorage, so what you see is always what is stored. That
 * also makes the font-size and line-length controls live previews — the app
 * shell reads the same values.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, JSX, ReactNode } from 'react'

import type { NotePath, ThemeName } from '../types'
import { dirname, formatDate, joinPath, sanitizeFileName, useAppStore } from '../state/store'
import { buildExport, parseImport } from '../core/vault/transfer'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { formatShortcut } from './useHotkeys'

/** Kept in step with `package.json` by hand — importing JSON would bloat the bundle. */
const APP_VERSION = '0.1.0'

const SOURCE_URL = 'https://github.com/spacefore/spacefore'

const THEMES: { value: ThemeName; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/** Suggestions for the editor font box; anything else may be typed instead. */
const FONT_SUGGESTIONS: { label: string; value: string }[] = [
  { label: 'System sans', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { label: 'System serif', value: 'Iowan Old Style, Palatino, "Palatino Linotype", Georgia, serif' },
  { label: 'System mono', value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { label: 'Inter / Helvetica', value: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
]

const SHORTCUTS: { spec: string; action: string }[] = [
  { spec: 'Mod+P', action: 'Go to file' },
  { spec: 'Mod+O', action: 'Open quick switcher' },
  { spec: 'Mod+Shift+F', action: 'Search in vault' },
  { spec: 'Mod+Shift+O', action: 'Go to heading' },
  { spec: 'Mod+G', action: 'Open graph view' },
  { spec: 'Mod+N', action: 'New note' },
  { spec: 'Mod+Shift+D', action: "Open today's daily note" },
  { spec: 'Mod+S', action: 'Save current note' },
  { spec: 'Mod+E', action: 'Toggle edit / preview' },
  { spec: 'Mod+\\', action: 'Split right' },
  { spec: 'Mod+Alt+B', action: 'Toggle left sidebar' },
  { spec: 'Mod+W', action: 'Close tab' },
  { spec: 'Mod+,', action: 'Open settings' },
  { spec: 'Mod+B', action: 'Bold' },
  { spec: 'Mod+I', action: 'Italic' },
  { spec: 'Mod+K', action: 'Insert link' },
  { spec: 'Mod+Shift+K', action: 'Insert wiki link' },
  { spec: 'Mod+Enter', action: 'Toggle task checkbox' },
]

const VAULT_KINDS: Record<string, string> = {
  demo: 'Demo vault — nothing is saved',
  browser: "Stored in this browser's IndexedDB",
  directory: 'A folder on your machine',
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** Every folder that holds a note, including intermediate ones. */
export function vaultFolders(paths: Iterable<NotePath>): string[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const dir = dirname(path)
    if (!dir) continue
    const parts = dir.split('/')
    for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join('/'))
  }
  return [...folders].sort((a, b) => a.localeCompare(b))
}

/**
 * Accepts every shape the export button (and hand-written files) produce:
 * `{ notes: { path: content } }`, `{ notes: [{ path, content }] }`, a bare
 * `{ path: content }` map, or an array of `{ path, content }`. Anything whose
 * value is not a string is skipped rather than throwing, so one bad entry does
 * not lose the rest of the import.
 */
/** Read a picked file as text, with a FileReader fallback for older engines. */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.readAsText(file)
  })
}

/** Trigger a browser download. Returns false when the browser refuses. */
function downloadFile(fileName: string, content: string, mime: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false
  }
  let url = ''
  try {
    url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } catch {
    return false
  } finally {
    // Revoking synchronously can cancel the download in some browsers, so it
    // waits a tick — and the check for the method belongs on the tick that
    // calls it, not on the one that schedules it.
    if (url) {
      setTimeout(() => {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
      }, 0)
    }
  }
  return true
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * Layout primitives
 * ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h3 className="settings-section" id={headingId}>
        {title}
      </h3>
      {children}
    </section>
  )
}

interface RowProps {
  label: string
  description?: string
  /** Id of the control this row labels; omit for a group of controls. */
  htmlFor?: string
  /** Accessible name for the control container when it holds several controls. */
  group?: string
  children: ReactNode
}

function Row({ label, description, htmlFor, group, children }: RowProps): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        {htmlFor === undefined ? <span>{label}</span> : <label htmlFor={htmlFor}>{label}</label>}
        {description !== undefined && <div className="settings-row-description">{description}</div>}
      </div>
      <div className="settings-row-control" role={group === undefined ? undefined : 'group'} aria-label={group}>
        {children}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * The modal
 * ------------------------------------------------------------------ */

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const notes = useAppStore((s) => s.notes)
  const adapter = useAppStore((s) => s.adapter)
  const vaultName = useAppStore((s) => s.vaultName)
  const createNote = useAppStore((s) => s.createNote)
  const restoreAttachments = useAppStore((s) => s.restoreAttachments)
  const pushToast = useAppStore((s) => s.pushToast)

  const ids = useId()
  const id = useCallback((suffix: string) => `${ids}-${suffix}`, [ids])
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const folders = useMemo(() => vaultFolders(notes.keys()), [notes])

  const number = (event: ChangeEvent<HTMLInputElement>): number => Number(event.currentTarget.value)

  const dailyPreview = useMemo(() => {
    const name = formatDate(settings.dailyNoteFormat, new Date())
    return name ? joinPath(settings.dailyNoteFolder, `${name}.md`) : '—'
  }, [settings.dailyNoteFormat, settings.dailyNoteFolder])

  const switchVault = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker'))
    onClose()
  }, [onClose])

  const exportVault = useCallback(async () => {
    const state = useAppStore.getState()
    const { payload, skipped } = await buildExport(state)
    const fileName = `${sanitizeFileName(state.vaultName || 'spacefore-vault')}.json`
    if (!downloadFile(fileName, JSON.stringify(payload, null, 2), 'application/json')) {
      pushToast('Downloads are not available in this browser', 'error')
      return
    }
    const included = Object.keys(payload.attachments ?? {}).length
    const what = included ? `${plural(state.notes.size, 'note')} and ${plural(included, 'attachment')}` : plural(state.notes.size, 'note')
    // Naming what was left out matters more than the success: an export is only
    // worth having if you know what is in it.
    if (skipped.length > 0) pushToast(`Exported ${what}; could not read ${skipped.join(', ')}`, 'error')
    else pushToast(`Exported ${what}`, 'success')
  }, [pushToast])

  const importVault = useCallback(
    async (file: File) => {
      setImporting(true)
      try {
        const { notes, attachments, unreadable } = parseImport(JSON.parse(await readFileText(file)) as unknown)
        if (notes.length === 0 && attachments.length === 0) throw new Error('No notes found in that file.')
        // Sequential: `createNote` de-duplicates against the notes already in
        // the store, and that check has to see the previous write.
        for (const [path, content] of notes) await createNote(path, content)
        const restored = await restoreAttachments(attachments)
        const parts = [plural(notes.length, 'note')]
        if (restored > 0) parts.push(plural(restored, 'attachment'))
        pushToast(`Imported ${parts.join(' and ')}`, 'success')
        const lost = unreadable.length + (attachments.length - restored)
        if (lost > 0) pushToast(`${plural(lost, 'attachment')} could not be restored`, 'error')
      } catch (error) {
        pushToast(`Could not import: ${describeError(error)}`, 'error')
      } finally {
        setImporting(false)
        // Let the same file be picked again after a failure.
        if (importInputRef.current) importInputRef.current.value = ''
      }
    },
    [createNote, restoreAttachments, pushToast],
  )

  const noteCount = notes.size

  return (
    <Modal
      open={open}
      title="Settings"
      onClose={onClose}
      width={640}
      footer={
        <>
          <span className="settings-row-description">Changes apply immediately.</span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {/* ------------------------------------------------ Appearance */}
      <Section title="Appearance">
        <Row label="Theme" description="Follow the system, or pin one palette." group="Theme">
          {THEMES.map((option) => {
            const active = settings.theme === option.value
            return (
              <button
                key={option.value}
                type="button"
                className={active ? 'btn btn-primary' : 'btn'}
                aria-pressed={active}
                onClick={() => updateSettings({ theme: option.value })}
              >
                {option.label}
              </button>
            )
          })}
        </Row>

        <Row label="Font size" description="Applies to the whole app, live." htmlFor={id('font-size')}>
          <input
            id={id('font-size')}
            className="slider"
            type="range"
            min={12}
            max={24}
            step={1}
            value={settings.fontSize}
            onChange={(event) => updateSettings({ fontSize: number(event) })}
          />
          <span className="settings-row-value">{settings.fontSize}px</span>
        </Row>

        <Row
          label="Editor font"
          description="Leave empty to use the theme's font. Pick a suggestion or type any CSS font stack."
          htmlFor={id('editor-font')}
        >
          <input
            id={id('editor-font')}
            className="input"
            type="text"
            list={id('font-list')}
            placeholder="Theme default"
            value={settings.editorFont}
            onChange={(event) => updateSettings({ editorFont: event.currentTarget.value })}
          />
          <datalist id={id('font-list')}>
            {FONT_SUGGESTIONS.map((font) => (
              <option key={font.label} value={font.value} label={font.label} />
            ))}
          </datalist>
        </Row>

        <Row
          label="Readable line length"
          description="Keep lines around 700px wide instead of filling the pane."
          htmlFor={id('readable')}
        >
          <input
            id={id('readable')}
            className="switch"
            type="checkbox"
            checked={settings.readableLineLength}
            onChange={(event) => updateSettings({ readableLineLength: event.currentTarget.checked })}
          />
        </Row>

        <Row label="Show line numbers" description="In the editor gutter." htmlFor={id('line-numbers')}>
          <input
            id={id('line-numbers')}
            className="switch"
            type="checkbox"
            checked={settings.showLineNumbers}
            onChange={(event) => updateSettings({ showLineNumbers: event.currentTarget.checked })}
          />
        </Row>
      </Section>

      {/* ---------------------------------------------------- Editor */}
      <Section title="Editor">
        <Row
          label="Live syntax hiding"
          description="Hide markdown markers until the cursor enters them."
          htmlFor={id('syntax-hiding')}
        >
          <input
            id={id('syntax-hiding')}
            className="switch"
            type="checkbox"
            checked={settings.liveSyntaxHiding}
            onChange={(event) => updateSettings({ liveSyntaxHiding: event.currentTarget.checked })}
          />
        </Row>

        <Row label="Spellcheck" description="Use the browser's spell checker while writing." htmlFor={id('spellcheck')}>
          <input
            id={id('spellcheck')}
            className="switch"
            type="checkbox"
            checked={settings.spellcheck}
            onChange={(event) => updateSettings({ spellcheck: event.currentTarget.checked })}
          />
        </Row>

        <Row
          label="Autosave delay"
          description="How long SpaceFore waits after your last keystroke before writing."
          htmlFor={id('autosave')}
        >
          <input
            id={id('autosave')}
            className="slider"
            type="range"
            min={200}
            max={5000}
            step={100}
            value={settings.autosaveDelay}
            onChange={(event) => updateSettings({ autosaveDelay: number(event) })}
          />
          <span className="settings-row-value">{(settings.autosaveDelay / 1000).toFixed(1)} s</span>
        </Row>
      </Section>

      {/* ----------------------------------------------------- Notes */}
      <Section title="Notes">
        <Row
          label="Default folder for new notes"
          description="Where “New note” and unresolved links create files."
          htmlFor={id('new-folder')}
        >
          <select
            id={id('new-folder')}
            className="select"
            value={settings.newNoteFolder}
            onChange={(event) => updateSettings({ newNoteFolder: event.currentTarget.value })}
          >
            <option value="">Vault root</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
            {/* A folder saved earlier that no longer holds notes must stay selectable. */}
            {settings.newNoteFolder !== '' && !folders.includes(settings.newNoteFolder) && (
              <option value={settings.newNoteFolder}>{settings.newNoteFolder}</option>
            )}
          </select>
        </Row>

        <Row
          label="Daily note folder"
          description="Created on demand, so it does not have to exist yet."
          htmlFor={id('daily-folder')}
        >
          <input
            id={id('daily-folder')}
            className="input"
            type="text"
            list={id('folder-list')}
            placeholder="Vault root"
            value={settings.dailyNoteFolder}
            onChange={(event) => updateSettings({ dailyNoteFolder: event.currentTarget.value })}
          />
          <datalist id={id('folder-list')}>
            {folders.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
        </Row>

        <Row
          label="Daily note format"
          description="YYYY, MM, DD, MMMM, DDDD, HH, mm and ss are replaced."
          htmlFor={id('daily-format')}
        >
          <input
            id={id('daily-format')}
            className="input"
            type="text"
            value={settings.dailyNoteFormat}
            onChange={(event) => updateSettings({ dailyNoteFormat: event.currentTarget.value })}
          />
        </Row>

        <Row label="Today’s daily note would be">
          <code data-testid="daily-preview">{dailyPreview}</code>
        </Row>
      </Section>

      {/* ----------------------------------------------------- Graph */}
      <Section title="Graph">
        <Row
          label="Show unresolved links"
          description="Draw a placeholder node for links to notes that do not exist yet."
          htmlFor={id('graph-unresolved')}
        >
          <input
            id={id('graph-unresolved')}
            className="switch"
            type="checkbox"
            checked={settings.graphShowUnresolved}
            onChange={(event) => updateSettings({ graphShowUnresolved: event.currentTarget.checked })}
          />
        </Row>

        <Row label="Show tags" description="Add a node per tag, linked to every note carrying it." htmlFor={id('graph-tags')}>
          <input
            id={id('graph-tags')}
            className="switch"
            type="checkbox"
            checked={settings.graphShowTags}
            onChange={(event) => updateSettings({ graphShowTags: event.currentTarget.checked })}
          />
        </Row>

        <Row label="Link distance" description="Resting length of every edge." htmlFor={id('graph-distance')}>
          <input
            id={id('graph-distance')}
            className="slider"
            type="range"
            min={30}
            max={200}
            step={5}
            value={settings.graphLinkDistance}
            onChange={(event) => updateSettings({ graphLinkDistance: number(event) })}
          />
          <span className="settings-row-value">{settings.graphLinkDistance}</span>
        </Row>

        <Row label="Repulsion" description="How strongly nodes push each other apart." htmlFor={id('graph-charge')}>
          <input
            id={id('graph-charge')}
            className="slider"
            type="range"
            min={40}
            max={400}
            step={10}
            /* The store keeps a negative charge; the slider shows its magnitude. */
            value={Math.abs(settings.graphChargeStrength)}
            onChange={(event) => updateSettings({ graphChargeStrength: -Math.abs(number(event)) })}
          />
          <span className="settings-row-value">{Math.abs(settings.graphChargeStrength)}</span>
        </Row>
      </Section>

      {/* ----------------------------------------------------- Vault */}
      <Section title="Vault">
        <Row label="Current vault" description={adapter ? VAULT_KINDS[adapter.kind] : 'No vault is open.'}>
          <span className="settings-row-value">{vaultName || '—'}</span>
        </Row>

        <Row label="Notes in this vault" description="Markdown files currently indexed.">
          <span className="settings-row-value">{plural(noteCount, 'note')}</span>
        </Row>

        <Row label="Change vault" description="Open the demo, the browser vault, or a folder on disk.">
          <button type="button" className="btn" onClick={switchVault}>
            <Icon name="folder-open" size={14} />
            Switch vault
          </button>
        </Row>

        <Row label="Export vault as JSON" description="One file with every note's path and text.">
          <button type="button" className="btn" disabled={noteCount === 0} onClick={exportVault}>
            <Icon name="copy" size={14} />
            Export
          </button>
        </Row>

        <Row
          label="Import notes from JSON"
          description="Adds the notes to the current vault; existing paths are never overwritten."
          htmlFor={id('import')}
        >
          <input
            id={id('import')}
            ref={importInputRef}
            className="input"
            type="file"
            accept="application/json,.json"
            disabled={importing}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) void importVault(file)
            }}
          />
        </Row>
      </Section>

      {/* ----------------------------------------------------- About */}
      <Section title="About">
        <Row label="SpaceFore" description="A local-first, plain-text knowledge base. No account, no server.">
          <span className="settings-row-value">v{APP_VERSION}</span>
        </Row>

        <Row label="Source">
          <a className="external-link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            View the source
          </a>
        </Row>

        <div className="settings-row">
          <table className="settings-shortcuts">
            <caption className="settings-row-description">Keyboard shortcuts</caption>
            <tbody>
              {SHORTCUTS.map((entry) => (
                <tr key={entry.spec}>
                  <th scope="row">{entry.action}</th>
                  <td>
                    <kbd>{formatShortcut(entry.spec)}</kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Modal>
  )
}

export default SettingsModal
