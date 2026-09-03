/**
 * SpaceLink — the tag pane.
 *
 * `getTagTree` already nests `project/alpha` under `project` and sorts every
 * level by how many notes hang off it, so this component only has to decide
 * what is *visible*: the filter prunes the tree, the collapse set hides
 * subtrees, and the result is flattened into a single list of rows.
 *
 * Flat rendering is deliberate. Depth is expressed through the `--depth` CSS
 * variable rather than nested containers, which means the rendered order is
 * also the keyboard order — ArrowUp/ArrowDown can simply step through the list
 * without reconstructing the tree.
 *
 * Clicking a tag hands the query to the search panel (`tag:project`) and brings
 * that panel to the front, which is the whole point of the pane.
 */
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'

import type { TagTreeNode } from '../core/graph/index'
import { getTagTree } from '../core/graph/index'
import { useAppStore } from '../state/store'
import { Icon } from './Icon'

/* ------------------------------------------------------------------ *
 * Tree shaping
 * ------------------------------------------------------------------ */

/** One rendered row: a node plus the indent level it sits at. */
export interface TagRow {
  node: TagTreeNode
  depth: number
}

/**
 * Keep the nodes whose full tag contains `filter`, plus every ancestor needed
 * to reach them. A node that matches keeps its whole subtree, so filtering for
 * `project` still reveals `project/alpha`.
 */
export function filterTagTree(nodes: readonly TagTreeNode[], filter: string): TagTreeNode[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return [...nodes]
  const out: TagTreeNode[] = []
  for (const node of nodes) {
    if (node.fullTag.toLowerCase().includes(needle)) {
      out.push(node)
      continue
    }
    const children = filterTagTree(node.children, needle)
    if (children.length > 0) out.push({ ...node, children })
  }
  return out
}

/** Every distinct tag in the tree, intermediate nodes included. */
export function countTagNodes(nodes: readonly TagTreeNode[]): number {
  let total = 0
  for (const node of nodes) total += 1 + countTagNodes(node.children)
  return total
}

/** Depth-first walk, skipping the children of collapsed nodes. */
export function flattenTagTree(
  nodes: readonly TagTreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): TagRow[] {
  const rows: TagRow[] = []
  for (const node of nodes) {
    rows.push({ node, depth })
    if (node.children.length > 0 && !collapsed.has(node.fullTag)) {
      rows.push(...flattenTagTree(node.children, collapsed, depth + 1))
    }
  }
  return rows
}

