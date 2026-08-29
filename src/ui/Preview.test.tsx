import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { AppState } from '../state/store'
import type { Note, NotePath, VaultAdapter, VaultFile } from '../types'
import { emptyIndex, buildIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { Preview } from './Preview'

/**
 * The whole store as it was when the module loaded, actions included. Restoring
 * it wholesale between tests undoes both the seeded data and any action we
 * replaced with a spy.
 */
const PRISTINE = useAppStore.getState()

const PANE_ID = 'pane-a'

function seed(files: Record<NotePath, string>, patch: Partial<AppState> = {}): void {
  const notes = new Map<NotePath, Note>()
  for (const [path, content] of Object.entries(files)) notes.set(path, makeNote(path, content, 1))
  useAppStore.setState({ notes, index: buildIndex(notes), ...patch })
}

function host(container: HTMLElement): HTMLElement {
  const element = container.querySelector('.preview-host')
  if (!element) throw new Error('preview host missing')
  return element as HTMLElement
}

/** jsdom does no layout, so scroll metrics have to be faked to be observable. */
function stubScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
}

beforeEach(() => {
  useAppStore.setState(
    {
      ...PRISTINE,
      notes: new Map(),
      attachments: [],
      index: emptyIndex(),
      adapter: null,
      dirty: new Set(),
      saving: new Set(),
      searchQuery: '',
      sidebarPanel: 'files',
      starred: [],
      recent: [],
      toasts: [],
      revision: 0,
      panes: [
        { id: PANE_ID, tabs: [], activeTabId: null },
        { id: 'pane-b', tabs: [], activeTabId: null },
      ],
      activePaneId: 'pane-b',
    },
    true,
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Preview — rendering', () => {
  it('renders the note as sanitized markdown', () => {
    seed({
      'A.md': [
        '# Title',
        '',
        'Some **bold** text with a [[Target]] link and a #topic tag.',
        '',
        '```js',
        'const x = 1',
        '```',
      ].join('\n'),
      'Target.md': '# Target',
    })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const preview = container.querySelector('.markdown-preview')

    expect(preview).not.toBeNull()
    expect(preview!.querySelector('h1')?.textContent).toContain('Title')
    expect(preview!.querySelector('strong')?.textContent).toBe('bold')

    const link = preview!.querySelector('a.internal-link') as HTMLElement
    expect(link.dataset.href).toBe('Target')
    expect(link.classList.contains('is-unresolved')).toBe(false)

    const tag = preview!.querySelector('a.tag') as HTMLElement
    expect(tag.dataset.tag).toBe('topic')

    expect(preview!.querySelector('pre.code-block')?.getAttribute('data-lang')).toBe('js')
  })

  it('renders a friendly empty state for a missing or empty note', () => {
    seed({ 'Blank.md': '   \n' })

    const missing = render(<Preview path="Ghost.md" paneId={PANE_ID} />)
    expect(missing.container.querySelector('.pane-empty')?.textContent).toContain('Ghost.md')
    expect(missing.container.querySelector('.markdown-preview')).toBeNull()
    cleanup()

    const blank = render(<Preview path="Blank.md" paneId={PANE_ID} />)
    expect(blank.container.querySelector('.pane-empty')?.textContent).toContain('empty')
  })

  it('does not let an XSS payload reach the DOM', () => {
    seed({
      'Evil.md': [
        '# Evil',
        '',
        '<script>window.__pwned = true</script>',
        '',
        '<img src="x" onerror="window.__pwned = true">',
        '',
        '[click me](javascript:window.__pwned=true)',
        '',
        '<a href="javascript:window.__pwned=true">raw</a>',
      ].join('\n'),
    })

    const { container } = render(<Preview path="Evil.md" paneId={PANE_ID} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
    expect(container.querySelector('[onerror]')).toBeNull()
    for (const anchor of container.querySelectorAll('a')) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
    }
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })
})

describe('Preview — navigation', () => {
  it('opens an internal link through the store, honouring modifier-click', async () => {
    const openLink = vi.fn(async () => {})
    seed({ 'A.md': 'See [[Target]] for more.', 'Target.md': '# Target' }, { openLink })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const link = container.querySelector('a.internal-link') as HTMLElement

    fireEvent.click(link)
    expect(openLink).toHaveBeenCalledWith('Target', 'A.md', { newTab: false })

    fireEvent.click(link, { ctrlKey: true })
    expect(openLink).toHaveBeenLastCalledWith('Target', 'A.md', { newTab: true })
  })

  it('carries the heading fragment of a link and opens the bare target', () => {
    const openLink = vi.fn(async () => {})
    seed({ 'A.md': 'Jump to [[Target#Second Part]].', 'Target.md': '# Target\n\n## Second Part\n' }, { openLink })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const link = container.querySelector('a.internal-link') as HTMLElement

    expect(link.dataset.heading).toBe('Second Part')
    fireEvent.click(link)
    expect(openLink).toHaveBeenCalledWith('Target', 'A.md', { newTab: false })
  })

  it('treats an unresolved link as a placeholder, not as a real note', () => {
    const openLink = vi.fn(async () => {})
    const openPath = vi.fn()
    seed({ 'A.md': 'Nothing at [[Nowhere]] yet.' }, { openLink, openPath })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const link = container.querySelector('a.internal-link') as HTMLElement

    expect(link.classList.contains('is-unresolved')).toBe(true)
    fireEvent.click(link)

    // The target is handed over verbatim; nothing pretends a note exists.
    expect(openLink).toHaveBeenCalledWith('Nowhere', 'A.md', { newTab: false })
    expect(openPath).not.toHaveBeenCalled()
    expect(useAppStore.getState().notes.has('Nowhere.md')).toBe(false)
  })

  it('opens the source note of an embed when its title is clicked', () => {
    const openLink = vi.fn(async () => {})
    seed({ 'A.md': '![[Target]]', 'Target.md': '# Target\n\nEmbedded body.\n' }, { openLink })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const title = container.querySelector('.embed .embed-title') as HTMLElement

    expect(container.querySelector('.embed-body')?.textContent).toContain('Embedded body.')
    fireEvent.click(title)
    expect(openLink).toHaveBeenCalledWith('Target', 'A.md', { newTab: false })
  })

  it('sends a tag click to the search sidebar without toggling it shut', () => {
    seed({ 'A.md': 'Filed under #project/alpha today.' })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const tag = container.querySelector('a.tag') as HTMLElement

    fireEvent.click(tag)
    expect(useAppStore.getState().sidebarPanel).toBe('search')
    expect(useAppStore.getState().searchQuery).toBe('tag:project/alpha')

    // Clicking a second time must not collapse the panel that just opened.
    fireEvent.click(tag)
    expect(useAppStore.getState().sidebarPanel).toBe('search')
  })

  it('moves the hash and scrolls for a heading anchor instead of navigating', () => {
    seed({ 'A.md': '# Title\n\n## Second Part\n\nBody.\n' })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const anchors = container.querySelectorAll<HTMLAnchorElement>('a.heading-anchor')
    const anchor = anchors[1]!
    expect(anchor.getAttribute('href')).toBe('#second-part')

    fireEvent.click(anchor)

    expect(window.location.hash).toBe('#second-part')
    expect(container.querySelector('h2')?.id).toBe('second-part')
  })

  it('leaves external links to the browser', () => {
    const openLink = vi.fn(async () => {})
    seed({ 'A.md': 'Read [the docs](https://example.com/docs).' }, { openLink })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const anchor = container.querySelector('a.external-link') as HTMLAnchorElement

    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(openLink).not.toHaveBeenCalled()
  })

  it('focuses its pane on any click', () => {
    seed({ 'A.md': 'Plain body text.' })
    expect(useAppStore.getState().activePaneId).toBe('pane-b')

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    fireEvent.click(container.querySelector('.markdown-preview p') as HTMLElement)

    expect(useAppStore.getState().activePaneId).toBe(PANE_ID)
  })
})

describe('Preview — task toggling', () => {
  it('rewrites exactly the clicked line', () => {
    const content = ['# Tasks', '', '- [ ] first', '- [x] second', '- [ ] third', ''].join('\n')
    seed({ 'Tasks.md': content })

    const { container } = render(<Preview path="Tasks.md" paneId={PANE_ID} />)
    const boxes = container.querySelectorAll<HTMLInputElement>('.task-item input[type="checkbox"]')
    expect(boxes).toHaveLength(3)
    // The renderer disables the inputs; the preview makes them clickable again.
    expect(boxes[0]!.disabled).toBe(false)

    fireEvent.click(boxes[0]!)
    expect(useAppStore.getState().notes.get('Tasks.md')!.content).toBe(
      ['# Tasks', '', '- [x] first', '- [x] second', '- [ ] third', ''].join('\n'),
    )

    fireEvent.click(
      container.querySelectorAll<HTMLInputElement>('.task-item input[type="checkbox"]')[1]!,
    )
    expect(useAppStore.getState().notes.get('Tasks.md')!.content).toBe(
      ['# Tasks', '', '- [x] first', '- [ ] second', '- [ ] third', ''].join('\n'),
    )
  })

  it('offsets data-line past frontmatter and preserves it byte for byte', () => {
    const content = [
      '---',
      'title: Chores',
      'tags: [home]',
      '---',
      '',
      '# Chores',
      '',
      '- [ ] water the plants',
      '  - [ ] the fern too',
      '- [ ] take out the bins',
      '',
    ].join('\n')
    seed({ 'Chores.md': content })

    const { container } = render(<Preview path="Chores.md" paneId={PANE_ID} />)
    const boxes = container.querySelectorAll<HTMLInputElement>('.task-item input[type="checkbox"]')
    expect(boxes).toHaveLength(3)

    // `data-line` indexes the original source, frontmatter lines included.
    const lines = content.split('\n')
    expect(Number(boxes[2]!.dataset.line)).toBe(lines.indexOf('- [ ] take out the bins'))

    fireEvent.click(boxes[2]!)

    const updated = useAppStore.getState().notes.get('Chores.md')!.content
    expect(updated).toBe(
      [
        '---',
        'title: Chores',
        'tags: [home]',
        '---',
        '',
        '# Chores',
        '',
        '- [ ] water the plants',
        '  - [ ] the fern too',
        '- [x] take out the bins',
        '',
      ].join('\n'),
    )
    // Frontmatter and every other line survive untouched.
    expect(updated.split('\n').slice(0, 9)).toEqual(lines.slice(0, 9))
  })

  it('toggles the nested task without disturbing its parent', () => {
    const content = ['- [ ] parent', '  - [x] child', ''].join('\n')
    seed({ 'Nested.md': content })

    const { container } = render(<Preview path="Nested.md" paneId={PANE_ID} />)
    const boxes = container.querySelectorAll<HTMLInputElement>('.task-item input[type="checkbox"]')
    fireEvent.click(boxes[1]!)

    expect(useAppStore.getState().notes.get('Nested.md')!.content).toBe(
      ['- [ ] parent', '  - [ ] child', ''].join('\n'),
    )
  })
})

describe('Preview — hover preview', () => {
  it('shows a card after the delay and hides it on Escape', () => {
    vi.useFakeTimers()
    seed({
      'A.md': 'See [[Target]].',
      'Target.md': '# Target Note\n\nA short body about targets.\n',
    })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const link = container.querySelector('a.internal-link') as HTMLElement

    fireEvent.mouseOver(link, { clientX: 40, clientY: 60 })
    act(() => {
      vi.advanceTimersByTime(399)
    })
    expect(container.querySelector('.hover-preview')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const card = container.querySelector('.hover-preview') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Target Note')
    expect(card.textContent).toContain('A short body about targets.')
    expect(card.style.left).toBe('54px')
    expect(card.style.top).toBe('74px')

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(container.querySelector('.hover-preview')).toBeNull()
  })

  it('cancels the card when the pointer leaves before the delay', () => {
    vi.useFakeTimers()
    seed({ 'A.md': 'See [[Target]].', 'Target.md': '# Target Note\n\nBody.\n' })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const link = container.querySelector('a.internal-link') as HTMLElement

    fireEvent.mouseOver(link, { clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    fireEvent.mouseOut(link, { relatedTarget: container })
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(container.querySelector('.hover-preview')).toBeNull()
  })

  it('never previews an unresolved link', () => {
    vi.useFakeTimers()
    seed({ 'A.md': 'See [[Nowhere]].' })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    fireEvent.mouseOver(container.querySelector('a.internal-link') as HTMLElement, {
      clientX: 10,
      clientY: 10,
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(container.querySelector('.hover-preview')).toBeNull()
  })

  it('flips the card back on screen near the right/bottom edge', () => {
    vi.useFakeTimers()
    seed({ 'A.md': 'See [[Target]].', 'Target.md': '# Target Note\n\nBody.\n' })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    // jsdom reports a zero-sized card, so give it a measurable box.
    const rect = { width: 300, height: 120 } as DOMRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect)

    fireEvent.mouseOver(container.querySelector('a.internal-link') as HTMLElement, {
      clientX: window.innerWidth - 20,
      clientY: window.innerHeight - 20,
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })

    const card = container.querySelector('.hover-preview') as HTMLElement
    expect(parseFloat(card.style.left)).toBe(window.innerWidth - 20 - 14 - 300)
    expect(parseFloat(card.style.top)).toBe(window.innerHeight - 20 - 14 - 120)
  })
})

describe('Preview — scrolling', () => {
  it('follows editor scroll events from its own pane only', () => {
    seed({ 'A.md': 'Body.\n' })

    const pane = 'pane-sync'
    const { container } = render(<Preview path="A.md" paneId={pane} scrollSync />)
    const element = host(container)
    stubScrollMetrics(element, 1000, 400)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:editor-scroll', { detail: { paneId: pane, ratio: 0.5 } }),
      )
    })
    expect(element.scrollTop).toBe(300)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:editor-scroll', { detail: { paneId: 'pane-b', ratio: 1 } }),
      )
    })
    expect(element.scrollTop).toBe(300)

    // Out-of-range ratios are clamped rather than thrown away.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:editor-scroll', { detail: { paneId: pane, ratio: 4 } }),
      )
    })
    expect(element.scrollTop).toBe(600)
  })

  it('ignores editor scroll events when scrollSync is off', () => {
    seed({ 'A.md': 'Body.\n' })

    const pane = 'pane-nosync'
    const { container } = render(<Preview path="A.md" paneId={pane} />)
    const element = host(container)
    stubScrollMetrics(element, 1000, 400)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:editor-scroll', { detail: { paneId: pane, ratio: 0.5 } }),
      )
    })
    expect(element.scrollTop).toBe(0)
  })

  it('restores the scroll offset of a note across tab switches', () => {
    seed({ 'A.md': 'Body of A.\n', 'B.md': 'Body of B.\n' })

    const pane = 'pane-restore'
    const first = render(<Preview path="A.md" paneId={pane} />)
    const elementA = host(first.container)
    elementA.scrollTop = 250
    fireEvent.scroll(elementA)
    cleanup()

    // A different note in the same pane starts at the top…
    const second = render(<Preview path="B.md" paneId={pane} />)
    expect(host(second.container).scrollTop).toBe(0)
    cleanup()

    // …and coming back to A lands where we left it.
    const third = render(<Preview path="A.md" paneId={pane} />)
    expect(host(third.container).scrollTop).toBe(250)
  })
})

