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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Prefix for the scratch file an atomic write moves into place. */
export const TEMP_PREFIX = '.spacefore-tmp-'

/** Directories never walked, written to, or served. */
const SKIP_DIRECTORIES = new Set(['.git', '.obsidian', '.spacefore', 'node_modules', '.trash', '.DS_Store'])

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
    // the server neither serves from it nor writes into it.
    for (const segment of inside.split(sep)) {
      if (SKIP_DIRECTORIES.has(segment)) {
        throw new VaultPathError(`"${inputPath}" is in a directory the vault does not sync.`)
      }
    }
    return { relative: inside.split(sep).join('/'), absolute }
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
     * @param {string} absolute
     * @param {string} prefix
     */
    const walk = async (absolute, prefix) => {
      /** @type {import('node:fs').Dirent[]} */
      let contents
      try {
        contents = await readdir(absolute, { withFileTypes: true })
      } catch {
        return
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
          const [info, body] = await Promise.all([stat(childAbsolute), readFile(childAbsolute)])
          entries.push({
            path: childPath,
            size: info.size,
            mtime: Math.round(info.mtimeMs),
            hash: hashOf(body),
            isMarkdown: /\.md$/i.test(entry.name),
          })
        } catch {
          // A file that vanished mid-walk simply is not in this listing.
        }
      }
    }

    await walk(this.root, '')
    entries.sort((a, b) => a.path.localeCompare(b.path))
    return entries
  }

  /**
   * @param {string} path
   * @returns {Promise<{ body: Buffer, hash: string, mtime: number }>}
   */
  async read(path) {
    const { absolute, relative: rel } = this.resolvePath(path)
    try {
      const [body, info] = await Promise.all([readFile(absolute), stat(absolute)])
      return { body, hash: hashOf(body), mtime: Math.round(info.mtimeMs) }
    } catch {
      throw new VaultNotFoundError(`"${rel}" is not in the vault.`)
    }
  }

  /** @param {string} path */
  async createReadStream(path) {
    const { absolute } = this.resolvePath(path)
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
    const { absolute } = this.resolvePath(path)
    const existing = await readFile(absolute).catch(() => null)

    if (expectedHash === '*') {
      if (existing) throw new VaultConflictError('That file already exists.', hashOf(existing))
    } else if (expectedHash !== undefined) {
      const current = existing ? hashOf(existing) : ''
      if (current !== expectedHash) {
        throw new VaultConflictError('The file changed since you last read it.', current)
      }
    }

    // Same-content writes are dropped: an editor that saves on every keystroke
    // must not wake every other device for nothing.
    if (existing && hashOf(existing) === hashOf(body)) {
      const info = await stat(absolute)
      return { hash: hashOf(existing), mtime: Math.round(info.mtimeMs) }
    }

    await mkdir(dirname(absolute), { recursive: true })
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
    return { hash: hashOf(body), mtime: Math.round(info.mtimeMs) }
  }

  /** @param {string} path */
  async remove(path) {
    const { absolute, relative: rel } = this.resolvePath(path)
    const info = await stat(absolute).catch(() => null)
    if (!info) throw new VaultNotFoundError(`"${rel}" is not in the vault.`)
    await rm(absolute, { force: true })
  }

  /**
   * @param {string} from
   * @param {string} to
   */
  async rename(from, to) {
    const source = this.resolvePath(from)
    const target = this.resolvePath(to)
    const info = await stat(source.absolute).catch(() => null)
    if (!info) throw new VaultNotFoundError(`"${source.relative}" is not in the vault.`)
    const clash = await stat(target.absolute).catch(() => null)
    if (clash) throw new VaultConflictError(`"${target.relative}" already exists.`, '')
    await mkdir(dirname(target.absolute), { recursive: true })
    await rename(source.absolute, target.absolute)
  }

  /** @param {string} path */
  async exists(path) {
    try {
      const { absolute } = this.resolvePath(path)
      const info = await stat(absolute).catch(() => null)
      return info !== null && info.isFile()
    } catch {
      return false
    }
  }
}

export { SKIP_DIRECTORIES }
