/**
 * SpaceLink — the shared right-click menu.
 *
 * Pure presentation on top of `useContextMenu`: it positions itself at the
 * pointer, flips when it would spill out of the viewport, and closes on the
 * three gestures people expect (Escape, a click elsewhere, a scroll). Keyboard
 * navigation uses `aria-activedescendant` rather than moving DOM focus, so the
 * menu container keeps focus and a single `keydown` listener can drive it.
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import type { ContextMenuItem, ContextMenuState } from './useContextMenu'
import { Icon } from './Icon'

export type { ContextMenuItem, ContextMenuState } from './useContextMenu'

/** Keeps the menu off the very edge of the window when it has to be moved. */
const EDGE_MARGIN = 8
/** Used only when layout is unavailable (jsdom reports a zero-sized rect). */
const FALLBACK_WIDTH = 200
const FALLBACK_ITEM_HEIGHT = 30

export interface ContextMenuProps {
  menu: ContextMenuState | null
  onClose: () => void
  /** Accessible name; override when a page shows more than one kind of menu. */
  label?: string
}

function isSelectable(item: ContextMenuItem | undefined): boolean {
  return item !== undefined && item.separator !== true && item.disabled !== true
}

/**
 * The next selectable index `step` rows away, wrapping around the ends and
 * skipping separators and disabled rows. `-1` when nothing can be selected.
 */
function stepIndex(items: ContextMenuItem[], from: number, step: number): number {
  const count = items.length
  if (count === 0) return -1
  // Starting "outside" the list: walking down begins at 0, walking up at the end.
  const origin = from === -1 ? (step > 0 ? -1 : 0) : from
  for (let i = 1; i <= count; i += 1) {
    const index = (((origin + step * i) % count) + count) % count
    if (isSelectable(items[index])) return index
  }
  return -1
}

export function ContextMenu({ menu, onClose, label = 'Context menu' }: ContextMenuProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null)
  /** Element that had focus when the menu opened, restored on Escape. */
  const openerRef = useRef<HTMLElement | null>(null)
  const [selected, setSelected] = useState(-1)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)
  const baseId = useId()

  const items = menu?.items ?? []

  const activate = useCallback(
    (item: ContextMenuItem): void => {
      if (item.separator === true || item.disabled === true) return
      // Close first: an action may move focus (inline rename, for instance) and
      // must not have it stolen back by the menu unmounting afterwards.
      onClose()
      item.onSelect?.()
    },
    [onClose],
  )

  // Reset, position and focus — all in one layout effect so that nothing can
  // undo the placement between the measurement and the paint.
  useLayoutEffect(() => {
    setSelected(-1)
    if (!menu) {
      setPlacement(null)
      openerRef.current = null
      return
    }
    const element = ref.current
    if (!element) return

    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && active !== element ? active : null

    const rect = element.getBoundingClientRect()
    const width = rect.width || element.offsetWidth || FALLBACK_WIDTH
    const height = rect.height || element.offsetHeight || menu.items.length * FALLBACK_ITEM_HEIGHT
    const viewportWidth = window.innerWidth || width + menu.x
    const viewportHeight = window.innerHeight || height + menu.y

    // Flip to the other side of the pointer first; only clamp if that still
    // does not fit (a menu taller than the viewport, say).
    let left = menu.x
    if (left + width + EDGE_MARGIN > viewportWidth) left = menu.x - width
    if (left + width + EDGE_MARGIN > viewportWidth) left = viewportWidth - width - EDGE_MARGIN
    let top = menu.y
    if (top + height + EDGE_MARGIN > viewportHeight) top = menu.y - height
    if (top + height + EDGE_MARGIN > viewportHeight) top = viewportHeight - height - EDGE_MARGIN

    setPlacement({ left: Math.max(EDGE_MARGIN, left), top: Math.max(EDGE_MARGIN, top) })

    if (typeof element.focus === 'function') element.focus()
  }, [menu])

  // Escape / arrows / Enter. Bound on the document in the capture phase so the
  // menu wins over whatever had focus before it opened.
  useEffect(() => {
    if (!menu) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape': {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          openerRef.current?.focus?.()
          break
        }
        case 'ArrowDown':
          event.preventDefault()
          setSelected((current) => stepIndex(items, current, 1))
          break
        case 'ArrowUp':
          event.preventDefault()
          setSelected((current) => stepIndex(items, current, -1))
          break
        case 'Home':
          event.preventDefault()
          setSelected(stepIndex(items, -1, 1))
          break
        case 'End':
          event.preventDefault()
          setSelected(stepIndex(items, -1, -1))
          break
        case 'Enter':
        case ' ': {
          const item = items[selected]
          if (!item) break
          event.preventDefault()
          event.stopPropagation()
          activate(item)
          break
        }
        case 'Tab':
          // Tabbing out of a context menu dismisses it everywhere else, too.
          onClose()
          break
        default:
          break
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [menu, items, selected, activate, onClose])

  // Dismiss on anything that invalidates the anchor point.
  useEffect(() => {
    if (!menu) return undefined
    const onPointerDown = (event: Event): void => {
      const element = ref.current
      if (element && event.target instanceof Node && element.contains(event.target)) return
      onClose()
    }
    const onLeave = (): void => onClose()
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('contextmenu', onPointerDown, true)
    // Capture phase: scrolling happens on inner containers, not just the window.
    window.addEventListener('scroll', onLeave, true)
    window.addEventListener('resize', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('contextmenu', onPointerDown, true)
      window.removeEventListener('scroll', onLeave, true)
      window.removeEventListener('resize', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [menu, onClose])

  if (!menu) return null

  const activeId = selected >= 0 && items[selected] ? `${baseId}-${items[selected]!.id}` : undefined

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      aria-activedescendant={activeId}
      tabIndex={-1}
      // Computed geometry: the menu tracks the pointer, so it cannot live in
      // the stylesheet. `.context-menu` supplies `position: fixed`.
      style={{ left: placement?.left ?? menu.x, top: placement?.top ?? menu.y }}
    >
      {items.map((item, index) =>
        item.separator === true ? (
          <div key={item.id} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            id={`${baseId}-${item.id}`}
            type="button"
            role="menuitem"
            className={[
              'context-menu-item',
              item.danger === true ? 'is-danger' : '',
              index === selected ? 'is-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={item.disabled === true}
            aria-disabled={item.disabled === true}
            tabIndex={-1}
            onMouseEnter={() => setSelected(index)}
            onClick={() => activate(item)}
          >
            {item.icon ? <Icon name={item.icon} size={15} /> : null}
            <span className="context-menu-label">{item.label}</span>
          </button>
        ),
      )}
    </div>
  )
}

export default ContextMenu
