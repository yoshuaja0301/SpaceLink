/**
 * SpaceFore — force-directed layout for the graph view.
 *
 * A small, dependency-free simulation. One tick applies, in order:
 *
 *   1. pairwise repulsion  — O(n²) for small graphs, uniform grid above 400 nodes
 *                            (density-sized cells, so the cost stays linear)
 *   2. spring attraction   — pulls linked nodes toward `linkDistance`
 *   3. centering           — a weak pull toward the origin
 *   4. velocity damping    — 0.85
 *   5. integration         — `x += vx`
 *   6. cooling             — `alpha *= 0.985`, floored at 0.001
 *
 * Every force is scaled by `alpha`, so the graph visibly settles and then
 * stops moving in any meaningful way.
 *
 * The simulation is **deterministic**: the same input plus the same number of
 * ticks always produces the same coordinates. There is no `Math.random()` and
 * no `Date.now()` anywhere in this file — coincident nodes are separated along
 * a direction derived from their node index instead.
 *
 * The simulation is centred on the origin; `width`/`height` describe the
 * viewport the consumer draws into (it is expected to translate/scale using
 * `bounds()`), and are kept on the options object for that consumer.
 */
import type { GraphData, GraphNode, NotePath } from '../../types'

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Golden angle in radians — matches the spiral seeding in `buildGraphData`. */
const GOLDEN_ANGLE = 2.399963
/** Radial spacing used when a node arrives without a usable position. */
const SPIRAL_SPACING = 12
/** Per-tick cooling factor. */
const ALPHA_DECAY = 0.985
/** Alpha never reaches zero, it just stops mattering. */
const ALPHA_MIN = 0.001
/** Velocity retained from one tick to the next. */
const DAMPING = 0.85
/** Repulsion is ignored beyond this many `linkDistance` units. */
const CUTOFF_LINKS = 6
/** Above this many nodes the O(n²) sweep is replaced by a uniform grid. */
const GRID_THRESHOLD = 400
/** Base spring stiffness, divided by the lower of the two endpoint degrees. */
const SPRING_STRENGTH = 0.6
/** Distance floor for repulsion, so near-coincident nodes cannot explode. */
const MIN_SEPARATION = 1
/** Per-tick speed ceiling, expressed in `linkDistance` units. */
const MAX_SPEED_LINKS = 4
/** Alpha `setData` / `pin` warm the simulation back up to. */
const REHEAT_ALPHA = 0.5
/** Squared distance under which two nodes count as coincident. */
const EPSILON_SQ = 1e-9

/** Nodes one grid cell aims to hold — the knob that bounds the repulsion cost. */
const GRID_TARGET_PER_CELL = 9
/** Partners one node takes from any single cell, so a crowded cell stays linear. */
const CELL_PARTNER_LIMIT = 16

/**
 * A node only ever compares against the 3×3 neighbourhood of its own cell.
 * These four offsets visit each unordered pair of adjacent cells exactly once
 * (the mirrored offsets are covered when the other cell takes its turn).
 */
const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
]

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ForceLayoutOptions {
  linkDistance: number
  charge: number
  centerStrength: number
  width: number
  height: number
}

/** Position + velocity snapshot, used to carry a node across `setData`. */
interface Placement {
  x: number
  y: number
  vx: number
  vy: number
}

/** A resolved edge: node references plus the stiffness for that pair. */
interface Spring {
  a: GraphNode
  b: GraphNode
  strength: number
}

