import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { headingElementId } from '../core/markdown/parse'
import { act } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import type { JSX } from 'react'

import type { AppState } from '../state/store'
import type { RenderContext } from '../core/markdown/render'
import type { Note, NotePath, VaultAdapter, VaultFile } from '../types'
import { emptyIndex, buildIndex } from '../core/graph/index'
import { makeNote, useAppStore } from '../state/store'
import { Preview } from './Preview'
import { useRenderContext } from './useRenderContext'

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
    expect(container.querySelector('h2')?.id).toBe(headingElementId('second-part'))
  })

  it('scrolls to the footnote a footnote ref points at, whose id is not a heading id', () => {
    seed({ 'A.md': 'Text[^1] here.\n\n[^1]: The note.\n' })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const ref = container.querySelector<HTMLAnchorElement>('a[href="#fn-1"]')!
    const footnote = container.querySelector<HTMLElement>('#fn-1')!
    const spy = vi.fn() // jsdom does not implement scrollIntoView
    Object.defineProperty(footnote, 'scrollIntoView', { configurable: true, value: spy })

    fireEvent.click(ref)

    expect(window.location.hash).toBe('#fn-1')
    expect(spy).toHaveBeenCalled()
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

describe('Preview — embedded notes', () => {
  const HOST = ['- [ ] buy milk', '- [x] pay rent', '', '![[Tasks]]', '', '- [ ] host tail', ''].join('\n')
  const EMBEDDED = ['---', 'title: Tasks', '---', '', '- [ ] embedded one', '- [ ] embedded two', ''].join(
    '\n',
  )

  const LINKED = {
    'a/Host.md': 'own [[Note]] here\n\n![[b/Embedded]]\n',
    'b/Embedded.md': 'see [[Note]]\n',
    'a/Note.md': '# A note\n\nThe one next to the host.\n',
    'b/Note.md': '# B note\n\nThe one next to the embedded note.\n',
  }

  function internalLinks(container: HTMLElement): { own: HTMLElement; embedded: HTMLElement } {
    const links = [...container.querySelectorAll<HTMLElement>('a.internal-link')]
    const own = links.find((link) => !link.closest('.embed-body'))
    const embedded = links.find((link) => link.closest('.embed-body'))
    if (!own || !embedded) throw new Error('expected a link in the host and one in the embed')
    return { own, embedded }
  }

  it('toggles the transcluded note, not the note on screen', () => {
    seed({ 'Home.md': HOST, 'Tasks.md': EMBEDDED })

    const { container } = render(<Preview path="Home.md" paneId={PANE_ID} />)
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.task-item input[type="checkbox"]')]
    const own = boxes.filter((box) => !box.closest('.embed-body'))
    const embedded = boxes.filter((box) => box.closest('.embed-body'))
    expect(own).toHaveLength(3)
    expect(embedded).toHaveLength(2)

    // Each checkbox names the note its line lives in, and the line indexes that
    // note's own source — frontmatter included, so the transcluded tasks sit at
    // 4 and 5 while the host's own tasks are at 0, 1 and 5.
    expect(embedded.map((box) => box.dataset.src)).toEqual(['Tasks.md', 'Tasks.md'])
    expect(own.map((box) => box.dataset.src)).toEqual(['Home.md', 'Home.md', 'Home.md'])
    const embeddedLines = EMBEDDED.split('\n')
    expect(embedded.map((box) => Number(box.dataset.line))).toEqual([
      embeddedLines.indexOf('- [ ] embedded one'),
      embeddedLines.indexOf('- [ ] embedded two'),
    ])
    expect(Number(own[2]!.dataset.line)).toBe(HOST.split('\n').indexOf('- [ ] host tail'))

    fireEvent.click(embedded[1]!)

    expect(useAppStore.getState().notes.get('Tasks.md')!.content).toBe(
      ['---', 'title: Tasks', '---', '', '- [ ] embedded one', '- [x] embedded two', ''].join('\n'),
    )
    // The host shares that line number with a task of its own and must not move.
    expect(useAppStore.getState().notes.get('Home.md')!.content).toBe(HOST)
  })

  it('opens a link inside an embed from the note it was written in', () => {
    const openLink = vi.fn(async () => {})
    seed(LINKED, { openLink })

    const { container } = render(<Preview path="a/Host.md" paneId={PANE_ID} />)
    const { own, embedded } = internalLinks(container)

    fireEvent.click(own)
    expect(openLink).toHaveBeenLastCalledWith('Note', 'a/Host.md', { newTab: false })

    // Same link text, different owner: the embed resolved it from `b/`, so the
    // click has to as well.
    fireEvent.click(embedded)
    expect(openLink).toHaveBeenLastCalledWith('Note', 'b/Embedded.md', { newTab: false })
  })

  it('previews the note an embedded link actually resolves to', () => {
    vi.useFakeTimers()
    seed(LINKED)

    const { container } = render(<Preview path="a/Host.md" paneId={PANE_ID} />)
    const { embedded } = internalLinks(container)

    fireEvent.mouseOver(embedded, { clientX: 20, clientY: 20 })
    act(() => {
      vi.advanceTimersByTime(400)
    })

    expect(container.querySelector('.hover-preview-title')?.textContent).toBe('B note')
  })

  it('still opens an embed title from the note that wrote the embed', () => {
    const openLink = vi.fn(async () => {})
    seed(LINKED, { openLink })

    const { container } = render(<Preview path="a/Host.md" paneId={PANE_ID} />)
    fireEvent.click(container.querySelector('.embed .embed-title') as HTMLElement)

    expect(openLink).toHaveBeenCalledWith('b/Embedded', 'a/Host.md', { newTab: false })
  })
})

describe('Preview — the window event contract', () => {
  const NOTE = ['# One', '', 'alpha', '', '## Two', '', 'beta', ''].join('\n')

  /** jsdom has no layout, so every heading has to be told where it sits. */
  function stubTop(element: Element, top: number): void {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top } as DOMRect)
  }

  function headings(container: HTMLElement): { h1: HTMLElement; h2: HTMLElement } {
    const h1 = container.querySelector('h1') as HTMLElement
    const h2 = container.querySelector('h2') as HTMLElement
    return { h1, h2 }
  }

  /** jsdom does not implement scrollIntoView; record the call instead. */
  function watchScrollIntoView(element: HTMLElement): ReturnType<typeof vi.fn> {
    const spy = vi.fn()
    Object.defineProperty(element, 'scrollIntoView', { configurable: true, value: spy })
    return spy
  }

  it('reveals the heading that owns a revealed line, and ignores other notes', () => {
    seed({ 'A.md': NOTE, 'B.md': '# Elsewhere\n' })

    const { container, unmount } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const { h1, h2 } = headings(container)
    const first = watchScrollIntoView(h1)
    const second = watchScrollIntoView(h2)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-line', { detail: { path: 'B.md', line: 6 } }),
      )
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    // `beta` sits under the second heading, `alpha` under the first.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-line', { detail: { path: 'A.md', line: 6 } }),
      )
    })
    expect(second).toHaveBeenCalledTimes(1)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-line', { detail: { path: 'A.md', line: 2 } }),
      )
    })
    expect(first).toHaveBeenCalledTimes(1)

    unmount()
    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-line', { detail: { path: 'A.md', line: 6 } }),
      )
    })
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('scrolls to the slug of a reveal-heading event for its own note only', () => {
    seed({ 'A.md': NOTE })

    const { container, unmount } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const { h2 } = headings(container)
    const spy = watchScrollIntoView(h2)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-heading', {
          detail: { path: 'Other.md', slug: 'two', line: 4 },
        }),
      )
    })
    expect(spy).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-heading', {
          detail: { path: 'A.md', slug: 'two', line: 4 },
        }),
      )
    })
    expect(spy).toHaveBeenCalledTimes(1)

    unmount()
    act(() => {
      window.dispatchEvent(
        new CustomEvent('spacefore:reveal-heading', {
          detail: { path: 'A.md', slug: 'two', line: 4 },
        }),
      )
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('reports the heading crossing the top of the viewport to the outline', () => {
    seed({ 'A.md': NOTE })

    const { container, unmount } = render(<Preview path="A.md" paneId={PANE_ID} />)
    const element = host(container)
    const { h1, h2 } = headings(container)

    const seen: unknown[] = []
    const listener = (event: Event): void => void seen.push((event as CustomEvent).detail)
    window.addEventListener('spacefore:preview-scroll', listener)

    stubTop(element, 0)
    stubTop(h1, -40)
    stubTop(h2, 500)
    fireEvent.scroll(element)
    expect(seen).toEqual([{ path: 'A.md', slug: 'one' }])

    // Still under the first heading: nothing new to say.
    fireEvent.scroll(element)
    expect(seen).toHaveLength(1)

    stubTop(h2, -10)
    fireEvent.scroll(element)
    expect(seen).toEqual([
      { path: 'A.md', slug: 'one' },
      { path: 'A.md', slug: 'two' },
    ])

    unmount()
    expect(seen).toHaveLength(2)
    window.removeEventListener('spacefore:preview-scroll', listener)
  })
})

