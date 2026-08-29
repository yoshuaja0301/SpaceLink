import type { GraphData, GraphEdge, GraphNode } from '../../types'
import type { ForceLayoutOptions } from './layout'
import { ForceLayout } from './layout'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const OPTIONS: ForceLayoutOptions = {
  linkDistance: 70,
  charge: -180,
  centerStrength: 0.05,
  width: 800,
  height: 600,
}

function node(id: string, x: number, y: number, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    degree: 1,
    unresolved: false,
    tags: [],
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 6,
    ...extra,
  }
}

function edge(source: string, target: string, count = 1): GraphEdge {
  return { source, target, count }
}

function distance(a: GraphNode, b: GraphNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function byId(data: GraphData, id: string): GraphNode {
  const found = data.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`no node ${id}`)
  return found
}

/** Golden-angle spiral, the same seeding `buildGraphData` produces. */
function spiralGraph(count: number, edgeCount: number): GraphData {
  const nodes: GraphNode[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = i * 2.399963
    const radius = 12 * Math.sqrt(i)
    nodes.push(node(`n${i}.md`, Math.cos(angle) * radius, Math.sin(angle) * radius, { degree: 3, radius: 8 }))
  }
  const edges: GraphEdge[] = []
  for (let i = 0; i < edgeCount; i += 1) {
    // Deterministic pseudo-shuffled wiring: every node links a few hops away.
    const from = i % count
    const to = (i * 7 + 3) % count
    if (from !== to) edges.push(edge(`n${from}.md`, `n${to}.md`))
  }
  return { nodes, edges }
}

function allFinite(data: GraphData): boolean {
  return data.nodes.every(
    (n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.vx) && Number.isFinite(n.vy),
  )
}

/* ------------------------------------------------------------------ *
 * Springs
 * ------------------------------------------------------------------ */

describe('ForceLayout — spring attraction', () => {
  it('pulls two far-apart linked nodes toward linkDistance', () => {
    const data: GraphData = { nodes: [node('a.md', -400, 0), node('b.md', 400, 0)], edges: [edge('a.md', 'b.md')] }
    const layout = new ForceLayout(data, OPTIONS)

    expect(distance(data.nodes[0]!, data.nodes[1]!)).toBe(800)
    layout.tick(400)

    const gap = distance(data.nodes[0]!, data.nodes[1]!)
    // Equilibrium sits slightly above linkDistance because repulsion keeps
    // pushing back; it must be unmistakably in that neighbourhood.
    expect(gap).toBeGreaterThan(55)
    expect(gap).toBeLessThan(95)
  })

  it('pushes two nearly coincident linked nodes back out to linkDistance', () => {
    const data: GraphData = { nodes: [node('a.md', -1, 0), node('b.md', 1, 0)], edges: [edge('a.md', 'b.md')] }
    const layout = new ForceLayout(data, OPTIONS)
    layout.tick(400)

    const gap = distance(data.nodes[0]!, data.nodes[1]!)
    expect(gap).toBeGreaterThan(55)
    expect(gap).toBeLessThan(95)
  })

  it('separates exactly coincident nodes deterministically, without NaN', () => {
    const build = (): GraphData => ({
      nodes: [node('a.md', 0, 0), node('b.md', 0, 0), node('c.md', 0, 0)],
      edges: [],
    })
    const first = build()
    const second = build()
    new ForceLayout(first, OPTIONS).tick(60)
    new ForceLayout(second, OPTIONS).tick(60)

    expect(allFinite(first)).toBe(true)
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) {
        expect(distance(first.nodes[i]!, first.nodes[j]!)).toBeGreaterThan(1)
      }
    }
    expect(first.nodes.map((n) => [n.x, n.y])).toEqual(second.nodes.map((n) => [n.x, n.y]))
  })

  it('ignores self links and edges pointing at missing nodes', () => {
    const data: GraphData = {
      nodes: [node('a.md', 10, 0)],
      edges: [edge('a.md', 'a.md'), edge('a.md', 'ghost.md')],
    }
    const layout = new ForceLayout(data, OPTIONS)
    expect(() => layout.tick(20)).not.toThrow()
    expect(allFinite(data)).toBe(true)
    // Only centering acts on it, so it drifts toward the origin.
    expect(Math.abs(data.nodes[0]!.x)).toBeLessThan(10)
  })
})

