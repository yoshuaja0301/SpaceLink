/**
 * The app with the network switched off.
 *
 * The README promises that once installed it "keeps working with the network
 * down". That is a service worker's job and nothing had ever checked it, so
 * this drives the actual promise: open the app, pull the network, open it
 * again, and use it.
 *
 * A service worker only exists on a secure context, which `http://localhost`
 * is, so this runs against the ordinary preview server.
 */
import { bootIn, hasEngine, must, report, step } from './lib.mjs'

const BASE = process.env.SPACEFORE_E2E_URL ?? 'http://localhost:4173/'

if (!(await hasEngine('chromium'))) {
  console.log('== 12. chromium is not installed, skipping ==')
  process.exitCode = 0
} else {
  console.log('== 12. the app with the network down ==')
  const { browser, page, problems } = await bootIn('chromium', {
    context: { viewport: { width: 1280, height: 900 } },
  })
  const context = page.context()

  /** Set once the page has genuinely been served from cache with no network. */
  let offlineDocument = false

  /** Wait until a worker is not just registered but actually in charge. */
  const controlled = () =>
    page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'no serviceWorker in this browser'
      const registration = await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) {
        // `clients.claim()` can land a tick after `ready` resolves.
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
          setTimeout(resolve, 3000)
        })
      }
      return navigator.serviceWorker.controller ? null : `registered (${registration.scope}) but not controlling`
    })

  try {
    await step('the manifest is real, and its icons exist', async () => {
      const manifest = await page.evaluate(async () => {
        const link = document.querySelector('link[rel="manifest"]')
        if (!link) return { error: 'no <link rel="manifest">' }
        const response = await fetch(link.href)
        if (!response.ok) return { error: `manifest is HTTP ${response.status}` }
        const parsed = await response.json()
        const icons = await Promise.all(
          (parsed.icons ?? []).map(async (icon) => {
            const at = new URL(icon.src, link.href).href
            return { src: icon.src, status: (await fetch(at)).status, sizes: icon.sizes }
          }),
        )
        return { parsed, icons }
      })
      must(!manifest.error, manifest.error)
      // Without these a browser will not offer to install it at all.
      for (const field of ['name', 'start_url', 'display', 'icons']) {
        must(manifest.parsed[field] !== undefined, `the manifest has no ${field}`)
      }
      const broken = manifest.icons.filter((icon) => icon.status !== 200)
      must(broken.length === 0, `icons that do not load: ${JSON.stringify(broken)}`)
      must(
        manifest.icons.some((icon) => /512/.test(icon.sizes ?? '')),
        `no 512px icon, which installing wants: ${JSON.stringify(manifest.icons.map((i) => i.sizes))}`,
      )
      return `${manifest.parsed.name}, ${manifest.icons.length} icons`
    })

    await step('a service worker takes charge of the page', async () => {
      const complaint = await controlled()
      must(complaint === null, complaint ?? '')
    })

    await step('the app opens again with the network down', async () => {
      // Stamped on the document that is about to be thrown away. If the reload
      // fails, Playwright leaves the old page in place and every check after
      // this one would quietly pass against it — which is exactly what happened
      // the first time this suite was broken on purpose.
      await page.evaluate(() => {
        window.__beforeTheNetworkWentDown = true
      })
      await context.setOffline(true)
      const response = await page.reload({ waitUntil: 'load' }).catch((error) => error)
      must(!(response instanceof Error), `the page would not load offline: ${response?.message}`)
      await page.waitForSelector('.statusbar', { timeout: 20_000 })
      must(await page.locator('.app').count(), 'the app shell did not render')
      const stale = await page.evaluate(() => Boolean(window.__beforeTheNetworkWentDown))
      must(!stale, 'this is the page from before, not one loaded from the cache')
      offlineDocument = true
    })

    await step('the vault is still there, and a note still opens', async () => {
      must(offlineDocument, 'the app never reloaded offline, so this proves nothing')
      const status = await page.locator('.statusbar').innerText()
      must(/note/i.test(status), `nothing loaded offline: ${status}`)
      await page.keyboard.press('Control+p')
      await page.waitForSelector('.palette-input', { timeout: 15_000 })
      await page.keyboard.type('Markdown')
      await page.waitForTimeout(600)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1200)
      const tab = await page.locator('.tab-title').first().innerText()
      must(/Markdown/i.test(tab), `opened ${tab}`)
      return `${status.split('\n')[1] ?? status} · ${tab}`
    })

    await step('editing still works with no network', async () => {
      must(offlineDocument, 'the app never reloaded offline, so this proves nothing')
      await page.locator('[aria-label="Edit view"]').first().click()
      await page.waitForSelector('.cm-content', { timeout: 20_000 })
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n\nWritten on a train with no signal.\n')
      await page.waitForTimeout(900)
      const text = await page.locator('.cm-content').first().innerText()
      must(text.includes('Written on a train with no signal.'), 'the keystrokes did not reach the document')
    })

    await step('nothing from the vault API was ever cached', async () => {
      const cached = await page.evaluate(async () => {
        const names = await caches.keys()
        const urls = []
        for (const name of names) {
          for (const request of await (await caches.open(name)).keys()) urls.push(request.url)
        }
        return urls
      })
      // Rule 1 of the worker: a device must never show a note the vault no
      // longer has, and a cached response could carry an access token.
      const leaked = cached.filter((url) => new URL(url).pathname.startsWith('/api/'))
      must(leaked.length === 0, `the cache holds vault responses: ${JSON.stringify(leaked)}`)
      return `${cached.length} entries, none of them /api/`
    })
  } finally {
    await context.setOffline(false).catch(() => {})
    await browser.close()
  }

  process.exitCode = report(problems, 'offline') > 0 ? 1 : 0
}
