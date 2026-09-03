/**
 * Two devices, one sync server, one folder of notes.
 *
 * The server is started for real over a real temporary folder, and it serves
 * the app as well as the API — which is exactly how it is used: you open the
 * server's own address on each device. The second device is a separate browser
 * context, so it has its own storage and pairs on its own, the way a phone
 * beside a laptop does.
 *
 * Both ways in are exercised: the access token, and an account made the only
 * way an account can be made — with a command on the machine holding the notes,
 * run here as a real child process before the server starts.
 *
 * Every claim about what is on disk is read back with `fs`, never from the app.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, must, openDevice, report, step } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKEN = 'e2e-token-'.padEnd(48, 'x')

const vault = await mkdtemp(join(tmpdir(), 'spacefore-sync-e2e-'))
await mkdir(join(vault, 'Ideas'), { recursive: true })
await writeFile(join(vault, 'Home.md'), '# Home\n\nStart at [[Ideas/Seed]].\n')
await writeFile(join(vault, 'Ideas/Seed.md'), '# Seed\n\nBack to [[Home]].\n')

/*
 * The server picks its own port and says which one, rather than this suite
 * naming one.
 *
 * A fixed port is a trap. When an earlier run died before its cleanup — a
 * browser that would not launch is enough — its server stays up holding that
 * port. The next run's server then cannot bind, exits, and the app happily
 * pairs with the *stranger*, which is serving somebody else's folder. Every
 * assertion that reads the folder on disk then fails, and it reads exactly
 * like the app has stopped writing notes. It cost an hour to learn that once.
 *
 * `--port 0` means no two runs can collide, and the ready line names the vault
 * the server is actually serving, so pairing with a stranger is caught here
 * instead of being reported as a broken app. `--print-ready` also arms the
 * server's stdin leash: hold the pipe open and it dies with this process, even
 * if this process is killed outright.
 */
const ACCOUNT = { email: 'e2e@example.com', password: 'a long enough password' }
const accountsFile = join(vault, '..', `spacefore-e2e-accounts-${process.pid}.json`)

/**
 * Make the account, as a person would: one command, on the machine that holds
 * the notes. There is no other way — the HTTP API cannot create one at all —
 * so this is also the check that the command works from a cold start.
 */
