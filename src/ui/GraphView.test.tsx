import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AppState } from '../state/store'
import type { Note, NotePath } from '../types'
import { buildIndex, emptyIndex } from '../core/graph/index'
import { DEFAULT_SETTINGS, makeNote, useAppStore } from '../state/store'
import { GraphView } from './GraphView'
import {
  MAX_ZOOM,
  clampZoom,
  clipLabel,
  fitTransform,
  screenToWorld,
  worldToScreen,
} from './graph/useGraphCanvas'

/** The store as it was at import time — actions included, so spies are undone. */
const PRISTINE = useAppStore.getState()

/** jsdom does no layout, so the viewport is faked at a size the maths can use. */
const VIEW_WIDTH = 800
const VIEW_HEIGHT = 600

const RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: VIEW_WIDTH,
  bottom: VIEW_HEIGHT,
  width: VIEW_WIDTH,
  height: VIEW_HEIGHT,
  toJSON: () => ({}),
}

/**
 * A single note sits at the simulation origin (the golden-angle spiral starts
 * there) and nothing ever moves it: no other node to repel, no spring, and the
 * centering force is zero at the origin. `fitTransform` therefore puts it dead
 * centre of the faked viewport, which is what the click/hover tests aim at.
 */
const CENTRE_X = VIEW_WIDTH / 2
const CENTRE_Y = VIEW_HEIGHT / 2

/**
 * A canvas 2d context that records calls and draws nothing. Only the methods
 * the renderer actually uses are stubbed — anything new it starts calling will
 * fail loudly rather than silently.
 */
function createContext2D(): { context: CanvasRenderingContext2D; clearRect: Mock } {
  const clearRect = vi.fn()
  const context = {
    canvas: null,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    clearRect,
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
  }
  return { context: context as unknown as CanvasRenderingContext2D, clearRect }
}

/** Give the canvas a real 2d context; returns the recorder. */
function withContext2D(): { clearRect: Mock } {
  const { context, clearRect } = createContext2D()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  return { clearRect }
}

/** The jsdom default: no 2d context at all. */
function withoutContext2D(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
}

function seed(files: Record<NotePath, string>, patch: Partial<AppState> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

function canvasEl(container: HTMLElement): HTMLCanvasElement {
  const element = container.querySelector('canvas.graph-canvas')
  if (!element) throw new Error('graph canvas missing')
  return element as HTMLCanvasElement
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * This jsdom build exposes `window.matchMedia` as an accessor that answers
 * `undefined`, so it cannot be spied on — the property has to be replaced
 * outright and put back afterwards.
 */
let restoreMatchMedia: (() => void) | null = null

function stubMatchMedia(matches: (query: string) => boolean): void {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
  restoreMatchMedia = () => {
    if (original) Object.defineProperty(window, 'matchMedia', original)
    else Reflect.deleteProperty(window, 'matchMedia')
  }
}

beforeEach(() => {
  // `getBoundingClientRect` lives on Element, and jsdom always answers 0.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => RECT)
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      settings: { ...DEFAULT_SETTINGS },
      hoveredPath: null,
      searchQuery: '',
      toasts: [],
      recent: [],
      panes: [{ id: 'pane-a', tabs: [], activeTabId: null }],
      activePaneId: 'pane-a',
    },
    true,
  )
})

