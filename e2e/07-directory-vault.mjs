/**
 * The folder-on-disk vault, against the browser's real File System Access
 * implementation.
 *
 * `showDirectoryPicker()` opens a native OS dialog no automation can click, so
 * the picker call itself is stubbed — but what it hands back is a genuine
 * `FileSystemDirectoryHandle` from the origin private file system, i.e. the same
 * class, the same methods and the same semantics the real picker returns. Every
 * assertion about "what is on disk" reads through a *fresh* handle, never the
 * adapter's cache, so a write that never landed cannot pass.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boot, step, report, must } from './lib.mjs'

/** The parsed export file, handed from the export step to the import step. */
let exported = null

/** Seeds a vault directory and returns the file list, run inside the page. */
const SEED = async () => {
  const root = await navigator.storage.getDirectory()
  for await (const name of root.keys()) {
    await root.removeEntry(name, { recursive: true }).catch(() => {})
  }
  const vault = await root.getDirectoryHandle('my-notes', { create: true })

  const write = async (dir, name, text) => {
    const handle = await dir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(text)
    await writable.close()
  }

  await write(vault, 'Home.md', '# Home\n\nStart at [[Ideas/Seed]], and [[Missing Note]] does not exist yet.\n')
  await write(vault, 'Journal.md', '# Journal\n\n- [ ] read [[Seed]]\n- [x] done already\n')

  const ideas = await vault.getDirectoryHandle('Ideas', { create: true })
  await write(ideas, 'Seed.md', '---\ntags: [seed, real]\n---\n\n# Seed\n\nBack to [[Home]]. Tagged #real.\n')
  const deep = await ideas.getDirectoryHandle('Deep', { create: true })
  await write(deep, 'Nested.md', '# Nested\n\nThree levels down, linking [[Seed]].\n')

  // An attachment: listed, but not a note.
  const png = await vault.getFileHandle('diagram.png', { create: true })
  const pngWritable = await png.createWritable()
  await pngWritable.write(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  await pngWritable.close()

  // Both of these must be skipped by the walker.
  const hidden = await vault.getDirectoryHandle('.obsidian', { create: true })
  await write(hidden, 'config.md', '# Config\n\nShould never appear.\n')
  const modules = await vault.getDirectoryHandle('node_modules', { create: true })
  await write(modules, 'junk.md', '# Junk\n\nShould never appear.\n')

  return true
}

/** Reads a file straight off "disk", bypassing whatever the app has cached. */
const READ_DISK = async (path) => {
  const root = await navigator.storage.getDirectory()
  let dir = await root.getDirectoryHandle('my-notes')
  const parts = path.split('/')
  const file = parts.pop()
  for (const part of parts) dir = await dir.getDirectoryHandle(part)
  const handle = await dir.getFileHandle(file)
  return (await handle.getFile()).text()
}

/** Every path under the vault directory, read fresh. */
const LIST_DISK = async () => {
  const root = await navigator.storage.getDirectory()
  const vault = await root.getDirectoryHandle('my-notes')
  const out = []
  const walk = async (dir, prefix) => {
    for await (const [name, child] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (child.kind === 'directory') await walk(child, path)
      else out.push(path)
    }
  }
  await walk(vault, '')
  return out.sort()
}

const { browser, page, problems } = await boot()
console.log('== 7. folder-on-disk vault (real File System Access handles) ==')

// The picker is the one thing automation cannot click; everything behind it is real.
await page.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('my-notes', { create: true })
  }
})

await step('the origin private file system gives us real handles', async () => {
  const kind = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('probe', { create: true })
    const file = await dir.getFileHandle('a.txt', { create: true })
    await root.removeEntry('probe', { recursive: true })
    return {
      dirClass: Object.getPrototypeOf(dir).constructor.name,
      fileClass: Object.getPrototypeOf(file).constructor.name,
      hasWritable: typeof file.createWritable === 'function',
    }
  })
  must(kind.dirClass === 'FileSystemDirectoryHandle', 'directory handle is ' + kind.dirClass)
  must(kind.fileClass === 'FileSystemFileHandle', 'file handle is ' + kind.fileClass)
  must(kind.hasWritable, 'no createWritable on the file handle')
  return `${kind.dirClass} / ${kind.fileClass}`
})

await step('a folder of markdown files opens as a vault', async () => {
  await page.evaluate(SEED)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(1600)

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
  await page.waitForTimeout(800)
  await page.locator('.vault-picker button').filter({ hasText: /folder/i }).first().click()
  await page.waitForTimeout(2500)

  const status = await page.locator('.statusbar').innerText()
  must(/my-notes/i.test(status), 'vault name is not the folder name: ' + status)
  must(/4 notes/.test(status), 'expected 4 notes, got: ' + status)
  return status.split('\n').slice(0, 2).join(' / ')
})

