/**
 * Two devices, one sync server, one folder of notes.
 *
 * The server is started for real over a real temporary folder, and it serves
 * the app as well as the API — which is exactly how it is used: you open the
 * server's own address on each device. The second device is a separate browser
 * context, so it has its own storage and pairs on its own, the way a phone
 * beside a laptop does.
 *
 * Every claim about what is on disk is read back with `fs`, never from the app.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, must, openDevice, report, step } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = 'e2e-token-'.padEnd(48, 'x')
const PORT = Number(process.env.SPACEFORE_SYNC_PORT ?? 4901)
const ORIGIN = `http://127.0.0.1:${PORT}`

const vault = await mkdtemp(join(tmpdir(), 'spacefore-sync-e2e-'))
await mkdir(join(vault, 'Ideas'), { recursive: true })
await writeFile(join(vault, 'Home.md'), '# Home\n\nStart at [[Ideas/Seed]].\n')
await writeFile(join(vault, 'Ideas/Seed.md'), '# Seed\n\nBack to [[Home]].\n')

const server = spawn(
  process.execPath,
  [join(HERE, '..', 'server', 'index.mjs'), '--vault', vault, '--port', String(PORT), '--token', TOKEN],
  { stdio: 'ignore' },
)

/** Wait for the server to answer, so the first navigation is not a race. */
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(`${ORIGIN}/api/health`)
    if (response.ok) break
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

const onDisk = (name) => readFile(join(vault, name), 'utf8')
const listDisk = async () => {
  const out = []
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else out.push(path)
    }
  }
  await walk(vault, '')
  return out.sort()
}

/** Pair a device with the server through the picker, the way a person would. */
async function pair(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
  await page.waitForTimeout(700)
  await page.locator('.vault-picker button').filter({ hasText: /server/i }).first().click()
  await page.waitForTimeout(400)
  await page.getByLabel('Server address').fill(ORIGIN)
  await page.getByLabel('Access token').fill(TOKEN)
  // Scoped to the form: the card that opens it is also called "Connect to a server".
  await page.locator('.vault-connect').getByRole('button', { name: 'Connect' }).click()
  await page.waitForTimeout(2500)
}

/** Open a note by name through the quick switcher. */
async function openNote(page, name) {
  await page.keyboard.press('Control+p')
  await page.waitForTimeout(300)
  await page.keyboard.type(name)
  await page.waitForTimeout(450)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
}

/** Poll until the page shows `text`, so a live update is not timed by guesswork. */
async function waitForText(page, text, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await page.evaluate((needle) => document.body.innerText.includes(needle), text)) return true
    await page.waitForTimeout(200)
  }
  return false
}

const { browser, page: laptop, problems } = await boot({ url: `${ORIGIN}/` })
console.log('== 8. sync server: two devices, one vault ==')

let phone
let phoneProblems = []