describe('Preview — scroll memory', () => {
  it('keeps the offset a note was left at when the next note clamps the scroller', () => {
    seed({ 'Long.md': 'Long body.\n', 'Short.md': 'Short.\n' })

    const pane = 'pane-clamp'
    const first = render(<Preview path="Long.md" paneId={pane} />)
    const element = host(first.container)
    element.scrollTop = 250
    fireEvent.scroll(element)

    // Switching tabs swaps the markup in before the effect cleanup runs, so the
    // browser has already clamped the scroller against the shorter note.
    element.scrollTop = 0
    cleanup()

    const back = render(<Preview path="Long.md" paneId={pane} />)
    expect(host(back.container).scrollTop).toBe(250)
  })
})

describe('Preview — hover card', () => {
  it('emits the classes the stylesheet targets and takes the card down on unmount', () => {
    vi.useFakeTimers()
    seed({ 'A.md': 'See [[Target]].', 'Target.md': '# Target Note\n\nA short body.\n' })

    const { container, unmount } = render(<Preview path="A.md" paneId={PANE_ID} />)
    fireEvent.mouseOver(container.querySelector('a.internal-link') as HTMLElement, {
      clientX: 10,
      clientY: 10,
    })
    act(() => {
      vi.advanceTimersByTime(400)
    })

    const card = container.querySelector('.hover-preview') as HTMLElement
    expect(card.getAttribute('role')).toBe('tooltip')
    expect(card.querySelector('.hover-preview-title')?.textContent).toBe('Target Note')
    expect(card.querySelector('.hover-preview-excerpt')?.textContent).toContain('A short body.')

    unmount()
    expect(document.querySelector('.hover-preview')).toBeNull()
  })
})

