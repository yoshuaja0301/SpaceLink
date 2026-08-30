/**
 * Shared harness for the end-to-end suites.
 *
 * These drive the built app in a real browser. They exist because a whole class
 * of defect — a keymap the editor swallows, a panel that never gets a height, a
 * dialog the browser blocks — passes every unit test and still breaks the app.
 */
import { chromium } from 'playwright'

/** Where the app under test is served. `npm run e2e` sets this. */
export const BASE_URL = process.env.SPACEFORE_E2E_URL ?? 'http://localhost:4173/'

/**
 * Chromium comes from Playwright's own download unless an image has put one
 * somewhere else (CI containers usually do).
 */
export const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined
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