await step('dot-directories and node_modules are skipped', async () => {
  const files = await page.locator('.nav-file').allInnerTexts()
  const all = JSON.stringify(files)
  must(!/Config/.test(all), '.obsidian was walked: ' + all)
  must(!/Junk/.test(all), 'node_modules was walked: ' + all)
  return all
})

await step('nested folders and attachments are read correctly', async () => {
  await page.keyboard.press('Control+p'); await page.waitForTimeout(300)
  await page.keyboard.type('Nested'); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)
  const text = await page.evaluate(() => document.body.innerText)
  must(/Three levels down/.test(text), 'the three-levels-deep note did not load')
  const status = await page.locator('.statusbar').innerText()
  must(!/5 notes/.test(status), 'the png was counted as a note: ' + status)
})

await step('links resolve across the real folder tree', async () => {
  await page.keyboard.press('Control+p'); await page.waitForTimeout(300)
  await page.keyboard.type('Home'); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)
  await page.locator('[aria-label="Preview view"]').first().click(); await page.waitForTimeout(900)
  const counts = await page.evaluate(() => ({
    resolved: document.querySelectorAll('.markdown-preview .internal-link:not(.is-unresolved)').length,
    unresolved: document.querySelectorAll('.markdown-preview .internal-link.is-unresolved').length,
  }))
  must(counts.resolved >= 1, 'no resolved link: ' + JSON.stringify(counts))
  must(counts.unresolved === 1, 'expected exactly one unresolved link: ' + JSON.stringify(counts))
  return JSON.stringify(counts)
})

await step('typing reaches the actual file on disk', async () => {
  await page.locator('[aria-label="Edit view"]').first().click(); await page.waitForTimeout(700)
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n\nWritten straight to disk by the test.\n')
  await page.waitForTimeout(2200)

  const onDisk = await page.evaluate(READ_DISK, 'Home.md')
  must(/Written straight to disk by the test\./.test(onDisk), 'the file on disk was not updated:\n' + onDisk)
  must(/# Home/.test(onDisk), 'the original content was lost:\n' + onDisk)
  return `${onDisk.length} bytes on disk, original intact`
})

await step('a new note is created as a real file in the right folder', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(420)
  await page.keyboard.type('New note'); await page.waitForTimeout(420)
  await page.keyboard.press('Enter'); await page.waitForTimeout(1000)
  await page.locator('.cm-content').first().click()
  await page.keyboard.type('\nA brand new file.\n')
  await page.waitForTimeout(2200)

  const paths = await page.evaluate(LIST_DISK)
  const created = paths.find((p) => /Untitled/i.test(p))
  must(created, 'no new file on disk: ' + JSON.stringify(paths))
  const body = await page.evaluate(READ_DISK, created)
  must(/A brand new file\./.test(body), 'the new file is empty on disk')
  return created
})

await step('renaming moves the file and rewrites links on disk', async () => {
  await page.keyboard.press('Control+p'); await page.waitForTimeout(300)
  await page.keyboard.type('Seed'); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)

  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(420)
  await page.keyboard.type('Rename current note'); await page.waitForTimeout(420)
  await page.keyboard.press('Enter'); await page.waitForTimeout(800)
  await page.getByLabel('New name').fill('Germinated')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)

  const paths = await page.evaluate(LIST_DISK)
  must(!paths.includes('Ideas/Seed.md'), 'the old file is still on disk: ' + JSON.stringify(paths))
  must(paths.includes('Ideas/Germinated.md'), 'the renamed file is missing: ' + JSON.stringify(paths))

  // The note that linked to it must have been rewritten on disk, not just in memory.
  const journal = await page.evaluate(READ_DISK, 'Journal.md')
  must(/\[\[Germinated\]\]/.test(journal), 'the link was not rewritten on disk:\n' + journal)
  return 'file moved and Journal.md rewritten'
})

await step('deleting removes the file from disk', async () => {
  await page.keyboard.press('Control+p'); await page.waitForTimeout(300)
  await page.keyboard.type('Untitled'); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)

  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(420)
  await page.keyboard.type('Delete current note'); await page.waitForTimeout(420)
  await page.keyboard.press('Enter'); await page.waitForTimeout(800)
  await page.locator('.modal').getByRole('button', { name: 'Delete' }).click()
  await page.waitForTimeout(1800)

  const paths = await page.evaluate(LIST_DISK)
  must(!paths.some((p) => /Untitled/i.test(p)), 'the file survived the delete: ' + JSON.stringify(paths))
  return JSON.stringify(paths)
})

