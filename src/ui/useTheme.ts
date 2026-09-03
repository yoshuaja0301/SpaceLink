/**
 * SpaceFore — theme application.
 *
 * `settings.theme` is the *choice* ('dark' | 'light' | 'system'); the attribute
 * on `<html>` is the *result*. `src/styles/theme.css` defines the light tokens
 * on bare `:root`, the dark tokens under `prefers-color-scheme: dark` (unless
 * `[data-theme='light']` overrides it) and again under `[data-theme='dark']`.
 * So the rule here is simply:
 *
 *   'dark' | 'light' → set `data-theme`
 *   'system'         → remove it and let the media query decide
 *
 * Everything touches the DOM through feature detection: the hook runs in jsdom
 * during tests, where `matchMedia` may be missing or may be a stub without
 * `addEventListener`.
 */
import { useEffect } from 'react'

import type { ThemeName } from '../types'
import { useAppStore } from '../state/store'

/**
 * Fallbacks for `<meta name="theme-color">` when the custom property cannot be
 * read (no stylesheet loaded — i.e. tests). These mirror `--bg-secondary` in
 * `src/styles/theme.css`; the live value always wins when it is available.
 */
const FALLBACK_THEME_COLOR: Record<'dark' | 'light', string> = {
  dark: '#191a1e',
  light: '#f6f5f9',
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The OS preference query, or null when the browser cannot answer. */
function darkMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  try {
    return window.matchMedia(DARK_QUERY)
  } catch {
    // Some embedded webviews throw on unsupported queries.
    return null
  }
}

/** Which of the two palettes a theme choice actually resolves to right now. */
export function resolveTheme(theme: ThemeName): 'dark' | 'light' {
  if (theme === 'dark' || theme === 'light') return theme
  return darkMediaQuery()?.matches === true ? 'dark' : 'light'
}

/**
 * Keep the browser chrome (address bar on mobile, PWA title bar) in step with
 * the palette. The tag is created on first use so `index.html` does not have to
 * carry a value that would immediately go stale.
 */
function syncThemeColor(resolved: 'dark' | 'light'): void {
  const head = document.head
  if (!head) return
  let meta = head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    head.appendChild(meta)
  }
  let color = ''
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      // Read the token rather than restating a hex here, so the meta colour can
      // never drift away from the stylesheet.
      color = window.getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim()
    } catch {
      color = ''
    }
  }
  meta.setAttribute('content', color || FALLBACK_THEME_COLOR[resolved])
}

/** Write the choice onto `<html>` and refresh the dependent chrome colour. */
function applyTheme(theme: ThemeName): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  // Read the computed token *after* the attribute changes, so it reflects the
  // palette that is now in force.
  syncThemeColor(resolveTheme(theme))
}

/**
 * Apply `settings.theme` to the document, and — while the user is on 'system' —
 * follow the OS as it flips between light and dark.
 */
export function useTheme(): void {
  const theme = useAppStore((s) => s.settings.theme)

  useEffect(() => {
    applyTheme(theme)
    // A pinned theme never changes underneath us; only 'system' needs a listener.
    if (theme !== 'system') return undefined

    const query = darkMediaQuery()
    if (!query) return undefined
    const onChange = (): void => applyTheme('system')

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    // Safari < 14 and some jsdom stubs only have the deprecated pair.
    if (typeof query.addListener === 'function') {
      query.addListener(onChange)
      return () => query.removeListener?.(onChange)
    }
    return undefined
  }, [theme])
}
