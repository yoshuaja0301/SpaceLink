#!/usr/bin/env node
// @ts-check
/**
 * SpaceLink MCP server.
 *
 * Lets an AI assistant reach a running SpaceLink vault: list and read notes,
 * search them, write notes, and import an outside file or folder into the vault
 * *by copying* — the source on disk is only ever read, never written, so opening
 * something through SpaceLink cannot change the original.
 *
 * It speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC
 * 2.0) and has no dependencies, so it runs with a bare `node` and nothing to
 * install. It finds the running server through the discovery file the server
 * writes on start — `~/.spacelink/runtime.json` — so nobody has to hand it a
 * port or a token.
 */
import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const NAME = 'spacelink'
const VERSION = '0.1.0'

/** Files that can be read as Markdown when imported. */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.org',
  '.rst',
  '.log',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
])

/** Directories never walked on import — the same heavy ones the vault skips. */
const SKIP_DIRECTORIES = new Set(['.git', '.obsidian', '.spacelink', '.spacefore', 'node_modules', '.trash', 'Library', 'Applications'])

const log = (message) => process.stderr.write(`spacelink-mcp: ${message}\n`)

/* ------------------------------------------------------------------ discovery */

/**
 * Read the running server's address and token from the discovery file the
 * server writes on start. Throws a sentence a person can act on when it is not
 * there, because "SpaceLink is not open" is the usual reason and the fix is to
 * open it.
 * @returns {Promise<{ url: string, token: string, vault: string }>}
 */
async function discoverServer() {
  const candidates = [join(homedir(), '.spacelink', 'runtime.json'), join(homedir(), '.spacefore', 'runtime.json')]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fsReadFile(file, 'utf8'))
      if (parsed?.url && parsed?.token) {
        return { url: String(parsed.url).replace(/\/$/, ''), token: String(parsed.token), vault: String(parsed.vault ?? '') }
      }
    } catch {
      // Not this one; try the next.
    }
  }
  throw new Error('SpaceLink does not appear to be running. Open the SpaceLink app, then try again.')
}

/**
 * A call to the running SpaceLink server.
 * @param {string} path
 * @param {{ method?: string, body?: Buffer | string, headers?: Record<string,string>, raw?: boolean }} [options]
 */
async function api(path, options = {}) {
  const { url, token } = await discoverServer()
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    body: options.body,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`SpaceLink API ${response.status} on ${options.method ?? 'GET'} ${path}${detail ? `: ${detail}` : ''}`)
  }
  if (options.raw) return Buffer.from(await response.arrayBuffer())
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

/* ------------------------------------------------------------------ vault ops */

/** @returns {Promise<Array<{ path: string, size: number, mtime: number, isMarkdown: boolean }>>} */
async function listFiles() {
  const data = await api('/api/files')
  return Array.isArray(data?.files) ? data.files : []
}

/** @param {string} path */
async function readNote(path) {
  const body = await api(`/api/file?path=${encodeURIComponent(path)}`, { raw: true })
  return body.toString('utf8')
}

/**
 * @param {string} path
 * @param {string} content
 * @param {boolean} [createOnly]
 */
