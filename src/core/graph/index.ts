/**
 * SpaceFore — link index and graph model.
 *
 * This module owns everything derived from *links between* notes: the vault
 * index (`buildIndex`), Obsidian-style link resolution (`resolveLinkTarget`),
 * the backlink / unresolved / orphan / tag views built on top of it, and the
 * node-link model the graph view renders (`buildGraphData`).
 *
 * ## Cost
 *
 * `buildIndex` is two linear passes and never scans the vault per link:
 *
 *   1. every note registers its names — basename, full path, path without the
 *      `.md` extension and every frontmatter alias — into `byName`, and its
 *      tags into `tags`;
 *   2. every link is resolved through that map, which is O(1) plus a scan of
 *      the (tiny) candidate list holding the homonyms of one name.
 *
 * So the whole build is O(notes + links), never O(notes x links).
 *
 * ## Determinism
 *
 * Nothing here calls `Math.random()`. Homonyms are broken with a total order
 * (same folder, then shortest path, then lexicographic), graph nodes are
 * emitted in sorted order and laid out on a golden-angle spiral, so building
 * the same vault twice produces identical output. Tests depend on this.
 */
import type {
  BacklinkGroup,
  GraphData,
  GraphEdge,
  GraphNode,
  LinkEdge,
  Note,
  NotePath,
  VaultIndex,
} from '../../types'

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Backlink context is clipped so one runaway source line cannot blow up the UI. */
const MAX_CONTEXT = 220
/** Golden angle in radians: consecutive spiral points never line up. */
const GOLDEN_ANGLE = 2.399963
/** Radial spacing of the initial spiral, in canvas units. */
const SPIRAL_SPACING = 12
/** Separator for edge keys — a character that never occurs in a vault path. */
const EDGE_KEY_SEP = '\n'

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

export interface TagTreeNode {
  /** Leaf segment, e.g. `alpha` for `project/alpha`. */
  name: string
  /** Full tag, e.g. `project/alpha`. */
  fullTag: string
  /** Notes carrying this exact tag. */
  count: number
  /** Distinct notes carrying this tag or any descendant of it. */
  totalCount: number
  children: TagTreeNode[]
}

export interface GraphOptions {
  showUnresolved: boolean
  showTags: boolean
  /** Restrict to a note and everything within N hops; null = whole vault. */
  focus?: { path: NotePath; depth: number } | null
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Basename without the `.md` extension. Mirrors `basename()` in the store. */
function basenameOf(path: NotePath): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.toLowerCase().endsWith('.md') ? file.slice(0, -3) : file
}

/** Folder containing `path`; `''` for vault-root files. */
function dirnameOf(path: NotePath): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Append to a `Map<K, V[]>`, creating the bucket on first use. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

/**
 * A link target as written, reduced to the part that names a note: a
 * `|display` suffix and `#heading` / `^block` fragments removed, `\` folded to
 * `/`, leading `./` and `/` dropped. Case is preserved.
 */
