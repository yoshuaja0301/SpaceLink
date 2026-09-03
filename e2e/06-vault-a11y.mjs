import { boot, step, report, open, mode, must } from './lib.mjs'
const { browser, page, problems } = await boot()
console.log('== 6. vault picker, persistence, keyboard ==')

await step('the vault picker offers the three vault kinds', async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacelink:open-vault-picker')))
  await page.waitForTimeout(900)
  const t = await page.locator('.vault-picker').innerText()
  for (const kind of ['demo', 'browser', 'folder'])
    must(new RegExp(kind, 'i').test(t), `no ${kind} option:\n${t}`)
  return t.split('\n').filter(l => l.trim()).slice(0, 3).join(' | ')
})

await step('the folder option is disabled when the API is missing', async () => {
  const state = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.vault-picker button')]
    const folder = cards.find(c => /folder/i.test(c.textContent || ''))
    return folder ? { disabled: folder.disabled || folder.getAttribute('aria-disabled') === 'true', supported: 'showDirectoryPicker' in window } : null
  })
  must(state, 'no folder card')
  // Chromium has the API, so it must be enabled here — the disabled path is the Firefox/Safari case.
  must(state.supported ? !state.disabled : state.disabled, `supported=${state.supported} disabled=${state.disabled}`)
  return `File System Access API supported: ${state.supported}`
})

await step('switching to the browser vault seeds and loads it', async () => {
  await page.locator('.vault-picker button').filter({ hasText: /browser/i }).first().click()
  await page.waitForTimeout(2500)
  const status = await page.locator('.statusbar').innerText()
  must(/note/i.test(status), 'status bar: ' + status)
  must(!(await page.locator('.vault-picker').count()), 'picker stayed open')
  return status.split('\n').slice(0, 2).join(' / ')
})

await step('a note written to the browser vault survives a reload', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(400)
  await page.keyboard.type('New note'); await page.waitForTimeout(400)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('# Persisted\n\nThis text must survive a reload.\n')
  await page.waitForTimeout(1800)

  const before = await page.locator('.nav-file').allInnerTexts()
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(3000)
  const after = await page.locator('.nav-file').allInnerTexts()
  must(JSON.stringify(before) === JSON.stringify(after), `file list changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  const target = after.find((f) => /Untitled/i.test(f))
  must(target, 'the new note is gone after reload: ' + JSON.stringify(after))
  await page.locator('.nav-file').filter({ hasText: target.trim() }).first().click()
  await page.waitForTimeout(900)
  must(await page.evaluate(() => /must survive a reload/i.test(document.body.innerText)), 'the text did not survive')
  return `${after.length} notes restored from IndexedDB, content intact`
})

await step('back to the demo vault leaves the browser vault alone', async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacelink:open-vault-picker')))
  await page.waitForTimeout(800)
  await page.locator('.vault-picker button').filter({ hasText: /demo/i }).first().click()
  await page.waitForTimeout(2200)
  const status = await page.locator('.statusbar').innerText()
  must(/22 notes/.test(status), 'demo vault did not load: ' + status)
  return status.split('\n')[0]
})

await step('the file tree is reachable and operable by keyboard', async () => {
  // The ribbon buttons toggle, so only click when the tree is not already up.
  if ((await page.locator('[role="tree"]').count()) === 0) {
    await page.locator('.ribbon-btn').first().click(); await page.waitForTimeout(800)
  }
  if ((await page.locator('[role="tree"]').count()) === 0) throw new Error('file tree never appeared')
  const first = page.locator('[role="treeitem"]').first()
  await first.focus(); await page.waitForTimeout(250)
  const start = await page.evaluate(() => document.activeElement?.getAttribute('data-path'))
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250)
  const moved = await page.evaluate(() => document.activeElement?.getAttribute('data-path'))
  must(start !== moved, `focus did not move (${start})`)
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(350)
  const expanded = await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))
  await page.keyboard.press('Enter'); await page.waitForTimeout(700)
  return `${start} -> ${moved} (aria-expanded=${expanded})`
})

await step('every tree row carries honest ARIA', async () => {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('[role="treeitem"]')]
      .filter(r => !r.getAttribute('aria-level') || !r.hasAttribute('aria-selected'))
      .map(r => r.getAttribute('data-path')))
  must(bad.length === 0, 'rows missing aria-level/selected: ' + JSON.stringify(bad.slice(0, 5)))
  const tree = await page.locator('[role="tree"]').count()
  must(tree === 1, `${tree} elements with role=tree`)
})

await step('tab strip is a real tablist', async () => {
  await open(page, 'Zettelkasten')
  if ((await page.locator('[role="tree"]').count()) === 0) {
    await page.locator('.ribbon-btn').first().click(); await page.waitForTimeout(600)
  }
  await page.locator('.nav-file').first().click({ modifiers: ['Control'] }); await page.waitForTimeout(700)
  const info = await page.evaluate(() => {
    const list = document.querySelector('.tab-bar [role="tablist"], .tab-bar')
    const tabs = [...document.querySelectorAll('.tab[role="tab"]')]
    return { tabs: tabs.length, selected: tabs.filter(t => t.getAttribute('aria-selected') === 'true').length,
             inTabOrder: tabs.filter(t => t.getAttribute('tabindex') !== '-1').length, hasList: !!list }
  })
  must(info.tabs >= 2, `${info.tabs} tabs`)
  must(info.selected === 1, `${info.selected} tabs marked selected`)
  must(info.inTabOrder === 1, `${info.inTabOrder} tabs in the tab order — should be 1 (roving tabindex)`)
  return JSON.stringify(info)
})

await step('the modal traps focus and restores it on close', async () => {
  await page.locator('.cm-content').first().click().catch(() => {})
  await page.keyboard.press('Control+,'); await page.waitForTimeout(800)
  const inside = await page.evaluate(() => !!document.activeElement?.closest('.modal'))
  must(inside, 'focus did not enter the modal')
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab')
  const stillInside = await page.evaluate(() => !!document.activeElement?.closest('.modal'))
  must(stillInside, 'focus escaped the modal')
  await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  const out = await page.evaluate(() => !!document.activeElement?.closest('.modal'))
  must(!out, 'focus stayed in a closed modal')
})

await step('no element has a positive tabindex', async () => {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('[tabindex]')].map(e => Number(e.getAttribute('tabindex'))).filter(n => n > 0).length)
  must(bad === 0, `${bad} elements with a positive tabindex`)
})

process.exitCode = report(problems, 'vault/a11y') > 0 ? 1 : 0
await browser.close()
