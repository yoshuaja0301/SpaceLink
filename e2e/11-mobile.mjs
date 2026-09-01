/**
 * The app on a phone.
 *
 * `docs/SERVER.md` tells people to install this on an iPhone, and the
 * stylesheet has had a narrow-width media query all along — but nothing had
 * ever been run at that width, and it did not work. Both sidebars opened over
 * the note, one on top of the other, so the first thing a reader saw was a
 * panel they could not dismiss covering a note they could not reach.
 *
 * These run at real device metrics, with touch, in both engines a phone might
 * actually be: WebKit for an iPhone, Chromium for an Android.
 *
 * Skipped, not failed, where an engine is not installed.
 */
import { devices } from 'playwright'

import { hasEngine, bootIn, must, report, step } from './lib.mjs'

const PHONES = [
  ['iPhone 14', 'webkit'],
  ['Pixel 7', 'chromium'],
]

let problems = []

for (const [phone, engine] of PHONES) {
  if (!(await hasEngine(engine))) {
    console.log(`== 11. ${phone}: ${engine} is not installed, skipping ==`)
    continue
  }

  const device = devices[phone]
  console.log(`== 11. ${phone} — ${device.viewport.width}×${device.viewport.height}, touch ==`)
  const { browser, page, problems: found } = await bootIn(engine, { context: device })

  /** The drawer's dismiss target, tapped near its edge — the drawer itself
   *  covers the middle of a screen this narrow. */
  const tapOutside = async () => {
    const box = await page.locator('.sidebar-scrim').boundingBox()
    if (!box) return
    await page.touchscreen.tap(box.x + box.width - 12, box.y + box.height / 2)
    await page.waitForTimeout(700)
  }

  try {
    await step(`${phone}: opens onto the note, not onto a panel`, async () => {
      must(!(await page.locator('.sidebar').count()), 'the file drawer was covering the note')
      must(!(await page.locator('.right-sidebar').count()), 'the backlinks drawer was covering the note')
      const workspace = await page.locator('.workspace-area').boundingBox()
      must(workspace !== null && workspace.width > device.viewport.width * 0.7, 'the note had no room')
      return `${Math.round(workspace.width)}px of ${device.viewport.width}`
    })

    await step(`${phone}: nothing scrolls sideways`, async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      must(overflow <= 0, `the page is ${overflow}px wider than the screen`)
    })

    await step(`${phone}: the ribbon opens the file drawer`, async () => {
      await page.locator('.ribbon button').first().tap()
      await page.waitForTimeout(800)
      must(await page.locator('.sidebar').count(), 'the drawer did not open')
      must(await page.locator('.sidebar-scrim').count(), 'nothing to tap to dismiss it')
    })

    await step(`${phone}: tapping a note opens it and gets out of the way`, async () => {
      const before = await page.locator('.tab-title').first().innerText().catch(() => '')
      await page.locator('.nav-file').first().tap()
      await page.waitForTimeout(1400)
      const after = await page.locator('.tab-title').first().innerText().catch(() => '')
      must(after !== '' && after !== before, `the tab still says ${after || '(nothing)'}`)
      // The whole point of a drawer: choosing something closes it.
      must(!(await page.locator('.sidebar').count()), 'the drawer stayed over the note that was just chosen')
      return `${before} → ${after}`
    })

    await step(`${phone}: a drawer you opened by mistake can be dismissed`, async () => {
      await page.locator('.ribbon button').first().tap()
      await page.waitForTimeout(700)
      await tapOutside()
      must(!(await page.locator('.sidebar').count()), 'tapping outside did not close it')
    })

    await step(`${phone}: never two drawers over the note at once`, async () => {
      await page.locator('.ribbon button').first().tap()
      await page.waitForTimeout(600)
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-right-sidebar')))
      await page.keyboard.press('Control+i')
      await page.waitForTimeout(700)
      const open = (await page.locator('.sidebar').count()) + (await page.locator('.right-sidebar').count())
      must(open <= 1, `${open} drawers open`)
      await tapOutside()
    })

    await step(`${phone}: the note is readable`, async () => {
      const text = await page.locator('.markdown-preview, .cm-content').first().innerText()
      must(text.trim().length > 40, `only ${text.trim().length} characters on screen`)
      return `${text.trim().length} characters`
    })

    await step(`${phone}: the status bar keeps what matters`, async () => {
      const bar = await page.evaluate(() => {
        const footer = document.querySelector('.statusbar')
        const items = [...footer.querySelectorAll('.statusbar-item')].filter(
          (element) => element.getBoundingClientRect().width > 0,
        )
        return {
          text: items.map((element) => element.textContent.trim()),
          overflow: Math.round(footer.scrollWidth - footer.clientWidth),
        }
      })
      // Whether the note is saved is the one thing that must not be the item
      // pushed off the end of a bar too narrow to hold everything.
      must(bar.overflow <= 0, `the bar overflows by ${bar.overflow}px`)
      must(
        bar.text.some((item) => /saved|saving|unsaved/i.test(item)),
        `no save state on the bar: ${JSON.stringify(bar.text)}`,
      )
      return bar.text.join(' · ')
    })
  } finally {
    problems = [...problems, ...found.map((entry) => `[${phone}] ${entry}`)]
    await browser.close()
  }
}

process.exitCode = report(problems, 'mobile') > 0 ? 1 : 0