/** One occupied cell of the uniform grid; `items` holds indices into `nodes`. */
interface Bucket {
  ix: number
  iy: number
  items: number[]
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Degree as a force weight: never zero, never NaN. */
function weightOf(node: GraphNode): number {
  return Number.isFinite(node.degree) && node.degree > 1 ? node.degree : 1
}

/**
 * Deterministic fallback position — the same golden-angle spiral
 * `buildGraphData` seeds with, so a node that arrives without coordinates
 * still lands somewhere sensible and reproducible.
 */
function spiralPosition(index: number): { x: number; y: number } {
  const angle = index * GOLDEN_ANGLE
  const radius = SPIRAL_SPACING * Math.sqrt(Math.max(0, index))
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function sanitizeOptions(options: ForceLayoutOptions): ForceLayoutOptions {
  return {
    linkDistance: positiveOr(options.linkDistance, 70),
    charge: finiteOr(options.charge, -180),
    centerStrength: finiteOr(options.centerStrength, 0.05),
    width: positiveOr(options.width, 800),
    height: positiveOr(options.height, 600),
  }
}

/* ------------------------------------------------------------------ *
 * ForceLayout
 * ------------------------------------------------------------------ */

export class ForceLayout {
  private current: GraphData
  private opts: ForceLayoutOptions
  private heat = 1
  private byId = new Map<NotePath, GraphNode>()
  private springs: Spring[] = []
  private pinned = new Map<NotePath, { x: number; y: number }>()

  constructor(data: GraphData, options: ForceLayoutOptions) {
    this.opts = sanitizeOptions(options)
    this.current = data
    this.install(data, null)
  }

  /** The live graph. Node objects are mutated in place as the layout runs. */
  get data(): GraphData {
    return this.current
  }

  /** Simulation temperature: 1 = just started, 0.001 = fully cooled. */
  get alpha(): number {
    return this.heat
  }

  /**
   * Swap in freshly indexed graph data. Nodes that survive keep their exact
   * position and velocity, genuinely new nodes are seeded next to a neighbour
   * that already has a place on screen, and removed nodes simply disappear
   * (their pins go with them). The simulation is warmed back up so the new
   * shape can settle.
   */
  setData(data: GraphData): void {
    const previous = new Map<NotePath, Placement>()
    for (const node of this.current.nodes) {
      previous.set(node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy })
    }
    this.install(data, previous)
    this.reheat(Math.max(this.heat, REHEAT_ALPHA))
  }

  /**
   * Patch the tunables. Changing a force parameter warms the simulation up so
   * the graph re-settles; resizing the viewport does not (nothing moved).
   */
  setOptions(patch: Partial<ForceLayoutOptions>): void {
    const before = this.opts
    const next = sanitizeOptions({ ...before, ...patch })
    this.opts = next
    const forcesChanged =
      next.linkDistance !== before.linkDistance ||
      next.charge !== before.charge ||
      next.centerStrength !== before.centerStrength
    if (forcesChanged) {
      // Spring stiffness itself does not depend on linkDistance, but the
      // graph does need to re-settle around the new target length.
      this.reheat(Math.max(this.heat, REHEAT_ALPHA))
    }
  }

  /** Advance the simulation. Returns the new alpha. */
  tick(steps = 1): number {
    const count = Number.isFinite(steps) ? Math.floor(steps) : 1
    for (let step = 0; step < count; step += 1) this.step()
    return this.heat
  }

  /** Warm the simulation back up (clamped to the usable alpha range). */
  reheat(alpha = 1): void {
    this.heat = Math.min(1, Math.max(ALPHA_MIN, finiteOr(alpha, 1)))
  }

  /**
   * Hit-test a point in simulation coordinates. Among every node whose circle
   * (radius + tolerance) contains the point, the highest-degree one wins —
   * hubs are drawn largest and are what the user is aiming at. Nodes of equal
   * degree are resolved in favour of the topmost, i.e. the one drawn last.
   */
  nodeAt(x: number, y: number, tolerance = 4): GraphNode | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const slack = finiteOr(tolerance, 0)
    const nodes = this.current.nodes
    let best: GraphNode | null = null
    // Back to front: the first hit is the topmost node.
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i]!
      const reach = Math.max(0, finiteOr(node.radius, 0) + slack)
      const dx = x - node.x
      const dy = y - node.y
      if (dx * dx + dy * dy > reach * reach) continue
      if (best === null || node.degree > best.degree) best = node
    }
    return best
  }

  /**
   * Fix a node in place until `unpin`. Pinned nodes ignore every force and
   * keep zero velocity, but still repel and still pull on their springs — so
   * dragging one drags its neighbourhood along.
   */
  pin(id: NotePath, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.pinned.set(id, { x, y })
    const node = this.byId.get(id)
    if (node) {
      node.x = x
      node.y = y
      node.vx = 0
      node.vy = 0
    }
    // A drag should visibly disturb the neighbours.
    this.reheat(Math.max(this.heat, REHEAT_ALPHA))
  }

  /** Release a pinned node. It keeps its current position and stays still. */
  unpin(id: NotePath): void {
    if (!this.pinned.delete(id)) return
    const node = this.byId.get(id)
    if (node) {
      node.vx = 0
      node.vy = 0
    }
    this.reheat(Math.max(this.heat, REHEAT_ALPHA))
  }

  /**
   * Bounding box of the drawn circles (position ± radius), so fit-to-view
   * never clips a node. An empty graph yields a small box around the origin
   * rather than an inverted/infinite one.
   */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const nodes = this.current.nodes
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of nodes) {
      const r = Math.max(0, finiteOr(node.radius, 0))
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
      if (node.x - r < minX) minX = node.x - r
      if (node.y - r < minY) minY = node.y - r
      if (node.x + r > maxX) maxX = node.x + r
      if (node.y + r > maxY) maxY = node.y + r
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
    }
    return { minX, minY, maxX, maxY }
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /** Adopt `data`, carrying positions over from `previous` when there is one. */
  private install(data: GraphData, previous: Map<NotePath, Placement> | null): void {
    this.current = data
    this.byId.clear()
    for (const node of data.nodes) this.byId.set(node.id, node)

    const fresh: { node: GraphNode; index: number }[] = []
    for (let i = 0; i < data.nodes.length; i += 1) {
      const node = data.nodes[i]!
      const kept = previous?.get(node.id)
      if (kept) {
        node.x = kept.x
        node.y = kept.y
        node.vx = kept.vx
        node.vy = kept.vy
        continue
      }
      // New (or first-ever) node: keep the incoming spiral position, but never
      // trust a NaN/Infinity through into the simulation.
      node.vx = finiteOr(node.vx, 0)
      node.vy = finiteOr(node.vy, 0)
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        const seat = spiralPosition(i)
        node.x = seat.x
        node.y = seat.y
      }
      if (previous) fresh.push({ node, index: i })
    }

    if (previous && fresh.length > 0) this.seedNewNodes(fresh, data, previous)
    this.rebuildSprings(data)

    // Pins only survive while their node does.
    for (const [id, at] of [...this.pinned]) {
      const node = this.byId.get(id)
      if (!node) {
        this.pinned.delete(id)
        continue
      }
      node.x = at.x
      node.y = at.y
      node.vx = 0
      node.vy = 0
    }
  }

  /**
   * Place nodes that were not in the previous data next to a neighbour that
   * was, so a note created from a `[[link]]` pops up beside the note linking
   * to it instead of at the far end of the spiral. The offset angle comes from
   * the node's index, so several new neighbours of the same node fan out
   * instead of stacking.
   */
  private seedNewNodes(
    fresh: { node: GraphNode; index: number }[],
    data: GraphData,
    previous: Map<NotePath, Placement>,
  ): void {
    const isFresh = new Set<NotePath>()
    for (const entry of fresh) isFresh.add(entry.node.id)

    const anchors = new Map<NotePath, Placement>()
    const consider = (id: NotePath, neighbour: NotePath): void => {
      if (!isFresh.has(id) || anchors.has(id)) return
      const at = previous.get(neighbour)
      if (at) anchors.set(id, at)
    }
    for (const edge of data.edges) {
      consider(edge.source, edge.target)
      consider(edge.target, edge.source)
    }

    const distance = this.opts.linkDistance
    for (const { node, index } of fresh) {
      const anchor = anchors.get(node.id)
      if (!anchor) continue
      const angle = index * GOLDEN_ANGLE
      node.x = anchor.x + Math.cos(angle) * distance
      node.y = anchor.y + Math.sin(angle) * distance
      node.vx = 0
      node.vy = 0
    }
  }

  /** Resolve edges to node references once, instead of per tick. */
  private rebuildSprings(data: GraphData): void {
    const springs: Spring[] = []
    for (const edge of data.edges) {
      if (edge.source === edge.target) continue // a self link cannot pull
      const a = this.byId.get(edge.source)
      const b = this.byId.get(edge.target)
      if (!a || !b) continue // edge into a node filtered out of this view
      // Hubs are held by many springs; softening by the lower degree keeps
      // them from being torn apart. `count` deliberately does not stiffen the
      // spring — five links between two notes should not collapse them.
      springs.push({ a, b, strength: SPRING_STRENGTH / Math.max(1, Math.min(weightOf(a), weightOf(b))) })
    }
    this.springs = springs
  }

  /** One integration step. */
  private step(): void {
    const nodes = this.current.nodes
    if (nodes.length > 0) {
      this.applyRepulsion(nodes)
      this.applyAttraction()
      this.applyCentering(nodes)
      this.integrate(nodes)
    }
    this.heat = Math.max(ALPHA_MIN, this.heat * ALPHA_DECAY)
  }

  private applyRepulsion(nodes: GraphNode[]): void {
    const cutoff = this.opts.linkDistance * CUTOFF_LINKS
    const cutoffSq = cutoff * cutoff
    if (nodes.length > GRID_THRESHOLD) {
      this.repelViaGrid(nodes, cutoff, cutoffSq)
      return
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        this.repel(nodes, i, j, cutoffSq)
      }
    }
  }

  /**
   * Grid pitch for one repulsion pass. Cells one cutoff wide only bound the
   * cost while the graph is thinner than one node per cutoff: a settled vault
   * is far denser than that, the cell then holds a constant fraction of the
   * whole graph and the sweep degenerates to O(n²) again. Sizing the pitch
   * from the *density* of the current layout keeps a handful of nodes per cell
   * whatever the graph looks like. The pitch never drops below `linkDistance`
   * (a spring sitting at its rest length must still feel its own repulsion)
   * and never exceeds the cutoff (pairs further apart contribute nothing).
   */
  private gridCell(nodes: GraphNode[], cutoff: number): number {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of nodes) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
      if (node.x < minX) minX = node.x
      if (node.x > maxX) maxX = node.x
      if (node.y < minY) minY = node.y
      if (node.y > maxY) maxY = node.y
    }
    const area = maxX > minX && maxY > minY ? (maxX - minX) * (maxY - minY) : 0
    const ideal = area > 0 ? Math.sqrt((area * GRID_TARGET_PER_CELL) / nodes.length) : 0
    return Math.max(1, Math.min(cutoff, Math.max(this.opts.linkDistance, finiteOr(ideal, 0))))
  }

  /**
   * Bucket the nodes into a uniform grid and only compare within the 3×3 cell
   * neighbourhood. Cells are sized so a handful of nodes land in each, which
   * caps the pairs one node is compared against — and `CELL_PARTNER_LIMIT`
   * caps it again for the pathological case (a thousand nodes piled into one
   * cell because a single outlier stretched the bounding box). Repulsion
   * beyond a couple of cells is dropped rather than paid for: a crowded graph
   * loses a little of the long-range field instead of losing its frame rate.
   */
  private repelViaGrid(nodes: GraphNode[], cutoff: number, cutoffSq: number): void {
    const cell = this.gridCell(nodes, cutoff)
    const byKey = new Map<string, Bucket>()
    const buckets: Bucket[] = []
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!
      const ix = Math.floor(node.x / cell)
      const iy = Math.floor(node.y / cell)
      const key = `${ix},${iy}`
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { ix, iy, items: [] }
        byKey.set(key, bucket)
        buckets.push(bucket)
      }
      bucket.items.push(i)
    }

    for (const bucket of buckets) {
      const items = bucket.items
      for (let a = 0; a < items.length; a += 1) {
        const last = Math.min(items.length, a + 1 + CELL_PARTNER_LIMIT)
        for (let b = a + 1; b < last; b += 1) {
          this.repel(nodes, items[a]!, items[b]!, cutoffSq)
        }
      }
      for (const [ox, oy] of NEIGHBOUR_OFFSETS) {
        const other = byKey.get(`${bucket.ix + ox},${bucket.iy + oy}`)
        if (!other) continue
        const partners = other.items
        const take = Math.min(partners.length, CELL_PARTNER_LIMIT)
        for (let a = 0; a < items.length; a += 1) {
          // Below the cap this walks the whole neighbouring cell; above it the
          // window rotates with `a`, so the sampling stays spread over that
          // cell instead of hammering its first few nodes. Index-driven, so
          // still deterministic.
          for (let k = 0; k < take; k += 1) {
            this.repel(nodes, items[a]!, partners[(a + k) % partners.length]!, cutoffSq)
          }
        }
      }
    }
  }

  /** Push two nodes apart with a 1/d falloff, scaled by charge and alpha. */
  private repel(nodes: GraphNode[], ai: number, bi: number, cutoffSq: number): void {
    const a = nodes[ai]!
    const b = nodes[bi]!
    let dx = b.x - a.x
    let dy = b.y - a.y
    let distSq = dx * dx + dy * dy
    if (distSq > cutoffSq) return
    if (distSq < EPSILON_SQ) {
      // Coincident nodes have no direction to separate along. Derive one from
      // the node indices — deterministic, unlike Math.random().
      const angleA = ai * GOLDEN_ANGLE
      const angleB = bi * GOLDEN_ANGLE
      dx = Math.cos(angleB) - Math.cos(angleA)
      dy = Math.sin(angleB) - Math.sin(angleA)
      distSq = dx * dx + dy * dy
      if (distSq < EPSILON_SQ) {
        // Same index (a node against itself) or an exact trigonometric tie.
        dx = 1
        dy = 0
        distSq = 1
      }
    }
    const dist = Math.sqrt(distSq)
    // Direction is exact; magnitude uses a floored distance so an almost-zero
    // gap produces a strong-but-bounded shove rather than an infinite one.
    const magnitude = (this.opts.charge * this.heat) / Math.max(dist, MIN_SEPARATION)
    const ux = (dx / dist) * magnitude
    const uy = (dy / dist) * magnitude
    a.vx += ux
    a.vy += uy
    b.vx -= ux
    b.vy -= uy
  }

  /** Pull each edge toward `linkDistance`; each endpoint takes half the load. */
  private applyAttraction(): void {
    const target = this.opts.linkDistance
    for (const spring of this.springs) {
      const { a, b } = spring
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distSq = dx * dx + dy * dy
      if (distSq < EPSILON_SQ) continue // coincident: repulsion separates them first
      const dist = Math.sqrt(distSq)
      const pull = (((dist - target) / dist) * this.heat * spring.strength) / 2
      a.vx += dx * pull
      a.vy += dy * pull
      b.vx -= dx * pull
      b.vy -= dy * pull
    }
  }

  /** Weak pull toward the origin, so detached clusters do not drift away. */
  private applyCentering(nodes: GraphNode[]): void {
    const strength = this.opts.centerStrength * this.heat
    if (strength === 0) return
    for (const node of nodes) {
      node.vx -= node.x * strength
      node.vy -= node.y * strength
    }
  }

  /** Damp velocities, clamp the speed, then move. Pinned nodes stay put. */
  private integrate(nodes: GraphNode[]): void {
    const maxSpeed = this.opts.linkDistance * MAX_SPEED_LINKS
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!
      const fixed = this.pinned.get(node.id)
      if (fixed) {
        node.x = fixed.x
        node.y = fixed.y
        node.vx = 0
        node.vy = 0
        continue
      }
      let vx = node.vx * DAMPING
      let vy = node.vy * DAMPING
      const speed = Math.sqrt(vx * vx + vy * vy)
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed
        vx *= scale
        vy *= scale
      }
      node.vx = vx
      node.vy = vy
      node.x += vx
      node.y += vy
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        // Belt and braces: a pathological option (charge of 1e308, say) must
        // never leave NaN coordinates behind for the renderer.
        const seat = spiralPosition(i)
        node.x = seat.x
        node.y = seat.y
        node.vx = 0
        node.vy = 0
      }
    }
  }
}
