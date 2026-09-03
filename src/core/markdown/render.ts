/**
 * SpaceLink — markdown → sanitized HTML.
 *
 * Everything here is implemented as markdown-it rules (block / inline / core)
 * plus renderer rules. That matters: a naive "render then regex the HTML"
 * approach corrupts code fences, code spans and attribute values. Because the
 * SpaceLink extensions live inside the tokenizer, `[[link]]`, `#tag` and `$x$`
 * inside a fence or a backtick span are left completely untouched — the
 * tokenizer never offers those characters to our rules in the first place.
 *
 * The final HTML always goes through DOMPurify. Sanitization is not optional:
 * notes can contain raw HTML (`html: true`), and a vault may well be shared.
 *
 * The markdown-it instance is built once at module scope. Nothing that depends
 * on a `RenderContext` is cached — the context travels through markdown-it's
 * `env`, so `renderMarkdown` stays safe to call at animation frame rate.
 *
 * ## Task checkbox ownership (binding — the reading view writes files from it)
 *
 * Every task checkbox is emitted as
 * `<input class="task-checkbox" type="checkbox" data-src="PATH" data-line="N" … disabled>`.
 *
 * - `data-src` names the note the task text actually lives in and `data-line`
 *   is a 0-based line index into **that** note's source, frontmatter included.
 * - Inside a `![[Note]]` transclusion both refer to the *embedded* note, never
 *   to the note being displayed — `![[Note#Heading]]` and `![[Note#^block]]`
 *   included, where `data-line` still counts from the top of the embedded file
 *   rather than from the top of the extracted slice.
 * - So the UI has a single rule: rewrite line `data-line` of the note named by
 *   `data-src`. `data-src` is omitted only when the context names no note
 *   (`currentPath === ''`), which is why that rule is written
 *   `checkbox.dataset.src ?? <displayed path>`.
 *
 * Heading ids follow the same "must agree with the other module" discipline:
 * they are `slugifyHeading(text)` de-duplicated per note exactly the way
 * `extractHeadings` in ./parse numbers repeats (`log`, `log-2`, `log-3`), so
 * `document.getElementById(headingElementId(heading.slug))` finds the heading
 * the parser meant. (The id is prefixed: see `headingElementId`.)
 */
import MarkdownIt from 'markdown-it'
import type {
  Env,
  MarkdownIt as MarkdownItInstance,
  StateBlock,
  StateCore,
  StateInline,
  Token,
} from 'markdown-it'
import DOMPurify from 'dompurify'
import type { Config as PurifyConfig } from 'dompurify'

import type { NoteFrontmatter, NotePath } from '../../types'
import { headingElementId, parseFrontmatter, slugifyHeading } from './parse'

export interface RenderContext {
  currentPath: NotePath
  /** Resolve `[[target]]` to a vault path, or null when the note does not exist. */
  resolveLink(target: string, fromPath: NotePath): NotePath | null
  /** Resolve an embedded image/attachment to a URL usable in `<img src>`. */
  resolveAsset?(target: string, fromPath: NotePath): string | null
  /** Raw markdown of an embedded note for `![[Note]]` transclusion. */
  getEmbedContent?(path: NotePath): string | null
  /** Recursion guard used internally by embeds. */
  depth?: number
}

/** `![[Note]]` transclusions never nest deeper than this. */
const MAX_EMBED_DEPTH = 3

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape text for use in both element content and double-quoted attributes. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string)
}

function countLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0x0a) n += 1
  return n
}

function basenameOf(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.toLowerCase().endsWith('.md') ? file.slice(0, -3) : file
}

/** `#note`, `note/sub` … → an id-safe token. */
function idSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
}

/* ------------------------------------------------------------------ *
 * Render environment
 *
 * markdown-it hands `env` to every rule and every renderer rule, which makes it
 * the natural place to hang per-call state. Nothing context dependent is ever
 * stored on the shared parser instance.
 * ------------------------------------------------------------------ */

interface SfEnv {
  ctx: RenderContext
  /** Lines of the original source consumed by frontmatter (task `data-line` offset). */
  lineOffset: number
  /** True when `ctx` can actually resolve links (false for `renderInline`). */
  resolves: boolean
  /** `[^label]` → definition markdown, filled by the block rule. */
  footnoteDefs: Map<string, string>
  /** True while re-parsing a footnote definition, so refs inside it stay literal. */
  inFootnoteDef: boolean
}

interface RenderEnv extends Env {
  sf: SfEnv
}

const NEUTRAL_CTX: RenderContext = {
  currentPath: '',
  resolveLink: () => null,
}

function makeEnv(ctx: RenderContext, lineOffset: number, resolves: boolean): RenderEnv {
  return {
    sf: {
      ctx,
      lineOffset,
      resolves,
      footnoteDefs: new Map<string, string>(),
      inFootnoteDef: false,
    },
  }
}

function sfOf(env: unknown): SfEnv {
  const holder = env as { sf?: SfEnv } | undefined | null
  if (holder && holder.sf) return holder.sf
  // Defensive: a rule invoked without our env still renders, just inertly.
  return makeEnv(NEUTRAL_CTX, 0, false).sf
}

/* The vault callbacks come from other modules; never let them break a render. */

function safeResolveLink(ctx: RenderContext, target: string): NotePath | null {
  try {
    return ctx.resolveLink(target, ctx.currentPath)
  } catch {
    return null
  }
}

function safeResolveAsset(ctx: RenderContext, target: string): string | null {
  try {
    return ctx.resolveAsset ? ctx.resolveAsset(target, ctx.currentPath) : null
  } catch {
    return null
  }
}

