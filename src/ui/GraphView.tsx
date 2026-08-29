/**
 * SpaceFore — the graph view.
 *
 * A canvas rendering of the vault's link graph: notes as circles, links as
 * lines, tags and unresolved links as optional extra nodes. The component
 * itself is deliberately thin — it turns store state into `GraphData`, renders
 * the controls, and hands the canvas to `useGraphCanvas`, which owns the
 * simulation, the painting and every pointer/keyboard gesture.
 *
 * Two shapes are supported by the same component:
 *
 *  - the full-tab graph (`local: false`) — the whole vault;
 *  - the local graph (`local: true`) — the current note plus everything within
 *    N hops, with N adjustable from the controls.
 *
 * `compact` drops the chrome for the sidebar embedding.
 */
import type { ChangeEvent, JSX } from 'react'
import { useCallback, useMemo, useState } from 'react'

import type { AppState } from '../state/store'
import type { NotePath } from '../types'
import { buildGraphData } from '../core/graph/index'
import { useAppStore } from '../state/store'
import { useGraphCanvas } from './graph/useGraphCanvas'

/** Hops shown around the focused note in a local graph, before the user changes it. */
const DEFAULT_LOCAL_DEPTH = 1
const MIN_LOCAL_DEPTH = 1
const MAX_LOCAL_DEPTH = 5

/** Slider ranges. Repulsion is shown as a positive magnitude of a negative charge. */
const LINK_DISTANCE_MIN = 20
const LINK_DISTANCE_MAX = 220
const REPULSION_MIN = 20
const REPULSION_MAX = 600

/** Zoom multiplier for the +/- buttons. */
const ZOOM_BUTTON_STEP = 1.3

export interface GraphViewProps {
  /** Note the graph centres on. Defaults to the active note. */
  focusPath?: NotePath | null
  /** Restrict the graph to `focusPath` and everything within N hops. */
  local?: boolean
  /** Drop the controls and legend (used by the sidebar embedding). */
  compact?: boolean
}

