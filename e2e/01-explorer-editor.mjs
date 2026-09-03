import { boot, step, report, open, mode, must } from './lib.mjs'
const { browser, page, problems } = await boot()
console.log('== 1. explorer, tabs, editor ==')

await step('boots with the demo vault loaded', async () => {
  const notes = await page.locator('.statusbar').innerText()
  must(/22 notes/.test(notes), 'status bar: ' + notes)
  return notes.split('\n').slice(0,2).join(' / ')
})

await step('folders expand and collapse', async () => {
  const folder = page.locator('.nav-folder-row').filter({ hasText: 'Guides' }).first()
  const before = await page.locator('.nav-file').count()
  await folder.click(); await page.waitForTimeout(400)
  const after = await page.locator('.nav-file').count()
  must(after > before, `expand did nothing (${before} -> ${after})`)
  await folder.click(); await page.waitForTimeout(400)
  must(await page.locator('.nav-file').count() === before, 'collapse did not restore')
  return `${before} -> ${after} rows`
})

await step('clicking a file opens it', async () => {
  await page.locator('.nav-folder-row').filter({ hasText: 'Guides' }).first().click(); await page.waitForTimeout(400)
  await page.locator('.nav-file').filter({ hasText: 'Search Syntax' }).first().click(); await page.waitForTimeout(700)
  const tab = await page.locator('.tab.is-active .tab-title, .tab[aria-selected="true"] .tab-title').first().innerText()
  must(/Search Syntax/.test(tab), 'active tab is ' + tab)
})

await step('ctrl-click opens a second tab', async () => {
  const before = await page.locator('.tab').count()
  await page.locator('.nav-file').filter({ hasText: 'Linking Notes' }).first().click({ modifiers: ['Control'] })
  await page.waitForTimeout(700)
  const after = await page.locator('.tab').count()
  must(after === before + 1, `tabs ${before} -> ${after}`)
  return `${after} tabs`
})

await step('middle-click closes a tab', async () => {
  const before = await page.locator('.tab').count()
  await page.locator('.tab').first().click({ button: 'middle' }); await page.waitForTimeout(500)
  const after = await page.locator('.tab').count()
  must(after === before - 1, `tabs ${before} -> ${after}`)
})

await step('typing edits the note and the status bar follows', async () => {
  await mode(page, 'Edit')
  const cm = page.locator('.cm-content').first()
  await cm.click(); await page.keyboard.press('Control+End')
  const before = await page.locator('.statusbar').innerText()
  await page.keyboard.type('\n\nA sentence added by the end to end test.')
  await page.waitForTimeout(1400)
  const after = await page.locator('.statusbar').innerText()
  must(before !== after, 'word count did not change')
  must(/Saved|Unsaved|Saving/.test(after), 'no save indicator: ' + after)
  return after.split('\n').filter(s=>/word/.test(s))[0]
})

await step('bold, italic and inline code round-trip', async () => {
  const cm = page.locator('.cm-content').first()
  await cm.click(); await page.keyboard.press('Control+End')
  await page.keyboard.type('\nroundtrip')
  const select = async () => { await page.keyboard.down('Shift'); for (let i=0;i<9;i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift') }
  for (const [key, marks] of [['b','**'],['i','*'],['e',null]]) {
    if (key === 'e') continue
    await select(); await page.keyboard.press(`Control+${key}`); await page.waitForTimeout(300)
    let text = await page.evaluate(()=>document.querySelector('.cm-content').innerText.slice(-30))
    must(text.includes(`${marks}roundtrip${marks}`), `${key}: applying gave ${JSON.stringify(text)}`)
    await select(); await page.keyboard.press(`Control+${key}`); await page.waitForTimeout(300)
    text = await page.evaluate(()=>document.querySelector('.cm-content').innerText.slice(-30))
    must(text.trimEnd().endsWith('roundtrip'), `${key}: undo gave ${JSON.stringify(text)}`)
  }
})

await step('[[ opens wiki-link autocomplete', async () => {
  const cm = page.locator('.cm-content').first()
  await cm.click(); await page.keyboard.press('Control+End')
  await page.keyboard.type('\n[[Zettel')
  await page.waitForTimeout(900)
  const opts = await page.locator('.cm-tooltip-autocomplete li').count()
  must(opts > 0, 'no completion options')
  await page.keyboard.press('Escape')
  return `${opts} options`
})

await step('undo restores the note', async () => {
  for (let i=0;i<40;i++) await page.keyboard.press('Control+z')
  await page.waitForTimeout(600)
  const text = await page.evaluate(()=>document.querySelector('.cm-content').innerText)
  must(!text.includes('roundtrip'), 'undo left test text behind')
})

await step('split right creates a second pane', async () => {
  await page.locator('[aria-label="Split right"]').first().click(); await page.waitForTimeout(900)
  const panes = await page.locator('.pane').count()
  must(panes === 2, `${panes} panes`)
  return `${panes} panes`
})

await step('closing a pane returns to one', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(400)
  await page.keyboard.type('Close pane'); await page.waitForTimeout(400)
  await page.keyboard.press('Enter'); await page.waitForTimeout(700)
  const panes = await page.locator('.pane').count()
  must(panes === 1, `${panes} panes`)
})

process.exitCode = report(problems, 'explorer/editor') > 0 ? 1 : 0
await browser.close()