function safeEmbedContent(ctx: RenderContext, path: NotePath): string | null {
  try {
    return ctx.getEmbedContent ? ctx.getEmbedContent(path) : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Wiki link / embed target parsing
 * ------------------------------------------------------------------ */

interface WikiTarget {
  target: string
  heading: string
  blockId: string
  /** The `|…` part: a display alias for links, a size for image embeds. */
  alias: string
}

function parseWikiTarget(inner: string): WikiTarget {
  const bar = inner.indexOf('|')
  const linkPart = (bar === -1 ? inner : inner.slice(0, bar)).trim()
  const alias = bar === -1 ? '' : inner.slice(bar + 1).trim()

  let target = linkPart
  let heading = ''
  let blockId = ''
  const hash = linkPart.indexOf('#')
  if (hash !== -1) {
    target = linkPart.slice(0, hash).trim()
    const fragment = linkPart.slice(hash + 1).trim()
    if (fragment.startsWith('^')) blockId = fragment.slice(1)
    else heading = fragment
  }
  return { target, heading, blockId, alias }
}

/** alias → "Target > Heading" → Target. */
function wikiDisplay(t: WikiTarget): string {
  if (t.alias) return t.alias
  // `[[#Heading]]` is a same-note link: there is no target to prefix with.
  if (t.heading) return t.target ? `${t.target} > ${t.heading}` : t.heading
  if (t.blockId) return t.target || `^${t.blockId}`
  return t.target
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])

function extensionOf(target: string): string {
  const dot = target.lastIndexOf('.')
  const slash = target.lastIndexOf('/')
  return dot > slash + 1 ? target.slice(dot + 1).toLowerCase() : ''
}

/* ------------------------------------------------------------------ *
 * Inline rule: [[wiki links]] and ![[embeds]]
 * ------------------------------------------------------------------ */

function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const start = state.pos
  let pos = start
  let embed = false
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    embed = true
    pos += 1
  }
  if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) return false

  const close = src.indexOf(']]', pos + 2)
  if (close === -1 || close + 2 > state.posMax) return false

  const inner = src.slice(pos + 2, close)
  // Wiki links never span lines and never nest.
  if (inner.length === 0 || inner.includes('\n') || inner.includes('[[')) return false

  if (!silent) {
    const token = state.push(embed ? 'sf_embed' : 'sf_wikilink', '', 0)
    token.content = inner
    token.markup = src.slice(start, close + 2)
  }
  state.pos = close + 2
  return true
}

function renderWikiLink(tokens: Token[], idx: number, _options: unknown, env: unknown): string {
  const sf = sfOf(env)
  const t = parseWikiTarget(tokens[idx]!.content)
  // An empty target means "this note" (`[[#Heading]]`), which always resolves.
  const href = t.target || sf.ctx.currentPath
  const resolved = t.target ? safeResolveLink(sf.ctx, t.target) !== null : true
  const unresolved = sf.resolves && !resolved

  const cls = unresolved ? 'internal-link is-unresolved' : 'internal-link'
  const heading = t.heading ? ` data-heading="${escapeHtml(t.heading)}"` : ''
  const block = t.blockId ? ` data-block="${escapeHtml(t.blockId)}"` : ''
  return (
    `<a class="${cls}" data-href="${escapeHtml(href)}"${heading}${block} href="#">` +
    `${escapeHtml(wikiDisplay(t))}</a>`
  )
}

/* ------------------------------------------------------------------ *
 * Embeds
 * ------------------------------------------------------------------ */

/**
 * Chain of note paths currently being rendered. `renderBody` pushes/pops it, so
 * `A → B → A` is detected even when the depth budget has not run out. A module
 * level stack is safe because rendering is synchronous and strictly nested.
 */
const embedStack: NotePath[] = []

function renderEmbed(tokens: Token[], idx: number, _options: unknown, env: unknown): string {
  const sf = sfOf(env)
  const token = tokens[idx]!
  const raw = token.markup || `![[${token.content}]]`
  const t = parseWikiTarget(token.content)
  if (IMAGE_EXTENSIONS.has(extensionOf(t.target))) return renderImageEmbed(t, raw, sf)
  return renderNoteEmbed(t, raw, sf)
}

function missingEmbed(raw: string): string {
  return `<span class="embed-missing">${escapeHtml(raw)}</span>`
}

function renderImageEmbed(t: WikiTarget, raw: string, sf: SfEnv): string {
  const url = safeResolveAsset(sf.ctx, t.target)
  if (!url) return missingEmbed(raw)

  // For image embeds the `|…` slot carries a size: `300` or `300x200`.
  const size = /^(\d+)(?:x(\d+))?$/.exec(t.alias)
  let dims = ''
  if (size) {
    dims = ` width="${size[1]}"`
    if (size[2]) dims += ` height="${size[2]}"`
  }
  const alt = t.alias && !size ? t.alias : t.target
  return `<img class="embed-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${dims}>`
}

function renderNoteEmbed(t: WikiTarget, raw: string, sf: SfEnv): string {
  const path = t.target ? safeResolveLink(sf.ctx, t.target) : sf.ctx.currentPath
  if (!path) return missingEmbed(raw)

  const depth = sf.ctx.depth ?? 0
  const label = t.target || basenameOf(path)

  if (depth >= MAX_EMBED_DEPTH || embedStack.includes(path)) {
    const title = t.alias || (t.heading ? `${label} > ${t.heading}` : label)
    return (
      `<div class="embed embed-cycle" data-href="${escapeHtml(label)}">` +
      `<div class="embed-title">${escapeHtml(title)}</div>` +
      `<div class="embed-body">Embedded content omitted (circular or too deeply nested).</div>` +
      `</div>`
    )
  }

  const content = safeEmbedContent(sf.ctx, path)
  if (content === null || content === undefined) return missingEmbed(raw)

  const parsed = parseFrontmatter(content)
  const fmTitle = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : ''
  const title =
    t.alias ||
    (t.heading
      ? `${fmTitle || label} > ${t.heading}`
      : t.blockId
        ? `${fmTitle || label} > ^${t.blockId}`
        : fmTitle || basenameOf(path))

  // `data-line` inside the embed has to index the embedded note's own source,
  // so the offset is that note's frontmatter plus wherever the slice starts.
  const slice: BodySlice = t.heading
    ? extractHeadingSection(parsed.body, t.heading)
    : t.blockId
      ? extractBlock(parsed.body, t.blockId)
      : { text: parsed.body, line: 0 }
  const lineOffset = countLines(content.slice(0, parsed.bodyOffset)) + slice.line

  const parent = sf.ctx
  const childCtx: RenderContext = {
    currentPath: path,
    depth: depth + 1,
    resolveLink: (target, fromPath) => parent.resolveLink(target, fromPath),
    resolveAsset: (target, fromPath) =>
      parent.resolveAsset ? parent.resolveAsset(target, fromPath) : null,
    getEmbedContent: (p) => (parent.getEmbedContent ? parent.getEmbedContent(p) : null),
  }
  const inner = renderBody(slice.text, childCtx, lineOffset)

  return (
    `<div class="embed" data-href="${escapeHtml(label)}">` +
    `<div class="embed-title">${escapeHtml(title)}</div>` +
    `<div class="embed-body">${inner}</div>` +
    `</div>`
  )
}

