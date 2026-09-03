/**
 * Which editor a command should act on.
 *
 * Deliberately its own module, holding nothing but this: the command palette
 * and the hotkeys need to know whether an editor exists in order to enable or
 * disable a command, and they are on screen from the first frame. Everything
 * that *operates* on an editor lives in `markdownCommands.ts`, which pulls in
 * CodeMirror — so keeping the question separate from the answers is what lets
 * CodeMirror be fetched only when a note is actually opened for editing.
 *
 * `EditorView` appears here as a type only, and types weigh nothing.
 */
import type { EditorView } from '@codemirror/view'

const editors = new Map<string, EditorView>()
let lastRegisteredPane: string | null = null

/**
 * Attach (or detach, with `null`) the editor belonging to a pane. `Editor.tsx`
 * calls this on mount, on focus and on unmount.
 */
export function registerEditor(paneId: string, view: EditorView | null): void {
  if (view === null) {
    editors.delete(paneId)
    if (lastRegisteredPane === paneId) lastRegisteredPane = null
    return
  }
  editors.set(paneId, view)
  lastRegisteredPane = paneId
}

/**
 * The editor a command should act on: whichever one has DOM focus, falling back
 * to the most recently registered/focused pane (the palette steals focus while
 * it is open, so "has focus" is usually false by the time a command runs).
 */
export function getActiveEditor(): EditorView | null {
  for (const view of editors.values()) {
    if (view.hasFocus) return view
  }
  if (lastRegisteredPane !== null) {
    const view = editors.get(lastRegisteredPane)
    if (view) return view
  }
  const first = editors.values().next()
  return first.done === true ? null : first.value
}

