import { afterEach, beforeEach, vi } from 'vitest'

import type { Tab } from '../types'
import {
  back,
  canBack,
  canForward,
  canReopen,
  current,
  forward,
  getVersion,
  popClosed,
  push,
  pushClosed,
  reset,
  snapshot,
  subscribe,
} from './paneHistory'

const PANE = 'pane-1'
const OTHER = 'pane-2'

function tab(id: string, path: string | null): Tab {
  return { id, kind: 'note', path, mode: 'edit', pinned: false }
}

beforeEach(() => {
  reset()
})

afterEach(() => {
  reset()
  vi.restoreAllMocks()
})

describe('paneHistory — back / forward', () => {
  it('starts empty: nothing to go back or forward to', () => {
    expect(canBack(PANE)).toBe(false)
    expect(canForward(PANE)).toBe(false)
    expect(back(PANE)).toBeNull()
    expect(forward(PANE)).toBeNull()
    expect(current(PANE)).toBeNull()
  })

  it('a single visit is not enough to enable back', () => {
    push(PANE, 'a.md')

    expect(current(PANE)).toBe('a.md')
    expect(canBack(PANE)).toBe(false)
    expect(canForward(PANE)).toBe(false)
  })

  it('walks backwards and forwards through the visited paths', () => {
    push(PANE, 'a.md')
    push(PANE, 'b.md')
    push(PANE, 'c.md')

    expect(canBack(PANE)).toBe(true)
    expect(canForward(PANE)).toBe(false)

    expect(back(PANE)).toBe('b.md')
    expect(back(PANE)).toBe('a.md')
    expect(back(PANE)).toBeNull() // already at the oldest entry
    expect(canBack(PANE)).toBe(false)
    expect(canForward(PANE)).toBe(true)

    expect(forward(PANE)).toBe('b.md')
    expect(forward(PANE)).toBe('c.md')
    expect(forward(PANE)).toBeNull()
    expect(canForward(PANE)).toBe(false)
  })

  it('ignores a repeat visit to the entry already on screen', () => {
    push(PANE, 'a.md')
    push(PANE, 'a.md')

    expect(snapshot(PANE)).toEqual({ entries: ['a.md'], index: 0 })
    expect(canBack(PANE)).toBe(false)
  })

  it('ignores a repeat visit after stepping back, but not a genuine revisit', () => {
    push(PANE, 'a.md')
    push(PANE, 'b.md')
    back(PANE)

    // The pane is showing a.md again; the store re-announcing it is a no-op,
    // so b.md must survive on the forward stack.
    push(PANE, 'a.md')
    expect(snapshot(PANE)).toEqual({ entries: ['a.md', 'b.md'], index: 0 })
    expect(canForward(PANE)).toBe(true)

    // Navigating forward and then back to a.md *is* a new visit.
    push(PANE, 'b.md')
    push(PANE, 'a.md')
    expect(snapshot(PANE)).toEqual({ entries: ['a.md', 'b.md', 'a.md'], index: 2 })
  })

  it('truncates the forward stack when a new path is pushed after going back', () => {
    push(PANE, 'a.md')
    push(PANE, 'b.md')
    push(PANE, 'c.md')
    back(PANE)
    back(PANE) // showing a.md, with b.md and c.md ahead

    push(PANE, 'z.md')

    expect(snapshot(PANE)).toEqual({ entries: ['a.md', 'z.md'], index: 1 })
    expect(canForward(PANE)).toBe(false)
    expect(back(PANE)).toBe('a.md')
  })

  it('keeps one stack per pane', () => {
    push(PANE, 'a.md')
    push(PANE, 'b.md')
    push(OTHER, 'x.md')

    expect(canBack(PANE)).toBe(true)
    expect(canBack(OTHER)).toBe(false)
    expect(back(PANE)).toBe('a.md')
    expect(current(OTHER)).toBe('x.md')
  })

  it('drops the oldest entries once the limit is passed', () => {
    for (let i = 0; i < 120; i += 1) push(PANE, `note-${i}.md`)

    const { entries, index } = snapshot(PANE)
    expect(entries).toHaveLength(100)
    expect(entries[0]).toBe('note-20.md')
    expect(index).toBe(99)
    expect(current(PANE)).toBe('note-119.md')
  })

  it('ignores an empty path', () => {
    push(PANE, '')

    expect(snapshot(PANE)).toEqual({ entries: [], index: -1 })
  })

  it('reset(paneId) clears only that pane', () => {
    push(PANE, 'a.md')
    push(PANE, 'b.md')
    push(OTHER, 'x.md')

    reset(PANE)

    expect(snapshot(PANE)).toEqual({ entries: [], index: -1 })
    expect(current(OTHER)).toBe('x.md')
  })
})

describe('paneHistory — closed tabs', () => {
  it('pops in reverse order and reports emptiness', () => {
    expect(canReopen()).toBe(false)
    expect(popClosed()).toBeNull()

    pushClosed(tab('t1', 'a.md'))
    pushClosed(tab('t2', 'b.md'))

    expect(canReopen()).toBe(true)
    expect(popClosed()?.path).toBe('b.md')
    expect(popClosed()?.path).toBe('a.md')
    expect(popClosed()).toBeNull()
    expect(canReopen()).toBe(false)
  })

  it('copies the tab so later mutation of the original cannot leak in', () => {
    const original = tab('t1', 'a.md')
    pushClosed(original)
    original.path = 'changed.md'
    original.pinned = true

    const reopened = popClosed()
    expect(reopened).toEqual({ id: 't1', kind: 'note', path: 'a.md', mode: 'edit', pinned: false })
  })

  it('keeps at most twenty closed tabs', () => {
    for (let i = 0; i < 25; i += 1) pushClosed(tab(`t${i}`, `note-${i}.md`))

    const popped: string[] = []
    let next = popClosed()
    while (next) {
      popped.push(next.path ?? '')
      next = popClosed()
    }

    expect(popped).toHaveLength(20)
    expect(popped[0]).toBe('note-24.md')
    expect(popped[19]).toBe('note-5.md')
  })

  it('reset() with no pane clears closed tabs as well', () => {
    pushClosed(tab('t1', 'a.md'))
    push(PANE, 'a.md')

    reset()

    expect(canReopen()).toBe(false)
    expect(snapshot(PANE)).toEqual({ entries: [], index: -1 })
  })
})

describe('paneHistory — subscriptions', () => {
  it('notifies subscribers and bumps the version on every mutation', () => {
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    const before = getVersion()

    push(PANE, 'a.md')
    push(PANE, 'b.md')
    back(PANE)
    forward(PANE)
    pushClosed(tab('t1', 'a.md'))
    popClosed()

    expect(listener).toHaveBeenCalledTimes(6)
    expect(getVersion()).toBe(before + 6)

    unsubscribe()
    push(PANE, 'c.md')
    expect(listener).toHaveBeenCalledTimes(6)
  })

  it('does not notify for no-op mutations', () => {
    push(PANE, 'a.md')
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)

    push(PANE, 'a.md') // same entry
    back(PANE) // nothing behind
    forward(PANE) // nothing ahead
    popClosed() // nothing closed
    reset('pane-that-never-existed')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