const FENCE_LINE = /^\s{0,3}(?:```|~~~)/

/** A slice of an embedded note: its text plus the 0-based body line it starts on. */
interface BodySlice {
  text: string
  line: number
}

/**
 * Slice out the section owned by `heading`: the heading line itself plus
 * everything up to the next heading of the same or higher level. Fenced code is
 * skipped so a `# comment` inside a shell block does not end the section.
 */
function extractHeadingSection(body: string, heading: string): BodySlice {
  const wanted = slugifyHeading(heading)
  const wantedText = heading.trim().toLowerCase()
  const lines = body.split('\n')

  let inFence = false
  let startIdx = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (!m) continue
    const text = (m[2] as string).replace(/\s+#+\s*$/, '').trim()
    if (slugifyHeading(text) === wanted || text.toLowerCase() === wantedText) {
      startIdx = i
      level = (m[1] as string).length
      break
    }
  }
  if (startIdx === -1) return { text: '', line: 0 }

  inFence = false
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^ {0,3}(#{1,6})\s+/.exec(line)
    if (m && (m[1] as string).length <= level) {
      endIdx = i
      break
    }
  }
  return { text: lines.slice(startIdx, endIdx).join('\n'), line: startIdx }
}

/** A line that is a block of its own: a heading, a fence or a thematic break. */
const OWN_BLOCK = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|```|~~~|(?:[-*_][ \t]*){3,}$)/
const LIST_ITEM_START = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/

/**
 * `![[Note#^id]]` — the block (paragraph / list item) tagged with `^id`: the
 * lines above the marker back to the start of *that* block, not back to the
 * previous blank line. A heading, a fence or a rule is never part of it, and a
 * list item begins it — `- item\nmore ^id` is one item, the second line its
 * continuation, and the item is what gets embedded.
 */
function extractBlock(body: string, blockId: string): BodySlice {
  const lines = body.split('\n')
  const marker = new RegExp(`\\s\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  for (let i = 0; i < lines.length; i += 1) {
    if (!marker.test(lines[i] as string)) continue
    let from = i
    const own = lines[i] as string
    if (!OWN_BLOCK.test(own) && !LIST_ITEM_START.test(own)) {
      while (from > 0) {
        const above = lines[from - 1] as string
        if (above.trim() === '' || OWN_BLOCK.test(above)) break
        from -= 1
        if (LIST_ITEM_START.test(above)) break
      }
    }
    const block = lines.slice(from, i + 1)
    block[block.length - 1] = (block[block.length - 1] as string).replace(marker, '')
    return { text: block.join('\n'), line: from }
  }
  return { text: '', line: 0 }
}

/* ------------------------------------------------------------------ *
 * Inline rule: #tags
 * ------------------------------------------------------------------ */

/**
 * A `#` only opens a tag when it is not glued to the end of a word. Rejecting
 * these characters is what keeps `https://x.dev/page#frag` and `issue#12` from
 * turning into tags, while still allowing `**#tag**` and `(#tag)`.
 */
const TAG_BLOCKED_PREFIX = /[\p{L}\p{N}/\\.\-&=?%#]/u
const TAG_NAME = /^[\p{L}\p{N}_\-/]+/u

function tagRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x23 /* # */) return false
  if (pos > 0 && TAG_BLOCKED_PREFIX.test(src[pos - 1] as string)) return false

  const m = TAG_NAME.exec(src.slice(pos + 1, state.posMax))
  if (!m) return false

  // Trailing separators belong to the surrounding prose, not the tag.
  const name = (m[0] as string).replace(/[-/_]+$/, '')
  if (!name) return false
  // `#1` is a number, not a tag.
  if (/^\d+$/.test(name)) return false

  if (!silent) {
    const token = state.push('sf_tag', '', 0)
    token.content = name
  }
  state.pos = pos + 1 + name.length
  return true
}

function renderTag(tokens: Token[], idx: number): string {
  const name = tokens[idx]!.content
  return `<a class="tag" data-tag="${escapeHtml(name)}" href="#">#${escapeHtml(name)}</a>`
}

/* ------------------------------------------------------------------ *
 * Math ($inline$ / $$block$$)
 * ------------------------------------------------------------------ */

/**
 * KaTeX, and the fonts and stylesheet that come with it, is the largest single
 * thing this app could ship — a third of the bundle — and most vaults contain
 * no mathematics at all. So it is not shipped up front: the first `$…$` that
 * anything actually renders fetches it, and until it lands the expression is
 * shown as the TeX its author typed, which is at least readable. `onMathReady`
 * is how the preview learns to render again.
 */
type KatexRender = (tex: string, options: Record<string, unknown>) => string

let katexRender: KatexRender | null = null
let katexLoading: Promise<void> | null = null
const mathListeners = new Set<() => void>()

/** Called once KaTeX has arrived, so anything already rendered can render again. */
export function onMathReady(listener: () => void): () => void {
  mathListeners.add(listener)
  return () => {
    mathListeners.delete(listener)
  }
}

/** True once math renders as mathematics rather than as its source. */
export function isMathReady(): boolean {
  return katexRender !== null
}

/**
 * Fetch KaTeX. Safe to call repeatedly — the work happens once — and awaited
 * by callers that would rather wait than show the TeX briefly.
 */
export function loadMath(): Promise<void> {
  if (katexRender) return Promise.resolve()
  katexLoading ??= (async () => {
    const [katex] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    // KaTeX ships as CommonJS, and whether the named export or the default one
    // carries `renderToString` depends on the bundler's interop. Both are read.
    const shapes = katex as unknown as { renderToString?: KatexRender; default?: { renderToString?: KatexRender } }
    const render = shapes.renderToString ?? shapes.default?.renderToString
    if (!render) throw new Error('KaTeX loaded without a renderer')
    katexRender = render
    // Copied first: a listener may unsubscribe while we iterate.
    for (const listener of [...mathListeners]) listener()
  })().catch(() => {
    // A failed fetch must not poison every later attempt — a reader who comes
    // back online should get their equations.
    katexLoading = null
  })
  return katexLoading
}

function katexHtml(tex: string, displayMode: boolean, raw: string): string {
  if (!katexRender) {
    void loadMath()
    return `<span class="math-pending">${escapeHtml(raw)}</span>`
  }
  try {
    // `throwOnError: false` already renders malformed TeX in red; the try/catch
    // covers the cases KaTeX still escalates (e.g. unrecoverable internals).
    return katexRender(tex, {
      throwOnError: false,
      displayMode,
      output: 'html',
      strict: 'ignore',
    })
  } catch {
    return `<span class="math-error">${escapeHtml(raw)}</span>`
  }
}

/**
 * A `$` is only a delimiter when it hugs its content. Mirrors the classic
 * markdown-it-katex heuristic, which is what makes `$5 and $10` plain text.
 */
function delimKinds(src: string, pos: number, max: number): { canOpen: boolean; canClose: boolean } {
  const prev = pos > 0 ? src.charCodeAt(pos - 1) : -1
  const next = pos + 1 <= max ? src.charCodeAt(pos + 1) : -1
  let canOpen = true
  let canClose = true
  // A closer may not follow whitespace, and may not be followed by a digit —
  // that second clause is what rules out currency amounts.
  if (prev === 0x20 || prev === 0x09 || (next >= 0x30 && next <= 0x39)) canClose = false
  if (next === 0x20 || next === 0x09 || next === -1) canOpen = false
  return { canOpen, canClose }
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const start = state.pos
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false

  const display = src.charCodeAt(start + 1) === 0x24
  const markerLen = display ? 2 : 1
  if (!display && !delimKinds(src, start, state.posMax).canOpen) return false
  if (display && start + 2 >= state.posMax) return false

  let pos = start + markerLen
  let found = -1
  while (pos < state.posMax) {
    const code = src.charCodeAt(pos)
    if (code === 0x5c /* \ */) {
      pos += 2
      continue
    }
    if (code === 0x24) {
      if (display) {
        if (src.charCodeAt(pos + 1) === 0x24) {
          found = pos
          break
        }
        pos += 1
        continue
      }
      if (delimKinds(src, pos, state.posMax).canClose) {
        found = pos
        break
      }
      pos += 1
      continue
    }
    pos += 1
  }
  if (found === -1 || found + markerLen > state.posMax) return false

  const content = src.slice(start + markerLen, found)
  if (content.trim().length === 0) return false

  if (!silent) {
    const token = state.push('sf_math_inline', '', 0)
    token.content = content
    token.markup = src.slice(start, found + markerLen)
    token.meta = { display }
  }
  state.pos = found + markerLen
  return true
}

function mathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false
  const begin = state.bMarks[startLine]! + state.tShift[startLine]!
  const max = state.eMarks[startLine]!
  if (begin + 2 > max) return false
  if (state.src.charCodeAt(begin) !== 0x24 || state.src.charCodeAt(begin + 1) !== 0x24) return false

  const firstLine = state.src.slice(begin + 2, max)
  const trimmedFirst = firstLine.trimEnd()

  let content: string
  let lastLine = startLine

  if (trimmedFirst.endsWith('$$') && trimmedFirst.length >= 2) {
    // Single line: `$$ x = y $$`
    content = trimmedFirst.slice(0, -2)
  } else {
    const parts: string[] = []
    if (firstLine.trim()) parts.push(firstLine)
    let next = startLine
    let closed = false
    for (;;) {
      next += 1
      if (next >= endLine) break
      const b = state.bMarks[next]! + state.tShift[next]!
      const e = state.eMarks[next]!
      const line = state.src.slice(b, e)
      const trimmed = line.trimEnd()
      if (trimmed.endsWith('$$')) {
        const tail = trimmed.slice(0, -2)
        if (tail.trim()) parts.push(tail)
        closed = true
        lastLine = next
        break
      }
      parts.push(line)
    }
    if (!closed) return false
    content = parts.join('\n')
  }

  if (silent) return true

  state.line = lastLine + 1
  const token = state.push('sf_math_block', 'div', 0)
  token.block = true
  token.content = content
  token.markup = '$$'
  token.map = [startLine, state.line]
  return true
}

function renderMathInline(tokens: Token[], idx: number): string {
  const token = tokens[idx]!
  const display = Boolean((token.meta as { display?: boolean } | null)?.display)
  const html = katexHtml(token.content, display, token.markup)
  return `<span class="math ${display ? 'math-display' : 'math-inline'}">${html}</span>`
}

function renderMathBlock(tokens: Token[], idx: number): string {
  const token = tokens[idx]!
  const html = katexHtml(token.content, true, `$$${token.content}$$`)
  return `<div class="math-block">${html}</div>\n`
}

/* ------------------------------------------------------------------ *
 * Fenced / indented code
 * ------------------------------------------------------------------ */

function renderFence(tokens: Token[], idx: number): string {
  const token = tokens[idx]!
  const info = token.info.trim()
  const lang = info.split(/\s+/, 1)[0] ?? ''
  const codeClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
  return (
    `<pre class="code-block" data-lang="${escapeHtml(lang)}">` +
    `<code${codeClass}>${escapeHtml(token.content)}</code></pre>\n`
  )
}

function renderCodeBlock(tokens: Token[], idx: number): string {
  return `<pre class="code-block" data-lang=""><code>${escapeHtml(tokens[idx]!.content)}</code></pre>\n`
}

/* ------------------------------------------------------------------ *
 * Links
 * ------------------------------------------------------------------ */

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

function renderLinkOpen(
  tokens: Token[],
  idx: number,
  options: Parameters<MarkdownItInstance['renderer']['renderToken']>[2],
  env: unknown,
  self: MarkdownItInstance['renderer'],
): string {
  const token = tokens[idx]!
  const cls = String(token.attrGet('class') ?? '')
  // Guard against re-decorating: token streams are rendered once, but a plugin
  // or a re-render must not stack duplicate classes.
  if (!cls.includes('external-link') && !cls.includes('internal-link')) {
    const href = String(token.attrGet('href') ?? '')
    if (isExternalHref(href)) {
      token.attrJoin('class', 'external-link')
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    } else if (href && !href.startsWith('#')) {
      const sf = sfOf(env)
      const target = decodeHref(href)
      const resolved = safeResolveLink(sf.ctx, target) !== null
      token.attrJoin('class', sf.resolves && !resolved ? 'internal-link is-unresolved' : 'internal-link')
      token.attrSet('data-href', target)
      token.attrSet('href', '#')
    }
  }
  return self.renderToken(tokens, idx, options)
}

/* ------------------------------------------------------------------ *
 * Core rule: callouts (`> [!note] Title`)
 * ------------------------------------------------------------------ */

const CALLOUT_MARKER = /^\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/

function calloutTitleFallback(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function calloutRule(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i += 1) {
    const open = tokens[i] as Token
    if (open.type !== 'blockquote_open') continue

    const pOpen = tokens[i + 1]
    const inline = tokens[i + 2]
    const pClose = tokens[i + 3]
    if (!pOpen || !inline || !pClose) continue
    if (pOpen.type !== 'paragraph_open' || inline.type !== 'inline' || pClose.type !== 'paragraph_close') {
      continue
    }

    const newline = inline.content.indexOf('\n')
    const firstLine = newline === -1 ? inline.content : inline.content.slice(0, newline)
    const m = CALLOUT_MARKER.exec(firstLine)
    if (!m) continue

    let closeIdx = -1
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j] as Token
      if (t.type === 'blockquote_close' && t.level === open.level) {
        closeIdx = j
        break
      }
    }
    if (closeIdx === -1) continue

    const kind = (m[1] as string).toLowerCase()
    const fold = m[2] as string
    const titleText = (m[3] as string).trim() || calloutTitleFallback(kind)
    const rest = newline === -1 ? '' : inline.content.slice(newline + 1)

    open.tag = 'div'
    open.attrJoin('class', 'callout')
    open.attrSet('data-callout', kind)
    if (fold) open.attrSet('data-callout-fold', fold)
    ;(tokens[closeIdx] as Token).tag = 'div'

    const titleOpen = new state.Token('callout_title_open', 'div', 1)
    titleOpen.attrSet('class', 'callout-title')
    titleOpen.block = true
    titleOpen.level = open.level + 1

    const titleInline = new state.Token('inline', '', 0)
    titleInline.content = titleText
    titleInline.children = []
    titleInline.level = open.level + 2
    state.md.inline.parse(titleText, state.md, state.env, titleInline.children)

    const titleClose = new state.Token('callout_title_close', 'div', -1)
    titleClose.block = true
    titleClose.level = open.level + 1

    const bodyOpen = new state.Token('callout_body_open', 'div', 1)
    bodyOpen.attrSet('class', 'callout-body')
    bodyOpen.block = true
    bodyOpen.level = open.level + 1

    const bodyClose = new state.Token('callout_body_close', 'div', -1)
    bodyClose.block = true
    bodyClose.level = open.level + 1

    let replacement: Token[]
    if (rest.trim()) {
      // Text after the `[!kind]` line stays a paragraph, inside the body.
      inline.content = rest
      inline.children = []
      state.md.inline.parse(rest, state.md, state.env, inline.children)
      replacement = [titleOpen, titleInline, titleClose, bodyOpen, pOpen, inline, pClose]
    } else {
      replacement = [titleOpen, titleInline, titleClose, bodyOpen]
    }

    tokens.splice(i + 1, 3, ...replacement)
    const shift = replacement.length - 3
    tokens.splice(closeIdx + shift, 0, bodyClose)
    // Not skipped to the close: a callout can hold another callout, and the
    // inner one's `blockquote_open` is up ahead inside this one's body.
  }
}

/* ------------------------------------------------------------------ *
 * Core rule: lift standalone note embeds out of their paragraph
 * ------------------------------------------------------------------ */

/**
 * `![[Note]]` renders a `<div>`, and a `<div>` inside a `<p>` makes the HTML
 * parser split the paragraph, leaving empty `<p></p>` shards behind. When a
 * paragraph holds nothing but note transclusions we hide its wrapper instead.
 * Image embeds stay inline — they are legitimate paragraph content.
 */
function blockEmbedRule(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 1; i < tokens.length - 1; i += 1) {
    const inline = tokens[i] as Token
    if (inline.type !== 'inline') continue
    const open = tokens[i - 1] as Token
    const close = tokens[i + 1] as Token
    if (open.type !== 'paragraph_open' || close.type !== 'paragraph_close') continue

    const children = inline.children ?? []
    if (children.length === 0) continue

    let noteEmbeds = 0
    let onlyEmbeds = true
    for (const child of children) {
      if (child.type === 'sf_embed') {
        if (!IMAGE_EXTENSIONS.has(extensionOf(parseWikiTarget(child.content).target))) noteEmbeds += 1
        continue
      }
      if (child.type === 'softbreak' || child.type === 'hardbreak') continue
      if ((child.type === 'text' || child.type === 'text_special') && child.content.trim() === '') {
        continue
      }
      onlyEmbeds = false
      break
    }
    if (!onlyEmbeds || noteEmbeds === 0) continue

    open.hidden = true
    close.hidden = true
  }
}

