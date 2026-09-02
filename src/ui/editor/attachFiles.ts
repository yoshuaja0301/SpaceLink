/**
 * Pasting and dropping files into a note.
 *
 * Taking a screenshot and putting it in the note you are writing is most of
 * what attachments are for, and there was no way to do it: the app could
 * display an image a folder already contained but never add one.
 *
 * Both gestures are handled here, and only when files are actually involved —
 * pasting text, and dragging a note from the explorer onto the editor, carry no
 * `files` and are left alone for CodeMirror and the rest of the app to handle
 * as they always did.
 */
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** Writes the file into the vault and answers with the text to insert. */
export type AttachHandler = (file: File) => Promise<string | null>

/** The files on a clipboard or drag payload, if any. */
function filesOf(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return []
  return [...(transfer.files ?? [])]
}

/**
 * Insert `text` at `at`, and leave the cursor after it.
 *
 * The position is clamped because attaching is asynchronous: the document can
 * be shorter by the time the write finishes, and an out-of-range position
 * throws rather than merely landing in the wrong place.
 */
function insertAt(view: EditorView, at: number, text: string): void {
  const position = Math.max(0, Math.min(at, view.state.doc.length))
  view.dispatch({
    changes: { from: position, insert: text },
    selection: { anchor: position + text.length },
    scrollIntoView: true,
  })
  view.focus()
}

/**
 * Attach every file in a gesture, one after another.
 *
 * Sequential on purpose: each name is made unique against the vault as it
 * stands, so two files pasted together have to be written in turn or they race
 * for the same name.
 */
async function attachAll(view: EditorView, at: number, files: File[], attach: AttachHandler): Promise<void> {
  let cursor = at
  for (const file of files) {
    const text = await attach(file)
    if (text === null) return
    const separator = cursor > 0 && view.state.doc.sliceString(cursor - 1, cursor) !== '\n' ? '\n' : ''
    insertAt(view, cursor, `${separator}${text}\n`)
    cursor = view.state.selection.main.head
  }
}

/** Handle pasted and dropped files; everything else passes through untouched. */
export function attachFilesOnPasteAndDrop(attach: AttachHandler): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = filesOf(event.clipboardData)
      if (files.length === 0) return false
      event.preventDefault()
      void attachAll(view, view.state.selection.main.head, files, attach)
      return true
    },
    drop(event, view) {
      const files = filesOf(event.dataTransfer)
      if (files.length === 0) return false
      event.preventDefault()
      // Where the file was actually dropped, not where the caret happened to
      // be — that is the whole meaning of the gesture.
      const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      void attachAll(view, at, files, attach)
      return true
    },
    dragover(event) {
      // Without this the browser navigates away to the dropped file.
      if (filesOf(event.dataTransfer).length === 0) return false
      event.preventDefault()
      return false
    },
  })
}
