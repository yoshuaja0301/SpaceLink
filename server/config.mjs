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
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Where the token and the accounts live.
 *
 * `~/.spacelink` now, `~/.spacefore` before the app was renamed. The old folder
 * is used when it is the only one there, because the alternative is silent: a
 * server that started against a fresh directory would mint a new token and find
 * no accounts, and every paired device would be turned away with nothing
 * explaining why. Once `~/.spacelink` exists it wins, so nothing is ever read
 * from two places at once.
 */
function configDirectory() {
  const current = join(homedir(), '.spacelink')
  const previous = join(homedir(), '.spacefore')
  if (existsSync(current)) return current
  return existsSync(previous) ? previous : current
}

const CONFIG_DIRECTORY = configDirectory()
const CONFIG_FILE = join(CONFIG_DIRECTORY, 'server.json')
/** Accounts and their sessions. Beside the token, and just as private. */
const ACCOUNTS_FILE = join(CONFIG_DIRECTORY, 'accounts.json')

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
      // The token is the whole of the vault's access, and this file is read on
      // every start and rewritten on none — so a file left readable by every
      // account on the machine, by an older build or by whatever copied it
      // here, stayed that way for as long as it was valid. Measured: 644 in,
      // 644 out, token kept. Tightened on the way past, which costs nothing
      // when it is already right.
      await tightenMode(CONFIG_FILE)
      return { token: parsed.token, created: false, file: CONFIG_FILE }
    }
  } catch {
    // No config yet, or an unreadable one: fall through and write a fresh token.
  }
  const token = generateToken()
  await mkdir(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 })
  // Through a temporary file and a rename, for two reasons. A power cut in the
  // middle of a plain write would leave half a file, and half a file is a
  // fresh token on the next start and every paired device sent to copy it
  // again. And `mode` on a write applies only to a file being created: a
  // fresh token written over a file that already existed, readable by all,
  // kept that file's mode — measured, 644 — while the rename always lands the
  // new file with its own.
  const temporary = `${CONFIG_FILE}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, CONFIG_FILE)
  return { token, created: true, file: CONFIG_FILE }
}

/**
 * Make `file` readable by its owner only, when it is not already.
 *
 * Exported because the accounts file needs exactly this and needs it for the
 * same reason: it is written 0600 and read on every start, so one that arrived
 * some other way — restored from a backup, unpacked from an archive that did
 * not carry modes, copied under a different umask — kept the mode it arrived
 * with for as long as nobody wrote to it. Measured on `accounts.json`, which
 * holds every password hash and every session id: 644 in, served, 644 still.
 *
 * A file that is not there, or not ours to change, is not an error. Refusing
 * to start over a mode would be worse than the mode.
 */
export async function tightenMode(file) {
  const info = await stat(file)
  if ((info.mode & 0o077) !== 0) await chmod(file, 0o600)
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{ vault: string, vaultChosen: boolean, port: number, host: string, token: string | null, tlsCert: string | null, tlsKey: string | null, printReady: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    vault: '',
    /**
     * Whether a folder was actually named, as opposed to the default below.
     *
     * Serving `./vault` when nobody said otherwise is a convenience. Writing
     * `./vault` into an account record is not: it is a folder the person never
     * chose, remembered permanently, and different depending on where they
     * happened to be standing when they typed the command.
     */
    vaultChosen: false,
    port: 4899,
    host: '127.0.0.1',
    /** @type {string | null} */
    token: null,
    /** @type {string | null} */
    accounts: null,
    /**
     * Account management, from the terminal and only from the terminal: there
     * is deliberately no sign-up endpoint for these to duplicate.
     * @type {string | null}
     */
    addAccount: null,
    /** @type {string | null} */
    setPassword: null,
    listAccounts: false,
    /** @type {string | null} */
    password: null,
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
      case '--accounts':
        options.accounts = value()
        break
      case '--add-account':
        options.addAccount = value()
        break
      case '--set-password':
        options.setPassword = value()
        break
      case '--list-accounts':
        options.listAccounts = true
        break
      case '--password':
        options.password = value()
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
  if (options.token !== null) {
    // Trimmed, because the token is copied out of a terminal and a copy brings
    // a newline or a space with it more often than not. The server compares it
    // byte for byte, so that stray character is the difference between the
    // token that was handed out and the one being checked against.
    options.token = options.token.trim()
    // And a token with nothing in it is refused rather than used. `--token
    // "$SPACELINK_TOKEN"` with the variable unset is an empty string, not a
    // missing option: the server took it, found it falsy, quietly fell back to
    // the token in ~/.spacelink/server.json, and announced a token nobody had
    // asked for — while every device was configured with the one that was
    // meant to be passed.
    if (options.token === '') {
      throw new Error('--token was given nothing. Leave it out to use the stored token, or pass the token itself.')
    }
  }
  options.vaultChosen = options.vault !== ''
  options.vault = options.vault ? resolve(options.vault) : resolve(process.cwd(), 'vault')
  return options
}

export const HELP = `
SpaceLink sync server — one vault, one owner, any number of devices.

  node server/index.mjs --vault ~/Notes [options]

Options
  --vault <dir>     Folder of Markdown files to serve. Created if missing.
  --port <number>   Port to listen on (default 4899). 0 asks the system for a
                    free one, which it then reports on the ready line below.
  --host <address>  Address to bind (default 127.0.0.1 — loopback only).
                    Use 0.0.0.0 to reach it from other devices on your network.
  --token <value>   Access token. Defaults to one stored in ~/.spacelink/server.json.
                    Surrounding whitespace is trimmed; an empty value is
                    refused rather than quietly falling back to the stored one.
  --tls-cert <file> Certificate for HTTPS. Usually unnecessary: a tunnel
  --tls-key <file>  (Tailscale, Cloudflare) terminates TLS for you.
  --print-ready     Print one line of JSON on stdout once the server is
                    listening: {"spacelink":"ready","url":…,"port":…,"token":…,
                    "vault":…}. For a program launching this server — the macOS
                    app does — so it does not have to read the banner meant for
                    people.
  -h, --help        Show this.

Accounts — sign in from any device instead of pasting a token
  --add-account <email>   Make an account and ask for a password. The account
                          gets --vault as its folder of notes. Made here and
                          only here: the server has no sign-up page.
  --set-password <email>  Change a password. Every device signed in on that
                          account is signed out.
  --list-accounts         Show the accounts, where their notes live, and which
                          devices are signed in.
  --password <value>      Supply the password instead of being asked, for a
                          script. It will be visible in your shell history;
                          piping it in, one line per prompt, is not.
  --accounts <file>       Where accounts live (default ~/.spacelink/accounts.json).

See docs/SERVER.md for reaching it from other devices, and for keeping it
running in the background on a Mac.
`.trimStart()

export { ACCOUNTS_FILE, CONFIG_FILE, dirname }
