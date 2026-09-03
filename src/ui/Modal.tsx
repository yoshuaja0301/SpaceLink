/**
 * SpaceLink — the shared modal shell.
 *
 * Deliberately portal-free: the app shell renders modals last, and
 * `.modal-backdrop` is `position: fixed` with a z-index above every pane, so a
 * portal would buy nothing and would break the React tree that tests query.
 *
 * What it does provide is the dialog behaviour everyone would otherwise
 * reimplement: a focus trap, Escape / backdrop dismissal, focus restoration,
 * `role="dialog"` wiring and a body scroll lock.
 */
import { useCallback, useEffect, useId, useRef } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import { Icon } from './Icon'

export interface ModalProps {
  open: boolean
  /** Shown in the header and used as the dialog's accessible name. */
  title: string
  onClose: () => void
  children: ReactNode
  /** Optional action bar pinned under the scrolling body. */
  footer?: ReactNode
  /** Override the default width, in px. */
  width?: number
}

/**
 * Everything the browser would put in the tab order. `[tabindex="-1"]` is
 * excluded on purpose — such elements are focusable by script (the dialog
 * itself is one) but must not be a Tab stop.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Tab stops inside `root`, in document order, skipping anything hidden. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    // `offsetParent` is null for `display: none` subtrees; jsdom reports 0 for
    // every box, so the `hidden` attribute check is what actually bites there.
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  )
}

export function Modal({ open, title, onClose, children, footer, width }: ModalProps): JSX.Element | null {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  /** Whatever had focus when the modal opened, so it can be handed back. */
  const restoreRef = useRef<HTMLElement | null>(null)
  /**
   * Whether the pointer went *down* on the backdrop. A click whose mousedown
   * started inside the dialog (selecting text and releasing outside) must not
   * dismiss it. `null` means "no mousedown seen", which is how synthetic
   * clicks arrive — those still close.
   */
  const pressedBackdropRef = useRef<boolean | null>(null)

  // Open lifecycle: remember focus, move it inside, lock scrolling, and undo
  // all three on close. Keyed on `open` so re-renders do not re-run it.
  useEffect(() => {
    if (!open) return undefined

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreRef.current = previouslyFocused

    // The dialog container carries `tabIndex={-1}`, so focusing it parks the
    // caret at the top of the dialog rather than on an arbitrary control.
    dialogRef.current?.focus()

    const body = document.body
    const previousOverflow = body.style.overflow
    body.style.overflow = 'hidden'

    return () => {
      body.style.overflow = previousOverflow
      const target = restoreRef.current
      restoreRef.current = null
      // Only restore if the element is still around — it may have been removed
      // by whatever the modal did.
      if (target && target.isConnected) target.focus()
    }
  }, [open])

  // Escape closes; Tab cycles. Captured on the document so the trap holds even
  // when focus has escaped the dialog, and so global hotkeys do not also see
  // the Escape that dismissed us.
  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const stops = focusableWithin(dialog)
      if (stops.length === 0) {
        // Nothing to move to: keep focus on the dialog itself.
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = stops[0]!
      const last = stops[stops.length - 1]!
      const active = document.activeElement
      // -1 covers both "focus escaped the dialog" and "focus is parked on the
      // dialog container itself", which is where it starts out.
      const index = active instanceof HTMLElement ? stops.indexOf(active) : -1

      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (index === -1 || index === stops.length - 1) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  const onBackdropMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    pressedBackdropRef.current = event.target === event.currentTarget
  }, [])

  const onBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const startedOnBackdrop = pressedBackdropRef.current
      pressedBackdropRef.current = null
      if (event.target !== event.currentTarget) return
      if (startedOnBackdrop === false) return
      onClose()
    },
    [onClose],
  )

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={onBackdropMouseDown} onClick={onBackdropClick}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        // Geometry only — every colour still comes from the stylesheet.
        style={width === undefined ? undefined : { width: `min(${width}px, 100%)` }}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-ghost" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="modal-body">{children}</div>

        {footer !== undefined && footer !== null && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export default Modal