await new Promise((resolveAccount, rejectAccount) => {
  const made = spawn(
    process.execPath,
    [
      join(HERE, '..', 'server', 'index.mjs'),
      '--vault', vault,
      '--accounts', accountsFile,
      '--add-account', ACCOUNT.email,
      '--password', ACCOUNT.password,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let complaint = ''
  made.stderr.setEncoding('utf8')
  made.stderr.on('data', (chunk) => (complaint += chunk))
  made.once('error', rejectAccount)
  made.once('exit', (code) =>
    code === 0 ? resolveAccount() : rejectAccount(new Error(`--add-account exited with ${code}: ${complaint.trim()}`)),
  )
})

const server = spawn(
  process.execPath,
  [
    join(HERE, '..', 'server', 'index.mjs'),
    '--vault', vault,
    '--port', String(process.env.SPACEFORE_SYNC_PORT ?? 0),
    '--token', TOKEN,
    '--accounts', accountsFile,
    '--print-ready',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
)

/** The server's first line of stdout: where it ended up, and over what. */
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the server never reported itself ready')), 30_000)
  let buffered = ''
  server.stdout.setEncoding('utf8')
  server.stdout.on('data', (chunk) => {
    buffered += chunk
    const newline = buffered.indexOf('\n')
    if (newline < 0) return
    clearTimeout(timer)
    try {
      resolve(JSON.parse(buffered.slice(0, newline)))
    } catch (error) {
      reject(new Error(`the ready line was not JSON: ${buffered.slice(0, newline)} (${error.message})`))
    }
  })
  // Kept so a server that dies on startup can say why. `EADDRINUSE` here means
  // something is already on the port, which is the whole reason for `--port 0`.
  let complaint = ''
  server.stderr.setEncoding('utf8')
  server.stderr.on('data', (chunk) => {
    complaint += chunk
    process.stderr.write(chunk)
  })

  server.once('error', reject)
  server.once('exit', (code) => {
    clearTimeout(timer)
    const why = /EADDRINUSE/.test(complaint)
      ? `something else is already listening on port ${process.env.SPACEFORE_SYNC_PORT}. ` +
        'Leave SPACEFORE_SYNC_PORT unset and the server will pick a free one.'
      : complaint.trim().split('\n').slice(-3).join(' ') || 'it said nothing'
    reject(new Error(`the server exited with ${code} before reporting ready: ${why}`))
  })
})

// Whatever we are about to talk to must be serving the folder we just made.
if (resolve(ready.vault) !== resolve(vault)) {
  throw new Error(`reached a server serving ${ready.vault}, not ${vault}`)
}

const ORIGIN = `http://127.0.0.1:${ready.port}`

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

/** Open the connect form on the picker. */
async function openConnectForm(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
  await page.waitForTimeout(700)
  // By its own identifier, not by its wording: the card describes itself
  // differently once this device has signed in, and a test that reads the
  // description would break on a copy edit rather than on a defect.
  await page.locator('.vault-picker-option[data-choice="remote"]').click()
  await page.waitForTimeout(400)
  await page.getByLabel('Server address').fill(ORIGIN)
}

/** Pair a device with the server's access token, the way a person would. */
async function pair(page) {
  await openConnectForm(page)
  await page.getByRole('radio', { name: 'Access token' }).click()
  await page.waitForTimeout(200)
  await page.getByLabel('Access token').fill(TOKEN)
  // Scoped to the form: the card that opens it is also called "Connect to a server".
  await page.locator('.vault-connect').getByRole('button', { name: 'Connect' }).click()
  await page.waitForTimeout(2500)
}

/** Sign a device in with the account instead — email and password, no token. */
async function signInDevice(page, password = ACCOUNT.password) {
  await openConnectForm(page)
  await page.getByRole('radio', { name: 'Sign in' }).click()
  await page.waitForTimeout(200)
  await page.getByLabel('Email').fill(ACCOUNT.email)
  await page.getByLabel('Password').fill(password)
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

  await step('a local host can hand the pairing over in the address', async () => {
    // What the macOS app does: it starts the server, then opens the page with
    // the token in the fragment. Nobody types anything.
    const fresh = await openDevice(browser, `${ORIGIN}/#token=${encodeURIComponent(TOKEN)}`)
    try {
      await fresh.page.waitForFunction(
        () => {
          const bar = document.querySelector('.statusbar')?.innerText ?? ''
          return /note/i.test(bar) && !/demo/i.test(bar) && !document.querySelector('.vault-picker')
        },
        null,
        { timeout: 30_000 },
      )
      const status = await fresh.page.locator('.statusbar').innerText()
      must(!(await fresh.page.locator('.vault-picker').count()), 'it still asked to be paired')

      // The token must not be left in the address for a bookmark to keep.
      const url = fresh.page.url()
      must(!url.includes(TOKEN), `the token is still in the address: ${url}`)
      must(!url.includes('#token'), `the fragment survived: ${url}`)

      // And it is a real pairing, not a one-off: a reload comes straight back.
      await fresh.page.reload({ waitUntil: 'networkidle' })
      await fresh.page.waitForTimeout(2500)
      must(!(await fresh.page.locator('.vault-picker').count()), 'the pairing was not kept')
      return status.split('\n').slice(0, 2).join(' / ')
    } finally {
      await fresh.context.close().catch(() => {})
    }
  })

  await step('a third device signs in with the account and sees the same vault', async () => {
    // No token anywhere: an email and a password, typed on a device that has
    // never met this server. This is the whole reason accounts exist.
    const desktop = await openDevice(browser, `${ORIGIN}/`)
    try {
      await signInDevice(desktop.page)
      must(!(await desktop.page.locator('.vault-picker').count()), 'the sign-in did not open the vault')
      const status = await desktop.page.locator('.statusbar').innerText()
      must(/note/i.test(status), 'signed in but no notes: ' + status)

      // The same folder the token-paired devices are on: a note written here
      // lands in the very file on disk the laptop has been editing.
      await openNote(desktop.page, 'Seed')
      must(
        await waitForText(desktop.page, 'Rewritten on the server by another program.'),
        'the signed-in device is looking at different notes',
      )

      // And it stays signed in, without being asked for the password again.
      await desktop.page.reload({ waitUntil: 'networkidle' })
      await desktop.page.waitForTimeout(3000)
      must(!(await desktop.page.locator('.vault-picker').count()), 'the session was not kept across a reload')
      return status.split('\n').slice(0, 2).join(' / ')
    } finally {
      await desktop.context.close().catch(() => {})
    }
  })

  await step('signing out ends the session on the server, not just in the browser', async () => {
    // What someone handing a laptop back is actually asking for. Forgetting
    // the token locally would leave it good for another thirty days.
    const borrowed = await openDevice(browser, `${ORIGIN}/`)
    try {
      await signInDevice(borrowed.page)
      const session = await borrowed.page.evaluate(
        () => JSON.parse(localStorage.getItem('spacefore.remote') ?? '{}').token ?? null,
      )
      must(typeof session === 'string' && session.length > 20, 'no session was kept: ' + session)

      const before = await fetch(`${ORIGIN}/api/files`, { headers: { authorization: `Bearer ${session}` } })
      must(before.status === 200, `the session did not work before signing out: ${before.status}`)

      await borrowed.page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
      await borrowed.page.waitForTimeout(700)
      await borrowed.page.locator('.vault-picker-option[data-choice="remote"]').click()
      await borrowed.page.waitForTimeout(400)
      await borrowed.page.locator('.vault-connect').getByRole('button', { name: 'Sign out' }).click()
      await borrowed.page.waitForTimeout(1500)

      const after = await fetch(`${ORIGIN}/api/files`, { headers: { authorization: `Bearer ${session}` } })
      must(after.status === 401, `the session still worked after signing out: ${after.status}`)

      const stored = await borrowed.page.evaluate(() => localStorage.getItem('spacefore.remote'))
      must(stored === null, 'the pairing was kept on the device: ' + stored)
      return `200 before, ${after.status} after`
    } finally {
      await borrowed.context.close().catch(() => {})
    }
  })

  await step('a wrong password is refused, and says so in the app', async () => {
    const wrong = await openDevice(browser, `${ORIGIN}/`)
    try {
      await signInDevice(wrong.page, 'not the password')
      must(await wrong.page.locator('.vault-picker').count() > 0, 'a wrong password opened a vault')
      const alert = await wrong.page.locator('[role="alert"]').first().innerText()
      must(/do not match an account/i.test(alert), 'the app said: ' + alert)
      // Nothing was remembered, so a reload does not retry the bad sign-in.
      const stored = await wrong.page.evaluate(() => localStorage.getItem('spacefore.remote'))
      must(stored === null, 'a refused sign-in was remembered: ' + stored)
      return alert.split('\n')[0]
    } finally {
      await wrong.context.close().catch(() => {})
    }
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
  await rm(accountsFile, { force: true })
}

// Two steps provoke a non-2xx on purpose — the conflict a 409, the wrong
// password a 401 — and a browser logs every one of them. Those are the
// mechanisms working, not defects; anything else still counts.
const expectedConflictNoise = /409|Conflict|401|Unauthorized/
const noise = [...problems, ...phoneProblems].filter((entry) => !expectedConflictNoise.test(entry))

process.exitCode = report(noise, 'sync server') > 0 ? 1 : 0
