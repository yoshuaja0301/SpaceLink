import { boot, step, report, open, mode, must } from './lib.mjs'
const { browser, page, problems } = await boot()
console.log('== 3. search, palette, shortcuts ==')

const search = async (q) => {
  await page.keyboard.press('Control+Shift+F'); await page.waitForTimeout(400)
  await page.keyboard.press('Control+a'); await page.keyboard.type(q)
  await page.waitForTimeout(900)
  return page.locator('.search-result').count()
}

await step('plain term search finds notes', async () => {
  const n = await search('zettelkasten')
  must(n > 0, 'no results'); return `${n} notes`
})

await step('tag: filter works', async () => {
  const n = await search('tag:pkm/method')
  must(n > 0, 'no results for tag:pkm/method'); return `${n} notes`
})

await step('path: filter narrows to a folder', async () => {
  const all = await search('note')
  const scoped = await search('note path:Guides')
  must(scoped > 0, 'path filter returned nothing')
  must(scoped < all, `path filter did not narrow (${all} -> ${scoped})`)
  return `${all} -> ${scoped}`
})

await step('"quoted phrase" is exact', async () => {
  const loose = await search('slip box')
  const exact = await search('"slip box"')
  must(exact > 0, 'no phrase results')
  must(exact <= loose, `phrase (${exact}) wider than loose (${loose})`)
  return `${loose} -> ${exact}`
})

await step('-exclusion removes notes', async () => {
  const with_ = await search('note')
  const without = await search('note -graph')
  must(without < with_, `exclusion did nothing (${with_} -> ${without})`)
  return `${with_} -> ${without}`
})

await step('/regex/ is honoured', async () => {
  const n = await search('/Luhmann|Zettel/')
  must(n > 0, 'regex returned nothing'); return `${n} notes`
})

await step('a broken regex does not crash the panel', async () => {
  await search('/unclosed[/')
  must(await page.locator('.search-panel').count() > 0, 'search panel disappeared')
})

await step('clicking a result reveals the line in the editor', async () => {
  await search('Luhmann')
  await page.locator('.search-match').first().click()
  await page.waitForTimeout(400)
  const flashed = await page.locator('.cm-flash-line').count()
  must(await page.locator('.cm-content').count() > 0, 'no editor opened')
  must(flashed > 0, 'the matched line was not flashed')
  return `${flashed} line flashed`
})

await step('command palette lists and runs commands', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(500)
  const total = await page.locator('.palette-item').count()
  must(total > 20, `only ${total} commands`)
  await page.keyboard.type('daily'); await page.waitForTimeout(450)
  const filtered = await page.locator('.palette-item').count()
  must(filtered > 0 && filtered < total, `filter ${total} -> ${filtered}`)
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  must(!(await page.locator('.palette').count()), 'palette did not close on Escape')
  return `${total} commands, "daily" -> ${filtered}`
})

await step('quick switcher offers to create an unknown note', async () => {
  await page.keyboard.press('Control+p'); await page.waitForTimeout(350)
  await page.keyboard.type('a note that does not exist at all'); await page.waitForTimeout(500)
  const text = await page.locator('.palette-list').innerText()
  must(/create/i.test(text), 'no create fallback: ' + text.slice(0, 120))
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
})

await step('go-to-heading lists the note headings', async () => {
  await page.keyboard.press('Escape')
  await open(page, 'Search Syntax')
  await page.keyboard.press('Control+Shift+O'); await page.waitForTimeout(500)
  const n = await page.locator('.palette-item').count()
  must(n > 1, `${n} headings`)
  await page.keyboard.press('Enter'); await page.waitForTimeout(600)
  return `${n} headings`
})

await step('arrow keys move the palette selection', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(450)
  const first = await page.locator('.palette-item.is-selected').first().innerText()
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250)
  const second = await page.locator('.palette-item.is-selected').first().innerText()
  must(first !== second, 'selection did not move')
  await page.keyboard.press('Escape')
  return `${first.split('\n')[0]} -> ${second.split('\n')[0]}`
})

await step('shortcuts fire while the caret is in the editor', async () => {
  await open(page, 'Start Here'); await mode(page, 'Edit')
  await page.locator('.cm-content').first().click(); await page.waitForTimeout(300)
  await page.keyboard.press('Control+g'); await page.waitForTimeout(2500)
  must(await page.locator('canvas').count() > 0, 'Ctrl+G did not open the graph')
  await page.keyboard.press('Control+,'); await page.waitForTimeout(700)
  must(await page.locator('.modal').count() > 0, 'Ctrl+, did not open settings')
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
})

await step('Ctrl+B toggles the sidebar only outside the editor', async () => {
  await open(page, 'Start Here'); await mode(page, 'Edit')
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+End'); await page.keyboard.type('\nsidebartest')
  await page.keyboard.down('Shift'); for (let i=0;i<11;i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift')
  await page.keyboard.press('Control+b'); await page.waitForTimeout(400)
  const text = await page.evaluate(()=>document.querySelector('.cm-content').innerText.slice(-30))
  must(text.includes('**sidebartest**'), 'Ctrl+B did not bold: ' + JSON.stringify(text))
  for (let i=0;i<30;i++) await page.keyboard.press('Control+z')
  await page.waitForTimeout(400)
})

await step('the quick switcher survives the editor arriving late', async () => {
  // The editor is a lazily loaded chunk, so its mount can land a second after
  // the app has painted — after a reader has opened the switcher and started
  // typing. It used to take the focus back at that moment: the palette went on
  // filtering, because it reads its own input, and Enter went to CodeMirror.
  // Nothing opened. This races it on a fresh page on purpose.
  const racer = await browser.newPage()
  const noise = []
  racer.on('pageerror', (error) => noise.push('PAGEERROR: ' + error.message))
  try {
    await racer.goto(page.url(), { waitUntil: 'load' })
    await racer.waitForSelector('.statusbar', { timeout: 40_000 })
    // Deliberately no settling time — that is the whole point.
    await racer.keyboard.press('Control+p')
    await racer.waitForSelector('.palette-input', { timeout: 15_000 })
    await racer.keyboard.type('Markdown')
    await racer.waitForTimeout(700)
    await racer.keyboard.press('Enter')
    await racer.waitForTimeout(1800)

    const tabs = await racer.locator('.tab-title').allInnerTexts()
    must(tabs.some((title) => /Markdown/i.test(title)), `Enter opened nothing: ${JSON.stringify(tabs)}`)
    must(noise.length === 0, noise.join('; '))
    return tabs.join(', ')
  } finally {
    await racer.close()
  }
})

process.exitCode = report(problems, 'search/palette') > 0 ? 1 : 0
await browser.close()