await step('the folder reopens by itself after a reload', async () => {
  const before = await page.evaluate(LIST_DISK)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)

  const status = await page.locator('.statusbar').innerText()
  must(/my-notes/i.test(status), 'the folder vault was not restored: ' + status)
  const after = await page.evaluate(LIST_DISK)
  must(JSON.stringify(before) === JSON.stringify(after), `disk changed across reload:\n${before}\n${after}`)

  await page.keyboard.press('Control+p'); await page.waitForTimeout(300)
  await page.keyboard.type('Home'); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)
  must(
    await page.evaluate(() => /Written straight to disk by the test/.test(document.body.innerText)),
    'the edit made before the reload is gone',
  )
  return status.split('\n').slice(0, 2).join(' / ')
})

await step('switching vaults mid-edit does not clobber the file on disk', async () => {
  // The regression the review caught: a debounced autosave firing after the
  // adapter had already been swapped wrote the outgoing vault's buffer through
  // the incoming one, over a same-named file.
  await page.locator('[aria-label="Edit view"]').first().click(); await page.waitForTimeout(700)
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nEdited immediately before switching away.\n')

  // Switch while the autosave debounce is still armed.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
  await page.waitForTimeout(250)
  await page.locator('.vault-picker button').filter({ hasText: /demo/i }).first().click()
  await page.waitForTimeout(3000)

  const status = await page.locator('.statusbar').innerText()
  must(/Demo vault/i.test(status), 'the demo vault did not open: ' + status)

  // The folder's own files must be intact — and must not have been overwritten
  // with anything from the demo vault.
  const home = await page.evaluate(READ_DISK, 'Home.md')
  must(/# Home/.test(home), 'Home.md on disk was replaced:\n' + home.slice(0, 200))
  must(!/Zettelkasten|Atomic Notes/.test(home), 'demo content leaked onto disk:\n' + home.slice(0, 200))
  must(/Edited immediately before switching away\./.test(home), 'the last edit was dropped instead of flushed')

  // Nothing added, nothing removed — including the directories the walker skips,
  // which the app must never touch.
  const expected = [
    '.obsidian/config.md',
    'Home.md',
    'Ideas/Deep/Nested.md',
    'Ideas/Germinated.md',
    'Journal.md',
    'diagram.png',
    'node_modules/junk.md',
  ]
  const paths = await page.evaluate(LIST_DISK)
  must(
    JSON.stringify(paths) === JSON.stringify(expected),
    `the folder changed while another vault was open:\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(paths)}`,
  )
  return `disk intact, ${paths.length} files`
})

await step('a file changed by another editor shows up on reload', async () => {
  // Reopen the folder, then edit a file behind the app's back — exactly what
  // happens when the same vault is open in another editor or synced.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
  await page.waitForTimeout(800)
  await page.locator('.vault-picker button').filter({ hasText: /folder/i }).first().click()
  await page.waitForTimeout(2500)

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const vault = await root.getDirectoryHandle('my-notes')
    const handle = await vault.getFileHandle('Journal.md')
    const writable = await handle.createWritable()
    await writable.write('# Journal\n\nRewritten by another editor entirely.\n')
    await writable.close()
  })

  await page.keyboard.press('Control+Shift+P'); await page.waitForTimeout(420)
  await page.keyboard.type('Reload vault'); await page.waitForTimeout(420)
  await page.keyboard.press('Enter'); await page.waitForTimeout(2500)

  await page.keyboard.press('Control+p'); await page.waitForTimeout(300)
  await page.keyboard.type('Journal'); await page.waitForTimeout(450)
  await page.keyboard.press('Enter'); await page.waitForTimeout(900)
  must(
    await page.evaluate(() => /Rewritten by another editor entirely/.test(document.body.innerText)),
    'the app kept serving its cached copy after the file changed underneath it',
  )
  return 'external change picked up'
})

