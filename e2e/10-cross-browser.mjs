/**
 * The same app, in the other two engines.
 *
 * Every suite before this one runs in Chromium, and for a long time that was
 * the only engine anything had been tried in — while the README claimed
 * Firefox and Safari worked. This runs the core journey in Gecko and WebKit so
 * that claim is backed by something.
 *
 * WebKit here is Playwright's build of the engine behind Safari. It is not
 * Safari on a Mac, and it will not catch everything Safari does; it does catch
 * the class of thing that actually goes wrong across engines — a CSS feature
 * that is not there, an API that is missing, a canvas that never paints.
 *
 * Skipped, not failed, where an engine is not installed:
 *   npx playwright install firefox webkit
 */
import { hasEngine, bootIn, must, report, step } from './lib.mjs'

const ENGINES = ['firefox', 'webkit']

let problems = []

for (const engine of ENGINES) {
  if (!(await hasEngine(engine))) {
    console.log(`== 10. ${engine}: not installed, skipping ==`)
    console.log(`   (npx playwright install ${engine})`)
    continue
  }

  console.log(`== 10. the app in ${engine} ==`)
  const { browser, page, problems: found } = await bootIn(engine, { context: { viewport: { width: 1400, height: 900 } } })

  try {
    await step(`${engine}: the vault loads`, async () => {
      const status = await page.locator('.statusbar').innerText()
      must(/note/i.test(status), `nothing loaded: ${status}`)
      return status.split('\n').slice(0, 2).join(' / ')
    })

    await step(`${engine}: the quick switcher opens a note`, async () => {
      await page.keyboard.press('Control+p')
      await page.waitForSelector('.palette-input', { timeout: 15_000 })
      await page.keyboard.type('Markdown')
      await page.waitForTimeout(600)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1200)
      const tab = await page.locator('.tab-title').first().innerText()
      must(/Markdown/i.test(tab), `opened ${tab}`)
      return tab
    })

    await step(`${engine}: typing reaches the document`, async () => {
      await page.locator('[aria-label="Edit view"]').first().click()
      await page.waitForSelector('.cm-content', { timeout: 20_000 })
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(`\n\nTyped in ${engine}.\n`)
      await page.waitForTimeout(900)
      const text = await page.locator('.cm-content').first().innerText()
      must(text.includes(`Typed in ${engine}.`), 'CodeMirror did not take the keystrokes')
    })

    await step(`${engine}: the preview renders it`, async () => {
      await page.locator('[aria-label="Preview view"]').first().click()
      await page.waitForTimeout(1400)
      const rendered = await page.locator('.markdown-preview').first().innerText()
      must(rendered.includes(`Typed in ${engine}.`), 'the preview did not show the edit')
      const links = await page.locator('.markdown-preview .internal-link').count()
      must(links > 0, 'no wiki links rendered')
      return `${links} links`
    })

    await step(`${engine}: mathematics arrives and renders`, async () => {
      await page.locator('[aria-label="Edit view"]').first().click()
      await page.waitForSelector('.cm-content', { timeout: 20_000 })
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nEuler: $e^{i\\pi} + 1 = 0$\n')
      await page.locator('[aria-label="Preview view"]').first().click()
      const rendered = await page
        .waitForSelector('.markdown-preview .katex', { timeout: 30_000 })
        .then(() => true)
        .catch(() => false)
      must(rendered, 'the KaTeX chunk never arrived, or never rendered')
      must(!(await page.locator('.math-pending').count()), 'a pending expression was left behind')
    })

    await step(`${engine}: search finds things`, async () => {
      await page.keyboard.press('Control+Shift+F')
      await page.waitForTimeout(700)
      await page.keyboard.type('zettelkasten')
      await page.waitForTimeout(1800)
      const hits = await page.locator('.search-result, .search-hit').count()
      must(hits > 0, 'the search found nothing')
      return `${hits} results`
    })

    await step(`${engine}: the graph paints, and frames itself`, async () => {
      await page.keyboard.press('Control+g')
      // WebKit settles the force layout appreciably slower than the others, so
      // this waits for the result rather than for a fixed time: the auto-fit
      // re-frames once the nodes stop moving, and until then the view is
      // provisional and zoomed in.
      const framed = await page
        .waitForFunction(
          () => {
            const canvas = document.querySelector('.graph-view canvas')
            if (!canvas) return false
            const { width, height } = canvas
            const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
            let lit = 0
            let total = 0
            for (let i = 0; i < data.length; i += 4 * 37) {
              total += 1
              if (data[i] + data[i + 1] + data[i + 2] > 250) lit += 1
            }
            // Painted, but not filling the canvas: that is a framed graph
            // rather than one still stuck at its opening zoom.
            return lit > 0 && lit / total < 0.12
          },
          null,
          { timeout: 30_000 },
        )
        .then(() => true)
        .catch(() => false)
      must(framed, 'the graph never painted, or never framed itself')
    })

    await step(`${engine}: the folder option is honest about this browser`, async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
      await page.waitForTimeout(900)
      const verdict = await page.evaluate(() => {
        const card = [...document.querySelectorAll('.vault-picker button')].find((button) =>
          /folder/i.test(button.textContent ?? ''),
        )
        return {
          found: Boolean(card),
          disabled: card ? card.disabled || card.getAttribute('aria-disabled') === 'true' : false,
          api: typeof window.showDirectoryPicker === 'function',
        }
      })
      must(verdict.found, 'the folder option is not in the picker at all')
      // Neither offered where it cannot work, nor withheld where it can.
      must(
        verdict.disabled === !verdict.api,
        `showDirectoryPicker=${verdict.api} but the card is ${verdict.disabled ? 'disabled' : 'enabled'}`,
      )
      return verdict.api ? 'offered' : 'disabled, with a reason'
    })
  } finally {
    problems = [...problems, ...found.map((entry) => `[${engine}] ${entry}`)]
    await browser.close()
  }
}

process.exitCode = report(problems, 'cross-browser') > 0 ? 1 : 0
