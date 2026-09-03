/**
 * SpaceLink — CodeMirror extension assembly.
 *
 * One function builds the whole extension list for an editor. Things that can
 * change while the editor is alive (line numbers, spellcheck, font) go behind
 * compartments so `Editor.tsx` can reconfigure them without recreating the
 * state — which would throw away the undo history.
 *
 * Things that are read *per computation* (the link index, `liveSyntaxHiding`)
 * are passed as getters instead, so they never go stale.
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'

import type { NotePath } from '../../types'
import { editorAppearance, editorHighlighting, editorTheme } from './editorTheme'
import { flashLineHighlight, markdownDecorations } from './markdownDecorations'
import { wikilinkCompletion } from './wikilinkComplete'

/** Wraps the gutter extensions, toggled by the `showLineNumbers` setting. */
export const lineNumbersCompartment = new Compartment()
/** Wraps font size / family, toggled by the `fontSize` and `editorFont` settings. */
export const appearanceCompartment = new Compartment()
/** Wraps `contentAttributes`, toggled by the `spellcheck` setting. */
export const spellcheckCompartment = new Compartment()

export interface EditorSetupOptions {
  /**
   * Resolve a wiki-link target to a vault path, or null when no such note
   * exists. Called during decoration building, so it must be cheap and must
   * read live state rather than close over a snapshot.
   */
  resolveLink: (target: string) => NotePath | null
  /** Live read of the `liveSyntaxHiding` setting. */
  liveSyntaxHiding: () => boolean
  /** Initial value of the `showLineNumbers` setting. */
  showLineNumbers: boolean
  /** Initial value of the `spellcheck` setting. */
  spellcheck: boolean
  /** Initial editor font size in px. */
  fontSize: number
  /** Initial editor font family; an empty string keeps the theme default. */
  editorFont: string
  /** Called with the full document text after every change that touched it. */
  onChange: (doc: string) => void
  /** Called when the editor takes DOM focus — used to activate the owning pane. */
  onFocus?: () => void
  /**
   * Called whenever the scroller moves, with the view that moved. Fires once
   * per scroll event, so the caller is responsible for throttling.
   */
  onScroll?: (view: EditorView) => void
}

/** Gutter extensions for the `showLineNumbers` setting. */
export function lineNumbersExtension(show: boolean): Extension {
  return show ? [lineNumbers(), highlightActiveLineGutter()] : []
}

/** Content attributes for the `spellcheck` setting. */
export function spellcheckExtension(enabled: boolean): Extension {
  return EditorView.contentAttributes.of({ spellcheck: enabled ? 'true' : 'false' })
}

/**
 * Build the extension list for one editor instance.
 *
 * Keymap order matters and is deliberate: bracket closing and completion get
 * first refusal on Enter/Escape/Tab, then the default bindings, then search and
 * history, with `indentWithTab` last so it only sees a Tab nobody else wanted.
 */
export function createEditorExtensions(opts: EditorSetupOptions): Extension[] {
  return [
    lineNumbersCompartment.of(lineNumbersExtension(opts.showLineNumbers)),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    closeBrackets(),
    autocompletion({
      override: [wikilinkCompletion()],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
      maxRenderedOptions: 20,
    }),
    search({ top: true }),
    // `codeLanguages` is deliberately omitted: no per-language parsers means no
    // extra bundle weight, and fenced code renders as plain monospace.
    markdown(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    markdownDecorations({ resolve: opts.resolveLink, hideSyntax: opts.liveSyntaxHiding }),
    flashLineHighlight,
    editorTheme,
    editorHighlighting,
    appearanceCompartment.of(editorAppearance({ fontSize: opts.fontSize, fontFamily: opts.editorFont })),
    spellcheckCompartment.of(spellcheckExtension(opts.spellcheck)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString())
    }),
    EditorView.domEventHandlers({
      focus: () => {
        opts.onFocus?.()
        return false
      },
      // Registered on the scroller (CodeMirror routes `scroll` there rather
      // than to the content element), and torn down with the view.
      scroll: (_event, view) => {
        opts.onScroll?.(view)
        return false
      },
    }),
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
  ]
}
