/**
 * The editor owns its buffer, so these tests drive CodeMirror directly (through
 * the view React mounted) rather than firing synthetic key events: what matters
 * is that the seams around the buffer — the reveal events, the scroll event and
 * the store subscription — match the window event contract and never fight the
 * person typing.
 */
import { EditorView } from '@codemirror/view'
import { cleanup, render } from '@testing-library/react'
import { StrictMode, act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import { buildIndex, emptyIndex } from '../core/graph/index'
import type { AppState } from '../state/store'
import { makeNote, useAppStore } from '../state/store'
import type { Note, NotePath } from '../types'
import { Editor } from './Editor'

/**
 * jsdom does no layout and leaves `Range.getClientRects` undefined, so
 * CodeMirror's measuring pass throws inside an animation frame as soon as a
 * transaction asks to scroll something into view. An empty rect list is the
 * "unmeasurable" answer it already knows how to handle.
 */
const rangeProto = Range.prototype as unknown as { getClientRects?: () => DOMRect[] }
if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = () => []

/** The store as it was when the module loaded, actions included. */
const PRISTINE = useAppStore.getState()

const PANE_ID = 'pane-a'

/**
 * A path no other test in this file has used. The remembered cursor positions
 * are module-level — they outlive the component on purpose — so tests that
 * shared a path would inherit each other's caret.
 */
let pathCounter = 0
function freshPath(): NotePath {
  pathCounter += 1
  return `note-${pathCounter}.md`
}

function seed(files: Record<NotePath, string>, patch: Partial<AppState> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

/** The `EditorView` React mounted inside `container`. */
function view(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor')
  const found = dom ? EditorView.findFromDOM(dom) : null
  if (!found) throw new Error('editor view missing')
  return found
}

/** Records the `detail` of every event of `type` until the test ends. */
const stopListening: Array<() => void> = []
function listen(type: string): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = []
  const handler = (event: Event): void => {
    seen.push(((event as CustomEvent<unknown>).detail ?? {}) as Record<string, unknown>)
  }
  window.addEventListener(type, handler)
  stopListening.push(() => window.removeEventListener(type, handler))
  return seen
}

function dispatchWindow(type: string, detail: unknown): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(type, { detail }))
  })
}

/** jsdom does no layout, so the scroller's metrics have to be faked. */
function stubScroller(element: HTMLElement, metrics: { scrollHeight: number; clientHeight: number }): void {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, writable: true, value })
  }
}

