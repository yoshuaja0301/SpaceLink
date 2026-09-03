/**
 * SpaceLink — right-click menu state.
 *
 * The hook owns nothing but "is a menu open, where, and with which items".
 * Rendering, viewport flipping and keyboard handling live in `ContextMenu`, so
 * a component can wire up a menu with two lines:
 *
 * ```tsx
 * const { menu, open, close } = useContextMenu()
 * <div onContextMenu={(event) => open(event, items)} />
 * <ContextMenu menu={menu} onClose={close} />
 * ```
 */
import { useCallback, useState } from 'react'

import type { IconName } from './Icon'

/**
 * One row of a context menu.
 *
 * `separator: true` draws a divider instead of a row; such entries still need
 * an `id` (React keys) but carry no label or action — which is why `onSelect`
 * is optional here even though every real item supplies one.
 */
export interface ContextMenuItem {
  id: string
  label: string
  icon?: IconName
  /** Renders the row in the error colour — use for destructive actions. */
  danger?: boolean
  /** Greyed out and inert, but still announced. */
  disabled?: boolean
  /** Draw a divider rather than a row. */
  separator?: boolean
  onSelect?: () => void
}

/** Where the menu sits (viewport coordinates) and what it contains. */
export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

/**
 * The bits of a pointer event `open` actually needs. Written structurally so
 * both a React `MouseEvent` and a native one can be passed straight through.
 */
export interface ContextMenuOrigin {
  clientX: number
  clientY: number
  preventDefault?: () => void
  stopPropagation?: () => void
}

export interface ContextMenuController {
  menu: ContextMenuState | null
  /** Suppress the browser menu and open ours at the pointer. */
  open: (event: ContextMenuOrigin, items: ContextMenuItem[]) => void
  close: () => void
}

export function useContextMenu(): ContextMenuController {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  const open = useCallback((event: ContextMenuOrigin, items: ContextMenuItem[]): void => {
    // The native menu would cover ours, and the event must not reach an outer
    // right-click handler (a folder row sits inside the tree's own zone).
    event.preventDefault?.()
    event.stopPropagation?.()
    // An empty menu would render an invisible, un-dismissable box.
    if (items.length === 0) {
      setMenu(null)
      return
    }
    setMenu({ x: event.clientX, y: event.clientY, items })
  }, [])

  const close = useCallback((): void => setMenu(null), [])

  return { menu, open, close }
}