describe('Preview — attachments', () => {
  it('resolves an embedded image through the adapter and re-renders with it', async () => {
    const file: VaultFile = {
      path: 'assets/diagram-unique.png',
      name: 'diagram-unique.png',
      extension: 'png',
      isMarkdown: false,
      size: 4,
      mtime: 1,
    }
    const readBinary = vi.fn(async () => new Blob(['data'], { type: 'image/png' }))
    const adapter = {
      kind: 'demo',
      name: 'test',
      writable: true,
      list: async () => [file],
      read: async () => '',
      readBinary,
      write: async () => {},
      writeBinary: async () => {},
      remove: async () => {},
      rename: async () => {},
      exists: async () => true,
    } as unknown as VaultAdapter

    seed({ 'A.md': '![[diagram-unique.png]]' }, { attachments: [file], adapter })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    // The first synchronous render cannot know the URL yet.
    expect(container.querySelector('img.embed-image')).toBeNull()

    await waitFor(() => {
      expect(container.querySelector('img.embed-image')).not.toBeNull()
    })
    const img = container.querySelector('img.embed-image') as HTMLImageElement
    expect(img.getAttribute('src')).toMatch(/^(blob:|data:image\/png)/)
    expect(readBinary).toHaveBeenCalledTimes(1)
    expect(readBinary).toHaveBeenCalledWith('assets/diagram-unique.png')
  })
})