async function writeNote(path, content, createOnly = false) {
  return api(`/api/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', ...(createOnly ? { 'if-match': '*' } : {}) },
    body: Buffer.from(content, 'utf8'),
  })
}

/** A vault-relative path, cleaned so it cannot escape the vault. */
function vaultPath(...parts) {
  return parts
    .join('/')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}

/**
 * Copy every readable text file under `source` into the vault under `into`,
 * naming non-Markdown text files `.md` so they open as notes. The source is
 * only read; nothing is written back to it. Returns what was copied and what
 * was skipped.
 * @param {string} source
 * @param {string} into
 */
async function importPath(source, into) {
  const absolute = resolve(source.replace(/^~(?=$|\/)/, homedir()))
  const info = await stat(absolute).catch(() => null)
  if (!info) throw new Error(`Nothing at "${source}".`)

  const base = into ? vaultPath(into) : vaultPath(basename(absolute).replace(/\.[^.]+$/, '') || 'imported')
  const copied = []
  const skipped = []

  /** @param {string} filePath @param {string} destRelative */
  const importFile = async (filePath, destRelative) => {
    const raw = await fsReadFile(filePath).catch(() => null)
    if (!raw) {
      skipped.push({ path: destRelative, reason: 'unreadable' })
      return
    }
    // A NUL byte means binary; it cannot be shown as Markdown, so it is left out.
    if (raw.includes(0)) {
      skipped.push({ path: destRelative, reason: 'binary' })
      return
    }
    const ext = extname(filePath).toLowerCase()
    const isMarkdown = ext === '.md' || ext === '.markdown' || ext === '.mdx'
    const dest = isMarkdown ? destRelative : `${destRelative}.md`
    await writeNote(dest, raw.toString('utf8'))
    copied.push(dest)
  }

  if (info.isFile()) {
    await importFile(absolute, vaultPath(base, basename(absolute)))
    return { source: absolute, into: base, copied, skipped }
  }

  /** @param {string} dir */
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (!entry.isFile()) continue
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        skipped.push({ path: relative(absolute, child).split(sep).join('/'), reason: 'not text' })
        continue
      }
      const destRelative = vaultPath(base, relative(absolute, child).split(sep).join('/'))
      await importFile(child, destRelative)
    }
  }
  await walk(absolute)
  return { source: absolute, into: base, copied, skipped }
}

/* --------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'list_notes',
    description: 'List the Markdown notes in the SpaceLink vault. Optionally filter by a folder prefix.',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Only list notes under this folder (vault-relative).' } },
    },
    run: async (args) => {
      const files = await listFiles()
      const folder = args?.folder ? vaultPath(args.folder) : ''
      const notes = files
        .filter((f) => f.isMarkdown && (!folder || f.path === folder || f.path.startsWith(`${folder}/`)))
        .map((f) => f.path)
      return `${notes.length} note(s):\n${notes.join('\n')}`
    },
  },
  {
    name: 'read_note',
    description: 'Read the full Markdown text of one note in the vault.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path, e.g. "Ideas/Plan.md".' } },
      required: ['path'],
    },
    run: async (args) => readNote(vaultPath(args.path)),
  },
  {
    name: 'search_notes',
    description: 'Search the text of every note in the vault and return matching notes with a snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for (case-insensitive).' },
        limit: { type: 'number', description: 'Maximum notes to return (default 20).' },
      },
      required: ['query'],
    },
    run: async (args) => {
      const query = String(args.query ?? '')
      const limit = Number.isInteger(args.limit) ? args.limit : 20
      const needle = query.toLowerCase()
      const files = (await listFiles()).filter((f) => f.isMarkdown)
      const hits = []
      for (const file of files) {
        if (hits.length >= limit) break
        const text = await readNote(file.path).catch(() => '')
        const at = text.toLowerCase().indexOf(needle)
        if (at === -1) continue
        const start = Math.max(0, at - 40)
        const snippet = text.slice(start, at + query.length + 40).replace(/\s+/g, ' ').trim()
        hits.push(`${file.path}\n  …${snippet}…`)
      }
      return hits.length ? `${hits.length} match(es):\n\n${hits.join('\n\n')}` : `No notes contain "${query}".`
    },
  },
  {
    name: 'write_note',
    description: 'Create or overwrite a note in the vault. Writes only inside the vault; never touches files outside it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path, e.g. "Ideas/New.md".' },
        content: { type: 'string', description: 'The Markdown text to write.' },
        create_only: { type: 'boolean', description: 'Fail if the note already exists (default false).' },
      },
      required: ['path', 'content'],
    },
    run: async (args) => {
      const result = await writeNote(vaultPath(args.path), String(args.content ?? ''), Boolean(args.create_only))
      return `Wrote ${result?.path ?? args.path} (hash ${String(result?.hash ?? '').slice(0, 12)}).`
    },
  },
  {
    name: 'import_path',
    description:
      'Copy an outside file or folder INTO the vault, so it can be read as Markdown. The original on disk is only read, never changed. Text files that are not Markdown are copied with a .md extension. Binary files are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path to a file or folder on disk (e.g. "~/Desktop/notes").' },
        into: { type: 'string', description: 'Vault folder to copy into (default: the source name).' },
      },
      required: ['source'],
    },
    run: async (args) => {
      const result = await importPath(String(args.source), args.into ? String(args.into) : '')
      const skippedNote = result.skipped.length ? `\nSkipped ${result.skipped.length} (binary or non-text).` : ''
      return `Imported ${result.copied.length} file(s) into "${result.into}" from ${result.source}. Originals unchanged.${skippedNote}\n\n${result.copied.join('\n')}`
    },
  },
  {
    name: 'vault_info',
    description: 'Where the vault is and how many notes and files it holds.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const { vault } = await discoverServer()
      const files = await listFiles()
      const notes = files.filter((f) => f.isMarkdown).length
      return `Vault: ${vault}\nNotes: ${notes}\nFiles total: ${files.length}`
    },
  },
]

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/* ----------------------------------------------------------- MCP over stdio */

/** @param {object} message */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** @param {any} id @param {any} result */
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
/** @param {any} id @param {number} code @param {string} message */
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(message) {
  const { id, method, params } = message
  // A notification (no id) never gets a response.
  const isRequest = id !== undefined && id !== null

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return isRequest && reply(id, {})
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  }
  if (method === 'tools/call') {
    const tool = TOOL_BY_NAME.get(params?.name)
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`)
    try {
      const text = await tool.run(params?.arguments ?? {})
      return reply(id, { content: [{ type: 'text', text: String(text) }] })
    } catch (error) {
      // A tool failure is reported inside the result, not as a protocol error,
      // so the model sees what went wrong and can react.
      return reply(id, { content: [{ type: 'text', text: `Error: ${error?.message ?? error}` }], isError: true })
    }
  }
  if (isRequest) return fail(id, -32601, `Method not found: ${method}`)
}

function main() {
  log('starting (stdio)')
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        log(`ignored non-JSON line`)
        continue
      }
      Promise.resolve(handle(message)).catch((error) => log(`handler error: ${error?.message ?? error}`))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

main()
