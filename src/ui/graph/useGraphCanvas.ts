/**
 * SpaceFore — the imperative half of the graph view.
 *
 * `GraphView` stays declarative (store reads, controls, counts) and hands
 * everything that has to happen at 60fps to this hook: sizing the canvas for
 * the device pixel ratio, driving `ForceLayout` from a `requestAnimationFrame`
 * loop, painting, hit-testing and the whole pointer/keyboard vocabulary.
 *
 * Three rules shape the design:
 *
 *  1. **Nothing here re-renders React.** All of the moving state (transform,
 *     drag, frame handle, palette) lives in plain closure variables inside
 *     `createEngine`, so a settling simulation never touches the React tree.
 *     The hook only publishes back out through the `onHover` / `onOpen`
 *     callbacks, and only when the value actually changed.
 *  2. **The loop stops.** Once `alpha` drops below `SETTLED_ALPHA` the frame
 *     loop unschedules itself; interaction and new data restart it. An
 *     unmount cancels whatever frame is in flight.
 *  3. **jsdom must survive it.** `getContext('2d')` returning `null` is a
 *     supported state, not an error: the container still renders, the layout
 *     is still hit-testable, and no frame is ever scheduled.
 *
 * The pure geometry helpers (`worldToScreen`, `screenToWorld`, `fitTransform`)
 * are exported so they can be unit-tested without a DOM.
 */
import type { RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import type { GraphData, GraphNode } from '../../types'
import { ForceLayout } from '../../core/graph/layout'

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Zoom is clamped to this range, everywhere. */
export const MIN_ZOOM = 0.15
export const MAX_ZOOM = 5

/** Empty space around the graph when fitting it to the viewport, in px. */
const FIT_PADDING = 48
/** Simulation alpha below which the graph counts as settled and the loop stops. */
const SETTLED_ALPHA = 0.005
/** Simulation steps per animation frame — >1 makes big graphs settle sooner. */
const TICKS_PER_FRAME = 2
/**
 * Steps used to settle the graph in one synchronous batch under
 * `prefers-reduced-motion`. `0.985 ** 400 ≈ 0.0024`, i.e. comfortably past
 * `SETTLED_ALPHA` even from a full reheat.
 */
const SETTLE_STEPS = 400
/** Weak pull toward the origin, so detached clusters stay on screen. */
const CENTER_STRENGTH = 0.06
/** Extra click/hover slack around a node, in screen pixels. */
const HIT_SLOP = 6
/** A press only becomes a drag after the pointer travels this far, in px. */
const DRAG_THRESHOLD = 3
/** Pixels panned per arrow key press (times three with Shift). */
const KEY_PAN_STEP = 48
/** Zoom multiplier for the +/- keys and the zoom buttons. */
const ZOOM_STEP = 1.25
/** Wheel sensitivity: `deltaY` is divided by this before being exponentiated. */
const WHEEL_DIVISOR = 320
/** Labels appear at or above this zoom, plus always for hovered/current nodes. */
const LABEL_ZOOM = 0.75
/** Label baseline offset below the node circle, in px. */
const LABEL_GAP = 5
const LABEL_FONT_SIZE = 11
/** Labels longer than this are clipped with an ellipsis. */
export const MAX_LABEL_CHARS = 22
/** Opacity applied to everything not adjacent to the hovered node. */
const DIM_ALPHA = 0.12
/** Base edge opacity, plus a little more for every repeated link. */
const EDGE_ALPHA = 0.3
const EDGE_ALPHA_PER_LINK = 0.12
const EDGE_ALPHA_MAX = 0.75
/** Retina is worth paying for; 4x displays are not. */
const MAX_DPR = 2
/** Used when the container has no measurable size yet (jsdom, display:none). */
const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 600

const TAU = Math.PI * 2

/* ------------------------------------------------------------------ *
 * Geometry — pure, exported, unit-tested
 * ------------------------------------------------------------------ */

/** Screen = world * k + (x, y). */
export interface Transform {
  x: number
  y: number
  k: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, k: 1 }

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))
}

/** Simulation coordinates → canvas (CSS pixel) coordinates. */
export function worldToScreen(point: Point, transform: Transform): Point {
  return { x: point.x * transform.k + transform.x, y: point.y * transform.k + transform.y }
}

