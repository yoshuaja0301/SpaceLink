#!/usr/bin/env node
// @ts-check
/**
 * SpaceFore sync server.
 *
 * Holds one vault — a folder of Markdown files — and serves both the app and a
 * small HTTP API over it, so every device you install the app on reads and
 * writes the same notes.
 *
 * Design notes worth knowing before changing anything here:
 *
 *  - **The vault on disk is the truth.** The server keeps no database and no
 *    copy. Anything that edits the folder — another editor, a sync client, you
 *    at the terminal — is picked up by the watcher and pushed to every device.
 *  - **Writes are conditional.** A client sends the hash it believed it was
 *    editing; a mismatch is a 409 with the current hash, never a silent
 *    overwrite. Two devices editing the same note offline end up with a
 *    conflict copy, not a lost note.
 *  - **Events are deduplicated.** An API write is announced immediately and the
 *    watcher's echo for the same content is dropped, so a device does not get
 *    told about its own save.
 */
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { watch as watchDirectory } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HELP, loadOrCreateToken, parseArgs, tokensMatch } from './config.mjs'
import { SKIP_DIRECTORIES, TEMP_PREFIX, VaultConflictError, VaultNotFoundError, VaultPathError, VaultStore, hashOf } from './vaultStore.mjs'

/**
 * Where this file lives, used only to find `dist/`.
 *
 * Guarded because a bundler can load this module under a non-file URL (the test
 * runner does), and failing to locate `dist/` must not stop the API from
 * working — a caller can always pass `distDir` explicitly.
 */
const HERE = (() => {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return resolve(process.cwd(), 'server')
  }
})()
const DIST = resolve(HERE, '..', 'dist')

/** Bodies larger than this are refused outright rather than buffered. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** How long an API write suppresses the watcher's echo for the same content. */
const ECHO_WINDOW_MS = 4000

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}

/** @param {import('node:http').IncomingMessage} request */
function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    /** @type {Buffer[]} */
    const chunks = []
    let length = 0
    request.on('data', (chunk) => {
      length += chunk.length
      if (length > MAX_BODY_BYTES) {
        rejectPromise(Object.assign(new Error('That file is too large to sync.'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolvePromise(Buffer.concat(chunks)))
    request.on('error', rejectPromise)
  })
}

/** @param {import('node:http').IncomingMessage} request */
function bearerToken(request) {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  return ''
}

/** Addresses this machine can be reached on, for the startup banner. */
function localAddresses() {
  /** @type {string[]} */
  const found = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address)
    }
  }
  return found
}

/**
 * @param {{ vault: string, token: string, distDir?: string }} options
 */
