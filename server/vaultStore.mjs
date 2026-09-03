// @ts-check
/**
 * Every filesystem operation the sync server performs, and the only place that
 * touches disk.
 *
 * Two rules hold throughout:
 *  - a request can never escape the vault directory, however the path is spelled;
 *  - a write either replaces a file completely or leaves the old one untouched,
 *    so a dropped connection cannot truncate somebody's note.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Prefix for the scratch file an atomic write moves into place. */
export const TEMP_PREFIX = '.spacelink-tmp-'

/** Directories never walked, watched, written to, or served. */
// `.spacefore` is the old name of this app's own folder, kept beside the new
// one: a vault that has been synced before may still hold it, and a folder that
// stopped being skipped would start being served as notes.
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.obsidian',
  '.spacelink',
  '.spacefore',
  'node_modules',
  '.trash',
  '.DS_Store',
])

/** @typedef {{ path: string, size: number, mtime: number, hash: string, isMarkdown: boolean }} VaultEntry */

export class VaultPathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'VaultPathError'
    this.status = 400
  }
}

export class VaultNotFoundError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'VaultNotFoundError'
    this.status = 404
  }
}

/**
 * The vault's own folder is not there.
 *
 * Its own class because the honest answer differs from every other failure
 * here: a missing *note* is a 404 the app can act on, while a missing *vault*
 * means nothing the app is showing can be trusted. 503, because it is very
 * often temporary — an unmounted drive, a folder being moved — and the app
 * should come back rather than conclude anything.
 */
export class VaultUnreachableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'VaultUnreachableError'
    this.status = 503
  }
}

export class VaultConflictError extends Error {
  /**
   * @param {string} message
   * @param {string} currentHash
   */
  constructor(message, currentHash) {
    super(message)
    this.name = 'VaultConflictError'
    this.status = 409
    this.currentHash = currentHash
  }
}