/* ------------------------------------------------------------------ *
 * Core rule: task lists
 * ------------------------------------------------------------------ */

const TASK_MARKER = /^\[([ xX])\](?:[ \t]+|$)/

function taskListRule(state: StateCore): void {
  const tokens = state.tokens
  const sf = sfOf(state.env)

  for (let i = 2; i < tokens.length; i += 1) {
    const inline = tokens[i] as Token
    if (inline.type !== 'inline') continue
    const pOpen = tokens[i - 1] as Token
    const liOpen = tokens[i - 2] as Token
    if (pOpen.type !== 'paragraph_open' || liOpen.type !== 'list_item_open') continue

    const m = TASK_MARKER.exec(inline.content)
    if (!m) continue

    const checked = (m[1] as string) !== ' '
    // `data-line` indexes the ORIGINAL source of `data-src`, frontmatter
    // included: the UI toggles a task by rewriting exactly that line of exactly
    // that note. Inside an embed both belong to the embedded note, so a
    // transcluded task edits the file it came from, not the one on screen.
    const line = (liOpen.map?.[0] ?? inline.map?.[0] ?? 0) + sf.lineOffset

    const markerLen = (m[0] as string).length
    inline.content = inline.content.slice(markerLen)
    const first = inline.children?.[0]
    if (first && (first.type === 'text' || first.type === 'text_special')) {
      first.content = first.content.slice(markerLen)
    }

    const checkbox = new state.Token('sf_task_checkbox', 'input', 0)
    checkbox.meta = { checked, line, src: sf.ctx.currentPath }
    inline.children = [checkbox, ...(inline.children ?? [])]

    liOpen.attrJoin('class', 'task-item')

    // Mark the enclosing list. The parent list open token sits one nesting
    // level below the item, so the nearest such token walking backwards wins.
    for (let j = i - 3; j >= 0; j -= 1) {
      const t = tokens[j] as Token
      if (
        (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') &&
        t.level === liOpen.level - 1
      ) {
        if (!String(t.attrGet('class') ?? '').includes('task-list')) t.attrJoin('class', 'task-list')
        break
      }
    }
  }
}

function renderTaskCheckbox(tokens: Token[], idx: number): string {
  const meta = (tokens[idx]!.meta ?? {}) as { checked?: boolean; line?: number; src?: string }
  const checked = meta.checked ? ' checked' : ''
  const src = meta.src ? ` data-src="${escapeHtml(meta.src)}"` : ''
  return (
    `<input class="task-checkbox" type="checkbox"${src} ` +
    `data-line="${meta.line ?? 0}"${checked} disabled>`
  )
}

/* ------------------------------------------------------------------ *
 * Core rule: heading ids + anchors
 * ------------------------------------------------------------------ */

/** Readable text of an inline token, used to build heading slugs. */
function inlineText(token: Token): string {
  let out = ''
  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
      case 'text_special':
      case 'code_inline':
        out += child.content
        break
      case 'sf_wikilink':
        out += wikiDisplay(parseWikiTarget(child.content))
        break
      case 'sf_tag':
        out += `#${child.content}`
        break
      case 'sf_math_inline':
        out += child.content
        break
      case 'softbreak':
      case 'hardbreak':
        out += ' '
        break
      default:
        break
    }
  }
  return out
}

