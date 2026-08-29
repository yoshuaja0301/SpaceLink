/**
 * SpaceFore — the markdown editor pane.
 *
 * The tricky part of hosting CodeMirror inside React is ownership of the
 * document. React must not re-render the text: a controlled `value` prop would
 * fight the editor on every keystroke (lost cursor, lost undo, lost IME
 * composition). So:
 *
 * - the editor owns the buffer and pushes changes *out* through
 *   `setNoteContent` (the store debounces the actual write);
 * - changes coming *in* — a rename rewriting links, a vault reload, the same
 *   note open in a second pane — arrive through an imperative store
 *   subscription and are applied only when the incoming text actually differs
 *   from what the editor already shows.
 *
 * Settings changes are compartment reconfigurations, never a rebuild, so the
 * undo history survives them.
 *
 * The editor is also one end of two window-event seams (see the table at the
 * bottom of docs/CONTRACTS.md): it listens for `spacefore:reveal-line` /
 * `spacefore:reveal-heading` and emits `spacefore:editor-scroll`. Both
 * listeners hang off `window` and read the current view through a ref, so
 * swapping notes can never leave one bound to a view that is gone.
 */
import { useEffect, useRef } from 'react'
import type { Extension } from '@codemirror/state'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { resolveLinkTarget } from '../core/graph/index'
import { useAppStore } from '../state/store'
import type { NotePath } from '../types'
import { registerEditor } from './editor/markdownCommands'
import { flashLine, refreshDecorations } from './editor/markdownDecorations'
import {
  appearanceCompartment,
  createEditorExtensions,
  lineNumbersCompartment,
  lineNumbersExtension,
  spellcheckCompartment,
  spellcheckExtension,
} from './editor/setup'
import { editorAppearance } from './editor/editorTheme'

/** Where the user was in each note, so switching tabs is not a trip to line 1. */
interface EditorMemory {
  anchor: number
  head: number
  scrollTop: number
}

/**
 * Module-level on purpose: the memory has to outlive both the component and the
 * `EditorState`, so closing a note and coming back to it still lands where you
 * left off.
 */
const memories = new Map<NotePath, EditorMemory>()

/**
 * How many notes' positions to keep. Nothing ever removes a path from the map —
 * not a delete, not a rename, not a vault switch — so without a cap a long
 * session in a big vault grows it without bound. Insertion order makes the map
 * its own LRU list.
 */
const MAX_MEMORIES = 100

function remember(view: EditorView, path: NotePath): void {
  const { anchor, head } = view.state.selection.main
  // Re-insert rather than overwrite, so the most recent note is always last.
  memories.delete(path)
  memories.set(path, { anchor, head, scrollTop: view.scrollDOM.scrollTop })
  while (memories.size > MAX_MEMORIES) {
    const oldest = memories.keys().next()
    if (oldest.done === true) break
    memories.delete(oldest.value)
  }
}

function restore(view: EditorView, path: NotePath): void {
  const memory = memories.get(path)
  if (!memory) return
  const max = view.state.doc.length
  view.dispatch({ selection: { anchor: Math.min(memory.anchor, max), head: Math.min(memory.head, max) } })
  const applyScroll = (): void => {
    view.scrollDOM.scrollTop = memory.scrollTop
  }
  // The scroller has no height until CodeMirror has measured it, so wait for a
  // frame where the browser can honour the offset.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyScroll)
  else applyScroll()
}

/** How long the revealed line stays lit. Long enough to find, short enough not to nag. */
const FLASH_MS = 1200

/**
 * Run `fn` on the next frame, or on a short timer where the browser has no
 * `requestAnimationFrame`. Returns the canceller for whichever was used.
 */
function nextFrame(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(fn, 16)
  return () => clearTimeout(id)
}

/** `scrollTop / (scrollHeight - clientHeight)`, clamped to 0–1; 0 when nothing can scroll. */
function scrollRatio(view: EditorView): number {
  const el = view.scrollDOM
  const range = el.scrollHeight - el.clientHeight
  if (!(range > 0)) return 0
  const ratio = el.scrollTop / range
  if (!Number.isFinite(ratio)) return 0
  return Math.max(0, Math.min(1, ratio))
}

