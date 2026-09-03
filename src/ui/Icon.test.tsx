import { render, cleanup } from '@testing-library/react'

import { Icon } from './Icon'
import type { IconName } from './Icon'

/**
 * Exhaustive by construction: a `Record<IconName, true>` fails to compile the
 * moment a name is added to the union without being listed here, so the loops
 * below can never silently skip an icon.
 */
const NAME_MAP: Record<IconName, true> = {
  files: true,
  search: true,
  tag: true,
  star: true,
  graph: true,
  settings: true,
  menu: true,
  'chevron-right': true,
  'chevron-down': true,
  close: true,
  plus: true,
  folder: true,
  'folder-open': true,
  file: true,
  edit: true,
  eye: true,
  columns: true,
  split: true,
  trash: true,
  link: true,
  pin: true,
  sun: true,
  moon: true,
  calendar: true,
  more: true,
  'arrow-left': true,
  'arrow-right': true,
  check: true,
  copy: true,
}

const NAMES = Object.keys(NAME_MAP) as IconName[]

function renderIcon(name: IconName, props: { size?: number; className?: string } = {}): SVGSVGElement {
  const { container } = render(<Icon name={name} {...props} />)
  const svg = container.querySelector('svg')
  if (!svg) throw new Error(`Icon "${name}" rendered no <svg>`)
  return svg
}

describe('Icon', () => {
  afterEach(cleanup)

  it('covers every name in the union', () => {
    // Guards against the map above drifting out of sync with the real set.
    expect(NAMES).toHaveLength(29)
  })

  it('renders an svg with drawable geometry for every name', () => {
    for (const name of NAMES) {
      const svg = renderIcon(name)
      expect(svg.tagName.toLowerCase()).toBe('svg')
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')

      const shapes = svg.querySelectorAll('path, circle, rect, line, polyline, polygon')
      expect(shapes.length, `${name} should draw at least one shape`).toBeGreaterThan(0)

      for (const shape of Array.from(shapes)) {
        const d = shape.getAttribute('d')
        // Paths must carry a real command list; primitives carry geometry attrs.
        if (shape.tagName.toLowerCase() === 'path') {
          expect(d, `${name} has an empty path`).toBeTruthy()
          expect(d!.trim().length).toBeGreaterThan(3)
          expect(/^[Mm]/.test(d!.trim()), `${name} path must start with a move-to`).toBe(true)
        }
      }
      cleanup()
    }
  })

  it('applies the shared stroke settings so icons inherit the theme colour', () => {
    for (const name of NAMES) {
      const svg = renderIcon(name)
      expect(svg.getAttribute('fill')).toBe('none')
      expect(svg.getAttribute('stroke')).toBe('currentColor')
      expect(svg.getAttribute('stroke-width')).toBe('1.8')
      expect(svg.getAttribute('stroke-linecap')).toBe('round')
      expect(svg.getAttribute('stroke-linejoin')).toBe('round')
      cleanup()
    }
  })

  it('is decorative: hidden from assistive tech and unfocusable', () => {
    const svg = renderIcon('search')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
  })

  it('defaults to 16px', () => {
    const svg = renderIcon('star')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
  })

  it('respects the size prop on both axes while keeping the 24x24 viewBox', () => {
    const svg = renderIcon('graph', { size: 40 })
    expect(svg.getAttribute('width')).toBe('40')
    expect(svg.getAttribute('height')).toBe('40')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('always carries the base and per-name classes', () => {
    const svg = renderIcon('folder-open')
    expect(svg.getAttribute('class')).toBe('icon icon-folder-open')
  })

  it('appends the className prop without dropping the base classes', () => {
    const svg = renderIcon('close', { className: 'tab-close-icon is-muted' })
    const classes = svg.getAttribute('class')!.split(' ')
    expect(classes).toContain('icon')
    expect(classes).toContain('icon-close')
    expect(classes).toContain('tab-close-icon')
    expect(classes).toContain('is-muted')
  })

  it('renders nothing for an unknown name instead of throwing', () => {
    // Names can arrive from untyped data (persisted settings, plugins).
    const { container } = render(<Icon name={'definitely-not-an-icon' as IconName} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('renders distinct geometry per icon (no accidental copy-paste duplicates)', () => {
    const seen = new Map<string, IconName>()
    for (const name of NAMES) {
      const svg = renderIcon(name)
      const geometry = svg.innerHTML
      const previous = seen.get(geometry)
      expect(previous, `${name} draws the same shape as ${previous}`).toBeUndefined()
      seen.set(geometry, name)
      cleanup()
    }
    expect(seen.size).toBe(NAMES.length)
  })
})
