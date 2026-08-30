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
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, watch as watchDirectory } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HELP, loadOrCreateToken, parseArgs, tokensMatch } from './config.mjs'
import { TEMP_PREFIX, VaultConflictError, VaultNotFoundError, VaultPathError, VaultStore, hashOf } from './vaultStore.mjs'

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
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function handle(request, response) {
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
      const status = typeof error?.status === 'number' ? error.status : 500
      const body = { error: error instanceof Error ? error.message : 'Something went wrong.' }
      if (error instanceof VaultConflictError) body.currentHash = error.currentHash
      sendJson(response, status, body)
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
      const body = JSON.parse((await readBody(request)).toString('utf8') || '{}')
      await store.rename(String(body.from ?? ''), String(body.to ?? ''))
      noteOwnWrite(String(body.from ?? ''), '')
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

  /** Watch the folder so edits made outside the app reach every device. */
  async function startWatching(signal) {
    try {
      const watcher = watchDirectory(store.root, { recursive: true, signal })
      for await (const event of watcher) {
        if (!event.filename) continue
        const relativePath = String(event.filename).split(/[\\/]/).join('/')
        // Dot-files are not part of the vault, and the scratch file an atomic
        // write moves into place must never be announced as a note.
        const leaf = relativePath.split('/').pop() ?? ''
        if (leaf.startsWith('.') || leaf.startsWith(TEMP_PREFIX)) continue
        let entry
        try {
          entry = store.resolvePath(relativePath)
        } catch {
          continue // inside a skipped directory, or otherwise not ours
        }
        const body = await readFile(entry.absolute).catch(() => null)
        if (body === null) {
          if (isOwnEcho(entry.relative, '')) continue
          broadcast({ type: 'remove', path: entry.relative })
          continue
        }
        const hash = hashOf(body)
        if (isOwnEcho(entry.relative, hash)) continue
        noteOwnWrite(entry.relative, hash)
        broadcast({ type: 'upsert', path: entry.relative, hash })
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        process.stderr.write(`SpaceFore: stopped watching the vault (${error?.message ?? error}).\n`)
      }
    }
  }

  return { store, handle, startWatching, listeners }
}

/**
 * @param {string} pathname
 * @param {import('node:http').ServerResponse} response
 * @param {string} distDir
 */
async function serveStatic(pathname, response, distDir) {
  const decoded = decodeURIComponent(pathname)
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
    const lines = [
      '',
      '  SpaceFore sync server',
      `  vault    ${server.store.root}`,
      `  token    ${stored.file}`,
      '',
      `  this Mac       ${scheme}://localhost:${options.port}/`,
    ]
    if (options.host === '0.0.0.0' || options.host === '::') {
      for (const address of localAddresses()) {
        lines.push(`  same network   ${scheme}://${address}:${options.port}/`)
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