/** Canvas (CSS pixel) coordinates → simulation coordinates. */
export function screenToWorld(point: Point, transform: Transform): Point {
  // A zero/NaN scale would produce infinities; fall back to 1:1 instead.
  const k = Number.isFinite(transform.k) && transform.k !== 0 ? transform.k : 1
  return { x: (point.x - transform.x) / k, y: (point.y - transform.y) / k }
}

/**
 * The transform that centres `bounds` inside `size` with `padding` to spare on
 * every side. Degenerate input (an empty graph, a zero-sized viewport) yields a
 * usable transform rather than NaN.
 */
export function fitTransform(bounds: Bounds, size: Size, padding = FIT_PADDING): Transform {
  const width = Math.max(1, Number.isFinite(size.width) ? size.width : DEFAULT_WIDTH)
  const height = Math.max(1, Number.isFinite(size.height) ? size.height : DEFAULT_HEIGHT)
  const safe =
    Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY)
      ? bounds
      : { minX: -1, minY: -1, maxX: 1, maxY: 1 }

  // Padding can never eat the whole viewport, however small the pane is.
  const pad = Math.max(0, Math.min(Number.isFinite(padding) ? padding : 0, Math.min(width, height) / 2 - 1))
  const spanX = Math.max(1e-6, safe.maxX - safe.minX)
  const spanY = Math.max(1e-6, safe.maxY - safe.minY)
  const k = clampZoom(Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY))
  const cx = (safe.minX + safe.maxX) / 2
  const cy = (safe.minY + safe.maxY) / 2
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k }
}

/** Clip a node label so one long title cannot smear across the canvas. */
export function clipLabel(text: string, max = MAX_LABEL_CHARS): string {
  if (max <= 1) return text.slice(0, Math.max(0, max))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

/**
 * The canvas cannot use `var(--token)`, so the theme is read out of the
 * document element once per theme change and cached. Fallbacks are CSS system
 * colours (never brand hexes), so even a document without the stylesheet
 * paints something theme-appropriate.
 */
export interface GraphPalette {
  background: string
  edge: string
  node: string
  nodeCurrent: string
  nodeTag: string
  nodeUnresolved: string
  label: string
  labelStrong: string
  font: string
}

const FALLBACK_PALETTE: GraphPalette = {
  background: 'Canvas',
  edge: 'GrayText',
  node: 'GrayText',
  nodeCurrent: 'AccentColor',
  nodeTag: 'VisitedText',
  nodeUnresolved: 'GrayText',
  label: 'GrayText',
  labelStrong: 'CanvasText',
  font: 'system-ui, sans-serif',
}

export function readGraphPalette(root?: Element | null): GraphPalette {
  const target = root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  if (!target || typeof getComputedStyle !== 'function') return { ...FALLBACK_PALETTE }

  let style: CSSStyleDeclaration
  try {
    style = getComputedStyle(target)
  } catch {
    return { ...FALLBACK_PALETTE }
  }
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name)
    const trimmed = value ? value.trim() : ''
    return trimmed || fallback
  }

  return {
    background: read('--bg-primary', FALLBACK_PALETTE.background),
    edge: read('--border-strong', FALLBACK_PALETTE.edge),
    node: read('--text-muted', FALLBACK_PALETTE.node),
    nodeCurrent: read('--accent', FALLBACK_PALETTE.nodeCurrent),
    nodeTag: read('--tag-text', FALLBACK_PALETTE.nodeTag),
    nodeUnresolved: read('--link-unresolved', FALLBACK_PALETTE.nodeUnresolved),
    label: read('--text-muted', FALLBACK_PALETTE.label),
    labelStrong: read('--text-normal', FALLBACK_PALETTE.labelStrong),
    font: read('--font-ui', FALLBACK_PALETTE.font),
  }
}

/** True when the user asked the OS for less animation. Never throws. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Hook surface
 * ------------------------------------------------------------------ */

export interface GraphCanvasOptions {
  /** The graph to draw. A new object means "the data changed". */
  data: GraphData
  /** Spring rest length, straight from settings. */
  linkDistance: number
  /** Repulsion charge (negative), straight from settings. */
  charge: number
  /** Node drawn as "you are here", if any. */
  currentId?: string | null
  /** Node currently highlighted — owned by the store, so the file tree can drive it too. */
  hoveredId?: string | null
  /** Called (only on change) when the pointer moves onto or off a node. */
  onHover: (id: string | null) => void
  /** Click or Enter on a node. `newTab` is Cmd/Ctrl-click. */
  onOpen: (id: string, newTab: boolean) => void
}

