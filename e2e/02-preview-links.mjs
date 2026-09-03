import { boot, step, report, open, mode, must } from './lib.mjs'
const { browser, page, problems } = await boot()
console.log('== 2. preview, links, tags, tasks, embeds ==')

await open(page, 'Formatting Playground'); await mode(page, 'Preview')

await step('every renderer feature appears', async () => {
  const c = await page.evaluate(() => ({
    headings: document.querySelectorAll('.markdown-preview h1,.markdown-preview h2,.markdown-preview h3').length,
    links: document.querySelectorAll('.markdown-preview .internal-link').length,
    unresolved: document.querySelectorAll('.markdown-preview .internal-link.is-unresolved').length,
    tags: document.querySelectorAll('.markdown-preview .tag').length,
    tasks: document.querySelectorAll('.markdown-preview .task-item').length,
    tables: document.querySelectorAll('.markdown-preview table').length,
    callouts: document.querySelectorAll('.markdown-preview .callout').length,
    code: document.querySelectorAll('.markdown-preview .code-block').length,
    katex: document.querySelectorAll('.markdown-preview .katex').length,
    embeds: document.querySelectorAll('.markdown-preview .embed').length,
    frontmatter: document.querySelectorAll('.markdown-preview .frontmatter').length,
    footnotes: document.querySelectorAll('.markdown-preview .footnotes').length,
    scripts: document.querySelectorAll('.markdown-preview script').length,
  }))
  for (const k of ['headings','links','tags','tasks','tables','callouts','code','katex','frontmatter'])
    must(c[k] > 0, `${k} = 0 — ${JSON.stringify(c)}`)
  must(c.scripts === 0, 'a <script> survived sanitisation')
  return JSON.stringify(c)
})

await step('code spans really are inert', async () => {
  const t = await page.evaluate(() => document.querySelector('.markdown-preview').innerText)
  must(t.includes('[[not a link]]'), 'literal wiki link inside code was transformed')
  must(t.includes('#nottag'), 'literal tag inside code was transformed')
  const inCode = await page.evaluate(() =>
    [...document.querySelectorAll('.markdown-preview code')].some(c => c.querySelector('.internal-link, .tag')))
  must(!inCode, 'a link or tag was rendered inside a code span')
})

await step('clicking an internal link navigates', async () => {
  await page.locator('.markdown-preview .internal-link:not(.is-unresolved)').first().click()
  await page.waitForTimeout(900)
  const tab = await page.locator('.tab[aria-selected="true"] .tab-title, .tab.is-active .tab-title').first().innerText()
  must(!/Formatting/.test(tab), 'still on the same note: ' + tab)
  return 'now on ' + tab
})

await step('clicking a tag drives the search panel', async () => {
  await open(page, 'Formatting Playground'); await mode(page, 'Preview')
  await page.locator('.markdown-preview .tag').first().click(); await page.waitForTimeout(900)
  const q = await page.locator('.search-panel input, .search-input').first().inputValue()
  must(/^tag:/.test(q), 'search query is ' + JSON.stringify(q))
  return q
})

await step('toggling a task checkbox rewrites exactly that line', async () => {
  await open(page, 'Formatting Playground'); await mode(page, 'Preview')
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.markdown-preview .task-item input')].map(i => i.checked))
  await page.locator('.markdown-preview .task-item input').first().click(); await page.waitForTimeout(1000)
  const after = await page.evaluate(() =>
    [...document.querySelectorAll('.markdown-preview .task-item input')].map(i => i.checked))
  must(before.length === after.length, `task count changed ${before.length} -> ${after.length}`)
  must(before[0] !== after[0], 'first checkbox did not toggle')
  const others = before.slice(1).every((v, i) => v === after[i + 1])
  must(others, `another checkbox changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  // put it back
  await page.locator('.markdown-preview .task-item input').first().click(); await page.waitForTimeout(900)
  return `${before.length} tasks, only the clicked one changed`
})

await step('an embed renders the target note inline', async () => {
  const embed = await page.evaluate(() => {
    const e = document.querySelector('.markdown-preview .embed')
    return e ? { title: e.querySelector('.embed-title')?.textContent, bodyLen: (e.querySelector('.embed-body')?.textContent || '').length } : null
  })
  must(embed, 'no embed rendered')
  must(embed.bodyLen > 20, 'embed body is empty: ' + JSON.stringify(embed))
  return JSON.stringify(embed)
})

await step('hover card appears over a resolved link', async () => {
  const link = page.locator('.markdown-preview .internal-link:not(.is-unresolved)').first()
  const b = await link.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.waitForTimeout(1000)
  const card = await page.evaluate(() => {
    const el = document.querySelector('.hover-preview')
    return el ? { title: el.querySelector('.hover-preview-title')?.textContent, bg: getComputedStyle(el).backgroundColor } : null
  })
  must(card, 'no hover card')
  must(card.bg !== 'rgba(0, 0, 0, 0)', 'hover card is transparent')
  await page.mouse.move(5, 5); await page.waitForTimeout(500)
  must(!(await page.locator('.hover-preview').count()), 'hover card did not dismiss')
  return card.title
})

await step('an unresolved link creates the note on click', async () => {
  await open(page, 'Linking Notes'); await mode(page, 'Preview')
  const beforeNotes = await page.locator('.statusbar').innerText()
  const unresolved = page.locator('.markdown-preview .internal-link.is-unresolved').first()
  if (!(await unresolved.count())) throw new Error('no unresolved link in this note to click')
  const name = await unresolved.innerText()
  await unresolved.click(); await page.waitForTimeout(1200)
  const afterNotes = await page.locator('.statusbar').innerText()
  must(beforeNotes !== afterNotes, 'note count unchanged: ' + afterNotes)
  const tab = await page.locator('.tab[aria-selected="true"] .tab-title, .tab.is-active .tab-title').first().innerText()
  must(tab.trim().length > 0, 'no tab opened')
  return `created and opened "${tab}" from [[${name}]]`
})

process.exitCode = report(problems, 'preview') > 0 ? 1 : 0
await browser.close()