describe('useRenderContext — memoisation', () => {
  function Probe({ path, seen }: { path: NotePath; seen: RenderContext[] }): JSX.Element {
    seen.push(useRenderContext(path))
    return <span />
  }

  it('survives a keystroke in a note it does not render', () => {
    seed({ 'A.md': 'Body of A.\n', 'Other.md': 'Body of other.\n' })

    const seen: RenderContext[] = []
    render(<Probe path="A.md" seen={seen} />)
    const renders = seen.length
    expect(renders).toBeGreaterThan(0)

    act(() => {
      useAppStore.getState().setNoteContent('Other.md', 'Body of other, edited.\n')
    })

    // The notes map identity changed; nothing this context reads did, so the
    // preview of A is not re-rendered and its markdown is not re-sanitized.
    expect(seen).toHaveLength(renders)
    expect(useAppStore.getState().notes.get('Other.md')!.content).toBe('Body of other, edited.\n')
  })

  it('is rebuilt when a note it transcludes changes', () => {
    seed({ 'Host.md': 'Before.\n\n![[Embedded]]\n', 'Embedded.md': 'first body\n' })

    const seen: RenderContext[] = []
    const { container } = render(
      <>
        <Probe path="Host.md" seen={seen} />
        <Preview path="Host.md" paneId={PANE_ID} />
      </>,
    )
    const last = seen[seen.length - 1]
    expect(container.querySelector('.embed-body')?.textContent).toContain('first body')

    act(() => {
      useAppStore.getState().setNoteContent('Embedded.md', 'second body\n')
    })

    expect(seen[seen.length - 1]).not.toBe(last)
    expect(container.querySelector('.embed-body')?.textContent).toContain('second body')
  })
})