/* ------------------------------------------------------------------ *
 * Repulsion
 * ------------------------------------------------------------------ */

describe('ForceLayout — repulsion', () => {
  it('pushes unlinked nodes apart', () => {
    const data: GraphData = { nodes: [node('a.md', -3, 0), node('b.md', 3, 0)], edges: [] }
    const layout = new ForceLayout(data, OPTIONS)
    expect(distance(data.nodes[0]!, data.nodes[1]!)).toBe(6)

    layout.tick(300)
    const gap = distance(data.nodes[0]!, data.nodes[1]!)
    expect(gap).toBeGreaterThan(50)
    // Centering stops them from flying off forever.
    expect(gap).toBeLessThan(200)
  })

  it('settles a whole graph with edges close to linkDistance', () => {
    const data = spiralGraph(60, 80)
    const layout = new ForceLayout(data, OPTIONS)
    layout.tick(600)

    const lookup = new Map(data.nodes.map((n) => [n.id, n]))
    const lengths = data.edges.map((e) => distance(lookup.get(e.source)!, lookup.get(e.target)!))
    const mean = lengths.reduce((sum, len) => sum + len, 0) / lengths.length
    expect(mean).toBeGreaterThan(OPTIONS.linkDistance * 0.75)
    expect(mean).toBeLessThan(OPTIONS.linkDistance * 1.5)
    // No edge collapses to nothing and none is left stretched across the view.
    expect(Math.min(...lengths)).toBeGreaterThan(20)
    expect(Math.max(...lengths)).toBeLessThan(OPTIONS.linkDistance * 4)
  })

  it('keeps unlinked nodes further apart than linked ones', () => {
    const linked: GraphData = { nodes: [node('a.md', -20, 0), node('b.md', 20, 0)], edges: [edge('a.md', 'b.md')] }
    const loose: GraphData = { nodes: [node('a.md', -20, 0), node('b.md', 20, 0)], edges: [] }
    new ForceLayout(linked, OPTIONS).tick(300)
    new ForceLayout(loose, OPTIONS).tick(300)

    expect(distance(loose.nodes[0]!, loose.nodes[1]!)).toBeGreaterThan(distance(linked.nodes[0]!, linked.nodes[1]!))
  })
})

/* ------------------------------------------------------------------ *
 * Cooling
 * ------------------------------------------------------------------ */

describe('ForceLayout — alpha', () => {
  it('starts hot, decays by 0.985 per tick and floors at 0.001', () => {
    const layout = new ForceLayout(spiralGraph(12, 14), OPTIONS)
    expect(layout.alpha).toBe(1)

    expect(layout.tick()).toBeCloseTo(0.985, 10)
    expect(layout.tick(2)).toBeCloseTo(0.985 ** 3, 10)

    layout.tick(2000)
    expect(layout.alpha).toBeCloseTo(0.001, 12)
  })

  it('reaches a near-stationary state within a few hundred ticks', () => {
    const data = spiralGraph(24, 30)
    const layout = new ForceLayout(data, OPTIONS)
    layout.tick(500)

    const before = data.nodes.map((n) => ({ x: n.x, y: n.y }))
    layout.tick(50)
    const moved = Math.max(...data.nodes.map((n, i) => Math.hypot(n.x - before[i]!.x, n.y - before[i]!.y)))

    expect(layout.alpha).toBeLessThan(0.01)
    expect(moved).toBeLessThan(1)
  })

  it('reheat clamps into the usable alpha range', () => {
    const layout = new ForceLayout(spiralGraph(4, 3), OPTIONS)
    layout.tick(600)
    expect(layout.alpha).toBeLessThan(0.01)

    layout.reheat()
    expect(layout.alpha).toBe(1)

    layout.reheat(5)
    expect(layout.alpha).toBe(1)
    layout.reheat(-2)
    expect(layout.alpha).toBe(0.001)
    layout.reheat(0.4)
    expect(layout.alpha).toBe(0.4)
  })

  it('tick(0) and negative step counts do nothing', () => {
    const data = spiralGraph(6, 5)
    const layout = new ForceLayout(data, OPTIONS)
    const before = data.nodes.map((n) => n.x)

    expect(layout.tick(0)).toBe(1)
    expect(layout.tick(-5)).toBe(1)
    expect(data.nodes.map((n) => n.x)).toEqual(before)
  })
})