export interface GraphCanvasHandle {
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Re-frame the whole graph inside the viewport. */
  fit: () => void
  /** Multiply the zoom about the viewport centre. */
  zoomBy: (factor: number) => void
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

interface EngineContext {
  container: HTMLDivElement
  canvas: HTMLCanvasElement
  /** Always the props from the latest render. */
  props: { current: GraphCanvasOptions }
}

interface Engine {
  fit: () => void
  zoomBy: (factor: number) => void
  setData: (data: GraphData) => void
  setForces: (linkDistance: number, charge: number) => void
  redraw: () => void
  destroy: () => void
}

interface DragState {
  kind: 'pan' | 'node'
  /** The dragged node, for `kind === 'node'`. */
  id: string | null
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** Set once the pointer has travelled past `DRAG_THRESHOLD`. */
  moved: boolean
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
  return setTimeout(callback, 16) as unknown as number
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else clearTimeout(handle)
}

/**
 * Everything imperative, built once per mount. Returns the handful of commands
 * the React layer needs; all other state stays sealed in this closure.
 */
function createEngine(context: EngineContext): Engine {
  const { container, canvas, props } = context

  let ctx2d: CanvasRenderingContext2D | null = null
  try {
    // jsdom (and a browser that ran out of GPU contexts) returns null here.
    ctx2d = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  } catch {
    ctx2d = null
  }

  let sim: ForceLayout | null = null
  let applied: GraphData | null = null
  let transform: Transform = { ...IDENTITY_TRANSFORM }
  let size = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, dpr: 1 }
  let palette = readGraphPalette()
  let reducedMotion = prefersReducedMotion()
  let frame: number | null = null
  let dirty = true
  let drag: DragState | null = null
  /** A press that turned into a drag must not also register as a click. */
  let suppressClick = false
  let hasFitted = false

  const nodeIndex = new Map<string, GraphNode>()
  const neighbours = new Map<string, Set<string>>()

  /* ---------------------------------------------------------------- *
   * Data
   * ---------------------------------------------------------------- */

  const indexData = (data: GraphData): void => {
    nodeIndex.clear()
    neighbours.clear()
    for (const node of data.nodes) nodeIndex.set(node.id, node)
    const connect = (from: string, to: string): void => {
      const bucket = neighbours.get(from)
      if (bucket) bucket.add(to)
      else neighbours.set(from, new Set([to]))
    }
    for (const edge of data.edges) {
      if (!nodeIndex.has(edge.source) || !nodeIndex.has(edge.target)) continue
      connect(edge.source, edge.target)
      connect(edge.target, edge.source)
    }
  }

  /* ---------------------------------------------------------------- *
   * Sizing
   * ---------------------------------------------------------------- */

  /** Re-measure the container; returns true when anything actually changed. */
  const measure = (): boolean => {
    const rect = typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : null
    const width = Math.max(1, Math.round(rect?.width || container.clientWidth || DEFAULT_WIDTH))
    const height = Math.max(1, Math.round(rect?.height || container.clientHeight || DEFAULT_HEIGHT))
    const ratio = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    const dpr = Math.min(MAX_DPR, Math.max(1, ratio))
    if (width === size.width && height === size.height && dpr === size.dpr) return false

    size = { width, height, dpr }
    // The backing store is in device pixels; the CSS box stays in CSS pixels.
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    sim?.setOptions({ width, height })
    dirty = true
    return true
  }

  /* ---------------------------------------------------------------- *
   * Frame loop
   * ---------------------------------------------------------------- */

  const pump = (): void => {
    frame = null
    if (sim) {
      if (reducedMotion) {
        // No animation: settle the whole thing in one synchronous batch and
        // paint the result exactly once.
        if (sim.alpha > SETTLED_ALPHA) {
          sim.tick(SETTLE_STEPS)
          dirty = true
        }
      } else if (sim.alpha > SETTLED_ALPHA) {
        sim.tick(TICKS_PER_FRAME)
        dirty = true
        frame = requestFrame(pump)
      }
    }
    if (dirty) {
      dirty = false
      draw()
    }
  }

  /** Mark the canvas dirty and make sure a frame is on its way. */
  const kick = (): void => {
    dirty = true
    // Without a 2d context there is nothing to paint — never schedule work.
    if (!ctx2d || frame !== null) return
    frame = requestFrame(pump)
  }

  /* ---------------------------------------------------------------- *
   * Painting
   * ---------------------------------------------------------------- */

