import { boot, step, report, open, mode, must } from './lib.mjs'
const { browser, page, problems } = await boot()
console.log('== 4. side panels, graph ==')

const rsTab = async (name) => { await page.locator('.right-sidebar-tab').filter({ hasText: name }).first().click(); await page.waitForTimeout(600) }

await open(page, 'Zettelkasten'); await mode(page, 'Preview')

await step('backlinks list linked mentions with context', async () => {
  await rsTab('Backlinks')
  const groups = await page.locator('.backlink-group').count()
  must(groups > 3, `${groups} backlink groups`)
  const ctx = await page.locator('.backlink-context').first().innerText()
  must(ctx.trim().length > 10, 'empty context line')
  return `${groups} groups`
})

await step('clicking a backlink opens the source note', async () => {
  const title = await page.locator('.backlink-group').first().innerText()
  await page.locator('.backlink-group').first().click(); await page.waitForTimeout(900)
  const tab = await page.locator('.tab[aria-selected="true"] .tab-title, .tab.is-active .tab-title').first().innerText()
  must(tab.trim().length > 0, 'nothing opened')
  return `${title.split('\n')[0]} -> tab "${tab}"`
})

await step('unlinked mentions are detected and can be linked', async () => {
  await open(page, 'Zettelkasten'); await mode(page, 'Preview'); await rsTab('Backlinks')
  const body = await page.locator('.right-sidebar').innerText()
  must(/unlinked mentions/i.test(body), 'no unlinked mentions section')
  return body.split('\n').filter(l => /unlinked/i.test(l))[0]
})

await step('outline lists headings and scrolls on click', async () => {
  await open(page, 'Search Syntax'); await mode(page, 'Edit')
  await rsTab('Outline')
  const items = await page.locator('.outline-item').count()
  must(items > 1, `${items} outline items`)
  const before = await page.evaluate(() => Math.round(document.querySelector('.cm-scroller')?.scrollTop ?? -1))
  await page.locator('.outline-item').last().click(); await page.waitForTimeout(800)
  const after = await page.evaluate(() => Math.round(document.querySelector('.cm-scroller')?.scrollTop ?? -1))
  must(after !== before, `scrollTop unchanged (${before})`)
  return `${items} headings, scrolled ${before} -> ${after}`
})

await step('note info shows real numbers', async () => {
  await rsTab('Info')
  const t = await page.locator('.right-sidebar-body').innerText()
  must(/Words/i.test(t) && /\d/.test(t), "no word count: " + t.slice(0, 160))
  must(/min|read/i.test(t), 'no reading time')
  return t.split('\n').filter(l => /word|read/i.test(l)).slice(0, 2).join(' / ')
})

await step('tag panel builds a nested tree and drives search', async () => {
  await page.locator('.ribbon-btn').nth(2).click(); await page.waitForTimeout(700)
  const items = await page.locator('.tag-tree-item').count()
  must(items > 3, `${items} tag rows`)
  await page.locator('.tag-tree-item').first().click(); await page.waitForTimeout(800)
  const q = await page.locator('.search-input, .search-panel input').first().inputValue()
  must(/^tag:/.test(q), 'query is ' + JSON.stringify(q))
  return `${items} tags, clicked -> ${q}`
})

await step('starring a note shows it in the starred panel', async () => {
  await open(page, 'Atomic Notes')
  await page.keyboard.press('Control+Shift+S'); await page.waitForTimeout(600)
  await page.locator('.ribbon-btn').nth(3).click(); await page.waitForTimeout(700)
  const t = await page.locator('.sidebar').innerText()
  must(/Atomic Notes/.test(t), 'starred panel: ' + t.slice(0, 200))
  await page.keyboard.press('Control+Shift+S'); await page.waitForTimeout(500)
})

await step('graph renders nodes, edges and a legend', async () => {
  await page.keyboard.press('Control+g'); await page.waitForTimeout(4500)
  const info = await page.evaluate(() => {
    const cv = document.querySelector('canvas'); if (!cv) return null
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let on = 0; for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) on++
    return { size: `${cv.width}x${cv.height}`, painted: on, controls: document.querySelector('.graph-controls')?.innerText.replace(/\n/g, ' ') }
  })
  must(info, 'no canvas')
  must(info.painted > 20, 'canvas is blank: ' + JSON.stringify(info))
  must(/\d+ nodes/.test(info.controls || ''), 'no node count: ' + info.controls)
  return `${info.size}, ${info.controls.slice(-24)}`
})

await step('graph zoom and pan respond', async () => {
  const box = await page.locator('canvas').first().boundingBox()
  const shot = async () => page.evaluate(() => {
    const cv = document.querySelector('canvas'); const d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data
    let h = 0; for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0; return h
  })
  const a = await shot()
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2)
  await page.mouse.wheel(0, -400); await page.waitForTimeout(800)
  const b = await shot()
  must(a !== b, 'zoom changed nothing')
  await page.mouse.down(); await page.mouse.move(box.x + box.width/2 + 120, box.y + box.height/2 + 80); await page.mouse.up()
  await page.waitForTimeout(700)
  must(await shot() !== b, 'pan changed nothing')
})

await step('graph toggles rewrite the graph', async () => {
  const nodes = async () => (await page.locator('.graph-controls').innerText()).match(/(\d+) nodes/)?.[1]
  const before = await nodes()
  await page.locator('.graph-controls input[type="checkbox"], .graph-controls .switch').nth(1).click()
  await page.waitForTimeout(2500)
  const after = await nodes()
  must(before !== after, `show-tags did not change the node count (${before})`)
  await page.locator('.graph-controls input[type="checkbox"], .graph-controls .switch').nth(1).click()
  await page.waitForTimeout(1500)
  return `${before} -> ${after} nodes with tags on`
})

await step('local graph renders for the active note', async () => {
  await open(page, 'Zettelkasten')
  await rsTab('Local graph')
  await page.waitForTimeout(3000)
  const n = await page.locator('.right-sidebar canvas').count()
  must(n > 0, 'no local graph canvas')
  const g = await page.evaluate(() => {
    const cv = document.querySelector('.right-sidebar canvas'); if (!cv) return null
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let opaque = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++
    return { size: `${cv.width}x${cv.height}`, pct: (opaque / (cv.width * cv.height)) * 100 }
  })
  must(g, 'no canvas')
  must(g.pct > 1, `local graph is blank (${g.pct.toFixed(2)}%)`)
  const [w, h] = g.size.split('x').map(Number)
  must(h > 300, `local graph canvas is only ${h}px tall — it is not filling the panel`)
  return `${g.size}, ${g.pct.toFixed(1)}% painted`
})

process.exitCode = report(problems, 'panels/graph') > 0 ? 1 : 0
await browser.close()