/** Path of the note in the active tab, or null when the tab is not a note. */
function selectActivePath(state: AppState): NotePath | null {
  const pane = state.panes.find((candidate) => candidate.id === state.activePaneId)
  if (!pane) return null
  return pane.tabs.find((tab) => tab.id === pane.activeTabId)?.path ?? null
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function GraphView({ focusPath = null, local = false, compact = false }: GraphViewProps): JSX.Element {
  const notes = useAppStore((state) => state.notes)
  const index = useAppStore((state) => state.index)
  const showUnresolved = useAppStore((state) => state.settings.graphShowUnresolved)
  const showTags = useAppStore((state) => state.settings.graphShowTags)
  const linkDistance = useAppStore((state) => state.settings.graphLinkDistance)
  const charge = useAppStore((state) => state.settings.graphChargeStrength)
  const hoveredPath = useAppStore((state) => state.hoveredPath)
  const activePath = useAppStore(selectActivePath)

  const openPath = useAppStore((state) => state.openPath)
  const openView = useAppStore((state) => state.openView)
  const setHoveredPath = useAppStore((state) => state.setHoveredPath)
  const setSearchQuery = useAppStore((state) => state.setSearchQuery)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const pushToast = useAppStore((state) => state.pushToast)

  const [depth, setDepth] = useState(DEFAULT_LOCAL_DEPTH)

  /** The note the graph revolves around: the explicit prop, else the active tab. */
  const centre = focusPath ?? activePath

  const data = useMemo(
    () =>
      buildGraphData(notes, index, {
        showUnresolved,
        showTags,
        focus: local && centre ? { path: centre, depth } : null,
      }),
    [notes, index, showUnresolved, showTags, local, centre, depth],
  )

  /**
   * Node ids are not all note paths: `#tag` marks a tag node and `?target` an
   * unresolved link. A real note always wins the lookup, so a file whose name
   * happens to start with one of those characters still opens.
   */
  const handleOpen = useCallback(
    (id: string, newTab: boolean) => {
      if (notes.has(id)) {
        openPath(id, { newTab })
        return
      }
      if (id.startsWith('#')) {
        // Tag nodes hand off to search rather than opening anything.
        setSearchQuery(`tag:${id.slice(1)}`)
        openView('search')
        return
      }
      const label = data.nodes.find((node) => node.id === id)?.label ?? id.replace(/^\?/, '')
      pushToast(`"${label}" has no note yet`, 'info')
    },
    [data, notes, openPath, openView, pushToast, setSearchQuery],
  )

  const handleHover = useCallback(
    (id: string | null) => {
      // Only real notes are worth broadcasting: the rest of the app highlights
      // by path, and a tag id would never match anything.
      setHoveredPath(id !== null && notes.has(id) ? id : null)
    },
    [notes, setHoveredPath],
  )

  const { containerRef, canvasRef, fit, zoomBy } = useGraphCanvas({
    data,
    linkDistance,
    charge,
    currentId: centre,
    hoveredId: hoveredPath,
    onHover: handleHover,
    onOpen: handleOpen,
  })

  const summary = `${plural(data.nodes.length, 'node', 'nodes')} · ${plural(data.edges.length, 'link', 'links')}`

  const onLinkDistance = (event: ChangeEvent<HTMLInputElement>): void => {
    updateSettings({ graphLinkDistance: Number(event.target.value) })
  }
  const onRepulsion = (event: ChangeEvent<HTMLInputElement>): void => {
    // The slider is a magnitude; the stored charge is negative.
    updateSettings({ graphChargeStrength: -Number(event.target.value) })
  }

  return (
    <div className={compact ? 'graph-view is-compact' : 'graph-view'} ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        tabIndex={0}
        role="application"
        aria-label={`Knowledge graph — ${summary}`}
      />

      {!compact && (
        <div className="graph-controls">
          <label>
            <span>Show unresolved</span>
            <input
              type="checkbox"
              className="switch"
              checked={showUnresolved}
              onChange={(event) => updateSettings({ graphShowUnresolved: event.target.checked })}
            />
          </label>
          <label>
            <span>Show tags</span>
            <input
              type="checkbox"
              className="switch"
              checked={showTags}
              onChange={(event) => updateSettings({ graphShowTags: event.target.checked })}
            />
          </label>

          <div className="graph-field">
            <span>Link distance</span>
            <input
              type="range"
              className="slider"
              aria-label="Link distance"
              min={LINK_DISTANCE_MIN}
              max={LINK_DISTANCE_MAX}
              step={5}
              value={clamp(Math.round(linkDistance), LINK_DISTANCE_MIN, LINK_DISTANCE_MAX)}
              onChange={onLinkDistance}
            />
          </div>
          <div className="graph-field">
            <span>Repulsion</span>
            <input
              type="range"
              className="slider"
              aria-label="Repulsion"
              min={REPULSION_MIN}
              max={REPULSION_MAX}
              step={10}
              value={clamp(Math.round(Math.abs(charge)), REPULSION_MIN, REPULSION_MAX)}
              onChange={onRepulsion}
            />
          </div>

          {local && (
            <div className="graph-field">
              <span>Depth</span>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Decrease depth"
                disabled={depth <= MIN_LOCAL_DEPTH}
                onClick={() => setDepth((current) => Math.max(MIN_LOCAL_DEPTH, current - 1))}
              >
                −
              </button>
              <span className="graph-depth">{depth}</span>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Increase depth"
                disabled={depth >= MAX_LOCAL_DEPTH}
                onClick={() => setDepth((current) => Math.min(MAX_LOCAL_DEPTH, current + 1))}
              >
                +
              </button>
            </div>
          )}

          <div className="graph-field">
            <button type="button" className="btn btn-ghost" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_BUTTON_STEP)}>
              −
            </button>
            <button type="button" className="btn" onClick={fit}>
              Fit
            </button>
            <button type="button" className="btn btn-ghost" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_BUTTON_STEP)}>
              +
            </button>
          </div>

          <span className="graph-counts">{summary}</span>
          {data.nodes.length === 0 && <span className="graph-empty">Nothing to graph yet.</span>}
        </div>
      )}

      {!compact && (
        <div className="graph-legend">
          <span>Note</span>
          {showUnresolved && <span className="is-unresolved">Unresolved</span>}
          {showTags && <span className="is-tag">Tag</span>}
        </div>
      )}
    </div>
  )
}

export default GraphView
