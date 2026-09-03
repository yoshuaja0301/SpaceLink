/**
 * SpaceLink — CodeMirror theme.
 *
 * Every colour here is a `var(--…)` from `src/styles/theme.css`, so the editor
 * follows the app's light/dark tokens for free and there is exactly one place
 * to change a colour. `src/styles/app.css` also styles `.editor-host .cm-*`;
 * those rules are more specific and deliberately win — this theme is the base
 * layer that keeps the editor correct on its own (in a test, or in a pane that
 * has not been given the host class yet).
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/** Structural + chrome styling, bound to the app's design tokens. */
export const editorTheme: Extension = EditorView.theme({
  '&': {
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-normal)',
    height: '100%',
    fontFamily: 'var(--font-editor)',
    lineHeight: 'var(--line-height-normal)',
  },
  '&.cm-focused': { outline: 'none' },

  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '0 var(--space-6)',
  },

  /* caret + selection ------------------------------------------------- */
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },

  /* gutters ------------------------------------------------------------ */
  '.cm-gutters': {
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-faint)',
    borderRight: '1px solid var(--divider)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.78em',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--text-muted)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0 var(--space-2)',
  },

  /* search panel + matches --------------------------------------------- */
  '.cm-panels': {
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text-normal)',
    borderColor: 'var(--border)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--font-size-ui)',
  },
  '.cm-panels input, .cm-panels button': {
    backgroundColor: 'var(--bg-primary)',
    color: 'var(--text-normal)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--highlight)', borderRadius: '2px' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },

  /* completion tooltip -------------------------------------------------- */
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-modal)',
    color: 'var(--text-normal)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-md)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--font-size-ui)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: 'var(--space-1) var(--space-3)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text-normal)',
  },
  '.cm-completionMatchedText': { color: 'var(--accent)', fontWeight: '700', textDecoration: 'none' },
  '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: 'var(--space-3)' },

  /* decorations the app stylesheet does not own ------------------------- */
  '.cm-highlight': { backgroundColor: 'var(--highlight)', borderRadius: '2px' },
  '.cm-task-checkbox': {
    width: '1em',
    height: '1em',
    margin: '0 0.35em 0 0',
    verticalAlign: '-0.1em',
    accentColor: 'var(--accent)',
    cursor: 'pointer',
  },
})

/**
 * Markdown token colours. The editor loads `@codemirror/lang-markdown` without
 * `codeLanguages`, so embedded code is parsed as plain text — the code-oriented
 * tags below still earn their keep for frontmatter-ish content and keep the
 * style honest if a language is ever wired in.
 */
export const markdownHighlightStyle: HighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--text-normal)', fontWeight: '650' },
  { tag: tags.heading2, color: 'var(--text-normal)', fontWeight: '650' },
  { tag: tags.heading3, color: 'var(--text-normal)', fontWeight: '650' },
  { tag: tags.heading4, color: 'var(--text-normal)', fontWeight: '650' },
  { tag: tags.heading5, color: 'var(--text-normal)', fontWeight: '650' },
  { tag: tags.heading6, color: 'var(--text-muted)', fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--text-faint)' },
  { tag: tags.link, color: 'var(--link)' },
  { tag: tags.url, color: 'var(--link)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--code-text)', fontFamily: 'var(--font-mono)' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--text-faint)' },
  { tag: tags.contentSeparator, color: 'var(--border-strong)' },
  // `processingInstruction` is what lezer-markdown calls the `#`, `*`, `>` and
  // fence characters — dim them so the prose leads.
  { tag: tags.processingInstruction, color: 'var(--text-faint)' },
  { tag: tags.meta, color: 'var(--text-faint)' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: tags.string, color: 'var(--text-success)' },
  { tag: tags.number, color: 'var(--code-text)' },
  { tag: tags.bool, color: 'var(--accent)' },
  { tag: tags.invalid, color: 'var(--text-error)' },
])

/** The highlight style, packaged as an extension. */
export const editorHighlighting: Extension = syntaxHighlighting(markdownHighlightStyle)

export interface EditorAppearance {
  /** Base font size in px (the `fontSize` setting). */
  fontSize: number
  /** Font family override; an empty string keeps `var(--font-editor)`. */
  fontFamily: string
}

/**
 * The parts of the look that change at runtime. Kept out of `editorTheme` so
 * the static theme can be created once and only this slice is reconfigured
 * through a compartment when the user moves the font-size slider.
 */
export function editorAppearance({ fontSize, fontFamily }: EditorAppearance): Extension {
  const family = fontFamily.trim() === '' ? 'var(--font-editor)' : fontFamily
  return EditorView.theme({
    '&': { fontSize: `${fontSize}px`, fontFamily: family },
    '.cm-content': { fontFamily: family },
  })
}