/** Every full tag in the tree that has children — used by "collapse all". */
function branchTags(nodes: readonly TagTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children.length === 0) continue
    out.push(node.fullTag)
    branchTags(node.children, out)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function classes(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Indent is CSS-driven: rows only publish their depth. */
function depthStyle(depth: number): CSSProperties {
  return { '--depth': depth } as CSSProperties
}

/** The query a tag row installs when clicked. */
export function tagQuery(fullTag: string): string {
  return `tag:${fullTag}`
}

/** Nothing is collapsed while a filter is active. */
const NOTHING_COLLAPSED: ReadonlySet<string> = new Set<string>()

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function TagPanel(): JSX.Element {
  const index = useAppStore((s) => s.index)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const sidebarPanel = useAppStore((s) => s.sidebarPanel)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const setSidebarPanel = useAppStore((s) => s.setSidebarPanel)

  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  const tree = useMemo(() => getTagTree(index), [index])
  const total = useMemo(() => countTagNodes(tree), [tree])
  const filtered = useMemo(() => filterTagTree(tree, filter), [tree, filter])
  const shown = useMemo(() => countTagNodes(filtered), [filtered])
  // A filter is a request to see what matched, so it overrides the collapse set.
  const effectiveCollapsed = filter.trim() ? NOTHING_COLLAPSED : collapsed
  const rows = useMemo(() => flattenTagTree(filtered, effectiveCollapsed), [filtered, effectiveCollapsed])

  const activeTag = useMemo(() => {
    const match = /^tag:(\S+)$/.exec(searchQuery.trim())
    return match ? match[1]!.toLowerCase() : null
  }, [searchQuery])

  /* -- actions ------------------------------------------------------- */

  const openTag = useCallback(
    (fullTag: string): void => {
      setSearchQuery(tagQuery(fullTag))
      // `setSidebarPanel` toggles when handed the panel that is already open,
      // so only ask for the switch when it is actually a switch.
      if (sidebarPanel !== 'search') setSidebarPanel('search')
    },
    [setSearchQuery, setSidebarPanel, sidebarPanel],
  )

  const setNodeCollapsed = useCallback((fullTag: string, next: boolean): void => {
    setCollapsed((prev) => {
      if (prev.has(fullTag) === next) return prev
      const updated = new Set(prev)
      if (next) updated.add(fullTag)
      else updated.delete(fullTag)
      return updated
    })
  }, [])

  const toggleNode = useCallback(
    (fullTag: string): void => setNodeCollapsed(fullTag, !collapsed.has(fullTag)),
    [collapsed, setNodeCollapsed],
  )

  const collapseAll = useCallback((): void => {
    setCollapsed((prev) => (prev.size > 0 ? new Set<string>() : new Set(branchTags(tree))))
  }, [tree])

  /** Move DOM focus by `step` rows, so the tree behaves like one widget. */
  const focusRow = useCallback(
    (from: number, step: number): void => {
      const target = rows[from + step]
      if (!target) return
      rowRefs.current.get(target.node.fullTag)?.focus?.()
    },
    [rows],
  )

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, row: TagRow, position: number): void => {
      const hasChildren = row.node.children.length > 0
      const isCollapsed = effectiveCollapsed.has(row.node.fullTag)
      switch (event.key) {
        case 'Enter':
        case ' ':
          event.preventDefault()
          openTag(row.node.fullTag)
          break
        case 'ArrowDown':
          event.preventDefault()
          focusRow(position, 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          focusRow(position, -1)
          break
        case 'ArrowRight':
          if (hasChildren && isCollapsed) {
            event.preventDefault()
            setNodeCollapsed(row.node.fullTag, false)
          }
          break
        case 'ArrowLeft':
          if (hasChildren && !isCollapsed) {
            event.preventDefault()
            setNodeCollapsed(row.node.fullTag, true)
          }
          break
        default:
          break
      }
    },
    [effectiveCollapsed, focusRow, openTag, setNodeCollapsed],
  )

  const registerRow = useCallback((fullTag: string) => {
    return (element: HTMLDivElement | null): void => {
      if (element) rowRefs.current.set(fullTag, element)
      else rowRefs.current.delete(fullTag)
    }
  }, [])

  /* -- render -------------------------------------------------------- */

  return (
    <div className="tag-panel">
      <div className="sidebar-header">
        <div className="sidebar-title">Tags</div>
        <span className="tag-count" title={`${total} tag${total === 1 ? '' : 's'} in this vault`}>
          {filter.trim() ? `${shown}/${total}` : total}
        </span>
        <div className="sidebar-actions">
          <button
            type="button"
            aria-label="Collapse all tags"
            title="Collapse all tags"
            disabled={tree.length === 0}
            onClick={collapseAll}
          >
            <Icon name="chevron-down" size={16} />
          </button>
        </div>
      </div>

      <div className="tag-filter search-toolbar">
        <input
          className="search-input"
          type="text"
          value={filter}
          spellCheck={false}
          autoComplete="off"
          placeholder="Filter tags…"
          aria-label="Filter tags"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="sidebar-body">
        {tree.length === 0 ? (
          <div className="empty-state">
            <p>No tags yet.</p>
            <p>
              Write <code>#topic</code> in a note, or add a <code>tags:</code> list to its frontmatter.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <p>No tags match “{filter.trim()}”.</p>
          </div>
        ) : (
          <div className="tag-tree" role="tree" aria-label="Tags">
            {rows.map((row, position) => {
              const { node, depth } = row
              const hasChildren = node.children.length > 0
              const isCollapsed = effectiveCollapsed.has(node.fullTag)
              const isActive = activeTag === node.fullTag.toLowerCase()
              return (
                <div
                  key={node.fullTag}
                  ref={registerRow(node.fullTag)}
                  className={classes('tag-tree-item', isActive && 'is-active')}
                  style={depthStyle(depth)}
                  role="treeitem"
                  tabIndex={0}
                  aria-level={depth + 1}
                  aria-selected={isActive}
                  aria-expanded={hasChildren ? !isCollapsed : undefined}
                  title={`#${node.fullTag} — ${node.totalCount} note${node.totalCount === 1 ? '' : 's'}`}
                  onClick={() => openTag(node.fullTag)}
                  onKeyDown={(event) => onRowKeyDown(event, row, position)}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      className="tag-tree-collapse"
                      aria-label={isCollapsed ? `Expand ${node.fullTag}` : `Collapse ${node.fullTag}`}
                      tabIndex={-1}
                      onClick={(event) => {
                        // The row itself opens the tag; the chevron must not.
                        event.stopPropagation()
                        toggleNode(node.fullTag)
                      }}
                    >
                      <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                    </button>
                  ) : (
                    <Icon name="tag" size={13} className="tag-tree-leaf" />
                  )}
                  <span className="tag-tree-name">{node.name}</span>
                  <span className="tag-count">{node.totalCount}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default TagPanel
