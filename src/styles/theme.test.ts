/*
 * Stylesheet regression tests.
 *
 * The three sheets are read from disk as text and checked the way a reviewer
 * would: resolve the tokens, composite the alpha layers, compute the
 * WCAG ratio, and assert the rules other components already emit classes for
 * actually exist. No DOM and no rendering, so nothing here is timing-flaky.
 */
import { readFileSync } from 'node:fs'

const read = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')

const appCss = read('./app.css')
const markdownCss = read('./markdown.css')
const themeCss = read('./theme.css')

/* -- colour maths ------------------------------------------------------- */

type Rgb = [number, number, number]

/** `#rrggbb`, `#rgb`, `rgb(...)` and `rgba(...)`; alpha is returned separately. */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const text = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const d = hex[1]
    const full = d.length === 3 ? d[0] + d[0] + d[1] + d[1] + d[2] + d[2] : d
    return {
      rgb: [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)],
      alpha: 1,
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text)
  if (fn) {
    const parts = fn[1].split(',').map((p) => Number(p.trim()))
    return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 }
  }
  throw new Error(`not a colour: ${value}`)
}

/** Paint `fg` at `alpha` over the opaque `bg`. */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as Rgb
}

/** `color-mix(in srgb, colour PCT%, transparent)` painted over `bg`. */
function wash(colour: Rgb, pct: number, bg: Rgb): Rgb {
  return composite(colour, pct / 100, bg)
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/* -- stylesheet parsing -------------------------------------------------- */

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration body of the first rule whose head matches `head` exactly. */
function ruleBody(css: string, head: string): string | null {
  const clean = stripComments(css)
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim())
    if (selectors.includes(head)) return match[2]
  }
  return null
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of body.split(';')) {
    const at = line.indexOf(':')
    if (at === -1) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** The `:root:not([data-theme='light'])` body inside the dark media query. */
function darkMediaBody(css: string): string {
  const clean = stripComments(css)
  const start = clean.indexOf('@media (prefers-color-scheme: dark)')
  expect(start).toBeGreaterThan(-1)
  const inner = clean.slice(start)
  const match = /:root:not\(\[data-theme='light'\]\)\s*\{([^{}]*)\}/.exec(inner)
  expect(match).not.toBeNull()
  return (match as RegExpExecArray)[1]
}

const lightTokens = declarations(ruleBody(themeCss, ':root') as string)
const darkMediaTokens = declarations(darkMediaBody(themeCss))
const darkExplicitTokens = declarations(ruleBody(themeCss, ":root[data-theme='dark']") as string)

/** Resolve `var(--x)` chains, then parse. Falls back to light for dark. */
function token(name: string, theme: 'light' | 'dark'): { rgb: Rgb; alpha: number } {
  const scope = theme === 'dark' ? { ...lightTokens, ...darkMediaTokens } : lightTokens
  let value = scope[name]
  for (let hops = 0; value !== undefined && value.startsWith('var('); hops += 1) {
    if (hops > 8) throw new Error(`var() cycle at ${name}`)
    value = scope[/var\((--[\w-]+)\)/.exec(value)?.[1] ?? '']
  }
  if (value === undefined) throw new Error(`undefined token: ${name} (${theme})`)
  return parseColor(value)
}

const opaque = (name: string, theme: 'light' | 'dark'): Rgb => token(name, theme).rgb
const THEMES = ['light', 'dark'] as const

/* -- tokens -------------------------------------------------------------- */

describe('theme tokens', () => {
  // Finding 17: --text-faint was sized against --bg-primary only, so it landed
  // at 4.30:1 (light) / 4.31:1 (dark) on --bg-tertiary and --bg-modal.
  const SURFACES = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-modal']

  it.each(THEMES)('--text-faint clears AA on every surface it is painted on (%s)', (theme) => {
    const fg = opaque('--text-faint', theme)
    for (const surface of SURFACES) {
      expect({ surface, ratio: contrast(fg, opaque(surface, theme)) }).toEqual({
        surface,
        ratio: expect.any(Number),
      })
      expect(contrast(fg, opaque(surface, theme))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(THEMES)('--text-faint stays quieter than --text-muted (%s)', (theme) => {
    const bg = opaque('--bg-primary', theme)
    expect(contrast(opaque('--text-faint', theme), bg)).toBeLessThan(
      contrast(opaque('--text-muted', theme), bg),
    )
  })

  // Finding 50: --accent as text is 3.79:1 on --bg-secondary in dark.
  it.each(THEMES)('--accent-text clears AA on every surface, where --accent did not (%s)', (theme) => {
    const accentText = opaque('--accent-text', theme)
    const accent = opaque('--accent', theme)
    for (const surface of SURFACES) {
      expect(contrast(accentText, opaque(surface, theme))).toBeGreaterThanOrEqual(4.5)
    }
    // it exists because --accent itself does not: 3.79:1 on --bg-secondary in dark
    expect(contrast(accentText, opaque('--bg-secondary', theme))).toBeGreaterThan(
      contrast(accent, opaque('--bg-secondary', theme)),
    )
  })

  it('defines every dark token on :root as well, so no colour lives only in a media query', () => {
    for (const name of Object.keys(darkMediaTokens)) {
      if (!name.startsWith('--')) continue
      expect(lightTokens).toHaveProperty(name)
    }
  })

  it('keeps the two dark blocks in sync', () => {
    expect(darkExplicitTokens).toEqual(darkMediaTokens)
  })
})

/* -- callouts ------------------------------------------------------------ */

describe('callout titles', () => {
  // Finding 16: `--callout-warning` and `--callout-info` were literal hexes
  // (#d08a1f / #3d8bd4) that did not change with the theme — 2.62:1 and 3.27:1
  // in light. `.callout-title` paints the title in --callout-color on
  // `color-mix(in srgb, var(--callout-color) 9%, transparent)`.
  const VARIANTS = {
    note: '--accent-text',
    info: '--callout-info',
    tip: '--text-success',
    warning: '--callout-warning',
    danger: '--text-error',
  }

  it.each(THEMES)('every callout colour clears AA against its own tint (%s)', (theme) => {
    for (const [variant, name] of Object.entries(VARIANTS)) {
      const colour = opaque(name, theme)
      const tint = wash(colour, 9, opaque('--bg-primary', theme))
      expect({ variant, pass: contrast(colour, tint) >= 4.5 }).toEqual({ variant, pass: true })
    }
  })

  it('drives every callout variant from a token, not a literal', () => {
    const clean = stripComments(markdownCss)
    for (const variant of Object.keys(VARIANTS)) {
      const rule = new RegExp(`\\.callout\\[data-callout='${variant}'\\][^{]*\\{([^}]*)\\}`).exec(clean)
      expect(rule?.[1]).toMatch(/--callout-color:\s*var\(--[\w-]+\)/)
    }
  })
})

describe('stylesheets', () => {
  it('hardcodes no colour outside theme.css', () => {
    for (const [name, css] of [
      ['app.css', appCss],
      ['markdown.css', markdownCss],
    ] as const) {
      expect({ name, literals: stripComments(css).match(/#[0-9a-f]{3,8}\b|\brgba?\(/gi) }).toEqual({
        name,
        literals: null,
      })
    }
  })
})

/* -- rules the components depend on -------------------------------------- */

describe('rules for classes the components already emit', () => {
  const has = (head: string): boolean => ruleBody(appCss, head) !== null

  // Finding 37: the wiki-link hover card had no rule at all, so it rendered as
  // transparent body text over the note.
  it('styles the wiki-link hover card as a floating surface', () => {
    const card = declarations(ruleBody(appCss, '.hover-preview') as string)
    expect(card.background).toBe('var(--bg-modal)')
    expect(card['box-shadow']).toBe('var(--shadow-lg)')
    expect(card.border).toContain('var(--border-strong)')
    expect(card['border-radius']).toBe('var(--radius-md)')
    expect(card.padding).toBeDefined()
    // above the panes and mobile sidebars, below the command palette (100)
    expect(Number(card['z-index'])).toBeGreaterThan(60)
    expect(Number(card['z-index'])).toBeLessThan(100)
    expect(declarations(ruleBody(appCss, '.hover-preview-title') as string)['font-weight']).toBe('650')
    expect(declarations(ruleBody(appCss, '.hover-preview-excerpt') as string).color).toBe('var(--text-muted)')
  })

  // Finding 33: drag-and-drop computed these classes and showed nothing.
  it('gives the file tree drop feedback', () => {
    const target = declarations(ruleBody(appCss, '.nav-item.is-drop-target') as string)
    expect(target.background).toBe('var(--accent-soft)')
    // a ring, not only a tint, so the target is not signalled by colour alone
    expect(target['box-shadow']).toContain('inset')
    expect(target['box-shadow']).toContain('var(--accent)')
    expect(declarations(ruleBody(appCss, '.nav-item.is-dragging') as string).opacity).toBeDefined()
    expect(declarations(ruleBody(appCss, '.nav-files-container.is-drop-target') as string)['box-shadow']).toContain(
      'var(--accent)',
    )
  })

  it('marks the tab drop position with a 2px accent bar', () => {
    for (const head of ['.tab.is-drop-before::before', '.tab.is-drop-after::after']) {
      const bar = declarations(ruleBody(appCss, head) as string)
      expect(bar.width).toBe('2px')
      expect(bar.background).toBe('var(--accent)')
      expect(bar.position).toBe('absolute')
    }
    expect(declarations(ruleBody(appCss, '.tab.is-dragging') as string).opacity).toBeDefined()
  })

  // Finding 32: the delete confirmation had no styling, so the destructive
  // "Delete" and the safe "Cancel" rendered as two identical bare words.
  it('styles the delete confirmation strip', () => {
    const strip = declarations(ruleBody(appCss, '.nav-confirm') as string)
    expect(strip.display).toBe('flex')
    expect(strip['box-shadow']).toContain('var(--text-error)')
    // indented to the row it belongs to, like `.nav-item`
    expect(strip['padding-left']).toContain('var(--depth, 0)')
    expect(has('.nav-confirm-text')).toBe(true)
    const buttons = declarations(ruleBody(appCss, '.nav-confirm-yes') as string)
    expect(buttons.height).toBeDefined()
    expect(buttons.padding).toBeDefined()
  })

  it('styles the scroll-into-view line flash and keeps it under reduced motion', () => {
    const flash = declarations(ruleBody(appCss, '.editor-host .cm-flash-line') as string)
    expect(flash['background-color']).toBe('var(--accent-soft)')
    expect(flash.animation).toContain('flash-line')
    // The blanket reduced-motion rule cuts every animation to 0.001ms, which
    // would end the flash before it is seen; the override keeps the highlight.
    const reduced = stripComments(appCss).slice(stripComments(appCss).indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(/\.editor-host \.cm-flash-line \{[^}]*animation:\s*none/.test(reduced)).toBe(true)
    expect(stripComments(appCss)).toMatch(/@keyframes flash-line/)
  })

  // Finding 50: which view mode is active was conveyed by a 2.73:1 hue alone.
  it('gives the active view-mode button a non-colour cue', () => {
    const active = declarations(ruleBody(appCss, '.tab-actions button.is-active') as string)
    expect(active.color).toBe('var(--accent-text)')
    // an underline, not only a fill
    expect(active['box-shadow']).toContain('inset')
    // and an opaque fill, so the glyph is not read against a 12%/18% tint
    expect(active.background).toBe('var(--bg-primary)')
    for (const theme of THEMES) {
      expect(contrast(opaque('--accent-text', theme), opaque('--bg-primary', theme))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('paints the unsaved-changes readout in the text-safe accent', () => {
    expect(declarations(ruleBody(appCss, '.statusbar-item.is-dirty') as string).color).toBe('var(--accent-text)')
    expect(declarations(ruleBody(appCss, '.editor-host .cm-completionMatchedText') as string).color).toBe(
      'var(--accent-text)',
    )
  })
})