describe('useRenderContext — asset cache', () => {
  function imageFile(path: NotePath): VaultFile {
    return {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      extension: 'png',
      isMarkdown: false,
      size: 4,
      mtime: 1,
    }
  }

  function imageVault(body: string): VaultAdapter {
    return {
      kind: 'directory',
      name: 'vault',
      writable: true,
      list: async () => [],
      read: async () => '',
      readBinary: async () => new Blob([body], { type: 'image/png' }),
      write: async () => {},
      writeBinary: async () => {},
      remove: async () => {},
      rename: async () => {},
      exists: async () => true,
    } as unknown as VaultAdapter
  }

  it('does not serve one vault’s image for the same path in the next vault', async () => {
    const revoked: string[] = []
    let issued = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      issued += 1
      return `blob:spacefore/${issued}`
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => void revoked.push(url))

    const file = imageFile('img/shared-name.png')
    const first = imageVault('vault one picture')
    seed({ 'A.md': '![[shared-name.png]]' }, { attachments: [file], adapter: first })

    const { container } = render(<Preview path="A.md" paneId={PANE_ID} />)
    await waitFor(() => {
      expect(container.querySelector('img.embed-image')).not.toBeNull()
    })
    const before = container.querySelector('img.embed-image')!.getAttribute('src')

    // Same path, different vault: the cached URL belongs to the vault that has
    // just been closed and must not be handed to the new one.
    const second = imageVault('vault two picture')
    await act(async () => {
      useAppStore.setState({ adapter: second, attachments: [file] })
    })

    await waitFor(() => {
      expect(container.querySelector('img.embed-image')?.getAttribute('src')).not.toBe(before)
    })
    expect(container.querySelector('img.embed-image')?.getAttribute('src')).toBe('blob:spacefore/2')
    expect(revoked).toContain(before)
  })
})

describe('Preview — rendered markup is not rebuilt on every render', () => {
  it('keeps the rendered DOM when a re-render produces the same markup', async () => {
    // React 19 compares `dangerouslySetInnerHTML` by object identity and then
    // assigns `innerHTML` unconditionally, so a fresh `{ __html }` literal each
    // render silently rebuilt the whole note. That replaced the element under
    // the pointer on every render, which is what kept the hover card from ever
    // reaching its 400 ms delay.
    seed({ 'a.md': '# A\n\nA link to [[b]] and some prose.\n', 'b.md': '# B\n\nBody.\n' })
    const { container, rerender } = render(<Preview path="a.md" paneId={PANE_ID} />)

    const link = container.querySelector('.markdown-preview .internal-link')
    expect(link).not.toBeNull()

    // Three re-renders that leave the markup identical.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        rerender(<Preview path="a.md" paneId={PANE_ID} />)
      })
    }

    // Same node, not an equal-looking replacement.
    expect(container.querySelector('.markdown-preview .internal-link')).toBe(link)
    expect(link!.isConnected).toBe(true)
  })

  it('shows the hover card once the delay elapses', async () => {
    vi.useFakeTimers()
    try {
      seed({ 'a.md': 'See [[b]].\n', 'b.md': '# B note\n\nThe body of B.\n' })
      const { container } = render(<Preview path="a.md" paneId={PANE_ID} />)
      const link = container.querySelector('.markdown-preview .internal-link')!

      await act(async () => {
        fireEvent.mouseOver(link, { bubbles: true })
      })
      expect(container.querySelector('.hover-preview')).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(container.querySelector('.hover-preview-title')?.textContent).toBe('B note')
    } finally {
      vi.useRealTimers()
    }
  })
})
