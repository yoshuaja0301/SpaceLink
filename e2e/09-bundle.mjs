/**
 * What the browser actually downloads before it can show anything.
 *
 * The app used to ship as one 1.45 MB file, so a reader waited for CodeMirror
 * and for KaTeX's fonts before the first note appeared — even to read a note
 * with no mathematics in it, which is nearly all of them. The editor, the
 * graph and KaTeX are separate chunks now.
 *
 * This suite guards that split. It is easy to undo by accident: one ordinary
 * looking `import` at the top of a file that the first screen happens to reach
 * pulls a megabyte back into the entry chunk, and nothing else in the test
 * suite would notice. So the entry chunk is read off disk and checked for the
 * things that must not be in it, and the numbers are printed either way.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, must, report, step } from './lib.mjs'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets')

/** Every built JS chunk, with the sources that went into it. */
function chunks() {
  const out = []
  for (const name of readdirSync(DIST)) {
    if (!name.endsWith('.js')) continue
    const code = readFileSync(join(DIST, name))
    const mapPath = join(DIST, `${name}.map`)
    let sources = []
    try {
      sources = JSON.parse(readFileSync(mapPath, 'utf8')).sources ?? []
    } catch {
      /* a chunk without a map still counts for its size */
    }
    out.push({ name, bytes: code.length, gzip: gzipSync(code).length, sources })
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

/** The chunk the HTML loads directly — everything else is fetched on demand. */
function entryChunk(all) {
  const html = readFileSync(join(DIST, '..', 'index.html'), 'utf8')
  const named = all.find((chunk) => html.includes(chunk.name))
  if (!named) throw new Error('no chunk in dist/assets is referenced by index.html')
  return named
}

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`

console.log('== 9. what the first screen has to download ==')

const all = chunks()
const entry = entryChunk(all)
const inEntry = (pattern) => entry.sources.filter((source) => pattern.test(source))

/**
 * A ceiling, not a target. It exists so that a change that adds a third of a
 * megabyte to the first download has to say so out loud rather than slipping
 * through; raise it deliberately when there is a reason to.
 */
const ENTRY_GZIP_BUDGET = 260 * 1024

const { browser, page, problems } = await boot()

try {
  await step('the app is split into chunks, not shipped as one file', async () => {
    must(all.length >= 3, `only ${all.length} chunk(s) were built`)
    return all.map((chunk) => `${chunk.name.replace(/-[A-Za-z0-9_-]{8,}\./, '.')} ${kb(chunk.bytes)}`).join(', ')
  })

  await step('the first download stays under budget', async () => {
    must(
      entry.gzip <= ENTRY_GZIP_BUDGET,
      `the entry chunk is ${kb(entry.gzip)} gzipped, over the ${kb(ENTRY_GZIP_BUDGET)} budget`,
    )
    return `${kb(entry.bytes)} raw, ${kb(entry.gzip)} gzipped`
  })

  await step('the editor is not in it', async () => {
    const found = inEntry(/node_modules\/(@codemirror|@lezer)\//)
    must(found.length === 0, `${found.length} CodeMirror/Lezer modules are in the entry chunk, e.g. ${found[0]}`)
  })

  await step('KaTeX and its fonts are not in it', async () => {
    const found = inEntry(/node_modules\/katex\//)
    must(found.length === 0, `${found.length} KaTeX modules are in the entry chunk, e.g. ${found[0]}`)
    const css = readdirSync(DIST).filter((name) => name.startsWith('katex-') && name.endsWith('.css'))
    must(css.length === 1, `expected KaTeX's stylesheet in its own file, found ${css.length}`)
    return `${kb(statSync(join(DIST, css[0])).size)} of stylesheet, deferred with it`
  })

  await step('the graph is not in it', async () => {
    const found = inEntry(/\/src\/ui\/graph\//)
    must(found.length === 0, `the graph renderer is in the entry chunk: ${found[0]}`)
  })

  // The split is only worth having if the app still works, so the rest of this
  // suite is about the seams — the places where a chunk arrives late.
  await step('the app renders before the editor chunk is needed', async () => {
    must(await page.locator('.app').count() > 0, 'the app did not render')
    const status = await page.locator('.statusbar').innerText()
    must(/note/i.test(status), `the vault did not load: ${status}`)
    return status.split('\n').slice(0, 2).join(' / ')
  })

  await step('a note opens for editing, chunk and all', async () => {
    await page.keyboard.press('Control+p')
    await page.waitForTimeout(300)
    await page.keyboard.type('Start Here')
    await page.waitForTimeout(450)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    await page.locator('[aria-label="Edit view"]').first().click()
    await page.waitForSelector('.cm-content', { timeout: 15_000 })
    await page.locator('.cm-content').first().click()
    await page.keyboard.type('typed after the editor arrived')
    await page.waitForTimeout(600)
    const text = await page.locator('.cm-content').first().innerText()
    must(/typed after the editor arrived/.test(text), 'the editor never became usable')
  })

  await step('the graph opens, chunk and all', async () => {
    await page.keyboard.press('Control+g')
    await page.waitForSelector('.graph-view canvas, .graph-view', { timeout: 15_000 })
    await page.waitForTimeout(2500)
    must(await page.locator('.graph-view').count() > 0, 'the graph never rendered')
  })

  await step('mathematics renders once KaTeX has been fetched', async () => {
    await page.keyboard.press('Control+p')
    await page.waitForTimeout(300)
    await page.keyboard.type('Sandbox')
    await page.waitForTimeout(450)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    await page.locator('[aria-label="Preview view"]').first().click()
    await page.waitForTimeout(700)

    // Whichever note the demo vault puts math in, write our own so the check
    // does not depend on the fixture.
    await page.locator('[aria-label="Edit view"]').first().click()
    await page.waitForSelector('.cm-content', { timeout: 15_000 })
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\n\nEuler: $e^{i\\pi} + 1 = 0$\n')
    await page.locator('[aria-label="Preview view"]').first().click()

    const rendered = await page
      .waitForSelector('.markdown-preview .katex', { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    must(rendered, 'KaTeX never arrived, so the expression stayed as its source')
    // And the placeholder is gone once it has.
    must(!(await page.locator('.math-pending').count()), 'a pending expression was left behind')
  })
} finally {
  await browser.close()
}

process.exitCode = report(problems, 'bundle') > 0 ? 1 : 0