/* ------------------------------------------------------------------ *
 * setData
 * ------------------------------------------------------------------ */

describe('ForceLayout — setData', () => {
  it('keeps position and velocity for surviving nodes, drops removed ones, and reheats', () => {
    const first: GraphData = {
      nodes: [node('a.md', -50, 0), node('b.md', 50, 0), node('gone.md', 0, 90)],
      edges: [edge('a.md', 'b.md')],
    }
    const layout = new ForceLayout(first, OPTIONS)
    layout.tick(600)
    expect(layout.alpha).toBeLessThan(0.01)

    const kept = { x: byId(first, 'a.md').x, y: byId(first, 'a.md').y, vx: byId(first, 'a.md').vx }

    const second: GraphData = {
      nodes: [node('a.md', 999, 999), node('b.md', -999, -999)],
      edges: [edge('a.md', 'b.md')],
    }
    layout.setData(second)

    expect(layout.data).toBe(second)
    expect(byId(second, 'a.md').x).toBe(kept.x)
    expect(byId(second, 'a.md').y).toBe(kept.y)
    expect(byId(second, 'a.md').vx).toBe(kept.vx)
    expect(second.nodes.some((n) => n.id === 'gone.md')).toBe(false)
    expect(layout.alpha).toBeGreaterThanOrEqual(0.5)
  })

  it('seeds a genuinely new node next to the neighbour it links to', () => {
    const first: GraphData = { nodes: [node('a.md', -300, 40)], edges: [] }
    const layout = new ForceLayout(first, OPTIONS)
    const anchor = { x: byId(first, 'a.md').x, y: byId(first, 'a.md').y }

    const second: GraphData = {
      nodes: [node('a.md', 0, 0), node('new.md', 5000, 5000)],
      edges: [edge('a.md', 'new.md')],
    }
    layout.setData(second)

    const created = byId(second, 'new.md')
    // Placed one link away from its neighbour rather than at its spiral seat.
    expect(Math.hypot(created.x - anchor.x, created.y - anchor.y)).toBeCloseTo(OPTIONS.linkDistance, 6)
    expect(created.vx).toBe(0)
    expect(created.vy).toBe(0)
  })

  it('leaves a new node without linked neighbours at its incoming spiral position', () => {
    const first: GraphData = { nodes: [node('a.md', -300, 40)], edges: [] }
    const layout = new ForceLayout(first, OPTIONS)

    const second: GraphData = { nodes: [node('a.md', 0, 0), node('island.md', 123, -456)], edges: [] }
    layout.setData(second)

    expect(byId(second, 'island.md').x).toBe(123)
    expect(byId(second, 'island.md').y).toBe(-456)
  })

  it('fans several new neighbours of the same node out instead of stacking them', () => {
    const first: GraphData = { nodes: [node('hub.md', 0, 0)], edges: [] }
    const layout = new ForceLayout(first, OPTIONS)

    const second: GraphData = {
      nodes: [node('hub.md', 0, 0), node('x.md', 0, 0), node('y.md', 0, 0), node('z.md', 0, 0)],
      edges: [edge('hub.md', 'x.md'), edge('hub.md', 'y.md'), edge('hub.md', 'z.md')],
    }
    layout.setData(second)

    const seats = ['x.md', 'y.md', 'z.md'].map((id) => byId(second, id))
    expect(distance(seats[0]!, seats[1]!)).toBeGreaterThan(1)
    expect(distance(seats[1]!, seats[2]!)).toBeGreaterThan(1)
    expect(distance(seats[0]!, seats[2]!)).toBeGreaterThan(1)
  })

  it('repairs non-finite incoming coordinates', () => {
    const data: GraphData = { nodes: [node('a.md', Number.NaN, Number.POSITIVE_INFINITY)], edges: [] }
    const layout = new ForceLayout(data, OPTIONS)
    expect(allFinite(data)).toBe(true)
    layout.tick(10)
    expect(allFinite(data)).toBe(true)
  })

  it('forgets pins for nodes that disappeared and keeps the ones that survived', () => {
    const first: GraphData = { nodes: [node('a.md', 0, 0), node('b.md', 30, 0)], edges: [] }
    const layout = new ForceLayout(first, OPTIONS)
    layout.pin('a.md', 111, 222)
    layout.pin('b.md', -40, 12)

    const second: GraphData = { nodes: [node('a.md', 0, 0)], edges: [] }
    layout.setData(second)
    layout.tick(50)

    expect(byId(second, 'a.md').x).toBe(111)
    expect(byId(second, 'a.md').y).toBe(222)

    // 'b.md' is gone; bringing an id back with the same name must not resurrect
    // a stale pin.
    const third: GraphData = { nodes: [node('a.md', 0, 0), node('b.md', 300, 300)], edges: [] }
    layout.setData(third)
    layout.tick(20)
    expect(byId(third, 'b.md').x).not.toBe(-40)
  })
})