export function createSyncServer({ vault, token, distDir = DIST }) {
  const store = new VaultStore(vault)

  /** @type {Set<import('node:http').ServerResponse>} */
  const listeners = new Set()
  /** @type {Map<string, { hash: string, at: number }>} */
  const recentWrites = new Map()

  /** @param {{ type: string, path?: string, from?: string, to?: string, hash?: string, origin?: string }} event */
  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const listener of listeners) {
      listener.write(payload)
    }
  }

  /**
   * Remember what an API call just wrote, so the watcher's echo can be dropped.
   * @param {string} path
   * @param {string} hash
   */
  function noteOwnWrite(path, hash) {
    recentWrites.set(path, { hash, at: Date.now() })
    for (const [key, value] of recentWrites) {
      if (Date.now() - value.at > ECHO_WINDOW_MS) recentWrites.delete(key)
    }
  }

  /**
   * @param {string} path
   * @param {string} hash
   */
  function isOwnEcho(path, hash) {
    const recent = recentWrites.get(path)
    if (!recent) return false
    if (Date.now() - recent.at > ECHO_WINDOW_MS) {
      recentWrites.delete(path)
      return false
    }
    return recent.hash === hash
  }

  /**
   * Every request, and no exception gets past here: the listener drops this
   * promise, so one that rejected would end the process — one badly spelled
   * address, from anyone on the network, no token needed.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function handle(request, response) {
    try {
      await route(request, response)
    } catch (error) {
      process.stderr.write(`SpaceFore: ${request.method} ${request.url} failed (${error?.message ?? error}).\n`)
      if (response.headersSent) response.destroy()
      else sendJson(response, 500, { error: 'Something went wrong.' })
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const origin = request.headers.origin

    // The API is protected by a bearer token, never by a cookie, so a page on
    // another origin cannot make authenticated calls just by being open.
    if (typeof origin === 'string') {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
      response.setHeader('access-control-allow-headers', 'authorization, content-type, if-match, x-spacefore-client')
      response.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE, OPTIONS')
      response.setHeader('access-control-expose-headers', 'etag, x-spacefore-mtime')
      response.setHeader('access-control-max-age', '600')
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(url.pathname, response, distDir)
      return
    }

    // Unauthenticated: just enough for a device to tell a SpaceFore server from
    // anything else at that address. It reveals nothing about the vault.
    if (url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true, service: 'spacefore' })
      return
    }

    // EventSource cannot send an Authorization header, so the change stream —
    // and only the change stream — also accepts the token as a query parameter.
    // Keeping it off every other endpoint limits how often it can end up in a
    // proxy log.
    const presented =
      url.pathname === '/api/events' && url.searchParams.has('token')
        ? String(url.searchParams.get('token'))
        : bearerToken(request)

    if (!tokensMatch(presented, token)) {
      sendJson(response, 401, { error: 'A valid access token is required.' })
      return
    }

    try {
      await handleApi(request, response, url)
    } catch (error) {
      // Only an error raised on purpose carries a status and a message written
      // for the caller. Anything else is Node's own, and those name the file
      // on disk — the vault's whole path — which is nobody's business.
      const known = typeof error?.status === 'number' && error instanceof Error
      if (!known) process.stderr.write(`SpaceFore: ${request.method} ${url.pathname} failed (${error?.message ?? error}).\n`)
      const body = { error: known ? error.message : 'Something went wrong.' }
      if (error instanceof VaultConflictError) body.currentHash = error.currentHash
      sendJson(response, known ? error.status : 500, body)
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {URL} url
   */
  async function handleApi(request, response, url) {
    const path = url.searchParams.get('path') ?? ''
    const client = String(request.headers['x-spacefore-client'] ?? '')

    if (url.pathname === '/api/vault' && request.method === 'GET') {
      sendJson(response, 200, { name: store.root.split(/[\\/]/).pop() || 'vault', writable: true })
      return
    }

    if (url.pathname === '/api/files' && request.method === 'GET') {
      sendJson(response, 200, { files: await store.list() })
      return
    }

    // Every note's text in one response, as newline-delimited JSON.
    //
    // This is what a device uses to open the vault. One request instead of one
    // per note matters more than it sounds: a browser will only hold six
    // connections open to an origin, so five thousand reads queue six deep and
    // the vault takes minutes to appear. It streams, so neither the server nor
    // the client ever holds the whole vault in memory as one string.
    if (url.pathname === '/api/bundle' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        // Nothing downstream should try to buffer this to add a length.
        'transfer-encoding': 'chunked',
      })
      const files = await store.list()
      response.write(JSON.stringify({ type: 'head', files: files.length, notes: files.filter((f) => f.isMarkdown).length }) + '\n')
      for await (const note of store.readAllMarkdown()) {
        // Back-pressure: a fast disk must not outrun a slow connection into an
        // unbounded write buffer.
        if (!response.write(JSON.stringify({ type: 'note', ...note }) + '\n')) {
          await new Promise((resolve) => response.once('drain', resolve))
        }
      }
      for (const file of files) {
        if (file.isMarkdown) continue
        response.write(JSON.stringify({ type: 'attachment', ...file }) + '\n')
      }
      response.end(JSON.stringify({ type: 'end' }) + '\n')
      return
    }

    if (url.pathname === '/api/file') {
      if (request.method === 'GET') {
        const file = await store.read(path)
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
          'content-length': file.body.length,
          etag: `"${file.hash}"`,
          'x-spacefore-mtime': String(file.mtime),
          'cache-control': 'no-store',
        })
        response.end(file.body)
        return
      }

      if (request.method === 'PUT') {
        const body = await readBody(request)
        const ifMatch = request.headers['if-match']
        const expected = typeof ifMatch === 'string' ? ifMatch.replace(/^"|"$/g, '') : undefined
        const written = await store.write(path, body, expected)
        noteOwnWrite(path, written.hash)
        broadcast({ type: 'upsert', path, hash: written.hash, origin: client })
        sendJson(response, 200, { path, ...written }, { etag: `"${written.hash}"` })
        return
      }

      if (request.method === 'DELETE') {
        await store.remove(path)
        noteOwnWrite(path, '')
        broadcast({ type: 'remove', path, origin: client })
        sendJson(response, 200, { path, removed: true })
        return
      }
    }

    if (url.pathname === '/api/rename' && request.method === 'POST') {
      let body
      try {
        body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
      } catch {
        throw new VaultPathError('The request body is not valid JSON.')
      }
      const renamed = await store.rename(String(body.from ?? ''), String(body.to ?? ''))
      noteOwnWrite(String(body.from ?? ''), '')
      // The new name too: the watcher will see a file appear there, and
      // without this it would announce it as an anonymous write — which the
      // renaming device, whose note is still marked unsaved, takes for
      // somebody else's edit.
      noteOwnWrite(String(body.to ?? ''), renamed.hash)
      broadcast({ type: 'rename', from: String(body.from), to: String(body.to), origin: client })
      sendJson(response, 200, { from: body.from, to: body.to, renamed: true })
      return
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      response.write(': connected\n\n')
      listeners.add(response)
      // A comment every 25s keeps proxies and phone radios from closing an idle
      // stream, which would otherwise look like the server going away.
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000)
      request.on('close', () => {
        clearInterval(keepAlive)
        listeners.delete(response)
      })
      return
    }

    sendJson(response, 404, { error: `No such endpoint: ${request.method} ${url.pathname}` })
  }

  /** Tell every listening device what one changed file now looks like. */
  async function announceChange(filename) {
    if (!filename) return
    const relativePath = String(filename).split(/[\\/]/).join('/')
    // Dot-files are not part of the vault, and the scratch file an atomic
    // write moves into place must never be announced as a note.
    const leaf = relativePath.split('/').pop() ?? ''
    if (leaf.startsWith('.') || leaf.startsWith(TEMP_PREFIX)) return
    let entry
    try {
      entry = await store.resolveOnDisk(relativePath)
    } catch {
      return // hidden, inside a skipped directory, through a link, or otherwise not ours
    }
    const info = await stat(entry.absolute).catch(() => null)
    if (info && !info.isFile()) return // a folder appearing is not a note going away
    const body = info ? await readFile(entry.absolute).catch(() => null) : null
    if (body === null) {
      if (isOwnEcho(entry.relative, '')) return
      // The file is gone, and with it what was last written there: a file
      // that comes back with the same bytes is news, not an echo of that write.
      recentWrites.delete(entry.relative)
      broadcast({ type: 'remove', path: entry.relative })
      return
    }
    const hash = hashOf(body)
    if (isOwnEcho(entry.relative, hash)) return
    noteOwnWrite(entry.relative, hash)
    broadcast({ type: 'upsert', path: entry.relative, hash })
  }

  /**
   * Watch the folder so edits made outside the app reach every device.
   *
   * On macOS and Windows the operating system offers a recursive watch and
   * `fs.watch` uses it. Linux offers none, and Node emulates one in
   * JavaScript — an emulation that, once a file has been replaced by an
   * atomic save (which is every save this server makes), reports nothing
   * more about that file: its later deletion and return go unseen, and the
   * other devices are never told the note is gone, or back. So on Linux every
   * folder is watched on its own. inotify on a folder reports each entry that
   * appears, changes or goes, and a folder that appears is watched as it comes.
   *
   * Either way what comes back is one emitter with `change` (the event type
   * and a path relative to the vault) and `error` events, and a `close()`.
   * Its `error` listener matters: a folder deleted while it is being scanned
   * is reported by *emitting* ENOENT, and an emitter with no listener rethrows
   * what it is given — deleting a folder inside your vault at the wrong moment
   * used to take the server with it. A test puts an error through the emitter
   * to prove the listener is there; nothing else needs the return value.
   *
   * @param {AbortSignal} [signal]
   * @param {'folders' | 'recursive'} [mode]
   */
  function startWatching(signal, mode = process.platform === 'linux' ? 'folders' : 'recursive') {
    if (signal?.aborted) return null
    const watcher = new EventEmitter()
    let stop = () => {}
    watcher.close = () => stop()

    watcher.on('error', (error) => {
      // A folder that went away mid-scan. There is nothing to do about it and
      // nothing is lost: the watch on the rest of the vault carries on.
      if (error?.code === 'ENOENT') return
      process.stderr.write(`SpaceFore: stopped watching the vault (${error?.message ?? error}).\n`)
      watcher.close()
    })

    // One at a time, in order: two events for the same file processed
    // together would race over `isOwnEcho`.
    let queue = Promise.resolve()
    watcher.on('change', (_eventType, filename) => {
      queue = queue.then(() => announceChange(filename)).catch((error) => {
        process.stderr.write(`SpaceFore: could not announce a change (${error?.message ?? error}).\n`)
      })
    })

    try {
      stop = mode === 'recursive' ? watchRecursively(store.root, watcher) : watchEachFolder(store.root, watcher, store)
    } catch (error) {
      process.stderr.write(`SpaceFore: could not watch the vault (${error?.message ?? error}).\n`)
      return null
    }

    signal?.addEventListener('abort', () => watcher.close(), { once: true })
    return watcher
  }

  return { store, handle, startWatching, listeners }
}

