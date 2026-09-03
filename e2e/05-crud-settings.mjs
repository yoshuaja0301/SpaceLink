import { boot, step, report, open, mode, must } from './lib.mjs'
const { browser, page, problems } = await boot()
console.log('== 5. create, rename, delete, settings, theme, persistence ==')

const noteCount = async () => Number((await page.locator('.statusbar').innerText()).match(/(\d+) notes/)?.[1] ?? -1)
const palette = async (cmd) => {
  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(420)
  await page.keyboard.type(cmd); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)
}

await step('New note creates and opens an empty note', async () => {
  const before = await noteCount()
  await palette('New note')
  const after = await noteCount()
  must(after === before + 1, `notes ${before} -> ${after}`)
  must(await page.locator('.cm-content').count() > 0, 'editor did not open')
  return `${before} -> ${after}`
})

await step('the new note can be typed into and saves', async () => {
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('# Scratch\n\nLinking to [[Zettelkasten]] from a brand new note.\n')
  await page.waitForTimeout(1500)
  const status = await page.locator('.statusbar').innerText()
  must(/Saved/.test(status), 'not saved: ' + status)
})

await step('the new note appears as a backlink on its target', async () => {
  await open(page, 'Zettelkasten')
  await page.locator('.right-sidebar-tab').filter({ hasText: 'Backlinks' }).first().click()
  await page.waitForTimeout(900)
  const t = await page.locator('.right-sidebar-body').innerText()
  must(/Scratch|Untitled/.test(t), 'new note is not in the backlinks: ' + t.slice(0, 160))
})

await step("today's daily note is created", async () => {
  const before = await noteCount()
  await page.keyboard.press('Control+Shift+D'); await page.waitForTimeout(1200)
  const after = await noteCount()
  must(after >= before, `notes went down ${before} -> ${after}`)
  const tab = await page.locator('.tab[aria-selected="true"] .tab-title, .tab.is-active .tab-title').first().innerText()
  must(/\d{4}-\d{2}-\d{2}/.test(tab), 'daily note tab is ' + tab)
  return tab
})

await step('renaming a note rewrites the links that pointed at it', async () => {
  await open(page, 'Atomic Notes')
  const before = await page.evaluate(() => {
    const el = document.querySelector('.cm-content')
    return el ? el.innerText.length : 0
  })
  await palette('Rename current note')
  await page.waitForTimeout(600)
  const field = page.getByLabel('New name')
  if (!(await field.count())) throw new Error('no rename field appeared')
  await field.fill('Atomic Notes Renamed'); await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  // A note that linked to it must now point at the new name.
  await open(page, 'Zettelkasten'); await mode(page, 'Edit')
  const text = await page.evaluate(() => document.querySelector('.cm-content')?.innerText ?? '')
  must(/Atomic Notes Renamed/.test(text), 'link was not rewritten')
  must(before >= 0, 'sanity')
  return 'links updated'
})

await step('renaming back restores the original links', async () => {
  await open(page, 'Atomic Notes Renamed')
  await palette('Rename current note'); await page.waitForTimeout(600)
  const field = page.getByLabel('New name')
  await field.fill('Atomic Notes'); await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  await open(page, 'Zettelkasten'); await mode(page, 'Edit')
  const text = await page.evaluate(() => document.querySelector('.cm-content')?.innerText ?? '')
  must(!/Atomic Notes Renamed/.test(text), 'stale renamed link left behind')
})

await step('deleting a note removes it and leaves the vault consistent', async () => {
  await open(page, 'Scratch')
  const before = await noteCount()
  await palette('Delete current note')
  await page.waitForTimeout(500)
  const confirm = page.locator('.modal').getByRole('button', { name: 'Delete' })
  if (!(await confirm.count())) throw new Error('no confirmation dialog appeared')
  await confirm.click(); await page.waitForTimeout(1200)
  const after = await noteCount()
  must(after === before - 1, `notes ${before} -> ${after}`)
  return `${before} -> ${after}`
})

await step('settings opens and every section is present', async () => {
  await page.keyboard.press('Control+,'); await page.waitForTimeout(800)
  const t = await page.locator('.modal').innerText()
  for (const section of ['Appearance', 'Editor', 'Notes', 'Graph', 'Vault', 'About'])
    must(new RegExp(section, 'i').test(t), `no ${section} section`)
  return 'all six sections'
})

await step('changing the theme in settings repaints the app', async () => {
  const bg = async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const dark = await bg()
  const light = page.locator('.modal').getByText('Light', { exact: true }).first()
  await light.click(); await page.waitForTimeout(900)
  const now = await bg()
  must(dark !== now, `background unchanged (${dark})`)
  await page.locator('.modal').getByText('Dark', { exact: true }).first().click(); await page.waitForTimeout(700)
  must(await bg() === dark, 'did not switch back to dark')
  return `${dark} -> ${now} -> back`
})

await step('the font size slider changes the app font size', async () => {
  const size = async () => page.evaluate(() => getComputedStyle(document.querySelector('.app')).fontSize)
  const before = await size()
  const slider = page.locator('.modal input[type="range"]').first()
  await slider.focus()
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  const after = await size()
  must(before !== after, `font size unchanged (${before})`)
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(500)
  return `${before} -> ${after}`
})

await step('settings closes on Escape', async () => {
  await page.keyboard.press('Escape'); await page.waitForTimeout(600)
  must(!(await page.locator('.modal').count()), 'modal still open')
})

await step('settings survive a reload', async () => {
  await page.keyboard.press('Control+,'); await page.waitForTimeout(700)
  await page.locator('.modal').getByText('Light', { exact: true }).first().click(); await page.waitForTimeout(600)
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1800)
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  must(theme === 'light', 'theme after reload is ' + theme)
  await page.evaluate(() => localStorage.clear())
  return 'theme persisted'
})

process.exitCode = report(problems, 'crud/settings') > 0 ? 1 : 0
await browser.close()
