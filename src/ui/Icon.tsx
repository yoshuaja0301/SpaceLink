/**
 * SpaceLink — the shared icon set.
 *
 * One hand-drawn 24x24 stroke geometry per name, scaled by the `size` prop.
 * Every icon inherits `currentColor`, so colour is decided by the surrounding
 * CSS (and therefore by the theme tokens) rather than by this file.
 *
 * Icons are decorative: they are always accompanied by a label or a tooltip in
 * the UI, so they are hidden from assistive technology and taken out of the
 * tab order.
 */
import type { JSX, ReactNode } from 'react'

export type IconName =
  | 'files'
  | 'search'
  | 'tag'
  | 'star'
  | 'graph'
  | 'settings'
  | 'menu'
  | 'chevron-right'
  | 'chevron-down'
  | 'close'
  | 'plus'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'edit'
  | 'eye'
  | 'columns'
  | 'split'
  | 'trash'
  | 'link'
  | 'pin'
  | 'sun'
  | 'moon'
  | 'calendar'
  | 'more'
  | 'arrow-left'
  | 'arrow-right'
  | 'check'
  | 'copy'
  | 'table'

export interface IconProps {
  name: IconName
  /** Edge length in px. The geometry is a 24x24 viewBox, scaled to fit. */
  size?: number
  className?: string
}

/**
 * The geometry for each icon, drawn on a 24x24 grid. Anything filled says so
 * explicitly; everything else inherits the stroke settings from `<svg>`.
 */
const SHAPES: Record<IconName, ReactNode> = {
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9.5h18" />
      <path d="M9.5 9.5V20" />
    </>
  ),
  files: (
    <>
      <path d="M9 3h5.5L19 7.5V16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M14.5 3v4.5H19" />
      <path d="M15 18v1a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  tag: (
    <>
      <path d="M20.5 12.9 12.9 20.5a1.6 1.6 0 0 1-2.3 0l-7-7a1.6 1.6 0 0 1-.5-1.2V4.6A1.6 1.6 0 0 1 4.6 3h7.7c.5 0 .9.2 1.2.5l7 7a1.6 1.6 0 0 1 0 2.4z" />
      <path d="M7.7 7.7h.01" />
    </>
  ),
  star: <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />,
  graph: (
    <>
      <circle cx="6" cy="17.2" r="2.6" />
      <circle cx="18" cy="17.2" r="2.6" />
      <circle cx="12" cy="5.5" r="2.6" />
      <path d="M10.7 7.8 7.3 14.9M13.3 7.8l3.4 7.1M8.6 17.2h6.8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.9 1.9 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.9 1.9 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.9 1.9 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.5 1.5 0 0 0-1.4.9z" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  'chevron-right': <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  'chevron-down': <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3.5 7.4a2 2 0 0 1 2-2h3.2l2 2.5h7.8a2 2 0 0 1 2 2v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  'folder-open': (
    <>
      <path d="M4 10.2V6.4a1.9 1.9 0 0 1 1.9-1.9h3.2l2 2.5h7a1.9 1.9 0 0 1 1.9 1.9v1.3" />
      <path d="M2.7 11.3A1.4 1.4 0 0 1 4 9.6h16a1.4 1.4 0 0 1 1.4 1.7l-1.3 6.4a2 2 0 0 1-2 1.6H6a2 2 0 0 1-2-1.6z" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.5H8a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z" />
      <path d="M13.5 3.5V8H18" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20.5h8.5" />
      <path d="M16.6 3.9a2.1 2.1 0 0 1 3 3L8.4 18.1l-4.4 1 1-4.4z" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  columns: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M12 4.5v15" />
    </>
  ),
  split: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M13.5 4.5v15" />
      <path d="m16.2 9.6 2.4 2.4-2.4 2.4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" />
      <path d="M6.6 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.8-12.5" />
      <path d="M10.5 10.5v6M13.5 10.5v6" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.4a3.6 3.6 0 0 0 5.4.4l2.5-2.5a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4" />
      <path d="M13.8 10.6a3.6 3.6 0 0 0-5.4-.4l-2.5 2.5a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4" />
    </>
  ),
  pin: (
    <>
      <path d="M9.5 3.5h5v1a1 1 0 0 1-.6.9l-.5.3.9 4.7 2.2 1.9a1 1 0 0 1 .3.7v.5H7.2V13a1 1 0 0 1 .3-.7l2.2-1.9.9-4.7-.5-.3a1 1 0 0 1-.6-.9z" />
      <path d="M12 13.5V21" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6" />
    </>
  ),
  moon: <path d="M20.5 14.4A8.5 8.5 0 0 1 9.6 3.5a8.5 8.5 0 1 0 10.9 10.9z" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.8h17M8.5 3.5v3M15.5 3.5v3" />
    </>
  ),
  // Filled dots: rings would read as three empty circles at 16px.
  more: (
    <>
      <circle cx="5.6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  copy: (
    <>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M15 9V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H9" />
    </>
  ),
}

export function Icon({ name, size = 16, className }: IconProps): JSX.Element {
  const shape = SHAPES[name]
  // An unknown name (e.g. one arriving from untyped data) renders nothing at
  // all rather than an empty box or a thrown error.
  if (shape === undefined) return <></>

  return (
    <svg
      className={className ? `icon icon-${name} ${className}` : `icon icon-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape}
    </svg>
  )
}

export default Icon