/**
 * The operating system's own recursive watch, relayed. Returns what stops it.
 * @param {string} root
 * @param {EventEmitter} facade
 */
function watchRecursively(root, facade) {
  const native = watchDirectory(root, { recursive: true })
  native.on('error', (error) => facade.emit('error', error))
  native.on('change', (type, name) => facade.emit('change', type, name))
  return () => native.close()
}

/**
 * One plain watch per folder, folders that appear included. Returns what
 * stops them all.
 *
 * A folder that goes takes its notes with it, and inotify says nothing about
 * those: the ones the store has seen are announced as gone from here, one by
 * one. A folder that appears whole — moved in from elsewhere — has its notes
 * announced the same way, since no watch was there to see them arrive.
 *
 * @param {string} root
 * @param {EventEmitter} facade
 * @param {VaultStore} store
 */
function watchEachFolder(root, facade, store) {
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map()
  let closed = false

  /** @param {string} name */
  const skipped = (name) => name.startsWith('.') || SKIP_DIRECTORIES.has(name)

  /** Stop watching `folder` and everything under it. @param {string} folder */
  const forget = (folder) => {
    for (const [watched, native] of watchers) {
      if (watched === folder || watched.startsWith(`${folder}${sep}`)) {
        native.close()
        watchers.delete(watched)
      }
    }
  }

  /**
   * Start watching one folder. False when it is already watched, or when the
   * system has run out of watches — that folder is then reported and skipped
   * rather than costing the rest of the vault its watch.
   * @param {string} folder
   */
  const watchFolder = (folder) => {
    if (closed || watchers.has(folder)) return false
    let native
    try {
      native = watchDirectory(folder)
    } catch (error) {
      if (error?.code === 'ENOSPC') {
        process.stderr.write(
          `SpaceFore: too many folders to watch; changes under ${folder} will not be noticed (raise fs.inotify.max_user_watches).\n`,
        )
        return false
      }
      throw error
    }
    native.on('error', (error) => {
      // The folder itself went away: its watch is done, the others carry on.
      if (error?.code === 'ENOENT') forget(folder)
      else facade.emit('error', error)
    })
    native.on('change', (type, name) => {
      if (name) void onEntry(folder, type, String(name))
    })
    watchers.set(folder, native)
    return true
  }

  /**
   * Watch `folder` and every folder below it; with `announce`, report every
   * file found as well.
   * @param {string} folder
   * @param {boolean} announce
   */
  const walk = async (folder, announce) => {
    // The root is watched before the walk starts; everything below it is
    // watched here, and a folder the system cannot watch is not walked.
    if (!watchers.has(folder) && !watchFolder(folder)) return
    /** @type {import('node:fs').Dirent[]} */
    let entries = []
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return // gone again already
    }
    for (const entry of entries) {
      if (skipped(entry.name)) continue
      const child = join(folder, entry.name)
      if (entry.isDirectory()) await walk(child, announce)
      else if (announce && entry.isFile()) facade.emit('change', 'rename', relative(root, child))
    }
  }

  /**
   * @param {string} folder
   * @param {string} type
   * @param {string} name
   */
  const onEntry = async (folder, type, name) => {
    const absolute = join(folder, name)
    if (!skipped(name)) {
      const info = await stat(absolute).catch(() => null)
      if (info?.isDirectory()) {
        if (!watchers.has(absolute)) await walk(absolute, true)
        return
      }
      if (!info && watchers.has(absolute)) {
        forget(absolute)
        for (const known of store.hashes.keys()) {
          if (known.startsWith(`${absolute}${sep}`)) facade.emit('change', 'rename', relative(root, known))
        }
        return
      }
    }
    facade.emit('change', type, relative(root, absolute))
  }

  // The root is watched now, so a failure there is a failure to start; the
  // rest of the tree follows as fast as it can be read.
  watchFolder(root)
  void walk(root, false).catch((error) => facade.emit('error', error))
  return () => {
    closed = true
    for (const native of watchers.values()) native.close()
    watchers.clear()
  }
}

