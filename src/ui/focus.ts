/**
 * Who is allowed to take the keyboard, and when.
 *
 * Mounting a view and focusing it is the right thing when a reader has just
 * opened a note. It stops being the right thing when the view arrives late.
 * The editor is loaded on demand, so its mount can land a second or more after
 * the app has painted — by which time the reader may already have opened the
 * quick switcher and started typing. The editor then took the focus back, the
 * palette kept filtering (it reads its own input's value), and pressing Enter
 * went to CodeMirror instead: the note under the cursor did not open, and the
 * keystrokes landed in whatever was already on screen.
 *
 * `aria-modal` is the existing, honest answer to "does something else own the
 * keyboard right now" — it is already on the palette and on every modal,
 * because it is what tells a screen reader the same thing.
 */

/** True when focus currently sits inside an open modal dialog. */
export function focusIsInsideModal(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  if (!active || active === document.body || typeof active.closest !== 'function') return false
  return active.closest('[aria-modal="true"]') !== null
}

/**
 * Whether a view that has just mounted should focus itself.
 *
 * Only the modal case says no. Nothing else here is a focus trap, and refusing
 * more widely would break the ordinary path — clicking a search result, say,
 * where the reader does expect the caret to end up in the note.
 */
export function mayTakeFocusOnMount(): boolean {
  return !focusIsInsideModal()
}
