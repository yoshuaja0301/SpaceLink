/**
 * SpaceLink — the far-left icon rail.
 *
 * Three groups, separated by rules: the sidebar panel switches at the top,
 * then the "make something" actions, then theme and settings pinned to the
 * bottom. Every button carries an accessible name and a `data-tooltip` the
 * stylesheet turns into a hover/focus tooltip.
 */
import type { IconName } from './Icon'
import type { JSX } from 'react'

import type { SidebarPanel } from '../types'
import { useAppStore } from '../state/store'
import { Icon } from './Icon'

interface PanelButton {
  panel: Exclude<SidebarPanel, null>
  icon: IconName
  label: string
}

const PANELS: PanelButton[] = [
  { panel: 'files', icon: 'files', label: 'Files' },
  { panel: 'search', icon: 'search', label: 'Search' },
  { panel: 'tags', icon: 'tag', label: 'Tags' },
  { panel: 'starred', icon: 'star', label: 'Starred' },
]

/** The theme actually on screen — `system` resolves through the media query. */
function resolvedTheme(theme: string): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') return theme
  const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  return query?.matches ? 'dark' : 'light'
}

/**
 * Geometry for the group rules. The stylesheet has no `.ribbon-divider` rule,
 * so the line is described here — colour still comes from a theme token.
 */
const DIVIDER_STYLE = { flex: 'none', width: '18px', height: '1px', background: 'var(--divider)' } as const

export function Ribbon({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const sidebarPanel = useAppStore((s) => s.sidebarPanel)
  const theme = useAppStore((s) => s.settings.theme)

  const next = resolvedTheme(theme) === 'dark' ? 'light' : 'dark'

  return (
    <nav className="ribbon" aria-label="Sidebar and actions">
      {PANELS.map(({ panel, icon, label }) => {
        const active = sidebarPanel === panel
        return (
          <button
            key={panel}
            type="button"
            className={active ? 'ribbon-btn is-active' : 'ribbon-btn'}
            aria-label={label}
            aria-pressed={active}
            data-tooltip={label}
            data-panel={panel}
            onClick={() => useAppStore.getState().setSidebarPanel(panel)}
          >
            <Icon name={icon} size={18} />
          </button>
        )
      })}

      <div className="ribbon-divider" role="separator" aria-orientation="horizontal" style={DIVIDER_STYLE} />

      <button
        type="button"
        className="ribbon-btn"
        aria-label="New note"
        data-tooltip="New note"
        onClick={() => void useAppStore.getState().createNoteFromTitle('Untitled')}
      >
        <Icon name="plus" size={18} />
      </button>
      <button
        type="button"
        className="ribbon-btn"
        aria-label="Daily note"
        data-tooltip="Daily note"
        onClick={() => void useAppStore.getState().openDailyNote()}
      >
        <Icon name="calendar" size={18} />
      </button>
      <button
        type="button"
        className="ribbon-btn"
        aria-label="Graph view"
        data-tooltip="Graph view"
        onClick={() => useAppStore.getState().openView('graph')}
      >
        <Icon name="graph" size={18} />
      </button>

      <div className="ribbon-spacer" />

      <button
        type="button"
        className="ribbon-btn"
        aria-label={`Switch to ${next} theme`}
        data-tooltip={`Switch to ${next} theme`}
        onClick={() => useAppStore.getState().setTheme(next)}
      >
        <Icon name={next === 'dark' ? 'moon' : 'sun'} size={18} />
      </button>
      <button
        type="button"
        className="ribbon-btn"
        aria-label="Settings"
        data-tooltip="Settings"
        onClick={onOpenSettings}
      >
        <Icon name="settings" size={18} />
      </button>
    </nav>
  )
}

export default Ribbon