/* ------------------------------------------------------------------ *
 * setOptions
 * ------------------------------------------------------------------ */

describe('ForceLayout — setOptions', () => {
  it('applies a new link distance and reheats', () => {
    const data: GraphData = { nodes: [node('a.md', -40, 0), node('b.md', 40, 0)], edges: [edge('a.md', 'b.md')] }
    const layout = new ForceLayout(data, OPTIONS)
    layout.tick(600)
    const settled = distance(data.nodes[0]!, data.nodes[1]!)

    layout.setOptions({ linkDistance: 200 })
    expect(layout.alpha).toBeGreaterThanOrEqual(0.5)
    layout.tick(400)

    const stretched = distance(data.nodes[0]!, data.nodes[1]!)
    expect(stretched).toBeGreaterThan(settled + 50)
    expect(stretched).toBeGreaterThan(150)
  })

  it('does not reheat when nothing that affects the forces changed', () => {
    const layout = new ForceLayout(spiralGraph(5, 4), OPTIONS)
    layout.tick(600)
    const cold = layout.alpha

    layout.setOptions({ width: 1200, height: 900 })
    expect(layout.alpha).toBe(cold)

    layout.setOptions({ linkDistance: OPTIONS.linkDistance })
    expect(layout.alpha).toBe(cold)
  })

  it('falls back to sane values for nonsense options', () => {
    const data: GraphData = { nodes: [node('a.md', 10, 10), node('b.md', -10, -10)], edges: [edge('a.md', 'b.md')] }
    const layout = new ForceLayout(data, { ...OPTIONS, linkDistance: 0, charge: Number.NaN, centerStrength: Number.NaN })
    layout.tick(100)
    expect(allFinite(data)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Pinning
 * ------------------------------------------------------------------ */

describe('ForceLayout — pin / unpin', () => {
  it('holds a pinned node still while the rest keeps moving', () => {
    const data: GraphData = {
      nodes: [node('a.md', 0, 0), node('b.md', 10, 0), node('c.md', -10, 5)],
      edges: [edge('a.md', 'b.md'), edge('a.md', 'c.md')],
    }
    const layout = new ForceLayout(data, OPTIONS)
    layout.pin('a.md', 300, -150)

    layout.tick(200)
    const pinnedNode = byId(data, 'a.md')
    expect(pinnedNode.x).toBe(300)
    expect(pinnedNode.y).toBe(-150)
    expect(pinnedNode.vx).toBe(0)
    expect(pinnedNode.vy).toBe(0)
    expect(byId(data, 'b.md').x).not.toBe(10)
  })

  it('still repels and still pulls its neighbours toward it', () => {
    const data: GraphData = {
      nodes: [node('a.md', 0, 0), node('b.md', 0, 400)],
      edges: [edge('a.md', 'b.md')],
    }
    // Centering off, so the only things acting on b are the spring to the
    // pinned node and the repulsion from it.
    const layout = new ForceLayout(data, { ...OPTIONS, centerStrength: 0 })
    layout.pin('a.md', 600, 0)
    layout.tick(400)

    // b is dragged across to the pinned node and parks about one link away.
    const gap = distance(byId(data, 'a.md'), byId(data, 'b.md'))
    expect(gap).toBeGreaterThan(55)
    expect(gap).toBeLessThan(100)
    expect(byId(data, 'b.md').x).toBeGreaterThan(400)
  })

  it('releases on unpin and lets the node move again', () => {
    const data: GraphData = { nodes: [node('a.md', 0, 0), node('b.md', 4, 0)], edges: [] }
    const layout = new ForceLayout(data, OPTIONS)
    layout.pin('a.md', 0, 0)
    layout.tick(100)
    expect(byId(data, 'a.md').x).toBe(0)

    layout.unpin('a.md')
    layout.reheat()
    layout.tick(100)
    expect(byId(data, 'a.md').x).not.toBe(0)
  })

  it('ignores unpinning something that was never pinned, and non-finite pins', () => {
    const data: GraphData = { nodes: [node('a.md', 7, 7)], edges: [] }
    const layout = new ForceLayout(data, OPTIONS)
    expect(() => layout.unpin('nope.md')).not.toThrow()

    layout.pin('a.md', Number.NaN, 3)
    layout.tick(5)
    expect(allFinite(data)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Hit testing
 * ------------------------------------------------------------------ */

describe('ForceLayout — nodeAt', () => {
  const data: GraphData = {
    nodes: [
      node('a.md', 0, 0, { radius: 10, degree: 2 }),
      node('far.md', 500, 500, { radius: 5, degree: 1 }),
    ],
    edges: [],
  }
  const layout = new ForceLayout(data, OPTIONS)

  it('hits inside the circle and misses outside it', () => {
    expect(layout.nodeAt(0, 0)?.id).toBe('a.md')
    expect(layout.nodeAt(9, 0)?.id).toBe('a.md')
    expect(layout.nodeAt(1000, 1000)).toBeNull()
  })

  it('applies the tolerance ring around the radius', () => {
    // radius 10, default tolerance 4 => hits up to 14, misses at 15.
    expect(layout.nodeAt(13.9, 0)?.id).toBe('a.md')
    expect(layout.nodeAt(15, 0)).toBeNull()
    expect(layout.nodeAt(15, 0, 6)?.id).toBe('a.md')
    expect(layout.nodeAt(11, 0, 0)).toBeNull()
    expect(layout.nodeAt(10, 0, 0)?.id).toBe('a.md')
  })

  it('prefers the higher-degree node when circles overlap', () => {
    const overlapping: GraphData = {
      nodes: [
        node('small.md', 0, 0, { radius: 8, degree: 1 }),
        node('hub.md', 4, 0, { radius: 20, degree: 12 }),
        node('other.md', 2, 0, { radius: 8, degree: 1 }),
      ],
      edges: [],
    }
    const hit = new ForceLayout(overlapping, OPTIONS).nodeAt(1, 0)
    expect(hit?.id).toBe('hub.md')
  })

  it('prefers the topmost node when overlapping nodes share a degree', () => {
    const overlapping: GraphData = {
      nodes: [node('under.md', 0, 0, { radius: 10, degree: 3 }), node('over.md', 2, 0, { radius: 10, degree: 3 })],
      edges: [],
    }
    expect(new ForceLayout(overlapping, OPTIONS).nodeAt(1, 0)?.id).toBe('over.md')
  })

  it('returns null for an empty graph and for non-finite probes', () => {
    const empty = new ForceLayout({ nodes: [], edges: [] }, OPTIONS)
    expect(empty.nodeAt(0, 0)).toBeNull()
    expect(layout.nodeAt(Number.NaN, 0)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

describe('ForceLayout — bounds', () => {
  it('returns a small finite box around the origin for an empty graph', () => {
    const box = new ForceLayout({ nodes: [], edges: [] }, OPTIONS).bounds()
    expect(box).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 })
    expect(Number.isFinite(box.minX)).toBe(true)
    expect(box.maxX).toBeGreaterThan(box.minX)
    expect(box.maxY).toBeGreaterThan(box.minY)
  })

  it('covers every node circle', () => {
    const data: GraphData = {
      nodes: [node('a.md', -100, -20, { radius: 10 }), node('b.md', 40, 60, { radius: 5 })],
      edges: [],
    }
    const box = new ForceLayout(data, OPTIONS).bounds()
    expect(box).toEqual({ minX: -110, minY: -30, maxX: 45, maxY: 65 })
  })

  it('tracks the nodes as they move', () => {
    const data: GraphData = { nodes: [node('a.md', -2, 0), node('b.md', 2, 0)], edges: [] }
    const layout = new ForceLayout(data, OPTIONS)
    const before = layout.bounds()
    layout.tick(200)
    const after = layout.bounds()
    expect(after.maxX - after.minX).toBeGreaterThan(before.maxX - before.minX)
  })
})

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('ForceLayout — determinism', () => {
  it('produces identical positions for two identical runs', () => {
    const runA = spiralGraph(40, 60)
    const runB = spiralGraph(40, 60)
    new ForceLayout(runA, OPTIONS).tick(250)
    new ForceLayout(runB, OPTIONS).tick(250)

    expect(runA.nodes.map((n) => [n.x, n.y, n.vx, n.vy])).toEqual(runB.nodes.map((n) => [n.x, n.y, n.vx, n.vy]))
  })

  it('does not care how the ticks are batched', () => {
    const single = spiralGraph(20, 25)
    const batched = spiralGraph(20, 25)
    new ForceLayout(single, OPTIONS).tick(120)
    const layout = new ForceLayout(batched, OPTIONS)
    for (let i = 0; i < 120; i += 1) layout.tick()

    expect(single.nodes.map((n) => [n.x, n.y])).toEqual(batched.nodes.map((n) => [n.x, n.y]))
  })

  it('is deterministic on the grid path too', () => {
    const runA = spiralGraph(450, 500)
    const runB = spiralGraph(450, 500)
    new ForceLayout(runA, OPTIONS).tick(20)
    new ForceLayout(runB, OPTIONS).tick(20)

    expect(runA.nodes.map((n) => [n.x, n.y])).toEqual(runB.nodes.map((n) => [n.x, n.y]))
  })
})

/* ------------------------------------------------------------------ *
 * Large graphs
 * ------------------------------------------------------------------ */

describe('ForceLayout — large graphs', () => {
  it('ticks a 600-node graph without blowing up', () => {
    const data = spiralGraph(600, 900)
    const layout = new ForceLayout(data, OPTIONS)

    const started = Date.now()
    layout.tick(30)
    const elapsed = Date.now() - started

    expect(allFinite(data)).toBe(true)
    const box = layout.bounds()
    expect(Number.isFinite(box.minX)).toBe(true)
    expect(Number.isFinite(box.maxX)).toBe(true)
    // Generous, but an accidental blow-up in cost would sail past it.
    expect(elapsed).toBeLessThan(5000)
  })

  it('skips pairs beyond the interaction cutoff once the grid kicks in', () => {
    // 500 clustered nodes (grid path) plus one node parked far outside the
    // 6 * linkDistance cutoff. The cluster sits off-axis, so any repulsion
    // leaking through would move the outlier off y = 0.
    const cluster = spiralGraph(500, 600)
    for (const n of cluster.nodes) n.y += 200
    cluster.nodes.push(node('far.md', 100_000, 0, { degree: 0 }))

    const layout = new ForceLayout(cluster, { ...OPTIONS, centerStrength: 0 })
    layout.tick(20)

    const far = byId(cluster, 'far.md')
    expect(far.y).toBe(0)
    expect(far.x).toBe(100_000)
    // …while the cluster itself is very much being pushed around.
    expect(cluster.nodes[0]!.y).not.toBe(200)
  })
})