const ATX_SOURCE = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/

/**
 * The heading's text as written in the source — what `extractHeadings` slugs.
 * Null when the heading sits inside a container (`> # Quoted`), which the
 * parser does not index either.
 */
function headingSourceText(lines: string[], open: Token): string | null {
  const map = open.map
  if (!map) return null
  if (open.markup.startsWith('#')) {
    const m = ATX_SOURCE.exec(lines[map[0]] ?? '')
    if (!m) return null
    return (m[1] ?? '').replace(/(^|[ \t])#+[ \t]*$/, '$1')
  }
  // Setext: every line above the underline is the heading.
  return lines.slice(map[0], map[1] - 1).join('\n')
}

function headingRule(state: StateCore): void {
  const tokens = state.tokens
  // Repeats are numbered per note, exactly as `extractHeadings` numbers them —
  // core rules run once per `render`, and an embed renders through its own
  // `renderBody`, so this counter never leaks across a note boundary.
  const slugCounts = new Map<string, number>()
  let lines: string[] | null = null
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const open = tokens[i] as Token
    if (open.type !== 'heading_open') continue
    const inline = tokens[i + 1] as Token
    if (inline.type !== 'inline') continue

    // The outline panel and the command palette look the heading up by the slug
    // `extractHeadings` reported, so the id has to match that one exactly —
    // numbering included, and duplicate ids would break `getElementById` anyway.
    // It is slugged from the same source text the parser read: `_em_`, `&amp;`,
    // inline HTML and a wiki link all render to something other than their
    // spelling, and the parser never sees the rendering.
    lines ??= state.src.split('\n')
    const base = slugifyHeading(headingSourceText(lines, open) ?? inlineText(inline))
    if (!base) continue
    const seen = slugCounts.get(base) ?? 0
    slugCounts.set(base, seen + 1)
    const slug = seen === 0 ? base : `${base}-${seen + 1}`
    open.attrSet('id', headingElementId(slug))

    const anchor = new state.Token('sf_heading_anchor', '', 0)
    anchor.meta = { slug }
    inline.children = [...(inline.children ?? []), anchor]
  }
}