function scrollTo(target: EditorView, scrollTop: number): void {
  Object.defineProperty(target.scrollDOM, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
  target.scrollDOM.dispatchEvent(new Event('scroll'))
}

/** Wait for the frame the scroll emit is throttled to. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

const lines = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n')

beforeEach(() => {
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      searchQuery: '',
      sidebarPanel: 'files',
      starred: [],
      recent: [],
      toasts: [],
      revision: 0,
      panes: [
        { id: PANE_ID, tabs: [], activeTabId: null },
        { id: 'pane-b', tabs: [], activeTabId: null },
      ],
      // Not the pane under test: a mounted editor focuses itself for its own
      // pane, and focus is not what these tests are about.
      activePaneId: 'pane-b',
    },
    true,
  )
})

afterEach(() => {
  for (const off of stopListening.splice(0)) off()
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Editor — spacelink:reveal-line', () => {
  it('puts the caret on the requested line and flashes it', () => {
    const path = freshPath()
    seed({ [path]: lines })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    dispatchWindow('spacelink:reveal-line', { path, line: 3 })

    // 0-based line 3 is `four`.
    expect(cm.state.selection.main.head).toBe(cm.state.doc.line(4).from)
    expect([...cm.dom.querySelectorAll('.cm-flash-line')].map((el) => el.textContent)).toEqual(['four'])
  })

  it('ignores a reveal aimed at another note', () => {
    const path = freshPath()
    const other = freshPath()
    seed({ [path]: lines, [other]: lines })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    dispatchWindow('spacelink:reveal-line', { path: other, line: 3 })

    expect(cm.state.selection.main.head).toBe(0)
    expect(cm.dom.querySelectorAll('.cm-flash-line')).toHaveLength(0)
  })

  it('follows the note the editor has actually switched to', () => {
    const first = freshPath()
    const second = freshPath()
    seed({ [first]: lines, [second]: lines })
    const { container, rerender } = render(<Editor path={first} paneId={PANE_ID} />)
    rerender(<Editor path={second} paneId={PANE_ID} />)

    dispatchWindow('spacelink:reveal-line', { path: first, line: 2 })
    expect(view(container).state.selection.main.head).toBe(0)

    dispatchWindow('spacelink:reveal-line', { path: second, line: 2 })
    expect(view(container).state.selection.main.head).toBe(view(container).state.doc.line(3).from)
  })

  it('clears the flash after about a second', () => {
    const path = freshPath()
    seed({ [path]: lines })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    vi.useFakeTimers()
    dispatchWindow('spacelink:reveal-line', { path, line: 1 })
    expect(cm.dom.querySelectorAll('.cm-flash-line')).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(cm.dom.querySelectorAll('.cm-flash-line')).toHaveLength(0)
  })

  it('clamps a line beyond the end of the note instead of throwing', () => {
    const path = freshPath()
    seed({ [path]: lines })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    expect(() => dispatchWindow('spacelink:reveal-line', { path, line: 900 })).not.toThrow()
    expect(cm.state.selection.main.head).toBe(cm.state.doc.line(cm.state.doc.lines).from)
  })

  it('ignores a malformed detail', () => {
    const path = freshPath()
    seed({ [path]: lines })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    dispatchWindow('spacelink:reveal-line', null)
    dispatchWindow('spacelink:reveal-line', { path })
    dispatchWindow('spacelink:reveal-line', { path, line: 'three' })

    expect(cm.state.selection.main.head).toBe(0)
    expect(cm.dom.querySelectorAll('.cm-flash-line')).toHaveLength(0)
  })
})

describe('Editor — spacelink:reveal-heading', () => {
  it('scrolls to the heading line and ignores other notes', () => {
    const path = freshPath()
    const other = freshPath()
    seed({ [path]: lines })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    dispatchWindow('spacelink:reveal-heading', { path: other, slug: 'five', line: 4 })
    expect(cm.state.selection.main.head).toBe(0)

    dispatchWindow('spacelink:reveal-heading', { path, slug: 'five', line: 4 })
    expect(cm.state.selection.main.head).toBe(cm.state.doc.line(5).from)
    expect([...cm.dom.querySelectorAll('.cm-flash-line')].map((el) => el.textContent)).toEqual(['five'])
  })
})

describe('Editor — spacelink:editor-scroll', () => {
  it('emits one clamped ratio per frame for its own pane', async () => {
    const path = freshPath()
    seed({ [path]: lines })
    const emitted = listen('spacelink:editor-scroll')
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)
    stubScroller(cm.scrollDOM, { scrollHeight: 1000, clientHeight: 200 })

    // Three events inside one frame must not become three dispatches.
    scrollTo(cm, 400)
    scrollTo(cm, 401)
    scrollTo(cm, 400)
    await frame()

    expect(emitted).toEqual([{ paneId: PANE_ID, ratio: 0.5 }])

    scrollTo(cm, 5000)
    await frame()
    expect(emitted[1]).toEqual({ paneId: PANE_ID, ratio: 1 })
  })

  it('reports 0 rather than a division by zero when nothing can scroll', async () => {
    const path = freshPath()
    seed({ [path]: lines })
    const emitted = listen('spacelink:editor-scroll')
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)
    stubScroller(cm.scrollDOM, { scrollHeight: 200, clientHeight: 200 })

    scrollTo(cm, 0)
    await frame()

    expect(emitted).toEqual([{ paneId: PANE_ID, ratio: 0 }])
    expect(Number.isFinite(emitted[0]!.ratio as number)).toBe(true)
  })
})

describe('Editor — teardown', () => {
  it('removes its window listeners on unmount', async () => {
    const path = freshPath()
    seed({ [path]: lines })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const emitted = listen('spacelink:editor-scroll')
    const { container, unmount } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)
    stubScroller(cm.scrollDOM, { scrollHeight: 1000, clientHeight: 200 })
    const notesBefore = useAppStore.getState().notes
    const reveals = added.mock.calls.filter(([type]) => type.startsWith('spacelink:reveal'))
    expect(reveals.map(([type]) => type)).toEqual(['spacelink:reveal-line', 'spacelink:reveal-heading'])

    unmount()

    // Same handler identity, or the listener is still on `window`.
    for (const [type, handler] of reveals) expect(removed).toHaveBeenCalledWith(type, handler)

    expect(() => {
      dispatchWindow('spacelink:reveal-line', { path, line: 2 })
      dispatchWindow('spacelink:reveal-heading', { path, slug: 'three', line: 2 })
      scrollTo(cm, 400)
    }).not.toThrow()
    await frame()

    expect(emitted).toEqual([])
    expect(useAppStore.getState().notes).toBe(notesBefore)
    expect(useAppStore.getState().dirty.size).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })

  it('cancels a scroll emit that was still queued when it unmounted', async () => {
    const path = freshPath()
    seed({ [path]: lines })
    const emitted = listen('spacelink:editor-scroll')
    const { container, unmount } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)
    stubScroller(cm.scrollDOM, { scrollHeight: 1000, clientHeight: 200 })

    scrollTo(cm, 500)
    unmount()
    await frame()

    expect(emitted).toEqual([])
  })

  it('survives StrictMode double mounting with exactly one live editor', async () => {
    const path = freshPath()
    seed({ [path]: lines })
    const emitted = listen('spacelink:editor-scroll')
    const { container } = render(
      <StrictMode>
        <Editor path={path} paneId={PANE_ID} />
      </StrictMode>,
    )
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1)
    const cm = view(container)
    // The second mount restores the position the first one remembered, on a
    // frame of its own. Let it land before faking a scroll of our own.
    await frame()
    stubScroller(cm.scrollDOM, { scrollHeight: 1000, clientHeight: 200 })

    dispatchWindow('spacelink:reveal-line', { path, line: 2 })
    expect(cm.state.selection.main.head).toBe(cm.state.doc.line(3).from)

    scrollTo(cm, 200)
    await frame()
    expect(emitted).toEqual([{ paneId: PANE_ID, ratio: 0.25 }])
  })
})

describe('Editor — buffer ownership', () => {
  it('does not let the store subscription clobber the keystroke that caused it', () => {
    const path = freshPath()
    seed({ [path]: 'alpha' })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)

    act(() => {
      cm.dispatch({
        changes: { from: 5, insert: '!' },
        selection: { anchor: 6 },
        userEvent: 'input.type',
      })
    })

    expect(cm.state.doc.toString()).toBe('alpha!')
    expect(cm.state.selection.main.head).toBe(6)
    expect(useAppStore.getState().notes.get(path)?.content).toBe('alpha!')
    expect([...useAppStore.getState().dirty]).toEqual([path])
  })

  it('takes in a change made outside and keeps the caret inside the new text', () => {
    const path = freshPath()
    seed({ [path]: 'a long first version' })
    const { container } = render(<Editor path={path} paneId={PANE_ID} />)
    const cm = view(container)
    act(() => {
      cm.dispatch({ selection: { anchor: 20 } })
    })

    act(() => {
      useAppStore.getState().setNoteContent(path, 'short')
    })

    expect(cm.state.doc.toString()).toBe('short')
    expect(cm.state.selection.main.head).toBe(5)
  })

  it('writes keystrokes to the note it switched to, not the one it left', () => {
    const first = freshPath()
    const second = freshPath()
    seed({ [first]: 'alpha', [second]: 'bravo' })
    const { container, rerender } = render(<Editor path={first} paneId={PANE_ID} />)
    rerender(<Editor path={second} paneId={PANE_ID} />)
    const cm = view(container)

    act(() => {
      cm.dispatch({ changes: { from: 5, insert: '!' }, selection: { anchor: 6 }, userEvent: 'input.type' })
    })

    expect(useAppStore.getState().notes.get(second)?.content).toBe('bravo!')
    expect(useAppStore.getState().notes.get(first)?.content).toBe('alpha')
  })
})

describe('Editor — remembered positions', () => {
  it(
    'restores where you were, but forgets the least recently visited notes',
    () => {
      // One more note than the memory holds, so the first one visited falls out
      // of it while the most recent are still there.
      const visits = 110
      const first = freshPath()
      const files: Record<NotePath, string> = { [first]: lines }
      const visited: NotePath[] = []
      for (let i = 0; i < visits; i += 1) {
        const path = freshPath()
        visited.push(path)
        files[path] = lines
      }
      seed(files)

      const { container, rerender } = render(<Editor path={first} paneId={PANE_ID} />)
      act(() => {
        view(container).dispatch({ selection: { anchor: 4 } })
      })

      for (const path of visited) rerender(<Editor path={path} paneId={PANE_ID} />)
      const last = visited[visits - 1]!
      act(() => {
        view(container).dispatch({ selection: { anchor: 8 } })
      })

      // The note just left is still remembered…
      rerender(<Editor path={visited[0]!} paneId={PANE_ID} />)
      rerender(<Editor path={last} paneId={PANE_ID} />)
      expect(view(container).state.selection.main.anchor).toBe(8)

      // …while the one visited a hundred switches ago has been dropped.
      rerender(<Editor path={first} paneId={PANE_ID} />)
      expect(view(container).state.selection.main.anchor).toBe(0)
    },
    20000,
  )
})
