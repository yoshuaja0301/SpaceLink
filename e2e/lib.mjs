/**
 * Shared harness for the end-to-end suites.
 *
 * These drive the built app in a real browser. They exist because a whole class
 * of defect — a keymap the editor swallows, a panel that never gets a height, a
 * dialog the browser blocks — passes every unit test and still breaks the app.
 */
import { accessSync, constants } from 'node:fs'
import path from 'node:path'

import { chromium, firefox, webkit } from 'playwright'

/** Where the app under test is served. `npm run e2e` sets this. */
export const BASE_URL = process.env.SPACEFORE_E2E_URL ?? 'http://localhost:4173/'

/**
 * Chromium comes from Playwright's own download unless the machine has put one
 * somewhere else. Container images commonly do, and then pin an older revision
 * than the `playwright` package resolves to — at which point Playwright looks
 * for a directory that was never downloaded and the suite dies at launch with
 * "Executable doesn't exist", which reads like a broken app and is not one.
 *
 * So: an explicit path wins, then a browser the image left at the root of
 * `PLAYWRIGHT_BROWSERS_PATH`, then Playwright's own. The middle case only ever
 * matches where an image deliberately put one there — Playwright's own layout
 * is `chromium-<revision>/`, never a bare `chromium` — so an ordinary checkout
 * is unaffected.
 */
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root) return undefined
  for (const name of ['chromium', 'chrome']) {
    const candidate = path.join(root, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not there, or not runnable — try the next.
    }
  }
  return undefined
}

export const CHROME = findChromium()

/** The engines a suite can ask for by name. */
export const ENGINES = { chromium, firefox, webkit }

/**
 * Whether an engine is actually installed.
 *
 * Only Chromium is assumed. A checkout that has not run
 * `npx playwright install firefox webkit` should skip those suites rather than
 * fail them — the app is not broken because a browser is absent.
 */
export async function hasEngine(name) {
  const engine = ENGINES[name]
  if (!engine) return false
  try {
    const browser = await engine.launch({
      ...(name === 'chromium' && CHROME ? { executablePath: CHROME } : {}),
      args: name === 'chromium' ? ARGS : [],
    })
    await browser.close()
    return true
  } catch {
    return false
  }
}

/** Launch a named engine, with the Chromium-only flags applied only to it. */
export function launchEngine(name) {
  const engine = ENGINES[name]
  if (!engine) throw new Error(`no such engine: ${name}`)
  return engine.launch({
    ...(name === 'chromium' && CHROME ? { executablePath: CHROME } : {}),
    args: name === 'chromium' ? ARGS : [],
  })
}

/** A page in a named engine, with the same console/error watching as `boot`. */
export async function bootIn(name, { theme = 'dark', url = BASE_URL, context = {} } = {}) {
  const browser = await launchEngine(name)
  const page = await (await browser.newContext({ colorScheme: theme, ...context })).newPage()
  const problems = []
  page.on('pageerror', (error) => problems.push('PAGEERROR: ' + error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push('CONSOLE: ' + message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`)
  })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForSelector('.statusbar', { timeout: 40_000 })
  return { browser, page, problems }
}
export const ARGS = [
  '--no-sandbox',
  '--disable-background-networking',
  '--disable-component-update',
  '--no-first-run',
]

export async function boot({ theme = 'dark', width = 1600, height = 1000, url = BASE_URL } = {}) {
  const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ARGS })
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme })
  const problems = []
  page.on('pageerror', e => problems.push('PAGEERROR: ' + e.message))
  page.on('console', m => { if (m.type() === 'error') problems.push('CONSOLE: ' + m.text()) })
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)
  return { browser, page, problems }
}

/**
 * A second, independent device against the same server: its own browser context
 * means its own storage, so it pairs and syncs separately, exactly as a phone
 * beside a laptop would.
 */
export async function openDevice(browser, url, { theme = 'dark', width = 1200, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (error) => problems.push('PAGEERROR: ' + error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push('CONSOLE: ' + message.text())
  })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)
  return { context, page, problems }
}

let failures = 0
export async function step(name, fn) {
  try { const r = await fn(); console.log(`  ok    ${name}${r ? '  — ' + r : ''}`) }
  catch (e) { failures++; console.log(`  FAIL  ${name}\n          ${String(e).split('\n')[0].slice(0, 220)}`) }
}
export function report(problems, label) {
  const uniq = [...new Set(problems)]
  console.log(`\n[${label}] step failures: ${failures}, console/page errors: ${uniq.length}`)
  uniq.slice(0, 15).forEach(p => console.log('   ! ' + p.slice(0, 220)))
  return failures + uniq.length
}

/** Open a note through the quick switcher. */
export async function open(page, name) {
  await page.keyboard.press('Control+p'); await page.waitForTimeout(280)
  await page.keyboard.type(name); await page.waitForTimeout(420)
  await page.keyboard.press('Enter'); await page.waitForTimeout(750)
}
export async function mode(page, which) {
  await page.locator(`[aria-label="${which} view"]`).first().click()
  await page.waitForTimeout(700)
}
export const must = (cond, msg) => { if (!cond) throw new Error(msg) }