  const draw = (): void => {
    const painter = ctx2d
    if (!painter || !sim) return

    const { width, height, dpr } = size
    painter.setTransform(dpr, 0, 0, dpr, 0, 0)
    painter.clearRect(0, 0, width, height)

    const view = transform
    const { hoveredId = null, currentId = null } = props.current
    // Hovering focuses the graph: the node, its neighbours and the edges
    // between them keep full opacity, everything else fades back.
    const focusId = hoveredId && nodeIndex.has(hoveredId) ? hoveredId : null
    const near = focusId ? neighbours.get(focusId) : undefined
    const opacityOf = (id: string): number => {
      if (!focusId) return 1
      if (id === focusId || near?.has(id)) return 1
      return DIM_ALPHA
    }

    /* Edges first, so nodes always sit on top of their links. */
    painter.lineCap = 'round'
    painter.strokeStyle = palette.edge
    for (const edge of sim.data.edges) {
      const a = nodeIndex.get(edge.source)
      const b = nodeIndex.get(edge.target)
      if (!a || !b) continue
      const from = worldToScreen(a, view)
      const to = worldToScreen(b, view)
      if (!segmentVisible(from, to, width, height)) continue

      const strength = Math.min(EDGE_ALPHA_MAX, EDGE_ALPHA + (edge.count - 1) * EDGE_ALPHA_PER_LINK)
      const touchesFocus = focusId === null || edge.source === focusId || edge.target === focusId
      painter.globalAlpha = touchesFocus ? strength : strength * DIM_ALPHA
      painter.lineWidth = Math.min(2.5, Math.max(0.6, 0.8 * view.k)) + (edge.count - 1) * 0.3
      painter.beginPath()
      painter.moveTo(from.x, from.y)
      painter.lineTo(to.x, to.y)
      painter.stroke()
    }

    /* Nodes. */
    painter.font = `${LABEL_FONT_SIZE}px ${palette.font}`
    painter.textAlign = 'center'
    painter.textBaseline = 'top'
    for (const node of sim.data.nodes) {
      const at = worldToScreen(node, view)
      const radius = Math.max(1.5, node.radius * view.k)
      if (at.x + radius < 0 || at.y + radius < 0 || at.x - radius > width || at.y - radius > height) continue

      const isCurrent = node.id === currentId
      const isFocus = node.id === focusId
      const alpha = opacityOf(node.id)
      const isTag = !node.unresolved && node.id.startsWith('#')

      painter.globalAlpha = alpha
      painter.beginPath()
      painter.arc(at.x, at.y, radius, 0, TAU)
      if (node.unresolved) {
        // Placeholder for a note that does not exist yet: hollow and dashed.
        painter.setLineDash([2, 3])
        painter.lineWidth = 1.25
        painter.strokeStyle = palette.nodeUnresolved
        painter.stroke()
        painter.setLineDash([])
      } else {
        painter.fillStyle = isCurrent ? palette.nodeCurrent : isTag ? palette.nodeTag : palette.node
        painter.fill()
      }

      // Rings: the current note always, the hovered node while it is hovered.
      if (isCurrent || isFocus) {
        painter.globalAlpha = 1
        painter.beginPath()
        painter.arc(at.x, at.y, radius + (isCurrent ? 4 : 3), 0, TAU)
        painter.lineWidth = isCurrent ? 2 : 1.5
        painter.strokeStyle = palette.nodeCurrent
        painter.stroke()
      }

      const showLabel = view.k >= LABEL_ZOOM || isFocus || isCurrent
      if (!showLabel) continue
      painter.globalAlpha = alpha
      const text = clipLabel(node.label || node.id)
      const y = at.y + radius + LABEL_GAP
      // A halo in the page background keeps labels legible over dense edges.
      painter.lineWidth = 3
      painter.strokeStyle = palette.background
      painter.strokeText(text, at.x, y)
      painter.fillStyle = isCurrent || isFocus ? palette.labelStrong : palette.label
      painter.fillText(text, at.x, y)
    }

    painter.globalAlpha = 1
  }

  /* ---------------------------------------------------------------- *
   * Hit testing
   * ---------------------------------------------------------------- */

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const nodeAtPoint = (point: Point): GraphNode | null => {
    if (!sim) return null
    const world = screenToWorld(point, transform)
    // The slop is a screen-pixel affordance, so it has to be un-scaled before
    // it reaches the simulation's coordinate space.
    const tolerance = HIT_SLOP / Math.max(0.01, transform.k)
    return sim.nodeAt(world.x, world.y, tolerance)
  }

