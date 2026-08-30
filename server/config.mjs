// @ts-check
/**
 * Server configuration and the access token.
 *
 * The token is the only thing standing between the internet and the user's
 * notes once a tunnel is running, so it is 256 bits of CSPRNG output, compared
 * in constant time, and stored outside the vault — a token that lived inside
 * the synced folder would travel to every device it was meant to protect.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const CONFIG_DIRECTORY = join(homedir(), '.spacefore')
const CONFIG_FILE = join(CONFIG_DIRECTORY, 'server.json')

export function generateToken() {
  return randomBytes(32).toString('base64url')
}

/**
 * Compare two tokens without leaking their contents through timing.
 * @param {string} a
 * @param {string} b
 */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; hash-free padding keeps the comparison uniform.
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Load the stored token, creating one on first run.
 * @returns {Promise<{ token: string, created: boolean, file: string }>}
 */
export async function loadOrCreateToken() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.token === 'string' && parsed.token.length >= 32) {
      return { token: parsed.token, created: false, file: CONFIG_FILE }
    }
  } catch {
    // No config yet, or an unreadable one: fall through and write a fresh token.
  }
  const token = generateToken()
  await mkdir(CONFIG_DIRECTORY, { recursive: true })
  await writeFile(CONFIG_FILE, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 })
  return { token, created: true, file: CONFIG_FILE }
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{ vault: string, port: number, host: string, token: string | null, tlsCert: string | null, tlsKey: string | null, printReady: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    vault: '',
    port: 4899,
    host: '127.0.0.1',
    /** @type {string | null} */
    token: null,
    /** @type {string | null} */
    tlsCert: null,
    /** @type {string | null} */
    tlsKey: null,
    printReady: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} needs a value.`)
      i += 1
      return next
    }
    switch (argument) {
      case '--vault':
        options.vault = value()
        break
      case '--port':
        options.port = Number(value())
        break
      case '--host':
        options.host = value()
        break
      case '--token':
        options.token = value()
        break
      case '--tls-cert':
        options.tlsCert = value()
        break
      case '--tls-key':
        options.tlsKey = value()
        break
      case '--print-ready':
        options.printReady = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}.`)
        if (!options.vault) options.vault = argument
    }
  }

  // Port 0 asks the operating system for a free one. That is what a wrapper
  // launching this server wants: it cannot know which ports are already taken,
  // and it reads the real one back from the ready line.
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`--port must be a number between 0 and 65535, not "${options.port}".`)
  }
  if ((options.tlsCert === null) !== (options.tlsKey === null)) {
    throw new Error('--tls-cert and --tls-key must be given together.')
  }
  options.vault = options.vault ? resolve(options.vault) : resolve(process.cwd(), 'vault')
  return options
}

export const HELP = `
SpaceFore sync server — one vault, one owner, any number of devices.

  node server/index.mjs --vault ~/Notes [options]

Options
  --vault <dir>     Folder of Markdown files to serve. Created if missing.
  --port <number>   Port to listen on (default 4899). 0 asks the system for a
                    free one, which it then reports on the ready line below.
  --host <address>  Address to bind (default 127.0.0.1 — loopback only).
                    Use 0.0.0.0 to reach it from other devices on your network.
  --token <value>   Access token. Defaults to one stored in ~/.spacefore/server.json.
  --tls-cert <file> Certificate for HTTPS. Usually unnecessary: a tunnel
  --tls-key <file>  (Tailscale, Cloudflare) terminates TLS for you.
  --print-ready     Print one line of JSON on stdout once the server is
                    listening: {"spacefore":"ready","url":…,"port":…,"token":…,
                    "vault":…}. For a program launching this server — the macOS
                    app does — so it does not have to read the banner meant for
                    people.
  -h, --help        Show this.

See docs/SERVER.md for reaching it from other devices, and for keeping it
running in the background on a Mac.
`.trimStart()

export { CONFIG_FILE, dirname }
