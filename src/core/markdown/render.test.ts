import { renderInline, renderMarkdown } from './render'
import type { RenderContext } from './render'
import { slugifyHeading } from './parse'

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function ctx(patch: Partial<RenderContext> = {}): RenderContext {
  return {
    currentPath: 'Note.md',
    resolveLink: () => null,
    ...patch,
  }
}

/** Parse rendered HTML back into a DOM so assertions can be structural. */
function dom(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

function render(source: string, patch: Partial<RenderContext> = {}): HTMLElement {
  return dom(renderMarkdown(source, ctx(patch)))
}

/** A tiny vault for embed / link resolution tests. */
const VAULT: Record<string, string> = {
  'Known.md': '---\ntitle: Known Note\n---\n\n# Known\n\nKnown body.',
  'A.md': 'A body\n\n![[B]]',
  'B.md': 'B body\n\n![[C]]',
  'C.md': 'C body\n\n![[D]]',
  'D.md': 'D body\n\n![[E]]',
  'E.md': 'E body',
  'Loop1.md': 'one\n\n![[Loop2]]',
  'Loop2.md': 'two\n\n![[Loop1]]',
  'Sections.md': '# One\n\nfirst para\n\n## Two\n\nsecond para\n\n```sh\n# not a heading\n```\n\n# Three\n\nthird para',
}

const vaultCtx: Partial<RenderContext> = {
  resolveLink: (target) => (VAULT[`${target}.md`] !== undefined ? `${target}.md` : null),
  getEmbedContent: (path) => VAULT[path] ?? null,
}

/* ------------------------------------------------------------------ *
 * Sanitization
 * ------------------------------------------------------------------ */

describe('sanitization', () => {
  it('strips <script> tags but keeps surrounding prose', () => {
    const el = render('Before\n\n<script>alert(1)</script>\n\nAfter')
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('Before')
    expect(el.textContent).toContain('After')
    expect(el.innerHTML).not.toContain('alert(1)')
  })

  it('strips inline event handlers', () => {
    const el = render('<img src="x.png" onerror="alert(1)">')
    const img = el.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.hasAttribute('onerror')).toBe(false)
    expect(el.innerHTML).not.toContain('onerror')
  })

  it('strips onload/onclick on arbitrary raw HTML', () => {
    const el = render('<div onclick="steal()"><span onmouseover="x()">hi</span></div>')
    expect(el.innerHTML).not.toContain('onclick')
    expect(el.innerHTML).not.toContain('onmouseover')
    expect(el.textContent).toContain('hi')
  })

  it('neutralizes javascript: hrefs, both markdown and raw HTML', () => {
    const md = render('[click](javascript:alert(1))')
    for (const a of Array.from(md.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/javascript:/i)
    }
    expect(md.innerHTML).not.toMatch(/href="javascript:/i)

    const raw = render('<a href="javascript:alert(1)">click</a>')
    const anchor = raw.querySelector('a')
    expect(anchor?.getAttribute('href') ?? '').not.toMatch(/javascript:/i)

    const mixedCase = render('<a href="JaVaScRiPt:alert(1)">click</a>')
    expect(mixedCase.innerHTML).not.toMatch(/javascript:/i)
  })

  it('drops iframes, forms and style blocks', () => {
    const el = render('<iframe src="https://evil.test"></iframe>\n\n<form action="/x"><input></form>\n\n<style>body{display:none}</style>')
    expect(el.querySelector('iframe')).toBeNull()
    expect(el.querySelector('form')).toBeNull()
    expect(el.querySelector('style')).toBeNull()
  })

  it('does not execute payloads hidden inside svg', () => {
    const el = render('<svg><script>alert(1)</script></svg>')
    expect(el.querySelector('script')).toBeNull()
  })

  it('escapes markup that lives inside a code fence', () => {
    const el = render('```html\n<script>alert(1)</script>\n```')
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('pre.code-block')?.textContent).toContain('<script>alert(1)</script>')
  })

  it('escapes html coming from frontmatter values', () => {
    const el = render('---\ntitle: <img src=x onerror=alert(1)>\n---\n\nbody')
    // The value is shown as literal text; no element is created from it.
    expect(el.querySelector('.frontmatter img')).toBeNull()
    expect(el.querySelector('.frontmatter-value')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('keeps blob: and data:image urls usable for resolved assets', () => {
    const el = render('![[pic.png]]', { resolveAsset: () => 'blob:https://app.test/abc-123' })
    expect(el.querySelector('img.embed-image')?.getAttribute('src')).toBe('blob:https://app.test/abc-123')
  })
})

/* ------------------------------------------------------------------ *
 * Wiki links
 * ------------------------------------------------------------------ */

describe('wiki links', () => {
  it('renders a resolved link', () => {
    const el = render('See [[Known]] today.', vaultCtx)
    const a = el.querySelector('a.internal-link')
    expect(a).not.toBeNull()
    expect(a!.getAttribute('data-href')).toBe('Known')
    expect(a!.getAttribute('href')).toBe('#')
    expect(a!.textContent).toBe('Known')
    expect(a!.classList.contains('is-unresolved')).toBe(false)
  })

  it('marks unknown targets as unresolved', () => {
    const el = render('See [[Nowhere]].', vaultCtx)
    const a = el.querySelector('a.internal-link')!
    expect(a.classList.contains('is-unresolved')).toBe(true)
    expect(a.getAttribute('data-href')).toBe('Nowhere')
  })

  it('prefers the alias for display', () => {
    const el = render('[[Known#Details|Read this]]', vaultCtx)
    const a = el.querySelector('a.internal-link')!
    expect(a.textContent).toBe('Read this')
    expect(a.getAttribute('data-href')).toBe('Known')
    expect(a.getAttribute('data-heading')).toBe('Details')
  })

  it('falls back to "Target > Heading" then Target', () => {
    const withHeading = render('[[Known#Details]]', vaultCtx).querySelector('a')!
    expect(withHeading.textContent).toBe('Known > Details')
    expect(withHeading.getAttribute('data-heading')).toBe('Details')

    const plain = render('[[Known]]', vaultCtx).querySelector('a')!
    expect(plain.textContent).toBe('Known')
    expect(plain.hasAttribute('data-heading')).toBe(false)
  })

  it('treats [[#Heading]] as a same-note link', () => {
    const el = render('[[#Later]]', { ...vaultCtx, currentPath: 'Known.md' })
    const a = el.querySelector('a.internal-link')!
    expect(a.textContent).toBe('Later')
    expect(a.getAttribute('data-href')).toBe('Known.md')
    expect(a.classList.contains('is-unresolved')).toBe(false)
  })

  it('does not fire inside code spans or fences', () => {
    const span = render('Literal `[[Known]]` here.', vaultCtx)
    expect(span.querySelector('a.internal-link')).toBeNull()
    expect(span.querySelector('code')?.textContent).toBe('[[Known]]')

    const fence = render('```md\n[[Known]]\n```', vaultCtx)
    expect(fence.querySelector('a.internal-link')).toBeNull()
    expect(fence.querySelector('pre.code-block')?.textContent).toContain('[[Known]]')
  })

  it('ignores an escaped or unterminated bracket run', () => {
    const el = render('\\[\\[Known]] and [[unclosed', vaultCtx)
    expect(el.querySelector('a.internal-link')).toBeNull()
  })

  it('does not memoize resolution across contexts', () => {
    const source = '[[Known]]'
    const resolved = render(source, vaultCtx).querySelector('a')!
    const unresolved = render(source, { resolveLink: () => null }).querySelector('a')!
    expect(resolved.classList.contains('is-unresolved')).toBe(false)
    expect(unresolved.classList.contains('is-unresolved')).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

describe('tags', () => {
  it('renders nested tags', () => {
    const el = render('Filed under #project/alpha today.')
    const a = el.querySelector('a.tag')!
    expect(a.getAttribute('data-tag')).toBe('project/alpha')
    expect(a.getAttribute('href')).toBe('#')
    expect(a.textContent).toBe('#project/alpha')
  })

  it('does not turn ATX headings into tags', () => {
    const el = render('# Heading\n\n### Deeper')
    expect(el.querySelector('a.tag')).toBeNull()
    expect(el.querySelector('h1')).not.toBeNull()
    expect(el.querySelector('h3')).not.toBeNull()
  })

  it('ignores all-digit tags', () => {
    const el = render('Issue #1 and #42 remain numbers, #v2 does not.')
    const tags = Array.from(el.querySelectorAll('a.tag')).map((a) => a.getAttribute('data-tag'))
    expect(tags).toEqual(['v2'])
  })

  it('ignores url fragments', () => {
    const el = render('See https://example.com/docs#install for details.')
    expect(el.querySelector('a.tag')).toBeNull()
    const link = el.querySelector('a.external-link')!
    expect(link.getAttribute('href')).toBe('https://example.com/docs#install')
  })

  it('ignores a # glued to the end of a word', () => {
    const el = render('issue#12 and C# and a#b')
    expect(el.querySelector('a.tag')).toBeNull()
  })

  it('still matches after emphasis markers and brackets', () => {
    const el = render('**#bold** and (#paren)')
    const tags = Array.from(el.querySelectorAll('a.tag')).map((a) => a.getAttribute('data-tag'))
    expect(tags).toEqual(['bold', 'paren'])
  })

  it('trims trailing punctuation and separators', () => {
    const el = render('End with #tag. And #nested/ too.')
    const tags = Array.from(el.querySelectorAll('a.tag')).map((a) => a.getAttribute('data-tag'))
    expect(tags).toEqual(['tag', 'nested'])
  })

  it('does not fire inside code spans or fences', () => {
    const span = render('Literal `#nope` here.')
    expect(span.querySelector('a.tag')).toBeNull()

    const fence = render('```py\n# comment #nope\n```')
    expect(fence.querySelector('a.tag')).toBeNull()
    expect(fence.querySelector('pre.code-block')?.textContent).toContain('# comment #nope')
  })
})

/* ------------------------------------------------------------------ *
 * Embeds
 * ------------------------------------------------------------------ */

describe('embeds', () => {
  it('renders an image embed with a size hint', () => {
    const el = render('![[diagram.png|300]]', { resolveAsset: () => '/assets/diagram.png' })
    const img = el.querySelector('img.embed-image')!
    expect(img.getAttribute('src')).toBe('/assets/diagram.png')
    expect(img.getAttribute('alt')).toBe('diagram.png')
    expect(img.getAttribute('width')).toBe('300')
    expect(img.hasAttribute('height')).toBe(false)
  })

  it('supports WIDTHxHEIGHT', () => {
    const el = render('![[diagram.png|300x120]]', { resolveAsset: () => '/a.png' })
    const img = el.querySelector('img.embed-image')!
    expect(img.getAttribute('width')).toBe('300')
    expect(img.getAttribute('height')).toBe('120')
  })

  it('falls back to embed-missing when the asset does not resolve', () => {
    const el = render('![[gone.png]]', { resolveAsset: () => null })
    expect(el.querySelector('img')).toBeNull()
    const miss = el.querySelector('span.embed-missing')!
    expect(miss.textContent).toBe('![[gone.png]]')
  })

  it('falls back to embed-missing when no resolveAsset is supplied', () => {
    const el = render('![[gone.png]]')
    expect(el.querySelector('span.embed-missing')?.textContent).toBe('![[gone.png]]')
  })

  it('transcludes a note recursively', () => {
    const el = render('![[Known]]', { ...vaultCtx, currentPath: 'Host.md' })
    const embed = el.querySelector('div.embed')!
    expect(embed.getAttribute('data-href')).toBe('Known')
    expect(embed.querySelector('.embed-title')?.textContent).toBe('Known Note')
    const body = embed.querySelector('.embed-body')!
    expect(body.textContent).toContain('Known body.')
    // The embedded note is rendered, not pasted: its heading became an <h1>.
    expect(body.querySelector('h1')).not.toBeNull()
    // …and the embedded note's own frontmatter is not repeated as a table.
    expect(body.querySelector('.frontmatter')).toBeNull()
  })

  it('embeds only the requested heading section', () => {
    const el = render('![[Sections#Two]]', { ...vaultCtx, currentPath: 'Host.md' })
    const body = el.querySelector('.embed-body')!
    expect(body.textContent).toContain('second para')
    expect(body.textContent).not.toContain('first para')
    expect(body.textContent).not.toContain('third para')
    // A `#` inside a fence must not end the section early.
    expect(body.querySelector('pre.code-block')?.textContent).toContain('# not a heading')
  })

  it('breaks a two-note cycle', () => {
    const el = render(VAULT['Loop1.md']!, { ...vaultCtx, currentPath: 'Loop1.md' })
    const inner = el.querySelector('.embed .embed .embed')
    expect(inner).toBeNull()
    const cycle = el.querySelector('div.embed.embed-cycle')!
    expect(cycle.getAttribute('data-href')).toBe('Loop1')
    expect(el.textContent).toContain('two')
  })

  it('breaks a direct self-embed', () => {
    const el = render('me\n\n![[Self]]', {
      currentPath: 'Self.md',
      resolveLink: () => 'Self.md',
      getEmbedContent: () => 'me\n\n![[Self]]',
    })
    expect(el.querySelector('div.embed.embed-cycle')).not.toBeNull()
    expect(el.querySelectorAll('div.embed').length).toBe(1)
  })

  it('stops recursing at depth 3', () => {
    const el = render(VAULT['A.md']!, { ...vaultCtx, currentPath: 'A.md' })
    const hrefs = Array.from(el.querySelectorAll('div.embed')).map((d) => d.getAttribute('data-href'))
    expect(hrefs).toEqual(['B', 'C', 'D', 'E'])
    // B, C and D expanded; E is the fourth level and is cut off.
    const cycle = el.querySelector('div.embed.embed-cycle')!
    expect(cycle.getAttribute('data-href')).toBe('E')
    expect(el.textContent).toContain('D body')
    expect(el.textContent).not.toContain('E body')
  })

  it('marks a note embed missing when the target does not exist', () => {
    const el = render('![[Ghost]]', vaultCtx)
    expect(el.querySelector('div.embed')).toBeNull()
    expect(el.querySelector('span.embed-missing')?.textContent).toBe('![[Ghost]]')
  })

  it('survives a throwing vault callback', () => {
    const el = render('![[Known]]', {
      resolveLink: () => {
        throw new Error('vault exploded')
      },
    })
    expect(el.querySelector('span.embed-missing')).not.toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Task lists
 * ------------------------------------------------------------------ */

describe('task lists', () => {
  it('renders checkboxes with source line numbers', () => {
    const el = render('- [ ] one\n- [x] two')
    const list = el.querySelector('ul')!
    expect(list.classList.contains('task-list')).toBe(true)

    const items = Array.from(el.querySelectorAll('li'))
    expect(items.every((li) => li.classList.contains('task-item'))).toBe(true)

    const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]'))
    expect(boxes.map((b) => b.getAttribute('data-line'))).toEqual(['0', '1'])
    expect(boxes.map((b) => b.hasAttribute('checked'))).toEqual([false, true])
    expect(boxes.every((b) => b.hasAttribute('disabled'))).toBe(true)

    // the `[ ]` marker itself is consumed, the label survives
    expect(items[0]!.textContent!.trim()).toBe('one')
    expect(items[1]!.textContent!.trim()).toBe('two')
  })

  it('counts lines from the start of the note, not the paragraph', () => {
    const el = render('intro\n\nmore\n\n- [ ] a\n- [x] b')
    const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]'))
    expect(boxes.map((b) => b.getAttribute('data-line'))).toEqual(['4', '5'])
  })

  it('accounts for the frontmatter offset', () => {
    const source = ['---', 'title: T', 'tags: [a, b]', '---', '', '- [ ] first', '- [x] second'].join('\n')
    // The task lives on source line 5 (0-based), frontmatter included.
    expect(source.split('\n')[5]).toBe('- [ ] first')

    const el = render(source)
    const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]'))
    expect(boxes.map((b) => b.getAttribute('data-line'))).toEqual(['5', '6'])
  })

  it('handles uppercase X and inline content in the label', () => {
    const el = render('- [X] done with [[Link]] and #tag')
    const box = el.querySelector('input[type="checkbox"]')!
    expect(box.hasAttribute('checked')).toBe(true)
    expect(el.querySelector('a.internal-link')).not.toBeNull()
    expect(el.querySelector('a.tag')).not.toBeNull()
  })

  it('leaves ordinary list items alone', () => {
    const el = render('- plain\n- also plain')
    expect(el.querySelector('input[type="checkbox"]')).toBeNull()
    expect(el.querySelector('ul')!.classList.contains('task-list')).toBe(false)
    expect(el.querySelector('li')!.classList.contains('task-item')).toBe(false)
  })

  it('does not treat a bracket pair in prose as a task', () => {
    const el = render('The array is [ ] when empty.')
    expect(el.querySelector('input[type="checkbox"]')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Math
 * ------------------------------------------------------------------ */

describe('math', () => {
  it('renders inline math with katex', () => {
    const el = render('Einstein wrote $E = mc^2$ once.')
    const math = el.querySelector('.math-inline')!
    expect(math.querySelector('.katex')).not.toBeNull()
    expect(el.textContent).toContain('Einstein wrote')
  })

  it('renders block math', () => {
    const el = render('before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nafter')
    const block = el.querySelector('div.math-block')!
    expect(block.querySelector('.katex')).not.toBeNull()
    expect(el.textContent).toContain('before')
    expect(el.textContent).toContain('after')
  })

  it('renders single-line $$…$$ as display math', () => {
    const el = render('$$a^2 + b^2 = c^2$$')
    expect(el.querySelector('div.math-block, .math-display')).not.toBeNull()
    expect(el.querySelector('.katex')).not.toBeNull()
  })

  it('does not treat currency as math', () => {
    const el = render('It costs $5 and $10 in total.')
    expect(el.querySelector('.katex')).toBeNull()
    expect(el.textContent).toContain('It costs $5 and $10 in total.')
  })

  it('does not open math on an escaped dollar', () => {
    const el = render('Pay \\$5 now, \\$7 later.')
    expect(el.querySelector('.katex')).toBeNull()
    expect(el.textContent).toContain('Pay $5 now, $7 later.')
  })

  it('does not open math on a lone or space-hugged dollar', () => {
    const el = render('a $ b $ c')
    expect(el.querySelector('.katex')).toBeNull()
    expect(el.textContent).toContain('a $ b $ c')
  })

  it('does not fire inside code', () => {
    const el = render('`$x^2$` and\n\n```tex\n$y^2$\n```')
    expect(el.querySelector('.katex')).toBeNull()
    expect(el.querySelector('code')!.textContent).toBe('$x^2$')
  })

  it('never throws on malformed tex', () => {
    expect(() => renderMarkdown('$\\frac{1$', ctx())).not.toThrow()
    expect(() => renderMarkdown('$$\\begin{matrix} a\n$$', ctx())).not.toThrow()
    expect(() => renderMarkdown('$\\notarealmacro{x}$', ctx())).not.toThrow()
  })

  it('degrades to the escaped raw text when katex throws', async () => {
    vi.resetModules()
    vi.doMock('katex', () => ({
      renderToString: () => {
        throw new Error('katex exploded')
      },
    }))
    try {
      const mod = await import('./render')
      const html = mod.renderMarkdown('before $a<b$ after', ctx())
      const el = dom(html)
      expect(el.querySelector('.math-error')).not.toBeNull()
      expect(el.textContent).toContain('$a<b$')
      // the raw tex is escaped, never injected as markup
      expect(html).toContain('$a&lt;b$')
    } finally {
      vi.doUnmock('katex')
      vi.resetModules()
    }
  })
})

/* ------------------------------------------------------------------ *
 * Code blocks
 * ------------------------------------------------------------------ */

describe('code blocks', () => {
  it('renders a fence with its language', () => {
    const el = render('```ts\nconst x: number = 1\n```')
    const pre = el.querySelector('pre.code-block')!
    expect(pre.getAttribute('data-lang')).toBe('ts')
    const code = pre.querySelector('code')!
    expect(code.classList.contains('language-ts')).toBe(true)
    expect(code.textContent).toBe('const x: number = 1\n')
  })

  it('renders a fence without a language', () => {
    const el = render('```\nplain\n```')
    const pre = el.querySelector('pre.code-block')!
    expect(pre.getAttribute('data-lang')).toBe('')
    expect(pre.querySelector('code')!.className).toBe('')
  })

  it('leaves SpaceFore syntax inside a fence completely untouched', () => {
    const source = '```md\n[[Target]] #tag $x^2$ ![[Note]] - [ ] task\n```'
    const el = render(source, vaultCtx)
    expect(el.querySelector('a')).toBeNull()
    expect(el.querySelector('input')).toBeNull()
    expect(el.querySelector('.katex')).toBeNull()
    expect(el.querySelector('div.embed')).toBeNull()
    expect(el.querySelector('pre.code-block code')!.textContent).toBe(
      '[[Target]] #tag $x^2$ ![[Note]] - [ ] task\n',
    )
  })

  it('renders indented code blocks the same way', () => {
    const el = render('    indented [[Target]]\n')
    const pre = el.querySelector('pre.code-block')!
    expect(pre.textContent).toContain('indented [[Target]]')
    expect(el.querySelector('a')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Callouts, blockquotes, tables, footnotes
 * ------------------------------------------------------------------ */

describe('callouts', () => {
  it('renders a titled callout', () => {
    const el = render('> [!note] Remember this\n> Body line one.\n> Body line two.')
    const callout = el.querySelector('div.callout')!
    expect(callout.getAttribute('data-callout')).toBe('note')
    expect(callout.querySelector('.callout-title')!.textContent).toBe('Remember this')
    const body = callout.querySelector('.callout-body')!
    expect(body.textContent).toContain('Body line one.')
    expect(body.textContent).toContain('Body line two.')
    expect(el.querySelector('blockquote')).toBeNull()
  })

  it('falls back to the callout kind when no title is given', () => {
    const el = render('> [!warning]\n> Careful.')
    const callout = el.querySelector('div.callout')!
    expect(callout.getAttribute('data-callout')).toBe('warning')
    expect(callout.querySelector('.callout-title')!.textContent).toBe('Warning')
    expect(callout.querySelector('.callout-body')!.textContent).toContain('Careful.')
  })

  it('records the fold marker and renders markdown inside the title', () => {
    const el = render('> [!tip]- Try [[Known]]\n> and #hint')
    const callout = el.querySelector('div.callout')!
    expect(callout.getAttribute('data-callout-fold')).toBe('-')
    expect(callout.querySelector('.callout-title a.internal-link')).not.toBeNull()
    expect(callout.querySelector('.callout-body a.tag')).not.toBeNull()
  })

  it('leaves an ordinary blockquote as a blockquote', () => {
    const el = render('> just a quote')
    expect(el.querySelector('blockquote')).not.toBeNull()
    expect(el.querySelector('div.callout')).toBeNull()
  })
})

describe('tables and footnotes', () => {
  it('renders GFM tables', () => {
    const el = render('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(el.querySelectorAll('table thead th').length).toBe(2)
    expect(el.querySelectorAll('table tbody td').length).toBe(2)
  })

  it('renders footnotes with refs, a list and backrefs', () => {
    const el = render('Claim[^src] and again[^src].\n\n[^src]: A *cited* source.')
    const refs = Array.from(el.querySelectorAll('sup.footnote-ref a'))
    expect(refs.length).toBe(2)
    expect(refs[0]!.getAttribute('href')).toBe('#fn-src')
    expect(refs.map((r) => r.textContent)).toEqual(['1', '1'])

    const item = el.querySelector('section.footnotes li#fn-src')!
    expect(item.textContent).toContain('A cited source.')
    expect(item.querySelector('em')).not.toBeNull()
    expect(item.querySelectorAll('a.footnote-backref').length).toBe(2)

    // the definition line is moved into the footnote section, not left inline
    const paragraphs = Array.from(el.querySelectorAll('p')).map((p) => p.textContent)
    expect(paragraphs.join(' ')).not.toContain('[^src]:')
  })

  it('leaves a reference with no definition as literal text', () => {
    const el = render('Dangling[^missing] reference.')
    expect(el.querySelector('sup.footnote-ref')).toBeNull()
    expect(el.textContent).toContain('[^missing]')
  })
})

/* ------------------------------------------------------------------ *
 * Headings and links
 * ------------------------------------------------------------------ */

describe('headings', () => {
  it('adds an id and an anchor that agree with the parser slug', () => {
    const el = render('## Hello, World!\n\ntext')
    const slug = slugifyHeading('Hello, World!')
    const h2 = el.querySelector('h2')!
    expect(h2.getAttribute('id')).toBe(slug)
    const anchor = h2.querySelector('a.heading-anchor')!
    expect(anchor.getAttribute('href')).toBe(`#${slug}`)
  })

  it('slugs headings containing wiki links and tags', () => {
    const el = render('# Notes on [[Known|Topic]] and #meta')
    const h1 = el.querySelector('h1')!
    expect(h1.getAttribute('id')).toBe(slugifyHeading('Notes on Topic and #meta'))
  })
})

describe('links', () => {
  it('opens external links in a new tab safely', () => {
    const el = render('[GitHub](https://github.com/x)')
    const a = el.querySelector('a')!
    expect(a.classList.contains('external-link')).toBe(true)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.getAttribute('href')).toBe('https://github.com/x')
  })

  it('treats linkified bare urls as external', () => {
    const el = render('Visit https://example.com today')
    const a = el.querySelector('a')!
    expect(a.classList.contains('external-link')).toBe(true)
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('routes relative markdown links through the vault', () => {
    const el = render('[Other](notes/Other.md)', {
      resolveLink: (target) => (target === 'notes/Other.md' ? 'notes/Other.md' : null),
    })
    const a = el.querySelector('a')!
    expect(a.classList.contains('internal-link')).toBe(true)
    expect(a.classList.contains('is-unresolved')).toBe(false)
    expect(a.getAttribute('data-href')).toBe('notes/Other.md')
    expect(a.getAttribute('href')).toBe('#')
  })

  it('marks unresolved relative links and leaves anchors alone', () => {
    const el = render('[Gone](Gone.md) and [Top](#top)')
    const [gone, top] = Array.from(el.querySelectorAll('a'))
    expect(gone!.classList.contains('is-unresolved')).toBe(true)
    expect(top!.getAttribute('href')).toBe('#top')
    expect(top!.classList.contains('internal-link')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Frontmatter
 * ------------------------------------------------------------------ */

describe('frontmatter', () => {
  it('renders a property table ahead of the body', () => {
    const el = render('---\ntitle: My Note\nstatus: draft\n---\n\n# Body\n\ntext')
    const table = el.querySelector('.frontmatter table')!
    const keys = Array.from(table.querySelectorAll('th')).map((th) => th.textContent)
    expect(keys).toContain('title')
    expect(keys).toContain('status')
    expect(table.textContent).toContain('My Note')

    // the frontmatter never leaks into the body
    expect(el.querySelector('h1')!.textContent).toContain('Body')
    const body = el.querySelectorAll('p')
    expect(Array.from(body).map((p) => p.textContent).join(' ')).not.toContain('title:')

    // and it comes first
    expect(el.firstElementChild!.classList.contains('frontmatter')).toBe(true)
  })

  it('renders arrays as chips and tags as tag links', () => {
    const el = render('---\ntags: [alpha, beta]\naliases: [One, Two]\n---\n\nbody')
    const tags = Array.from(el.querySelectorAll('.frontmatter a.tag'))
    expect(tags.map((a) => a.getAttribute('data-tag'))).toEqual(['alpha', 'beta'])
    expect(tags.map((a) => a.textContent)).toEqual(['#alpha', '#beta'])

    const chips = Array.from(el.querySelectorAll('.frontmatter .frontmatter-chip'))
    expect(chips.map((c) => c.textContent)).toEqual(['One', 'Two'])
  })

  it('renders nothing when there is no frontmatter', () => {
    expect(render('just body text').querySelector('.frontmatter')).toBeNull()
  })

  it('renders nothing for an empty frontmatter block', () => {
    const el = render('---\n---\n\nbody')
    expect(el.querySelector('.frontmatter')).toBeNull()
    expect(el.textContent).toContain('body')
  })
})

/* ------------------------------------------------------------------ *
 * renderInline
 * ------------------------------------------------------------------ */

describe('renderInline', () => {
  it('renders without block wrapping', () => {
    const html = renderInline('**bold** and *em*')
    expect(html).not.toContain('<p>')
    const el = dom(html)
    expect(el.querySelector('strong')!.textContent).toBe('bold')
    expect(el.querySelector('em')!.textContent).toBe('em')
  })

  it('renders wiki links and tags neutrally (no vault context)', () => {
    const el = dom(renderInline('[[Known|Alias]] and #tag'))
    const link = el.querySelector('a.internal-link')!
    expect(link.textContent).toBe('Alias')
    // Without a resolver there is nothing to be unresolved against.
    expect(link.classList.contains('is-unresolved')).toBe(false)
    expect(el.querySelector('a.tag')!.getAttribute('data-tag')).toBe('tag')
  })

  it('sanitizes its input too', () => {
    const el = dom(renderInline('<img src=x onerror="alert(1)"> text'))
    expect(el.innerHTML).not.toContain('onerror')
    expect(el.textContent).toContain('text')
  })

  it('renders inline math', () => {
    expect(dom(renderInline('$a^2$')).querySelector('.katex')).not.toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * Re-entrancy / repeat calls
 * ------------------------------------------------------------------ */

describe('repeated rendering', () => {
  const source = [
    '---',
    'title: Repeat',
    'tags: [x]',
    '---',
    '',
    '# Heading',
    '',
    'Prose with [[Known]], #tag, $a^2$ and [ext](https://e.test).',
    '',
    '- [ ] todo',
    '- [x] done',
    '',
    '```ts',
    'const a = "[[nope]] #nope"',
    '```',
    '',
    '> [!note] Callout',
    '> body',
  ].join('\n')

  it('is stable across calls (no shared state leaks between renders)', () => {
    const first = renderMarkdown(source, ctx(vaultCtx))
    for (let i = 0; i < 5; i += 1) {
      expect(renderMarkdown(source, ctx(vaultCtx))).toBe(first)
    }
    const el = dom(first)
    expect(el.querySelectorAll('a.external-link').length).toBe(1)
    expect(el.querySelector('a.external-link')!.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('does not accumulate footnote definitions between renders', () => {
    renderMarkdown('a[^one]\n\n[^one]: first', ctx())
    const el = dom(renderMarkdown('b[^one] plain', ctx()))
    expect(el.querySelector('section.footnotes')).toBeNull()
    expect(el.textContent).toContain('[^one]')
  })
})