await step('a folder whose permission the browser dropped falls back cleanly', async () => {
  // Browsers do not keep a directory grant forever. When the stored handle can
  // no longer be used, the app has to say so and stay usable rather than
  // opening an empty vault that silently swallows writes.
  await page.addInitScript(() => {
    // OPFS handles carry no permission methods; adding them exercises exactly
    // the branch a real picker-derived handle would take.
    FileSystemDirectoryHandle.prototype.queryPermission = async () => 'denied'
    FileSystemDirectoryHandle.prototype.requestPermission = async () => 'denied'
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(3000)

  const status = await page.locator('.statusbar').innerText()
  must(!/my-notes/i.test(status), 'the app claims to have opened a folder it cannot read: ' + status)
  must(/vault|note/i.test(status), 'the app did not fall back to a usable vault: ' + status)
  must(await page.locator('.app').count() > 0, 'the app failed to render at all')

  // And the folder on disk must be untouched by the failed restore.
  const paths = await page.evaluate(LIST_DISK)
  must(paths.includes('Home.md'), 'the folder was damaged by a denied restore: ' + JSON.stringify(paths))
  return status.split('\n').slice(0, 2).join(' / ')
})

await step('a folder whose permission is re-granted opens again', async () => {
  await page.addInitScript(() => {
    FileSystemDirectoryHandle.prototype.queryPermission = async () => 'prompt'
    FileSystemDirectoryHandle.prototype.requestPermission = async () => 'granted'
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(3200)

  const status = await page.locator('.statusbar').innerText()
  must(/my-notes/i.test(status), 'the folder did not reopen after the grant: ' + status)
  return status.split('\n').slice(0, 2).join(' / ')
})

await step('exporting the vault carries the attachment, not just the notes', async () => {
  // "Export vault as JSON" is what someone reaches for to keep a copy. It used
  // to write `state.notes` and nothing else, so a folder of notes *and images*
  // came back as a folder of notes and broken links — silently, from the one
  // button whose whole purpose is not losing anything.
  const download = page.waitForEvent('download', { timeout: 30_000 })
  await page.keyboard.press('Control+Shift+P')
  await page.waitForSelector('.palette-input', { timeout: 15_000 })
  await page.keyboard.type('Export vault')
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')

  const file = await (await download).path()
  exported = JSON.parse(await readFile(file, 'utf8'))

  must(Object.keys(exported.notes ?? {}).length === 4, `notes: ${JSON.stringify(Object.keys(exported.notes ?? {}))}`)
  const encoded = exported.attachments?.['diagram.png']
  must(typeof encoded === 'string', `no attachment in the export: ${JSON.stringify(Object.keys(exported))}`)
  // The exact bytes the seed wrote, not merely something of the right length.
  must(
    Buffer.from(encoded, 'base64').equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `the bytes came back wrong: ${Buffer.from(encoded, 'base64').toString('hex')}`,
  )
  return `4 notes + diagram.png (${Buffer.from(encoded, 'base64').length} bytes)`
})

await step('importing it into an empty vault brings the attachment back', async () => {
  must(exported !== null, 'the export step did not run')

  // A browser vault is a different backend entirely, which is the point: the
  // export has to be enough on its own.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-vault-picker')))
  await page.waitForTimeout(800)
  await page.locator('.vault-picker button').filter({ hasText: /browser/i }).first().click()
  await page.waitForTimeout(2500)

  const carrier = join(tmpdir(), `spacefore-export-${Date.now()}.json`)
  await writeFile(carrier, JSON.stringify(exported))
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('spacefore:open-settings')))
    await page.waitForSelector('.modal input[type="file"]', { timeout: 15_000 })
    await page.locator('.modal input[type="file"]').setInputFiles(carrier)
    await page.waitForTimeout(3500)

    // Read it straight out of IndexedDB, the way the rest of this suite reads
    // straight off disk: what the app believes is not evidence.
    const landed = await page.evaluate(async () => {
      // The browser vault names its database after the vault, so ask rather
      // than assume — and say which ones exist if the expected one is missing.
      const names = (await indexedDB.databases()).map((entry) => entry.name)
      const chosen = names.includes('SpaceFore') ? 'SpaceFore' : names[0]
      if (!chosen) return { paths: [], bytes: [], databases: names }
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(chosen)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction('files', 'readonly').objectStore('files').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const picture = records.find((record) => record.path === 'diagram.png')
      const bytes = picture?.binary ? [...new Uint8Array(await picture.binary.arrayBuffer())] : []
      return { paths: records.map((record) => record.path).sort(), bytes, databases: names }
    })

    must(landed.paths.includes('Home.md'), `notes did not import: ${JSON.stringify(landed)}`)
    must(landed.paths.includes('diagram.png'), `attachment did not import: ${JSON.stringify(landed.paths)}`)
    must(
      landed.bytes.join(',') === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].join(','),
      `the restored bytes are wrong: ${JSON.stringify(landed.bytes)}`,
    )
    return landed.paths.join(', ')
  } finally {
    await rm(carrier, { force: true })
  }
})

process.exitCode = report(problems, 'directory vault') > 0 ? 1 : 0
await browser.close()