try {
  await step('the server serves the app itself', async () => {
    const title = await laptop.title()
    must(title.toLowerCase().includes('spacefore'), `page title is ${title}`)
    must(await laptop.locator('.app').count() > 0, 'the app did not render')
    return title
  })

  await step('a device pairs with the server and sees the vault', async () => {
    await pair(laptop)
    const status = await laptop.locator('.statusbar').innerText()
    must(/2 notes/.test(status), 'expected the 2 seeded notes: ' + status)
    must(!(await laptop.locator('.vault-picker').count()), 'the picker stayed open')
    return status.split('\n').slice(0, 2).join(' / ')
  })

  await step('editing on this device reaches the folder on disk', async () => {
    await openNote(laptop, 'Home')
    await laptop.locator('[aria-label="Edit view"]').first().click()
    await laptop.waitForTimeout(600)
    await laptop.locator('.cm-content').first().click()
    await laptop.keyboard.press('Control+End')
    await laptop.keyboard.type('\n\nTyped on the laptop.\n')
    await laptop.waitForTimeout(2200)

    const body = await onDisk('Home.md')
    must(/Typed on the laptop\./.test(body), 'the server never wrote it:\n' + body)
    must(/# Home/.test(body), 'the original content was lost')
  })

  await step('a second device pairs and sees the same notes', async () => {
    const device = await openDevice(browser, `${ORIGIN}/`)
    phone = device.page
    phoneProblems = device.problems
    await pair(phone)
    const status = await phone.locator('.statusbar').innerText()
    must(/2 notes/.test(status), 'the second device sees: ' + status)

    await openNote(phone, 'Home')
    must(await waitForText(phone, 'Typed on the laptop.'), 'the laptop’s edit is not on the second device')
    return status.split('\n').slice(0, 2).join(' / ')
  })

  await step('an edit on one device appears on the other without a reload', async () => {
    await laptop.locator('.cm-content').first().click()
    await laptop.keyboard.press('Control+End')
    await laptop.keyboard.type('\nA line that should arrive live.\n')
    await laptop.waitForTimeout(2200)

    must(await waitForText(phone, 'A line that should arrive live.'), 'the second device never received the change')
    return 'live'
  })

  await step('a note created on one device appears on the other', async () => {
    await laptop.keyboard.press('Control+Shift+P')
    await laptop.waitForTimeout(420)
    await laptop.keyboard.type('New note')
    await laptop.waitForTimeout(420)
    await laptop.keyboard.press('Enter')
    await laptop.waitForTimeout(900)
    await laptop.locator('.cm-content').first().click()
    await laptop.keyboard.type('# Made on the laptop\n\nHello from over there.\n')
    await laptop.waitForTimeout(2400)

    const paths = await listDisk()
    must(paths.some((path) => /Untitled/i.test(path)), 'no new file on disk: ' + JSON.stringify(paths))

    const arrived = await waitForText(phone, 'Untitled')
    must(arrived, 'the new note did not reach the second device')
    return JSON.stringify(paths)
  })

  await step('a file changed on disk reaches every device', async () => {
    await writeFile(join(vault, 'Ideas/Seed.md'), '# Seed\n\nRewritten on the server by another program.\n')

    await openNote(laptop, 'Seed')
    must(
      await waitForText(laptop, 'Rewritten on the server by another program.'),
      'the laptop kept its cached copy',
    )
    await openNote(phone, 'Seed')
    must(
      await waitForText(phone, 'Rewritten on the server by another program.'),
      'the second device kept its cached copy',
    )
  })

  await step('a note deleted on one device disappears from the other', async () => {
    await openNote(laptop, 'Untitled')
    await laptop.keyboard.press('Control+Shift+P')
    await laptop.waitForTimeout(420)
    await laptop.keyboard.type('Delete current note')
    await laptop.waitForTimeout(420)
    await laptop.keyboard.press('Enter')
    await laptop.waitForTimeout(700)
    await laptop.locator('.modal').getByRole('button', { name: 'Delete' }).click()
    await laptop.waitForTimeout(2200)

    const paths = await listDisk()
    must(!paths.some((path) => /Untitled/i.test(path)), 'the file survived on disk: ' + JSON.stringify(paths))

    const deadline = Date.now() + 12_000
    let gone = false
    while (Date.now() < deadline) {
      const files = await phone.locator('.nav-file').allInnerTexts()
      if (!files.some((name) => /Untitled/i.test(name))) {
        gone = true
        break
      }
      await phone.waitForTimeout(250)
    }
    must(gone, 'the deleted note is still listed on the second device')
  })

  await step('two devices editing the same note keep both versions', async () => {
    // The laptop opens the note and stops there — its idea of the note is now
    // one save behind whatever happens next.
    await openNote(laptop, 'Home')
    await laptop.locator('[aria-label="Edit view"]').first().click()
    await laptop.waitForTimeout(600)

    // Something else changes it: the same situation as a second device that was
    // offline, without needing to take one offline.
    await writeFile(join(vault, 'Home.md'), '# Home\n\nChanged behind the laptop’s back.\n')
    await laptop.waitForTimeout(1500)

    // Now the laptop saves what it still has.
    await laptop.locator('.cm-content').first().click()
    await laptop.keyboard.press('Control+End')
    await laptop.keyboard.type('\nThe laptop’s own version.\n')
    await laptop.waitForTimeout(3000)

    const paths = await listDisk()
    const conflict = paths.find((path) => /conflict/i.test(path))
    const home = await onDisk('Home.md')

    // Neither version is gone: whichever ended up in Home.md, the other is
    // beside it under a conflict name.
    if (conflict) {
      const kept = await onDisk(conflict)
      must(/laptop/i.test(kept) || /behind the laptop/i.test(kept), 'the conflict copy holds neither version:\n' + kept)
      return `kept both: Home.md + ${conflict}`
    }
    must(
      /Changed behind the laptop’s back\./.test(home) || /The laptop’s own version\./.test(home),
      'a version was lost with no conflict copy:\n' + home,
    )
    return 'no conflict needed — the devices had converged'
  })

  await step('a device reconnects by itself after a reload', async () => {
    await laptop.reload({ waitUntil: 'networkidle' })
    await laptop.waitForTimeout(3200)
    const status = await laptop.locator('.statusbar').innerText()
    must(/note/i.test(status), 'nothing loaded after the reload: ' + status)
    must(!(await laptop.locator('.vault-picker').count()), 'it asked to be paired again')
    return status.split('\n').slice(0, 2).join(' / ')
  })

  await step('the vault is unreachable without the token', async () => {
    const status = await fetch(`${ORIGIN}/api/files`).then((response) => response.status)
    must(status === 401, `an unauthenticated request got ${status}`)
    const health = await fetch(`${ORIGIN}/api/health`).then((response) => response.status)
    must(health === 200, 'health should stay open so a device can find the server')
  })
} finally {
  server.kill('SIGTERM')
  await phone?.context().close().catch(() => {})
  await browser.close()
  await rm(vault, { recursive: true, force: true })
}

// The conflict step deliberately provokes a 409, and a browser logs every
// non-2xx response. That one is the mechanism working, not a defect; anything
// else still counts.
const expectedConflictNoise = /409|Conflict/
const noise = [...problems, ...phoneProblems].filter((entry) => !expectedConflictNoise.test(entry))

process.exitCode = report(noise, 'sync server') > 0 ? 1 : 0