function cleanTarget(target: string): string {
  if (!target) return ''
  let text = target.trim()
  const pipe = text.indexOf('|')
  if (pipe !== -1) text = text.slice(0, pipe)
  const fragment = text.search(/[#^]/)
  if (fragment !== -1) text = text.slice(0, fragment)
  return text.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim()
}

/** `cleanTarget`, lowercased — the exact key shape stored in `byName`. */
function normalizeTarget(target: string): string {
  return cleanTarget(target).toLowerCase()
}

/**
 * True when an embed names a file rather than a note: any target carrying an
 * extension that is not `.md`. `![[diagram.png]]` and `![[photos/trip.jpg|400]]`
 * are attachments the renderer resolves through `resolveAsset`;
 * `![[Concepts/Atomic Notes]]` is a note.
 */
function isAttachmentTarget(target: string): boolean {
  const clean = cleanTarget(target)
  const dot = clean.lastIndexOf('.')
  if (dot <= clean.lastIndexOf('/') + 1) return false
  return clean.slice(dot + 1).toLowerCase() !== 'md'
}

/**
 * Keys to try for one link, most specific first: the target itself, the target
 * without `.md`, and — when the target is a path — its last segment, so
 * `[[folder/Note]]` still finds a `Note` that lives somewhere else.
 */
function lookupKeys(key: string): string[] {
  const keys = [key]
  const addKey = (candidate: string): void => {
    if (candidate && !keys.includes(candidate)) keys.push(candidate)
  }
  if (key.endsWith('.md')) addKey(key.slice(0, -3))
  const slash = key.lastIndexOf('/')
  if (slash !== -1) {
    const last = key.slice(slash + 1)
    addKey(last)
    if (last.endsWith('.md')) addKey(last.slice(0, -3))
  }
  return keys
}

/** A candidate that only got into the bucket through a frontmatter alias. */
const ALIAS_TIER = 3

/**
 * How directly a candidate answers to one lookup key, judged from its own
 * shape: the whole path, the path plus `.md`, the basename, or — anything else
 * is in the bucket because of an alias — a frontmatter alias.
 */
function tierOf(candidate: NotePath, key: string): number {
  const lower = candidate.toLowerCase()
  if (lower === key) return 0
  if (lower === `${key}.md`) return 1
  if (basenameOf(candidate).toLowerCase() === key) return 2
  return ALIAS_TIER
}

/**
 * Total order over the homonyms of one lookup key. An alias never outranks a
 * note carrying the key as a name of its own. Among the rest, a bare `[[Note]]`
 * means the note next door before it means the one at the vault root, so the
 * same-folder test leads and the tier follows; a written path
 * (`[[folder/Note]]`) is matched exactly first, so there the tier leads. Then
 * the shortest path, then lexicographic order — that last clause is what keeps
 * resolution independent of vault iteration order.
 */
function compareCandidates(a: NotePath, b: NotePath, dir: string, key: string, bare: boolean): number {
  const aTier = tierOf(a, key)
  const bTier = tierOf(b, key)
  const aAlias = aTier === ALIAS_TIER ? 1 : 0
  const bAlias = bTier === ALIAS_TIER ? 1 : 0
  if (aAlias !== bAlias) return aAlias - bAlias
  const aLocal = dirnameOf(a) === dir ? 0 : 1
  const bLocal = dirnameOf(b) === dir ? 0 : 1
  if (bare && aLocal !== bLocal) return aLocal - bLocal
  if (aTier !== bTier) return aTier - bTier
  if (aLocal !== bLocal) return aLocal - bLocal
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** Best candidate for `key` under `compareCandidates`, or null when there is none. */
function pickCandidate(candidates: NotePath[], fromPath: NotePath, key: string): NotePath | null {
  if (candidates.length === 0) return null
  const dir = dirnameOf(fromPath)
  // A key without a slash was written as a bare name, not as a path.
  const bare = !key.includes('/')
  let best = candidates[0]!
  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i]!
    if (compareCandidates(candidate, best, dir, key, bare) < 0) best = candidate
  }
  return best
}

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

export function emptyIndex(): VaultIndex {
  return {
    outgoing: new Map(),
    incoming: new Map(),
    unresolved: new Map(),
    tags: new Map(),
    byName: new Map(),
  }
}

/**
 * Build the whole-vault link index.
 *
 * Every entry of `notes` is treated as a markdown note (that is the contract of
 * the map); nothing is silently dropped.
 */
export function buildIndex(notes: Map<NotePath, Note>): VaultIndex {
  const index = emptyIndex()
  // `#Project` and `#project` are one tag; the first casing the vault shows is
  // the one the tag panel and the graph display it under.
  const tagCasing = new Map<string, string>()

  /* Pass 1 — names and tags. ---------------------------------------- */
  for (const [path, note] of notes) {
    // One `seen` set per note keeps `byName` free of duplicate entries for the
    // same note (a root-level note would otherwise register `alpha` twice: once
    // as its basename, once as its path minus `.md`) without an O(n) scan of
    // the candidate list on every insert.
    const seen = new Set<string>()
    const addName = (name: unknown): void => {
      if (typeof name !== 'string') return
      const key = name.trim().toLowerCase()
      if (!key || seen.has(key)) return
      seen.add(key)
      push(index.byName, key, path)
    }

    addName(note.name || basenameOf(path))
    addName(path)
    if (path.toLowerCase().endsWith('.md')) addName(path.slice(0, -3))

    const aliases = note.parsed.frontmatter.aliases
    if (Array.isArray(aliases)) for (const alias of aliases) addName(alias)

    const tagged = new Set<string>()
    for (const tag of note.parsed.allTags) {
      if (!tag) continue
      const key = tag.toLowerCase()
      if (tagged.has(key)) continue
      tagged.add(key)
      let display = tagCasing.get(key)
      if (display === undefined) {
        display = tag
        tagCasing.set(key, display)
      }
      push(index.tags, display, path)
    }
  }

  /* Pass 2 — links. -------------------------------------------------- */
  for (const [path, note] of notes) {
    const links = note.parsed.links
    if (links.length === 0) continue
    // Split once per note rather than once per link: context stays linear.
    const lines = note.content.split('\n')

    for (const link of links) {
      const to = resolveLinkTarget(link.target, path, index)
      // An embed of a file the vault has no note for is an attachment, not a
      // missing note: recording it would draw a phantom node in the graph and
      // count against the unresolved links of the note holding the picture.
      if (to === null && link.embed && isAttachmentTarget(link.target)) continue
      const source = lines[link.line - 1] ?? ''
      const edge: LinkEdge = {
        from: path,
        to,
        targetText: link.target,
        embed: link.embed,
        context: source.trim().slice(0, MAX_CONTEXT),
        line: link.line,
      }
      push(index.outgoing, path, edge)
      if (to !== null) push(index.incoming, to, edge)
      else push(index.unresolved, normalizeTarget(link.target), edge)
    }
  }

  return index
}

/**
 * Obsidian-style resolution, all case-insensitive:
 *
 *   1. exact path match (`[[notes/Alpha.md]]`)
 *   2. path + `.md` (`[[notes/Alpha]]`)
 *   3. basename (`[[Alpha]]`)
 *   4. frontmatter alias
 *
 * Fragments (`#heading`, `^block`) and a `|display` suffix are stripped first;
 * a link that is *only* a fragment (`[[#Heading]]`) points inside the note it
 * was written in, so it resolves to `fromPath`.
 *
 * Homonyms are ranked, not bucketed: a candidate is classified by its own shape
 * — a path whose basename equals the lookup key got into that bucket as a
 * basename, anything else got there through an alias — so basenames always beat
 * aliases regardless of the order `byName` happens to hold them in, and for a
 * bare name the note in the same folder as `fromPath` beats a homonym sitting
 * at the vault root (whose path *is* the bare name plus `.md`). A written path
 * still matches exactly first.
 */
export function resolveLinkTarget(target: string, fromPath: NotePath, index: VaultIndex): NotePath | null {
  const key = normalizeTarget(target)
  if (!key) return fromPath

  for (const candidateKey of lookupKeys(key)) {
    const candidates = index.byName.get(candidateKey)
    if (!candidates || candidates.length === 0) continue
    const resolved = pickCandidate(candidates, fromPath, candidateKey)
    if (resolved !== null) return resolved
  }

  return null
}

/* ------------------------------------------------------------------ *
 * Views over the index
 * ------------------------------------------------------------------ */

/**
 * Notes linking *to* `path`, grouped by source note. Self-links are dropped — a
 * note is not its own backlink. Groups are ordered by title (case-insensitive,
 * path as the tiebreak) and the edges inside a group by line.
 */
export function getBacklinks(path: NotePath, index: VaultIndex, notes: Map<NotePath, Note>): BacklinkGroup[] {
  const incoming = index.incoming.get(path)
  if (!incoming || incoming.length === 0) return []

  const groups = new Map<NotePath, BacklinkGroup>()
  for (const edge of incoming) {
    if (edge.from === path) continue
    const group = groups.get(edge.from)
    if (group) {
      group.edges.push(edge)
    } else {
      const note = notes.get(edge.from)
      groups.set(edge.from, {
        source: edge.from,
        title: note?.parsed.title || basenameOf(edge.from),
        edges: [edge],
      })
    }
  }

  const list = [...groups.values()]
  for (const group of list) {
    group.edges.sort((a, b) => a.line - b.line || a.targetText.localeCompare(b.targetText))
  }
  list.sort(
    (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.source.localeCompare(b.source),
  )
  return list
}

/**
 * Every link target that does not exist yet, most-linked first.
 *
 * `target` is the normalised (lowercased, fragment-free) key — exactly the key
 * `index.unresolved` stores the edges under, so callers can look the edges back
 * up with it.
 */
export function getUnresolvedLinks(index: VaultIndex): { target: string; count: number }[] {
  const list: { target: string; count: number }[] = []
  for (const [target, edges] of index.unresolved) list.push({ target, count: edges.length })
  list.sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  return list
}

/**
 * Notes nothing links to and that link nowhere themselves. A self-link does not
 * rescue a note from orphanhood: it connects it to nothing.
 */
export function getOrphans(notes: Map<NotePath, Note>, index: VaultIndex): NotePath[] {
  const orphans: NotePath[] = []
  for (const path of notes.keys()) {
    const incoming = index.incoming.get(path)
    if (incoming && incoming.some((edge) => edge.from !== path)) continue
    const outgoing = index.outgoing.get(path)
    if (outgoing && outgoing.some((edge) => edge.to !== null && edge.to !== path)) continue
    orphans.push(path)
  }
  return orphans.sort((a, b) => a.localeCompare(b))
}

interface TagBuildNode {
  name: string
  fullTag: string
  count: number
  /** Distinct notes in this subtree — a Set, so `#a` + `#a/b` on one note counts once. */
  notes: Set<NotePath>
  children: Map<string, TagBuildNode>
}

function toTagTree(level: Map<string, TagBuildNode>): TagTreeNode[] {
  const list: TagTreeNode[] = []
  for (const node of level.values()) {
    list.push({
      name: node.name,
      fullTag: node.fullTag,
      count: node.count,
      totalCount: node.notes.size,
      children: toTagTree(node.children),
    })
  }
  list.sort(
    (a, b) => b.totalCount - a.totalCount || a.name.localeCompare(b.name) || a.fullTag.localeCompare(b.fullTag),
  )
  return list
}

/**
 * Nest `project/alpha/ui` style tags into a tree. `count` is the notes carrying
 * that exact tag; `totalCount` is the distinct notes in the whole subtree, so a
 * note tagged both `#project` and `#project/alpha` is counted once under
 * `project`.
 */
export function getTagTree(index: VaultIndex): TagTreeNode[] {
  const roots = new Map<string, TagBuildNode>()

  for (const [tag, paths] of index.tags) {
    const segments = tag
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
    if (segments.length === 0) continue

    let level = roots
    let fullTag = ''
    let node: TagBuildNode | undefined
    for (const segment of segments) {
      // Levels are keyed case-insensitively so `#Project/alpha` and
      // `#project/beta` share a parent; the first casing seen is displayed.
      const key = segment.toLowerCase()
      node = level.get(key)
      if (node) {
        fullTag = node.fullTag
      } else {
        fullTag = fullTag ? `${fullTag}/${segment}` : segment
        node = { name: segment, fullTag, count: 0, notes: new Set(), children: new Map() }
        level.set(key, node)
      }
      // Every ancestor carries these notes too — that is what `totalCount` is.
      for (const path of paths) node.notes.add(path)
      level = node.children
    }
    if (node) node.count = new Set(paths).size
  }

  return toTagTree(roots)
}

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

function makeNode(id: string, label: string, unresolved: boolean, tags: string[]): GraphNode {
  // x/y/radius are filled in once the final node set — and therefore each
  // node's degree — is known.
  return { id, label, degree: 0, unresolved, tags, x: 0, y: 0, vx: 0, vy: 0, radius: 0 }
}

/**
 * Build the node-link model the graph view renders.
 *
 * - one node per note, plus (optionally) one per unresolved target
 *   (id `?target`, lowercased) and one per tag (id `#tag`);
 * - parallel links between the same ordered pair collapse into a single edge
 *   whose `count` records how many there were; self-links are dropped;
 * - `degree` is the number of distinct edges touching a node *after* focus
 *   filtering, so the drawn radius matches what is actually on screen;
 * - initial positions are a golden-angle spiral around the origin — no
 *   randomness, so the same vault always lays out the same way.
 */
export function buildGraphData(
  notes: Map<NotePath, Note>,
  index: VaultIndex,
  options: GraphOptions,
): GraphData {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  const addEdge = (source: string, target: string): void => {
    if (source === target) return
    const key = `${source}${EDGE_KEY_SEP}${target}`
    const existing = edges.get(key)
    if (existing) existing.count += 1
    else edges.set(key, { source, target, count: 1 })
  }

  /* Nodes for notes, in a stable order so the spiral is reproducible. */
  const notePaths = [...notes.keys()].sort((a, b) => a.localeCompare(b))
  for (const path of notePaths) {
    const note = notes.get(path)!
    nodes.set(
      path,
      makeNode(path, note.parsed.title || note.name || basenameOf(path), false, [...note.parsed.allTags]),
    )
  }

  /* Link edges, plus placeholder nodes for unresolved targets. */
  for (const path of notePaths) {
    for (const edge of index.outgoing.get(path) ?? []) {
      if (edge.to !== null) {
        if (nodes.has(edge.to)) addEdge(path, edge.to)
        continue
      }
      if (!options.showUnresolved) continue
      const key = normalizeTarget(edge.targetText)
      if (!key) continue
      const id = `?${key}`
      if (!nodes.has(id)) nodes.set(id, makeNode(id, cleanTarget(edge.targetText) || key, true, []))
      addEdge(path, id)
    }
  }

  /* Tag nodes. */
  if (options.showTags) {
    const tags = [...index.tags.keys()].sort((a, b) => a.localeCompare(b))
    for (const tag of tags) {
      const id = `#${tag}`
      const paths = (index.tags.get(tag) ?? []).filter((path) => nodes.has(path))
      if (paths.length === 0) continue
      if (!nodes.has(id)) nodes.set(id, makeNode(id, id, false, [tag]))
      for (const path of paths) addEdge(path, id)
    }
  }

  /* Focus: keep only what is within `depth` hops of `focus.path`. */
  let kept: Set<string> | null = null
  const focus = options.focus
  if (focus) {
    // An unknown focus path keeps nothing — better an empty local graph than a
    // silent fall back to the whole vault.
    kept = new Set<string>()
    if (nodes.has(focus.path)) {
      const adjacency = new Map<string, string[]>()
      for (const edge of edges.values()) {
        push(adjacency, edge.source, edge.target)
        push(adjacency, edge.target, edge.source)
      }
      const depth = Math.max(0, Math.floor(focus.depth))
      kept.add(focus.path)
      let frontier: string[] = [focus.path]
      for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
        const next: string[] = []
        for (const id of frontier) {
          for (const neighbour of adjacency.get(id) ?? []) {
            if (kept.has(neighbour)) continue
            kept.add(neighbour)
            next.push(neighbour)
          }
        }
        frontier = next
      }
    }
  }

  const visible = kept
  const finalEdges = visible
    ? [...edges.values()].filter((edge) => visible.has(edge.source) && visible.has(edge.target))
    : [...edges.values()]
  const finalNodes = visible ? [...nodes.values()].filter((node) => visible.has(node.id)) : [...nodes.values()]

  /* Degree, radius and the deterministic starting layout. */
  const byId = new Map<string, GraphNode>()
  for (const node of finalNodes) byId.set(node.id, node)
  for (const edge of finalEdges) {
    const source = byId.get(edge.source)
    if (source) source.degree += 1
    const target = byId.get(edge.target)
    if (target) target.degree += 1
  }
  for (let i = 0; i < finalNodes.length; i += 1) {
    const node = finalNodes[i]!
    const angle = i * GOLDEN_ANGLE
    const radius = SPIRAL_SPACING * Math.sqrt(i)
    node.x = Math.cos(angle) * radius
    node.y = Math.sin(angle) * radius
    node.vx = 0
    node.vy = 0
    node.radius = 4 + Math.min(10, Math.sqrt(node.degree) * 3)
  }

  return { nodes: finalNodes, edges: finalEdges }
}