/** @param {string | Buffer} content */
export function hashOf(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * A vault-relative path, normalised to POSIX and proven to stay inside the root.
 *
 * Rejecting `..` textually is not enough — on a case-insensitive filesystem, or
 * through a symlink, a path can still resolve outside. The resolved path is
 * compared against the resolved root, which is the only check that holds.
 */
export class VaultStore {
  /** @param {string} root */
  constructor(root) {
    this.root = resolve(root)
    /**
     * The root with every link resolved, found once. `resolve` is lexical: a
     * path that stays inside the root on paper can still lead anywhere on disk
     * through a symlink, and only `realpath` can tell.
     * @type {Promise<string> | null}
     */
    this.realRoot = null
    /**
     * One promise per absolute path, for whatever is running against it.
     * @type {Map<string, Promise<void>>}
     */
    this.locks = new Map()
    /**
     * Content hashes, keyed by absolute path.
     *
     * A listing has to report a hash per file, and computing one means reading
     * the file — so an unguarded `list()` reads the entire vault every time a
     * device asks what has changed. Size and mtime together are what every
     * backup tool in existence uses to decide a file is unchanged, and they are
     * free: `readdir` has already returned the entry. A file whose size and
     * mtime both match keeps its remembered hash and is not read again.
     *
     * The cost of being wrong is bounded: a file edited within the same
     * millisecond, to exactly the same length, would keep a stale hash — and
     * the watcher would still announce the change, so a device refetches it.
     * @type {Map<string, { size: number, mtimeMs: number, hash: string }>}
     */
    this.hashes = new Map()
  }

  /**
   * The hash of a file, from the cache when size and mtime say it cannot have
   * changed. Returns null if the file could not be read.
   *
   * @param {string} absolute
   * @param {import('node:fs').Stats} info
   * @returns {Promise<string | null>}
   */
  async hashFor(absolute, info) {
    const remembered = this.hashes.get(absolute)
    if (remembered && remembered.size === info.size && remembered.mtimeMs === info.mtimeMs) {
      return remembered.hash
    }
    const body = await readFile(absolute).catch(() => null)
    if (!body) {
      this.hashes.delete(absolute)
      return null
    }
    const hash = hashOf(body)
    this.hashes.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, hash })
    return hash
  }

  /** Record what a write just put on disk, so the next listing does not re-read it. */
  /**
   * @param {string} absolute
   * @param {import('node:fs').Stats} info
   * @param {string} hash
   */
  rememberHash(absolute, info, hash) {
    this.hashes.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, hash })
  }

  /**
   * @param {string} inputPath
   * @returns {{ relative: string, absolute: string }}
   */
  resolvePath(inputPath) {
    if (typeof inputPath !== 'string' || inputPath.trim() === '') {
      throw new VaultPathError('A path is required.')
    }
    if (inputPath.includes('\0')) throw new VaultPathError('That path is not valid.')

    const cleaned = inputPath.replace(/\\/g, '/').replace(/\/+/g, '/')
    // Vault paths are relative by contract. Silently reinterpreting "/etc/passwd"
    // as a vault-relative path would keep the request inside the vault but hide
    // the fact that the caller asked for something else entirely.
    if (cleaned.startsWith('/')) throw new VaultPathError(`"${inputPath}" must be relative to the vault.`)
    if (cleaned === '' || cleaned === '.') throw new VaultPathError('A path is required.')

    const absolute = resolve(this.root, cleaned)
    const inside = relative(this.root, absolute)
    if (inside === '' || inside.startsWith('..') || inside.startsWith(`..${sep}`)) {
      throw new VaultPathError(`"${inputPath}" is outside the vault.`)
    }
    // A skipped directory anywhere in the path is off limits, in both directions:
    // the server neither serves from it nor writes into it. So is anything
    // hidden: the listing walks past every dot-entry, and a note the listing
    // does not show must not be announced, served or written either — a device
    // would add it, then lose it on the next reload.
    for (const segment of inside.split(sep)) {
      if (SKIP_DIRECTORIES.has(segment)) {
        throw new VaultPathError(`"${inputPath}" is in a directory the vault does not sync.`)
      }
      if (segment.startsWith('.')) {
        throw new VaultPathError(`"${inputPath}" is hidden, and hidden files are not part of the vault.`)
      }
    }
    return { relative: inside.split(sep).join('/'), absolute }
  }

  /**
   * `resolvePath`, then the check only the filesystem can make: that no link
   * on the way leads out of the vault, or anywhere at all. Links are not
   * followed — the listing skips them — so the file API must not quietly
   * read, write or delete through one. A path that does not exist yet is
   * judged by its deepest existing ancestor.
   * @param {string} inputPath
   * @returns {Promise<{ relative: string, absolute: string }>}
   */
  async resolveOnDisk(inputPath) {
    const entry = this.resolvePath(inputPath)
    this.realRoot ??= realpath(this.root)
    /** @type {string} */
    let realRoot
    try {
      realRoot = await this.realRoot
    } catch (error) {
      // The vault's folder is not there. Said plainly, and not cached as a
      // rejected promise: the drive may be mounted again a moment later, and a
      // remembered failure would outlast the problem.
      this.realRoot = undefined
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw new VaultUnreachableError(
          'The folder this vault lives in is not there. It may have been moved or renamed, or its drive may not be mounted.',
        )
      }
      throw error
    }
    let probe = entry.absolute
    for (;;) {
      /** @type {string | null} */
      let real = null
      try {
        real = await realpath(probe)
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      }
      if (real !== null) {
        if (real !== join(realRoot, relative(this.root, probe))) {
          throw new VaultPathError(`"${inputPath}" goes through a link, and the vault does not follow links.`)
        }
        return entry
      }
      if (probe === this.root) return entry
      probe = dirname(probe)
    }
  }

  /**
   * Run `operation` once everything already running against `keys` is done.
   *
   * `write` reads the file, compares its hash and then writes. Two of them
   * interleaved both read the old hash, both pass the check, and both land:
   * the first device's edit is gone with no conflict to show for it. One
   * operation at a time per file is what makes the If-Match promise true.
   * @template T
   * @param {string[]} keys
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  serialized(keys, operation) {
    const sorted = [...new Set(keys)].sort()
    const earlier = Promise.all(sorted.map((key) => this.locks.get(key) ?? Promise.resolve()))
    const run = earlier.then(operation, operation)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    for (const key of sorted) this.locks.set(key, settled)
    void settled.then(() => {
      for (const key of sorted) if (this.locks.get(key) === settled) this.locks.delete(key)
    })
    return run
  }

  /** Create the vault directory if it is not there yet. */
  async ensureRoot() {
    await mkdir(this.root, { recursive: true })
  }

  /**
   * Every file in the vault, with a content hash so clients can tell what changed.
   * @returns {Promise<VaultEntry[]>}
   */
  async list() {
    /** @type {VaultEntry[]} */
    const entries = []

    /**
     * An arrow function on purpose: it reads `this.hashFor`.
     * @param {string} absolute
     * @param {string} prefix
     */
    const walk = async (absolute, prefix, isRoot = false) => {
      /** @type {import('node:fs').Dirent[]} */
      let contents
      try {
        contents = await readdir(absolute, { withFileTypes: true })
      } catch (error) {
        // A folder inside the vault that went away mid-scan is nothing to
        // report: the walk simply has no more to say about it.
        //
        // The vault's own root is a different question, and answering it the
        // same way was a real defect. A folder that has been moved, renamed or
        // left on an unmounted drive would list as an empty vault — the app
        // told, with a 200, that the person has no notes. "I cannot see your
        // notes" and "you have no notes" must never be the same answer.
        if (!isRoot) return
        throw new VaultUnreachableError(
          `The folder this vault lives in is not there. It may have been moved or renamed, or its drive may not be mounted.`,
        )
      }
      for (const entry of contents) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
        const childAbsolute = join(absolute, entry.name)
        const childPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          await walk(childAbsolute, childPath)
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await stat(childAbsolute)
          const hash = await this.hashFor(childAbsolute, info)
          if (hash === null) continue
          entries.push({
            path: childPath,
            size: info.size,
            mtime: Math.round(info.mtimeMs),
            hash,
            isMarkdown: /\.md$/i.test(entry.name),
          })
        } catch {
          // A file that vanished mid-walk simply is not in this listing.
        }
      }
    }

    await walk(this.root, '', true)
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return entries
  }

  /**
   * @param {string} path
   * @returns {Promise<{ body: Buffer, hash: string, mtime: number }>}
   */
  async read(path) {
    const { absolute, relative: rel } = await this.resolveOnDisk(path)
    try {
      const [body, info] = await Promise.all([readFile(absolute), stat(absolute)])
      const hash = hashOf(body)
      this.rememberHash(absolute, info, hash)
      return { body, hash, mtime: Math.round(info.mtimeMs) }
    } catch {
      throw new VaultNotFoundError(`"${rel}" is not in the vault.`)
    }
  }

  /**
   * Every Markdown file in the vault, one at a time.
   *
   * A device opening a vault needs the text of every note. Asking for them one
   * request at a time is fine for a folder of twenty and hopeless for a folder
   * of five thousand: a browser opens six connections to an origin, so the
   * requests queue and the vault takes minutes to appear. Yielding them here
   * lets the API hand the whole vault over in a single response.
   *
   * Attachments are deliberately left out. They are binary, often far larger
   * than the notes, and nothing needs them until a note that embeds one is
   * actually rendered.
   *
   * @returns {AsyncGenerator<{ path: string, mtime: number, hash: string, text: string }>}
   */
  async *readAllMarkdown() {
    for (const entry of await this.list()) {
      if (!entry.isMarkdown) continue
      const { absolute } = this.resolvePath(entry.path)
      const body = await readFile(absolute, 'utf8').catch(() => null)
      // A note that vanished between the listing and the read is simply not in
      // this bundle; the change feed will tell every device it is gone.
      if (body === null) continue
      yield { path: entry.path, mtime: entry.mtime, hash: entry.hash, text: body }
    }
  }

  /** @param {string} path */
  async createReadStream(path) {
    const { absolute } = await this.resolveOnDisk(path)
    const info = await stat(absolute).catch(() => null)
    if (!info || !info.isFile()) throw new VaultNotFoundError(`"${path}" is not in the vault.`)
    const body = await readFile(absolute)
    return { stream: createReadStream(absolute), size: info.size, hash: hashOf(body) }
  }

  /**
   * Replace a file's contents.
   *
   * `expectedHash` is the hash the client believed it was editing:
   *  - omitted        → unconditional write
   *  - `'*'`          → the file must not exist yet
   *  - a hash         → the file must still match, otherwise it is a conflict
   *
   * @param {string} path
   * @param {Buffer} body
   * @param {string} [expectedHash]
   * @returns {Promise<{ hash: string, mtime: number }>}
   */
  async write(path, body, expectedHash) {
    const { absolute, relative: rel } = await this.resolveOnDisk(path)
    return this.serialized([absolute], () => this.writeNow(absolute, rel, body, expectedHash))
  }

  /**
   * `write`, once it holds the file.
   * @param {string} absolute
   * @param {string} rel
   * @param {Buffer} body
   * @param {string} [expectedHash]
   * @returns {Promise<{ hash: string, mtime: number }>}
   */
  async writeNow(absolute, rel, body, expectedHash) {
    const target = await stat(absolute).catch(() => null)
    if (target && !target.isFile()) throw new VaultPathError(`"${rel}" is a folder, not a file.`)
    const existing = await readFile(absolute).catch(() => null)
    const current = existing ? hashOf(existing) : ''
    const incoming = hashOf(body)

    if (expectedHash === '*') {
      if (existing) throw new VaultConflictError('That file already exists.', current)
    } else if (expectedHash !== undefined) {
      if (current !== expectedHash) {
        throw new VaultConflictError('The file changed since you last read it.', current)
      }
    }

    // Same-content writes are dropped: an editor that saves on every keystroke
    // must not wake every other device for nothing.
    if (existing && current === incoming) {
      const info = await stat(absolute)
      this.rememberHash(absolute, info, current)
      return { hash: current, mtime: Math.round(info.mtimeMs) }
    }

    await this.makeFolderFor(absolute, rel)
    // Write beside the target and move it into place, so a failure part-way
    // through leaves the previous version whole rather than a truncated file.
    // A dot prefix keeps the half-written file out of both the listing and the
    // change feed; otherwise every save announces a phantom `.tmp` note.
    const temporary = join(dirname(absolute), `${TEMP_PREFIX}${randomUUID()}`)
    try {
      await writeFile(temporary, body)
      await rename(temporary, absolute)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    const info = await stat(absolute)
    this.rememberHash(absolute, info, incoming)
    return { hash: incoming, mtime: Math.round(info.mtimeMs) }
  }

  /**
   * The folder `absolute` lives in, created as needed. A file sitting where a
   * folder is needed is the caller's mistake, not a server failure — and the
   * error Node raises for it names the whole path on disk.
   * @param {string} absolute
   * @param {string} rel
   */
  async makeFolderFor(absolute, rel) {
    try {
      await mkdir(dirname(absolute), { recursive: true })
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTDIR') {
        throw new VaultPathError(`"${rel}" cannot be created: a file sits where one of its folders would be.`)
      }
      throw error
    }
  }

  /** @param {string} path */
  async remove(path) {
    const { absolute, relative: rel } = await this.resolveOnDisk(path)
    return this.serialized([absolute], async () => {
      const info = await stat(absolute).catch(() => null)
      if (!info) throw new VaultNotFoundError(`"${rel}" is not in the vault.`)
      if (!info.isFile()) throw new VaultPathError(`"${rel}" is a folder, not a file.`)
      await rm(absolute, { force: true })
      this.hashes.delete(absolute)
    })
  }

  /**
   * @param {string} from
   * @param {string} to
   * @returns {Promise<{ hash: string }>} the moved file's hash
   */
  async rename(from, to) {
    const source = await this.resolveOnDisk(from)
    const target = await this.resolveOnDisk(to)
    return this.serialized([source.absolute, target.absolute], async () => {
      const info = await stat(source.absolute).catch(() => null)
      if (!info) throw new VaultNotFoundError(`"${source.relative}" is not in the vault.`)
      if (!info.isFile()) throw new VaultPathError(`"${source.relative}" is a folder, not a file.`)
      const clash = await stat(target.absolute).catch(() => null)
      if (clash) throw new VaultConflictError(`"${target.relative}" already exists.`, '')
      await this.makeFolderFor(target.absolute, target.relative)
      await rename(source.absolute, target.absolute)
      // The hash travels with the bytes; only the key it is filed under changes.
      const moved = this.hashes.get(source.absolute)
      this.hashes.delete(source.absolute)
      if (moved) this.hashes.set(target.absolute, moved)
      return { hash: moved?.hash ?? hashOf(await readFile(target.absolute)) }
    })
  }

  /** @param {string} path */
  async exists(path) {
    try {
      const { absolute } = await this.resolveOnDisk(path)
      const info = await stat(absolute).catch(() => null)
      return info !== null && info.isFile()
    } catch {
      return false
    }
  }
}

export { SKIP_DIRECTORIES }