/** Put the caret at the start of `line` (0-based), centre it, and light it up. */
function revealLine(view: EditorView, line: number): void {
  const { doc } = view.state
  const number = Math.max(1, Math.min(doc.lines, Math.floor(line) + 1))
  const { from } = doc.line(number)
  view.dispatch({
    selection: { anchor: from },
    effects: [EditorView.scrollIntoView(from, { y: 'center' }), flashLine.of(from)],
  })
}

export function Editor({ path, paneId }: { path: NotePath; paneId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const extensionsRef = useRef<Extension[] | null>(null)
  /** The path whose document is currently loaded into the view. */
  const loadedRef = useRef<NotePath>(path)
  /** The path this render was asked for — read by effects that run after it. */
  const pathRef = useRef<NotePath>(path)
  pathRef.current = path
  /** Cancels the queued `editor-scroll` emit, so one is sent per frame at most. */
  const scrollFrameRef = useRef<(() => void) | null>(null)
  /** Clears the reveal flash. Reset by a second reveal, cancelled on unmount. */
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fontSize = useAppStore((s) => s.settings.fontSize)
  const editorFont = useAppStore((s) => s.settings.editorFont)
  const showLineNumbers = useAppStore((s) => s.settings.showLineNumbers)
  const spellcheck = useAppStore((s) => s.settings.spellcheck)
  const readableLineLength = useAppStore((s) => s.settings.readableLineLength)
  const liveSyntaxHiding = useAppStore((s) => s.settings.liveSyntaxHiding)
  const isActivePane = useAppStore((s) => s.activePaneId === paneId)

  const activeRef = useRef(isActivePane)
  activeRef.current = isActivePane

  /* ---- create / destroy the view ------------------------------------- */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const settings = useAppStore.getState().settings
    const extensions = createEditorExtensions({
      // These two read the store at call time rather than closing over a
      // snapshot: the link index changes whenever any note is edited, and
      // syntax hiding is flipped from the settings modal.
      resolveLink: (target) => resolveLinkTarget(target, loadedRef.current, useAppStore.getState().index),
      liveSyntaxHiding: () => useAppStore.getState().settings.liveSyntaxHiding,
      showLineNumbers: settings.showLineNumbers,
      spellcheck: settings.spellcheck,
      fontSize: settings.fontSize,
      editorFont: settings.editorFont,
      onChange: (doc) => {
        // The store ignores a set that changes nothing, which is exactly what
        // makes echoing an externally applied change back here harmless.
        useAppStore.getState().setNoteContent(loadedRef.current, doc)
      },
      onFocus: () => {
        registerEditor(paneId, viewRef.current)
        if (!activeRef.current) useAppStore.getState().setActivePane(paneId)
      },
      onScroll: (scrolled) => {
        // Scroll events arrive far faster than frames and the Preview can only
        // use one ratio per frame, so coalesce them.
        if (scrollFrameRef.current !== null) return
        scrollFrameRef.current = nextFrame(() => {
          scrollFrameRef.current = null
          if (typeof window === 'undefined' || typeof window.CustomEvent !== 'function') return
          window.dispatchEvent(
            new CustomEvent('spacefore:editor-scroll', { detail: { paneId, ratio: scrollRatio(scrolled) } }),
          )
        })
      },
    })
    extensionsRef.current = extensions

    const initial = pathRef.current
    const view = new EditorView({
      state: EditorState.create({ doc: useAppStore.getState().notes.get(initial)?.content ?? '', extensions }),
      parent: host,
    })
    viewRef.current = view
    loadedRef.current = initial
    registerEditor(paneId, view)
    restore(view, initial)
    if (activeRef.current) view.focus()

    return () => {
      remember(view, loadedRef.current)
      registerEditor(paneId, null)
      // A queued emit would fire for a view that no longer exists.
      scrollFrameRef.current?.()
      scrollFrameRef.current = null
      view.destroy()
      viewRef.current = null
      extensionsRef.current = null
    }
  }, [paneId])

  /* ---- swap the document when the tab points at another note ---------- */
  useEffect(() => {
    const view = viewRef.current
    const extensions = extensionsRef.current
    if (!view || !extensions || loadedRef.current === path) return
    remember(view, loadedRef.current)
    loadedRef.current = path

    // A fresh state rather than one enormous replace transaction: a different
    // note deserves its own undo history, and nothing from the previous note
    // can be undone into this one.
    const current = useAppStore.getState().settings
    view.setState(
      EditorState.create({ doc: useAppStore.getState().notes.get(path)?.content ?? '', extensions }),
    )
    // `setState` resets every compartment to the value baked in at mount, so
    // re-apply anything the user has changed since.
    view.dispatch({
      effects: [
        appearanceCompartment.reconfigure(editorAppearance({ fontSize: current.fontSize, fontFamily: current.editorFont })),
        lineNumbersCompartment.reconfigure(lineNumbersExtension(current.showLineNumbers)),
        spellcheckCompartment.reconfigure(spellcheckExtension(current.spellcheck)),
      ],
    })
    restore(view, path)
  }, [path])

  /* ---- pull in edits made outside this editor ------------------------- */
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        // `notes` is replaced wholesale on any content change, so this is a
        // cheap gate against the many store updates that are not about text.
        if (state.notes === previous.notes) return
        const view = viewRef.current
        if (!view) return
        const content = state.notes.get(loadedRef.current)?.content
        if (content === undefined) return
        const shown = view.state.doc.toString()
        // Our own keystrokes arrive here first, already in agreement.
        if (content === shown) return
        const head = Math.min(view.state.selection.main.head, content.length)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          selection: { anchor: head },
        })
      }),
    [],
  )

  /* ---- reveal a line asked for by search / backlinks / the outline ----- */
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    // Registered once and reading both refs live: the note this editor shows
    // changes without the listener being re-registered, and an event that
    // arrives between two documents finds the one actually loaded.
    const onReveal = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail as
        | { path?: unknown; line?: unknown }
        | null
        | undefined
      if (!detail || typeof detail !== 'object') return
      if (detail.path !== loadedRef.current) return
      const { line } = detail
      if (typeof line !== 'number' || !Number.isFinite(line)) return
      const view = viewRef.current
      if (!view) return
      revealLine(view, line)
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => {
        flashTimerRef.current = null
        viewRef.current?.dispatch({ effects: flashLine.of(null) })
      }, FLASH_MS)
    }
    // `reveal-heading` carries a slug for the preview and a line for us.
    window.addEventListener('spacefore:reveal-line', onReveal)
    window.addEventListener('spacefore:reveal-heading', onReveal)
    return () => {
      window.removeEventListener('spacefore:reveal-line', onReveal)
      window.removeEventListener('spacefore:reveal-heading', onReveal)
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current)
        flashTimerRef.current = null
      }
    }
  }, [])

  /* ---- live settings --------------------------------------------------- */
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: appearanceCompartment.reconfigure(editorAppearance({ fontSize, fontFamily: editorFont })),
    })
  }, [fontSize, editorFont])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: lineNumbersCompartment.reconfigure(lineNumbersExtension(showLineNumbers)) })
  }, [showLineNumbers])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckExtension(spellcheck)) })
  }, [spellcheck])

  useEffect(() => {
    // Syntax hiding is neither a document nor a selection change, so the
    // decoration plugin has to be told to rebuild.
    viewRef.current?.dispatch({ effects: refreshDecorations.of(null) })
  }, [liveSyntaxHiding])

  /* ---- clicks ---------------------------------------------------------- */
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    const store = useAppStore.getState()
    if (store.activePaneId !== paneId) store.setActivePane(paneId)

    const target = event.target as HTMLElement | null
    if (!target || typeof target.closest !== 'function') return

    const link = target.closest('.cm-wikilink') as HTMLElement | null
    if (link) {
      // Handled on mousedown so the caret never jumps into the link first.
      event.preventDefault()
      const wikiTarget = link.dataset.target ?? ''
      if (wikiTarget !== '') {
        void store.openLink(wikiTarget, loadedRef.current, { newTab: event.metaKey || event.ctrlKey })
      }
      return
    }

    const tag = target.closest('.cm-tag') as HTMLElement | null
    if (tag) {
      event.preventDefault()
      const name = tag.dataset.tag ?? ''
      if (name !== '') {
        store.setSearchQuery(`tag:${name}`)
        // `setSidebarPanel` toggles, so only nudge it when it is not there yet.
        if (store.sidebarPanel !== 'search') store.setSidebarPanel('search')
      }
    }
  }

  return (
    <div
      ref={hostRef}
      className={readableLineLength ? 'editor-host is-readable-width' : 'editor-host'}
      data-path={path}
      onMouseDown={onMouseDown}
    />
  )
}

export default Editor
