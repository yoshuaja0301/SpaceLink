/**
 * SpaceLink — transient notifications.
 *
 * The store owns the list and drops each toast four seconds after it was
 * pushed. This component only decides what a toast *looks* like and gives a
 * removed toast a moment to animate out before it disappears: when an id
 * vanishes from the store it is kept on screen, marked `is-leaving`, for the
 * length of the exit animation.
 *
 * Newest toasts stack at the bottom (the store appends, and `.toast-stack` is
 * a column), and at most four are shown at once so a burst of errors cannot
 * cover the workspace.
 */
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

import type { Toast } from '../types'
import { useAppStore } from '../state/store'
import { Icon } from './Icon'
import type { IconName } from './Icon'

/** How many toasts are on screen at once; older ones wait their turn. */
const MAX_VISIBLE = 4

/** Must match the exit animation below, so the node is removed once it is gone. */
const EXIT_MS = 160

/**
 * The exit animation replays `toast-in` (defined in `src/styles/app.css`)
 * backwards. It lives here rather than in the stylesheet because this component
 * owns the leaving state; `prefers-reduced-motion` still neutralises it through
 * the global rule in that stylesheet.
 */
const EXIT_ANIMATION = { animation: `toast-in ${EXIT_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1) reverse both` } as const

/**
 * The shared icon set has no dedicated warning glyph, so an error borrows the
 * cross — it is tinted `--text-error` by `.toast.is-error`, which is what
 * actually distinguishes it from the dismiss button on the far right.
 */
const ICONS: Record<Toast['kind'], IconName> = {
  info: 'more',
  success: 'check',
  error: 'close',
}

const CLASSES: Record<Toast['kind'], string> = {
  info: 'toast is-info',
  success: 'toast is-success',
  error: 'toast is-error',
}

export function Toasts(): JSX.Element {
  const toasts = useAppStore((s) => s.toasts)
  const dismissToast = useAppStore((s) => s.dismissToast)

  /** Toasts that left the store but are still animating away. */
  const [leaving, setLeaving] = useState<Toast[]>([])
  /** The exact list rendered last time, so removals can be diffed out of it. */
  const shownRef = useRef<Toast[]>([])
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const visible = toasts.length > MAX_VISIBLE ? toasts.slice(-MAX_VISIBLE) : toasts

  // Only the unmount path cancels the exit timers. Tying them to the diffing
  // effect below would strand a leaving toast the moment another one arrived.
  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    },
    [],
  )

  useEffect(() => {
    const live = new Set(visible.map((toast) => toast.id))
    const removed = shownRef.current.filter((toast) => !live.has(toast.id))
    shownRef.current = visible
    if (removed.length === 0) return

    const removedIds = new Set(removed.map((toast) => toast.id))
    setLeaving((current) => [...current, ...removed])
    const timer = setTimeout(() => {
      timersRef.current = timersRef.current.filter((pending) => pending !== timer)
      setLeaving((current) => current.filter((toast) => !removedIds.has(toast.id)))
    }, EXIT_MS)
    timersRef.current.push(timer)
    // `visible` is derived from `toasts` in the same render, so keying on the
    // store list is exactly right — and keeps the diff from re-running (and
    // re-animating) when something unrelated re-renders the component.
  }, [toasts, visible])

  // Ids only ever leave the store, so a leaving toast can never be live again.
  const rendered: { toast: Toast; leaving: boolean }[] = [
    ...leaving.map((toast) => ({ toast, leaving: true })),
    ...visible.map((toast) => ({ toast, leaving: false })),
  ]

  return (
    <div className="toast-stack" aria-label="Notifications">
      {rendered.map(({ toast, leaving: isLeaving }) => (
        <div
          key={toast.id}
          className={isLeaving ? `${CLASSES[toast.kind]} is-leaving` : CLASSES[toast.kind]}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
          data-kind={toast.kind}
          style={isLeaving ? EXIT_ANIMATION : undefined}
        >
          <Icon name={ICONS[toast.kind]} size={14} />
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="btn-ghost"
            aria-label="Dismiss notification"
            disabled={isLeaving}
            onClick={() => dismissToast(toast.id)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

export default Toasts