  const centrePoint = (): Point => ({ x: size.width / 2, y: size.height / 2 })

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  const fit = (): void => {
    measure()
    const bounds = sim ? sim.bounds() : { minX: -1, minY: -1, maxX: 1, maxY: 1 }
    transform = fitTransform(bounds, size, FIT_PADDING)
    hasFitted = true
    kick()
  }

  const zoomAt = (point: Point, factor: number): void => {
    const k = clampZoom(transform.k * (Number.isFinite(factor) && factor > 0 ? factor : 1))
    if (k === transform.k) return
    // Keep the world point under the cursor exactly where it is.
    const anchor = screenToWorld(point, transform)
    transform = { k, x: point.x - anchor.x * k, y: point.y - anchor.y * k }
    kick()
  }

  const panBy = (dx: number, dy: number): void => {
    transform = { ...transform, x: transform.x + dx, y: transform.y + dy }
    kick()
  }

  const setData = (data: GraphData): void => {
    if (applied === data) return
    const wasEmpty = applied === null || applied.nodes.length === 0
    applied = data
    indexData(data)
    if (!sim) {
      sim = new ForceLayout(data, {
        linkDistance: props.current.linkDistance,
        charge: props.current.charge,
        centerStrength: CENTER_STRENGTH,
        width: size.width,
        height: size.height,
      })
    } else {
      sim.setData(data)
    }
    // Re-fitting on every keystroke would fight the user's pan/zoom, so only
    // frame the graph when there was nothing to frame before.
    if (wasEmpty || !hasFitted) fit()
    else kick()
  }

  const setForces = (linkDistance: number, charge: number): void => {
    sim?.setOptions({ linkDistance, charge })
    kick()
  }