/**
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} response
 * @param {string} distDir
 */
async function serveStatic(pathname, response, distDir) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // `/%ZZ` is not an address, and it is not a reason to stop serving.
    sendJson(response, 400, { error: 'That address is not valid.' })
    return
  }
  const candidate = resolve(distDir, `.${decoded}`)
  const inside = candidate === distDir || candidate.startsWith(`${distDir}/`) || candidate.startsWith(`${distDir}\\`)
  const target = inside && decoded !== '/' ? candidate : join(distDir, 'index.html')

  let body = await readFile(target).catch(() => null)
  if (body === null) {
    // Unknown path: hand back the app shell so client-side routing still works.
    body = await readFile(join(distDir, 'index.html')).catch(() => null)
    if (body === null) {
      sendJson(response, 404, {
        error: 'The app has not been built yet. Run `npm run build`, then start the server again.',
      })
      return
    }
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    // The bundle is content-hashed; index.html must never be held onto.
    'cache-control': target.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  response.end(body)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    process.exit(1)
    return
  }
  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  const stored = options.token ? { token: options.token, created: false, file: '(passed on the command line)' } : await loadOrCreateToken()
  const server = createSyncServer({ vault: options.vault, token: stored.token })
  await server.store.ensureRoot()

  const controller = new AbortController()
  void server.startWatching(controller.signal)

  const listener =
    options.tlsCert && options.tlsKey
      ? createHttpsServer(
          { cert: await readFile(options.tlsCert), key: await readFile(options.tlsKey) },
          (request, response) => void server.handle(request, response),
        )
      : createHttpServer((request, response) => void server.handle(request, response))

  listener.listen(options.port, options.host, () => {
    const scheme = options.tlsCert ? 'https' : 'http'
    // Never `options.port`: with `--port 0` the operating system chose one, and
    // the number the caller asked for is not the number anyone can connect to.
    const address = listener.address()
    const port = typeof address === 'object' && address ? address.port : options.port

    // One line of JSON, before the banner, for a program that launched this
    // server and needs to know where it ended up. Printed only when asked, so
    // the token never appears in a log nobody meant to hold one.
    if (options.printReady) {
      process.stdout.write(
        `${JSON.stringify({
          spacefore: 'ready',
          url: `${scheme}://127.0.0.1:${port}/`,
          port,
          token: stored.token,
          vault: server.store.root,
        })}\n`,
      )
    }

    const lines = [
      '',
      '  SpaceFore sync server',
      `  vault    ${server.store.root}`,
      `  token    ${stored.file}`,
      '',
      `  this Mac       ${scheme}://localhost:${port}/`,
    ]
    if (options.host === '0.0.0.0' || options.host === '::') {
      for (const networkAddress of localAddresses()) {
        lines.push(`  same network   ${scheme}://${networkAddress}:${port}/`)
      }
    } else {
      lines.push('  (bound to loopback — pass --host 0.0.0.0 to reach it from other devices)')
    }
    lines.push('', '  Connect a device: open the address above, choose "Connect to a server",', '  and paste this token:', '', `    ${stored.token}`, '')
    if (stored.created) lines.push('  (a new token was generated and saved; it will be reused next time)', '')
    lines.push('  Reaching it from outside your network: see docs/SERVER.md', '')
    process.stdout.write(`${lines.join('\n')}\n`)
  })

  const shutdown = () => {
    controller.abort()
    listener.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // A server started by another program outlives it if that program crashes,
  // and then sits on a port and a file watcher with nobody to stop it. So when
  // we were launched by one — which `--print-ready` says — the parent's end of
  // stdin becomes the leash: the moment it closes, we go too.
  if (options.printReady) {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
    process.stdin.resume()
  }
}

// Run as a program, not when imported by a test. Compared as paths: a file URL
// percent-encodes a space or a non-ASCII letter (`My%20Apps`) while argv[1] is
// the raw path, so building a URL by hand matched only paths that happened to
// contain nothing worth encoding — and inside an app bundle under such a path
// the server loaded, did nothing, and exited without a word.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