function renderHeadingAnchor(tokens: Token[], idx: number): string {
  const slug = String((tokens[idx]!.meta as { slug?: string } | null)?.slug ?? '')
  return `<a class="heading-anchor" href="#${escapeHtml(slug)}" aria-hidden="true">#</a>`
}

/* ------------------------------------------------------------------ *
 * Footnotes
 * ------------------------------------------------------------------ */

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/

function footnoteDefRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false
  const begin = state.bMarks[startLine]! + state.tShift[startLine]!
  const max = state.eMarks[startLine]!
  if (state.src.charCodeAt(begin) !== 0x5b /* [ */ || state.src.charCodeAt(begin + 1) !== 0x5e) {
    return false
  }
  const m = FOOTNOTE_DEF.exec(state.src.slice(begin, max))
  if (!m) return false
  if (silent) return true

  const parts: string[] = []
  if (m[2]) parts.push(m[2] as string)

  // Lazy continuation: keep swallowing lines until a blank line or a new
  // definition. Footnote bodies are single paragraphs in practice.
  let next = startLine + 1
  while (next < endLine && !state.isEmpty(next)) {
    const b = state.bMarks[next]! + state.tShift[next]!
    const e = state.eMarks[next]!
    const text = state.src.slice(b, e)
    if (/^\[\^[^\]\s]+\]:/.test(text)) break
    parts.push(text)
    next += 1
  }

  sfOf(state.env).footnoteDefs.set(m[1] as string, parts.join('\n').trim())
  state.line = next
  return true
}

function footnoteRefRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5e) return false

  const close = src.indexOf(']', pos + 2)
  if (close === -1 || close >= state.posMax) return false
  const label = src.slice(pos + 2, close)
  if (!label || /\s/.test(label)) return false
  if (src.charCodeAt(close + 1) === 0x3a /* : */) return false

  const sf = sfOf(state.env)
  // Block parsing runs first, so every definition is already known here.
  if (sf.inFootnoteDef || !sf.footnoteDefs.has(label)) return false

  if (!silent) {
    const token = state.push('sf_footnote_ref', '', 0)
    token.content = label
    token.meta = { label }
  }
  state.pos = close + 1
  return true
}

function footnoteSectionRule(state: StateCore): void {
  const sf = sfOf(state.env)
  if (sf.footnoteDefs.size === 0) return

  const order: string[] = []
  const numbers = new Map<string, number>()
  const uses = new Map<string, number>()

  for (const token of state.tokens) {
    if (token.type !== 'inline') continue
    for (const child of token.children ?? []) {
      if (child.type !== 'sf_footnote_ref') continue
      const label = String((child.meta as { label?: string } | null)?.label ?? '')
      let index = numbers.get(label)
      if (index === undefined) {
        index = order.push(label)
        numbers.set(label, index)
      }
      const occurrence = (uses.get(label) ?? 0) + 1
      uses.set(label, occurrence)
      child.meta = { label, index, occurrence }
    }
  }
  if (order.length === 0) return

  const out: Token[] = []
  const sectionOpen = new state.Token('sf_footnotes_open', 'section', 1)
  sectionOpen.block = true
  out.push(sectionOpen)

  sf.inFootnoteDef = true
  try {
    for (const label of order) {
      const itemOpen = new state.Token('sf_footnote_open', 'li', 1)
      itemOpen.block = true
      itemOpen.meta = { label }
      out.push(itemOpen)

      const body = new state.Token('inline', '', 0)
      body.content = sf.footnoteDefs.get(label) ?? ''
      body.children = []
      state.md.inline.parse(body.content, state.md, state.env, body.children)
      out.push(body)

      const backref = new state.Token('sf_footnote_backref', '', 0)
      backref.meta = { label, uses: uses.get(label) ?? 1 }
      out.push(backref)

      const itemClose = new state.Token('sf_footnote_close', 'li', -1)
      itemClose.block = true
      out.push(itemClose)
    }
  } finally {
    sf.inFootnoteDef = false
  }

  const sectionClose = new state.Token('sf_footnotes_close', 'section', -1)
  sectionClose.block = true
  out.push(sectionClose)

  state.tokens.push(...out)
}

function renderFootnoteRef(tokens: Token[], idx: number): string {
  const meta = (tokens[idx]!.meta ?? {}) as { label?: string; index?: number; occurrence?: number }
  const id = idSafe(meta.label ?? '')
  const suffix = (meta.occurrence ?? 1) > 1 ? `-${meta.occurrence}` : ''
  return (
    `<sup class="footnote-ref">` +
    `<a href="#fn-${id}" id="fnref-${id}${suffix}">${meta.index ?? 1}</a></sup>`
  )
}

function renderFootnoteBackref(tokens: Token[], idx: number): string {
  const meta = (tokens[idx]!.meta ?? {}) as { label?: string; uses?: number }
  const id = idSafe(meta.label ?? '')
  const total = meta.uses ?? 1
  let html = ''
  for (let n = 1; n <= total; n += 1) {
    const suffix = n > 1 ? `-${n}` : ''
    html += ` <a class="footnote-backref" href="#fnref-${id}${suffix}">↩</a>`
  }
  return html
}

/* ------------------------------------------------------------------ *
 * Frontmatter property table
 * ------------------------------------------------------------------ */

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

function tagChip(value: string): string {
  const name = value.trim().replace(/^#/, '')
  if (!name) return ''
  return `<a class="tag" data-tag="${escapeHtml(name)}" href="#">#${escapeHtml(name)}</a>`
}

function chip(text: string): string {
  return `<span class="frontmatter-chip">${escapeHtml(text)}</span>`
}

function isTagKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'tag' || k === 'tags'
}

function frontmatterValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (isTagKey(key) ? tagChip(scalarText(item)) : chip(scalarText(item))))
      .filter(Boolean)
    return parts.join(' ')
  }
  if (isTagKey(key) && typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((part) => tagChip(part))
      .filter(Boolean)
      .join(' ')
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => chip(`${k}: ${scalarText(v)}`))
      .join(' ')
  }
  return escapeHtml(scalarText(value))
}

