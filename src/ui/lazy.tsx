/**
 * The two views heavy enough to be worth fetching separately.
 *
 * The editor is CodeMirror, and the graph is its own canvas renderer and
 * force layout; together they are most of what the app weighs, and neither is
 * needed to show the vault, read a note, or pick a vault in the first place.
 * Splitting them out is what lets the first screen arrive without them.
 *
 * They are prefetched as soon as the browser is idle, so in practice the chunk
 * is already there by the time anyone opens a note to edit it — the fallbacks
 * below are for a slow connection, not for the ordinary case.
 */
import type { JSX } from 'react'
import { Suspense, lazy, useEffect } from 'react'

import type { NotePath } from '../types'
import type { GraphViewProps } from './GraphView'

const EditorImpl = lazy(async () => ({ default: (await import('./Editor')).Editor }))
const GraphViewImpl = lazy(async () => ({ default: (await import('./GraphView')).GraphView }))

/** Shown only while a chunk is in flight. Deliberately quiet: a spinner that
 *  appears for 20 ms is worse than nothing at all. */
function ViewLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="view-loading" role="status" aria-live="polite">
      <span>Loading the {label}…</span>
    </div>
  )
}

export function Editor(props: { path: NotePath; paneId: string }): JSX.Element {
  return (
    <Suspense fallback={<ViewLoading label="editor" />}>
      <EditorImpl {...props} />
    </Suspense>
  )
}

export function GraphView(props: GraphViewProps): JSX.Element {
  return (
    <Suspense fallback={<ViewLoading label="graph" />}>
      <GraphViewImpl {...props} />
    </Suspense>
  )
}

/**
 * Fetch both chunks once the browser has nothing better to do.
 *
 * Mounted once, at the top of the app. Failures are swallowed on purpose: this
 * is an optimisation, and if it does not happen the `Suspense` boundaries above
 * fetch the chunk when it is actually needed.
 */
export function usePrefetchHeavyViews(): void {
  useEffect(() => {
    let cancelled = false
    const prefetch = (): void => {
      if (cancelled) return
      void import('./Editor').catch(() => {})
      void import('./GraphView').catch(() => {})
    }

    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(prefetch, { timeout: 3000 })
      return () => {
        cancelled = true
        cancelIdleCallback(handle)
      }
    }
    // Safari has no `requestIdleCallback`; a timeout is close enough for work
    // that is only ever a head start.
    const timer = setTimeout(prefetch, 1200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])
}