afterEach(() => {
  cleanup()
  restoreMatchMedia?.()
  restoreMatchMedia = null
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('worldToScreen / screenToWorld', () => {
  it('applies scale then translation', () => {
    const transform = { x: 100, y: 50, k: 2 }
    expect(worldToScreen({ x: 10, y: 20 }, transform)).toEqual({ x: 120, y: 90 })
  })

  it('round-trips an arbitrary point through both directions', () => {
    const transform = { x: -37.5, y: 412.25, k: 0.6234 }
    for (const point of [
      { x: 0, y: 0 },
      { x: 123.5, y: -998.25 },
      { x: -4321, y: 17 },
    ]) {
      const back = screenToWorld(worldToScreen(point, transform), transform)
      expect(back.x).toBeCloseTo(point.x, 6)
      expect(back.y).toBeCloseTo(point.y, 6)
    }
  })

  it('does not blow up on a zero scale', () => {
    const back = screenToWorld({ x: 10, y: 10 }, { x: 0, y: 0, k: 0 })
    expect(Number.isFinite(back.x)).toBe(true)
    expect(Number.isFinite(back.y)).toBe(true)
  })
})

describe('fitTransform', () => {
  it('centres the bounds in the viewport', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    const transform = fitTransform(bounds, { width: 400, height: 400 }, 50)
    // 300px of usable space for a 100-unit span.
    expect(transform.k).toBeCloseTo(3, 6)
    const centre = worldToScreen({ x: 50, y: 50 }, transform)
    expect(centre.x).toBeCloseTo(200, 6)
    expect(centre.y).toBeCloseTo(200, 6)
  })

  it('centres off-origin bounds too, and fits the tighter axis', () => {
    const bounds = { minX: 100, minY: -300, maxX: 300, maxY: -100 }
    const transform = fitTransform(bounds, { width: 1000, height: 400 }, 0)
    // Height is the tighter axis: 400 / 200 = 2.
    expect(transform.k).toBeCloseTo(2, 6)
    const centre = worldToScreen({ x: 200, y: -200 }, transform)
    expect(centre.x).toBeCloseTo(500, 6)
    expect(centre.y).toBeCloseTo(200, 6)
  })

  it('clamps the zoom for a tiny graph and keeps it centred', () => {
    const transform = fitTransform({ minX: -4, minY: -4, maxX: 4, maxY: 4 }, { width: 800, height: 600 }, 48)
    expect(transform.k).toBe(MAX_ZOOM)
    expect(worldToScreen({ x: 0, y: 0 }, transform)).toEqual({ x: 400, y: 300 })
  })

  it('survives degenerate bounds and viewports', () => {
    const empty = fitTransform({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, { width: 0, height: 0 }, 48)
    expect(Number.isFinite(empty.k)).toBe(true)
    expect(Number.isFinite(empty.x)).toBe(true)
    expect(Number.isFinite(empty.y)).toBe(true)

    const broken = fitTransform(
      { minX: Number.NaN, minY: 0, maxX: Infinity, maxY: 10 },
      { width: 300, height: 300 },
      10,
    )
    expect(Number.isFinite(broken.k)).toBe(true)
    expect(Number.isFinite(broken.x)).toBe(true)
  })
})

describe('clampZoom / clipLabel', () => {
  it('keeps the zoom inside the interactive range', () => {
    expect(clampZoom(0.001)).toBeCloseTo(0.15, 6)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
  })

  it('ellipsises only labels past the limit', () => {
    expect(clipLabel('Short note')).toBe('Short note')
    expect(clipLabel('A very long note title that keeps going')).toHaveLength(22)
    expect(clipLabel('A very long note title that keeps going').endsWith('…')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

describe('GraphView', () => {
  it('mounts without a 2d context and still reports the node/link counts', () => {
    withoutContext2D()
    seed({ 'A.md': 'Links to [[B]]', 'B.md': 'Back to [[A]]' })

    const { container } = render(<GraphView />)

    expect(container.querySelector('.graph-view')).not.toBeNull()
    expect(canvasEl(container)).not.toBeNull()
    // Two notes, one link — the pair of reciprocal links collapses onto one
    // undirected edge only if the ids match; here they are two directed edges.
    expect(screen.getByText('2 nodes · 2 links')).toBeTruthy()
  })

  it('counts the placeholder node for an unresolved link', () => {
    withoutContext2D()
    seed({ 'A.md': 'Points at [[Nowhere]]' })

    render(<GraphView />)
    expect(screen.getByText('2 nodes · 1 link')).toBeTruthy()
  })

  it('writes "show unresolved" to settings and drops the placeholder node', () => {
    withoutContext2D()
    seed({ 'A.md': 'Points at [[Nowhere]]' })

    render(<GraphView />)
    const toggle = screen.getByLabelText('Show unresolved') as HTMLInputElement
    expect(toggle.checked).toBe(true)

    fireEvent.click(toggle)

    expect(useAppStore.getState().settings.graphShowUnresolved).toBe(false)
    expect(screen.getByText('1 node · 0 links')).toBeTruthy()
  })

  it('writes "show tags" to settings and adds the tag node', () => {
    withoutContext2D()
    seed({ 'A.md': 'Tagged #alpha' })

    render(<GraphView />)
    expect(screen.getByText('1 node · 0 links')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Show tags'))

    expect(useAppStore.getState().settings.graphShowTags).toBe(true)
    expect(screen.getByText('2 nodes · 1 link')).toBeTruthy()
  })

  it('writes the link distance and repulsion sliders to settings', () => {
    withoutContext2D()
    seed({ 'A.md': '# A' })

    render(<GraphView />)
    fireEvent.change(screen.getByLabelText('Link distance'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('Repulsion'), { target: { value: '300' } })

    expect(useAppStore.getState().settings.graphLinkDistance).toBe(120)
    // The slider is a magnitude; the stored charge stays negative.
    expect(useAppStore.getState().settings.graphChargeStrength).toBe(-300)
  })

  it('hides the controls and legend when compact', () => {
    withoutContext2D()
    seed({ 'A.md': '# A' })

    const { container } = render(<GraphView compact />)

    expect(container.querySelector('.graph-view')?.className).toContain('is-compact')
    expect(container.querySelector('.graph-controls')).toBeNull()
    expect(container.querySelector('.graph-legend')).toBeNull()
    expect(canvasEl(container)).not.toBeNull()
  })

  it('restricts a local graph to the focused note and widens it with the depth stepper', () => {
    withoutContext2D()
    seed({ 'A.md': 'to [[B]]', 'B.md': 'to [[C]]', 'C.md': '# C' })

    render(<GraphView focusPath="A.md" local />)
    expect(screen.getByText('2 nodes · 1 link')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Increase depth'))
    expect(screen.getByText('3 nodes · 2 links')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Decrease depth'))
    expect(screen.getByText('2 nodes · 1 link')).toBeTruthy()
  })

  /*
   * The interaction tests below drive a stubbed 2d context: the drawing calls
   * are exercised but nothing is asserted about the pixels — only about the
   * hit-testing, the transform and the store wiring.
   */

  it('opens the note under the cursor on click (drawing itself is not asserted)', () => {
    withContext2D()
    const openPath = vi.fn()
    seed({ 'A.md': '# A' }, { openPath })

    const { container } = render(<GraphView />)
    fireEvent.click(canvasEl(container), { clientX: CENTRE_X, clientY: CENTRE_Y })

    expect(openPath).toHaveBeenCalledTimes(1)
    expect(openPath).toHaveBeenCalledWith('A.md', { newTab: false })
  })

  it('opens in a new tab on Cmd/Ctrl+click and ignores empty space', () => {
    withContext2D()
    const openPath = vi.fn()
    seed({ 'A.md': '# A' }, { openPath })

    const { container } = render(<GraphView />)
    const canvas = canvasEl(container)

    fireEvent.click(canvas, { clientX: 12, clientY: 12 })
    expect(openPath).not.toHaveBeenCalled()

    fireEvent.click(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y, metaKey: true })
    expect(openPath).toHaveBeenCalledWith('A.md', { newTab: true })
  })

  it('does not open a note when the click was the end of a drag', () => {
    withContext2D()
    const openPath = vi.fn()
    seed({ 'A.md': '# A' }, { openPath })

    const { container } = render(<GraphView />)
    const canvas = canvasEl(container)

    fireEvent.mouseDown(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y })
    fireEvent.mouseMove(canvas, { clientX: CENTRE_X + 90, clientY: CENTRE_Y })
    fireEvent.mouseUp(canvas, { clientX: CENTRE_X + 90, clientY: CENTRE_Y })
    fireEvent.click(canvas, { clientX: CENTRE_X + 90, clientY: CENTRE_Y })

    expect(openPath).not.toHaveBeenCalled()

    // The drag is over, so the next plain click opens again — the node has
    // moved with the pointer, which is where we now aim.
    fireEvent.click(canvas, { clientX: CENTRE_X + 90, clientY: CENTRE_Y })
    expect(openPath).toHaveBeenCalledWith('A.md', { newTab: false })
  })

  it('publishes the hovered note to the store and clears it again', () => {
    withContext2D()
    seed({ 'A.md': '# A' })

    const { container } = render(<GraphView />)
    const canvas = canvasEl(container)

    fireEvent.mouseMove(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y })
    expect(useAppStore.getState().hoveredPath).toBe('A.md')

    fireEvent.mouseMove(canvas, { clientX: 8, clientY: 8 })
    expect(useAppStore.getState().hoveredPath).toBeNull()

    fireEvent.mouseMove(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y })
    fireEvent.mouseLeave(canvas)
    expect(useAppStore.getState().hoveredPath).toBeNull()
  })

  it('opens the hovered node on Enter and clears the hover on Escape', () => {
    withContext2D()
    const openPath = vi.fn()
    seed({ 'A.md': '# A' }, { openPath })

    const { container } = render(<GraphView />)
    const canvas = canvasEl(container)

    fireEvent.mouseMove(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y })
    fireEvent.keyDown(canvas, { key: 'Enter' })
    expect(openPath).toHaveBeenCalledWith('A.md', { newTab: false })

    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(useAppStore.getState().hoveredPath).toBeNull()
  })

  it('zooms about the cursor and re-fits on a double click in empty space', () => {
    withContext2D()
    const openPath = vi.fn()
    seed({ 'A.md': '# A' }, { openPath })

    const { container } = render(<GraphView />)
    const canvas = canvasEl(container)

    // Zoom is already clamped at the maximum for a one-node graph, so zoom out
    // first: the node then no longer sits under the viewport centre.
    fireEvent.wheel(canvas, { deltaY: 240, clientX: 0, clientY: 0 })
    fireEvent.click(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y })
    expect(openPath).not.toHaveBeenCalled()

    // Double-clicking empty space re-frames the graph, which re-centres it.
    fireEvent.doubleClick(canvas, { clientX: 20, clientY: 20 })
    fireEvent.click(canvas, { clientX: CENTRE_X, clientY: CENTRE_Y })
    expect(openPath).toHaveBeenCalledWith('A.md', { newTab: false })
  })

  it('sends a tag node to search instead of trying to open it', () => {
    withContext2D()
    const openPath = vi.fn()
    const openView = vi.fn()
    seed({ 'A.md': 'Tagged #alpha' }, { openPath, openView, settings: { ...DEFAULT_SETTINGS, graphShowTags: true } })

    const { container } = render(<GraphView />)
    const canvas = canvasEl(container)
    expect(screen.getByText('2 nodes \u00b7 1 link')).toBeTruthy()

    // Sweep the viewport instead of hard-coding where the layout put things:
    // `fit()` guarantees both nodes are somewhere inside it.
    for (let y = 0; y <= VIEW_HEIGHT && openView.mock.calls.length === 0; y += 20) {
      for (let x = 0; x <= VIEW_WIDTH && openView.mock.calls.length === 0; x += 20) {
        fireEvent.click(canvas, { clientX: x, clientY: y })
      }
    }

    expect(openView).toHaveBeenCalledWith('search')
    expect(useAppStore.getState().searchQuery).toBe('tag:alpha')
    // The tag node never reaches `openPath` — only the real note does.
    for (const call of openPath.mock.calls) expect(call[0]).toBe('A.md')
  })

  it('keeps painting frames while the layout is still hot', async () => {
    const { clearRect } = withContext2D()
    seed({ 'A.md': 'to [[B]]', 'B.md': 'to [[C]]', 'C.md': 'to [[A]]' })

    render(<GraphView />)

    await waitFor(() => expect(clearRect.mock.calls.length).toBeGreaterThan(0))
    const first = clearRect.mock.calls.length
    await sleep(80)
    // The simulation is nowhere near settled yet, so the loop re-schedules
    // itself and the canvas is repainted several more times.
    expect(clearRect.mock.calls.length).toBeGreaterThan(first)
  })

  it('settles in one synchronous batch under prefers-reduced-motion', async () => {
    stubMatchMedia((query) => query.includes('prefers-reduced-motion'))
    const { clearRect } = withContext2D()
    seed({ 'A.md': 'to [[B]]', 'B.md': 'to [[C]]', 'C.md': 'to [[A]]' })

    render(<GraphView />)

    await waitFor(() => expect(clearRect.mock.calls.length).toBeGreaterThan(0))
    const drawn = clearRect.mock.calls.length
    await sleep(80)

    // One batch of ticks, one paint, no animation loop at all.
    expect(drawn).toBe(1)
    expect(clearRect.mock.calls.length).toBe(drawn)
  })

  it('stops the animation loop when it unmounts', async () => {
    const { clearRect } = withContext2D()
    seed({ 'A.md': 'to [[B]]', 'B.md': 'to [[A]]' })

    const { unmount } = render(<GraphView />)

    // The simulation starts hot, so frames keep arriving until it settles.
    await waitFor(() => expect(clearRect.mock.calls.length).toBeGreaterThan(0))
    expect(clearRect.mock.calls.length).toBeGreaterThan(0)

    unmount()
    const drawnAtUnmount = clearRect.mock.calls.length
    await sleep(80)

    expect(clearRect.mock.calls.length).toBe(drawnAtUnmount)
  })
})
