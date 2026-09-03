/**
 * Teaching the service worker what to keep, from what the build actually made.
 *
 * A worker that only caches what it happens to intercept never gets the chance
 * to cache the first page load: it is not in charge yet while that page is
 * fetching. So the app was three visits away from working offline, and the
 * README said one. The cure is to precache during `install`, and the list has
 * to come from the build or it drifts the first time a chunk is renamed.
 *
 * Nothing here parses `sw.js`. The build prepends two assignments to it and the
 * worker reads them if they are there, so the worker stays a working file on
 * its own and this stays a list-maker.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'

/**
 * Whether a built file is worth keeping for offline use.
 *
 * @param {string} file - path inside the output directory, `/`-separated
 */
export function shouldPrecache(file) {
  // The worker cannot be served to itself out of its own cache: that is how a
  // bad worker becomes permanent.
  if (file === 'sw.js') return false
  // Sourcemaps are twice the weight of the app and are for a debugger, which
  // is not a thing you have on a train.
  if (file.endsWith('.map')) return false
  return true
}

/**
 * The URLs a worker should hold, given everything the build emitted.
 *
 * `./` leads because it is what a navigation asks for, and it is not any file's
 * name — `index.html` is a different cache key and both are wanted.
 *
 * @param {string[]} files - output-relative paths
 * @returns {string[]}
 */
export function precacheList(files) {
  const kept = files.filter(shouldPrecache).sort()
  return ['./', ...kept.map((file) => `./${file}`)]
}

/**
 * A name for this build's cache, derived from the bytes it will hold.
 *
 * Naming the cache after its contents means the `activate` step's existing
 * "delete every cache that is not mine" prunes the previous build exactly, and
 * there is no version number anyone has to remember to bump.
 *
 * @param {Array<{ file: string, bytes: Buffer | string }>} entries
 */
export function buildId(entries) {
  const digest = createHash('sha256')
  for (const { file, bytes } of [...entries].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    digest.update(file)
    digest.update('\0')
    digest.update(bytes)
  }
  return digest.digest('hex').slice(0, 16)
}

/** Every file under `directory`, as `/`-separated relative paths. */
export async function walk(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const absolute = join(entry.parentPath ?? entry.path, entry.name)
    found.push(relative(directory, absolute).split(sep).join(posix.sep))
  }
  return found.sort()
}

/**
 * Vite plugin: after the bundle is on disk, tell `sw.js` what is in it.
 */
export function precachePlugin() {
  return {
    name: 'spacefore-precache',
    apply: 'build',
    // `closeBundle` sees the finished directory, `public/` copies and all —
    // which is the point: the list should describe what shipped, not what the
    // bundler happens to know about.
    async closeBundle() {
      const outDir = this.environment?.config?.build?.outDir ?? 'dist'
      const files = await walk(outDir)
      const worker = files.find((file) => file === 'sw.js')
      if (!worker) return

      const wanted = precacheList(files)
      const entries = await Promise.all(
        wanted
          .filter((url) => url !== './')
          .map(async (url) => {
            const file = url.slice('./'.length)
            return { file, bytes: await readFile(join(outDir, file)) }
          }),
      )

      const source = await readFile(join(outDir, 'sw.js'), 'utf8')
      const preamble =
        '/* Written by build/precache.mjs. The worker runs without it, offline is what suffers. */\n' +
        `self.__SPACEFORE_PRECACHE__ = ${JSON.stringify(wanted)}\n` +
        `self.__SPACEFORE_BUILD__ = ${JSON.stringify(buildId(entries))}\n`
      await writeFile(join(outDir, 'sw.js'), `${preamble}${source}`)

      const bytes = entries.reduce((total, entry) => total + entry.bytes.length, 0)
      this.info?.(`precaching ${wanted.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`)
    },
  }
}
