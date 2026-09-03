import { RemoteRefused } from './remoteVault'

/**
 * The sync server this device is paired with.
 *
 * Stored in `localStorage`, which is the same place the app already keeps the
 * reader's settings and, for a browser vault, their notes. The token is
 * therefore only as private as the browser profile it lives in — which is the
 * honest trade for a device that must reconnect on its own after a reload.
 * `forgetRemoteConnection` is what a shared or borrowed device needs.
 */
export interface RemoteConnection {
  /** Origin of the server, e.g. `https://notes.example.ts.net`. */
  url: string
  token: string
  /** Vault name the server reported when it was paired, for the picker. */
  name?: string
  /**
   * The account this device signed in as, when it did.
   *
   * Absent for a device paired with the server's access token — the two
   * credentials fail differently and are worth telling apart: a token was
   * rotated and must be copied again, while a sign-in expired and needs the
   * password. The password itself is never kept, here or anywhere.
   */
  email?: string
}

export const REMOTE_KEY = 'spacelink.remote'

/**
 * What to tell the reader when a remembered server could not be reopened.
 *
 * There are two failures behind that one moment and the advice is opposite.
 * A server that is asleep, off the network, or being restarted comes back, and
 * the pairing works again by itself — so "reload once it is back" is exactly
 * right. A credential the server refused never comes back: a session ended
 * from another device, or an account whose password was changed, which is the
 * command documented as signing every device out. Measured: the server
 * answered 200 on `/api/health` and 401 on the credential, and the reader was
 * told their server could not be reached and to reload until it was — advice
 * that could not work however long they followed it.
 *
 * The pairing is kept either way: it is what pre-fills the address and the
 * email, so signing in again is one field rather than a fresh setup.
 */
export function reconnectFailure(error: unknown): string {
  if (error instanceof RemoteRefused) {
    return `${error.message} Open “Connect to a server” from the status bar.`
  }
  return 'Could not reach your sync server. Your pairing is kept — reload once it is back.'
}

export function loadRemoteConnection(): RemoteConnection | null {
  try {
    const raw = localStorage.getItem(REMOTE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { url, token, name, email } = parsed as Record<string, unknown>
    if (typeof url !== 'string' || url === '') return null
    if (typeof token !== 'string' || token === '') return null
    return {
      url,
      token,
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof email === 'string' && email !== '' ? { email } : {}),
    }
  } catch {
    return null
  }
}

export function saveRemoteConnection(connection: RemoteConnection): void {
  try {
    localStorage.setItem(REMOTE_KEY, JSON.stringify(connection))
  } catch {
    // Private mode: the device simply asks for the address again next time.
  }
}

export function forgetRemoteConnection(): void {
  try {
    localStorage.removeItem(REMOTE_KEY)
  } catch {
    /* nothing to forget */
  }
}

/* ------------------------------------------------------------------ *
 * Being launched by a local host
 * ------------------------------------------------------------------ */

/**
 * Whether an origin is this machine talking to itself.
 *
 * Only these get to hand a token over in a URL. `localhost` and the loopback
 * addresses never leave the machine, so the token cannot be read off the wire,
 * logged by a proxy, or sent as a referrer to anywhere real.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  // 127.0.0.0/8 — every one of them is this machine.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * A connection handed to this page in its own address, by whatever started it.
 *
 * The macOS app launches the sync server on a port the system picked, with a
 * token it generated for that launch, and then opens this page — so there is
 * nobody to type the token in, and nothing sensible to type. It arrives as
 * `#token=…` instead.
 *
 * The fragment, not the query string: a fragment is never sent to a server, so
 * it cannot land in an access log even by accident. And only from a loopback
 * origin, so a link someone was sent can never pair their app with a stranger's
 * server.
 *
 * Returns null and leaves the address alone when any of that does not hold.
 */
export function takeHandoffConnection(location: Location, history: History): RemoteConnection | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  if (!hash) return null

  let token: string | null
  try {
    token = new URLSearchParams(hash).get('token')
  } catch {
    return null
  }
  if (!token) return null

  // Consume it either way: an ignored token must not sit in the address bar,
  // in the window title, or in whatever the reader pastes to a colleague next.
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } catch {
    /* a page that cannot rewrite its own URL still must not use the token */
    return null
  }

  if (!isLoopbackOrigin(location.origin)) return null
  return { url: location.origin, token }
}
