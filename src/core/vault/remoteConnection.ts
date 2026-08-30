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
}

export const REMOTE_KEY = 'spacefore.remote'

export function loadRemoteConnection(): RemoteConnection | null {
  try {
    const raw = localStorage.getItem(REMOTE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { url, token, name } = parsed as Record<string, unknown>
    if (typeof url !== 'string' || url === '') return null
    if (typeof token !== 'string' || token === '') return null
    return { url, token, ...(typeof name === 'string' ? { name } : {}) }
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