function renderFrontmatterTable(frontmatter: NoteFrontmatter): string {
  const keys = Object.keys(frontmatter)
  if (keys.length === 0) return ''
  const rows = keys
    .map(
      (key) =>
        `<tr class="frontmatter-row">` +
        `<th class="frontmatter-key" scope="row">${escapeHtml(key)}</th>` +
        `<td class="frontmatter-value">${frontmatterValue(key, frontmatter[key])}</td></tr>`,
    )
    .join('')
  return `<div class="frontmatter"><table class="frontmatter-table"><tbody>${rows}</tbody></table></div>`
}

/* ------------------------------------------------------------------ *
 * The parser instance
 * ------------------------------------------------------------------ */

let cachedMd: MarkdownItInstance | null = null

function createMd(): MarkdownItInstance {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
  })

  // Block rules. Footnote definitions must beat the reference-definition rule,
  // since `[^x]: y` is also a valid link reference.
  md.block.ruler.before('reference', 'sf_footnote_def', footnoteDefRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.block.ruler.before('fence', 'sf_math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })

  // Inline rules run before `link`/`image`, but after `escape` and `backticks`
  // — which is exactly why `\#tag` and `` `[[x]]` `` are left alone.
  md.inline.ruler.before('link', 'sf_wikilink', wikiLinkRule)
  md.inline.ruler.before('link', 'sf_footnote_ref', footnoteRefRule)
  md.inline.ruler.before('link', 'sf_tag', tagRule)
  md.inline.ruler.before('link', 'sf_math_inline', mathInlineRule)

  // Core rules run after `inline`, so token children already exist.
  md.core.ruler.push('sf_callouts', calloutRule)
  md.core.ruler.push('sf_block_embeds', blockEmbedRule)
  md.core.ruler.push('sf_tasks', taskListRule)
  md.core.ruler.push('sf_headings', headingRule)
  md.core.ruler.push('sf_footnotes', footnoteSectionRule)

  const rules = md.renderer.rules
  rules.sf_wikilink = renderWikiLink
  rules.sf_embed = renderEmbed
  rules.sf_tag = renderTag
  rules.sf_math_inline = renderMathInline
  rules.sf_math_block = renderMathBlock
  rules.sf_task_checkbox = renderTaskCheckbox
  rules.sf_heading_anchor = renderHeadingAnchor
  rules.sf_footnote_ref = renderFootnoteRef
  rules.sf_footnote_backref = renderFootnoteBackref
  rules.sf_footnotes_open = () => '<section class="footnotes"><hr class="footnotes-sep">\n<ol class="footnotes-list">\n'
  rules.sf_footnotes_close = () => '</ol>\n</section>\n'
  rules.sf_footnote_open = (tokens, idx) => {
    const label = String((tokens[idx]!.meta as { label?: string } | null)?.label ?? '')
    return `<li id="fn-${idSafe(label)}" class="footnote-item">`
  }
  rules.sf_footnote_close = () => '</li>\n'
  rules.fence = renderFence
  rules.code_block = renderCodeBlock
  rules.link_open = renderLinkOpen

  return md
}

function getMd(): MarkdownItInstance {
  if (!cachedMd) cachedMd = createMd()
  return cachedMd
}

/* ------------------------------------------------------------------ *
 * Sanitization
 * ------------------------------------------------------------------ */

/**
 * Same shape as DOMPurify's default, plus `blob:` (object URLs handed back by
 * the vault adapters) and inline base64 images. `javascript:`, `vbscript:` and
 * `data:text/html` still fail every branch.
 */
const ALLOWED_URI =
  /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|blob):|data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml);base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

const PURIFY_CONFIG: PurifyConfig = {
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ADD_ATTR: [
    'target',
    'data-href',
    'data-heading',
    'data-block',
    'data-tag',
    'data-src',
    'data-line',
    'data-lang',
    'data-callout',
    'data-callout-fold',
  ],
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'form',
    'link',
    'meta',
    'base',
    'noscript',
    'template',
    'textarea',
    'select',
    'button',
  ],
  FORBID_ATTR: ['action', 'formaction', 'ping', 'srcdoc'],
  ALLOW_DATA_ATTR: true,
}

function sanitize(html: string): string {
  // No DOM (plain node, no jsdom) means DOMPurify is a no-op — refuse to emit
  // markup we could not clean rather than silently returning it raw.
  if (!DOMPurify.isSupported) return escapeHtml(html)
  return DOMPurify.sanitize(html, PURIFY_CONFIG)
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Render a note body (frontmatter already stripped) without sanitizing.
 * Also maintains `embedStack`, so a transclusion cycle is caught even when the
 * depth budget has not run out. The pop lives in `finally` to keep the stack
 * balanced if a rule throws.
 */
function renderBody(body: string, ctx: RenderContext, lineOffset: number): string {
  const env = makeEnv(ctx, lineOffset, true)
  const path = ctx.currentPath
  if (path) embedStack.push(path)
  try {
    return getMd().render(body, env)
  } finally {
    if (path) embedStack.pop()
  }
}

/** Returns sanitized HTML. Never returns untrusted markup. */
export function renderMarkdown(source: string, ctx: RenderContext): string {
  const { frontmatter, body, bodyOffset } = parseFrontmatter(source)
  const lineOffset = countLines(source.slice(0, bodyOffset))
  const html = renderBody(body, ctx, lineOffset)
  return sanitize(renderFrontmatterTable(frontmatter) + html)
}

/** Rendered HTML for a heading-anchored table of contents. */
export function renderInline(source: string): string {
  // No vault context here, so internal links render neutrally rather than
  // claiming every target is missing.
  const env = makeEnv(NEUTRAL_CTX, 0, false)
  return sanitize(getMd().renderInline(source, env))
}