  /* ---------------------------------------------------------------- *
   * Pointer + keyboard
   * ---------------------------------------------------------------- */

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    // deltaMode 0 = pixels, 1 = lines, 2 = pages.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1
    zoomAt(localPoint(event), Math.exp((-event.deltaY * unit) / WHEEL_DIVISOR))
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (typeof canvas.focus === 'function') canvas.focus()
    const point = localPoint(event)
    const node = nodeAtPoint(point)
    drag = {
      kind: node ? 'node' : 'pan',
      id: node ? node.id : null,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      moved: false,
    }
    // Pin immediately so the node stops being pushed around mid-grab.
    if (node && sim) sim.pin(node.id, node.x, node.y)
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
    // Suppresses the text-selection drag; focus is handled above.
    event.preventDefault()
  }

  const onWindowMouseMove = (event: MouseEvent): void => {
    const state = drag
    if (!state) return
    const point = localPoint(event)
    const dx = point.x - state.lastX
    const dy = point.y - state.lastY
    state.lastX = point.x
    state.lastY = point.y
    if (!state.moved && Math.hypot(point.x - state.startX, point.y - state.startY) > DRAG_THRESHOLD) {
      state.moved = true
    }
    if (!state.moved) return

    if (state.kind === 'pan') {
      panBy(dx, dy)
      return
    }
    if (state.id && sim) {
      const world = screenToWorld(point, transform)
      sim.pin(state.id, world.x, world.y)
      kick()
    }
  }

  const onWindowMouseUp = (event: MouseEvent): void => {
    const state = drag
    drag = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    if (!state) return
    // Shift keeps the node where it was dropped; a plain release lets the
    // simulation reclaim it.
    if (state.kind === 'node' && state.id && sim && !event.shiftKey) sim.unpin(state.id)
    suppressClick = state.moved
    kick()
  }

  const onMouseMove = (event: MouseEvent): void => {
    if (drag) return // the window listener owns the pointer during a drag
    const node = nodeAtPoint(localPoint(event))
    const id = node ? node.id : null
    if (id !== (props.current.hoveredId ?? null)) props.current.onHover(id)
    canvas.style.cursor = node ? 'pointer' : ''
  }

  const onMouseLeave = (): void => {
    if (!drag && (props.current.hoveredId ?? null) !== null) props.current.onHover(null)
  }

  const onClick = (event: MouseEvent): void => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    const node = nodeAtPoint(localPoint(event))
    if (!node) return
    props.current.onOpen(node.id, event.metaKey || event.ctrlKey)
  }

  const onDoubleClick = (event: MouseEvent): void => {
    // Only empty space re-fits; double-clicking a node is just two opens.
    if (nodeAtPoint(localPoint(event))) return
    fit()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? KEY_PAN_STEP * 3 : KEY_PAN_STEP
    switch (event.key) {
      // Arrows move the camera: looking left slides the content right.
      case 'ArrowLeft':
        panBy(step, 0)
        break
      case 'ArrowRight':
        panBy(-step, 0)
        break
      case 'ArrowUp':
        panBy(0, step)
        break
      case 'ArrowDown':
        panBy(0, -step)
        break
      case '+':
      case '=':
        zoomAt(centrePoint(), ZOOM_STEP)
        break
      case '-':
      case '_':
        zoomAt(centrePoint(), 1 / ZOOM_STEP)
        break
      case 'Enter': {
        const id = props.current.hoveredId ?? null
        if (!id) return
        props.current.onOpen(id, event.metaKey || event.ctrlKey)
        break
      }
      case 'Escape':
        if ((props.current.hoveredId ?? null) === null) return
        props.current.onHover(null)
        break
      default:
        return
    }
    event.preventDefault()
  }

  /* ---------------------------------------------------------------- *
   * Environment listeners
   * ---------------------------------------------------------------- */

  const onThemeChange = (): void => {
    palette = readGraphPalette()
    kick()
  }

  const onMotionChange = (): void => {
    reducedMotion = prefersReducedMotion()
    kick()
  }

  const onWindowResize = (): void => {
    if (measure()) kick()
  }

  let themeObserver: MutationObserver | null = null
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
    themeObserver = new MutationObserver(onThemeChange)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
  }

  /** Media queries we listen to; `null` entries simply are not supported here. */
  const watchMedia = (query: string, handler: () => void): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    try {
      const list = window.matchMedia(query)
      if (typeof list.addEventListener !== 'function') return () => {}
      list.addEventListener('change', handler)
      return () => list.removeEventListener('change', handler)
    } catch {
      return () => {}
    }
  }
  const unwatchScheme = watchMedia('(prefers-color-scheme: dark)', onThemeChange)
  const unwatchMotion = watchMedia('(prefers-reduced-motion: reduce)', onMotionChange)

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(onWindowResize)
    resizeObserver.observe(container)
  } else if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowResize)
  }

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseleave', onMouseLeave)
  canvas.addEventListener('click', onClick)
  canvas.addEventListener('dblclick', onDoubleClick)
  canvas.addEventListener('keydown', onKeyDown)

  measure()
  setData(props.current.data)

  return {
    fit,
    zoomBy: (factor: number) => zoomAt(centrePoint(), factor),
    setData,
    setForces,
    redraw: kick,
    destroy() {
      if (frame !== null) {
        cancelFrame(frame)
        frame = null
      }
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('dblclick', onDoubleClick)
      canvas.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowMouseUp)
      window.removeEventListener('resize', onWindowResize)
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
      unwatchScheme()
      unwatchMotion()
      drag = null
      sim = null
    },
  }
}

/** True when the segment could touch the viewport at all. */
function segmentVisible(a: Point, b: Point, width: number, height: number): boolean {
  if (a.x < 0 && b.x < 0) return false
  if (a.y < 0 && b.y < 0) return false
  if (a.x > width && b.x > width) return false
  if (a.y > height && b.y > height) return false
  return true
}

/* ------------------------------------------------------------------ *
 * The hook
 * ------------------------------------------------------------------ */

export function useGraphCanvas(options: GraphCanvasOptions): GraphCanvasHandle {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<Engine | null>(null)

  // The engine is built once and reads props through this ref, so no listener
  // ever has to be rebound when a callback identity changes.
  const propsRef = useRef(options)
  propsRef.current = options

  useLayoutEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return undefined
    const engine = createEngine({ container, canvas, props: propsRef })
    engineRef.current = engine
    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [])

  const { data, linkDistance, charge, currentId, hoveredId } = options

  useEffect(() => {
    engineRef.current?.setData(data)
  }, [data])

  useEffect(() => {
    engineRef.current?.setForces(linkDistance, charge)
  }, [linkDistance, charge])

  // Hover and "you are here" only affect painting, so a redraw is enough.
  useEffect(() => {
    engineRef.current?.redraw()
  }, [currentId, hoveredId])

  const fit = useCallback(() => {
    engineRef.current?.fit()
  }, [])

  const zoomBy = useCallback((factor: number) => {
    engineRef.current?.zoomBy(factor)
  }, [])

  return { containerRef, canvasRef, fit, zoomBy }
}
