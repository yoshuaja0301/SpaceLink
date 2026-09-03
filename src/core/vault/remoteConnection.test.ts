/**
 * Pairing details this device holds, and the one case where they arrive in a
 * URL rather than from a person.
 *
 * The handover exists because the macOS app starts the sync server itself, on a
 * port the system chose, with a token it generated for that launch — so there
 * is nobody to type it in. That convenience is also the risk, so most of what
 * is checked here is the cases it must refuse.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  REMOTE_KEY,
  forgetRemoteConnection,
  isLoopbackOrigin,
  loadRemoteConnection,
  saveRemoteConnection,
  takeHandoffConnection,
} from './remoteConnection'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('remembering a pairing', () => {
  it('round-trips what it was given', () => {
    saveRemoteConnection({ url: 'https://notes.example.ts.net', token: 'abc', name: 'Notes' })
    expect(loadRemoteConnection()).toEqual({ url: 'https://notes.example.ts.net', token: 'abc', name: 'Notes' })
  })

  it('treats a half-written entry as no pairing at all', () => {
    for (const bad of ['{}', '{"url":"http://x"}', '{"token":"t"}', '{"url":"","token":"t"}', 'not json', 'null']) {
      localStorage.setItem(REMOTE_KEY, bad)
      expect(loadRemoteConnection(), bad).toBeNull()
    }
  })

  it('forgets on request, which is what a borrowed device needs', () => {
    saveRemoteConnection({ url: 'http://localhost:4899', token: 'abc' })
    forgetRemoteConnection()
    expect(loadRemoteConnection()).toBeNull()
  })

  it('remembers the account a device signed in as, and never a password', () => {
    saveRemoteConnection({ url: 'https://notes.example.ts.net', token: 'session', email: 'me@example.com' })
    expect(loadRemoteConnection()).toEqual({
      url: 'https://notes.example.ts.net',
      token: 'session',
      email: 'me@example.com',
    })
    // Nothing else of the sign-in is kept — the password was used once, by the
    // request that exchanged it for this session.
    expect(localStorage.getItem(REMOTE_KEY)).not.toMatch(/password/i)
  })

  it('leaves the account off a pairing that was made with a token', () => {
    // The two fail differently and are told apart by this field alone: a
    // rotated token is copied again, an expired sign-in needs the password.
    saveRemoteConnection({ url: 'http://localhost:4899', token: 'abc' })
    expect(loadRemoteConnection()).toEqual({ url: 'http://localhost:4899', token: 'abc' })
    for (const bad of ['{"url":"http://x","token":"t","email":""}', '{"url":"http://x","token":"t","email":7}']) {
      localStorage.setItem(REMOTE_KEY, bad)
      expect(loadRemoteConnection(), bad).toEqual({ url: 'http://x', token: 't' })
    }
  })
})

describe('isLoopbackOrigin', () => {
  it('accepts this machine, however it is spelled', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:4899',
      'https://localhost:4899',
      'http://127.0.0.1:1',
      'http://127.0.0.1:65535',
      'http://127.9.9.9:4899',
      'http://[::1]:4899',
      'http://app.localhost:4899',
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(true)
    }
  })

  it('refuses everything else', () => {
    for (const origin of [
      'http://192.168.1.20:4899',
      'http://10.0.0.5:4899',
      'https://notes.example.ts.net',
      'https://evil.example.com',
      // The lookalikes: a hostname that merely contains a loopback spelling.
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
      'http://notlocalhost',
      // Not a web origin at all.
      'file:///Users/you/index.html',
      'javascript:alert(1)',
      '',
      'not a url',
    ]) {
      expect(isLoopbackOrigin(origin), origin).toBe(false)
    }
  })
})

/** A stand-in for `window.location` and `window.history` at a given address. */
function pageAt(href: string): { location: Location; history: History; url: () => string } {
  let current = new URL(href)
  const location = {
    get origin() {
      return current.origin
    },
    get pathname() {
      return current.pathname
    },
    get search() {
      return current.search
    },
    get hash() {
      return current.hash
    },
  } as Location
  const history = {
    replaceState(_data: unknown, _title: string, url: string) {
      current = new URL(url, current)
    },
  } as History
  return { location, history, url: () => current.toString() }
}

describe('takeHandoffConnection', () => {
  it('takes a token the local host put in the fragment', () => {
    const page = pageAt('http://127.0.0.1:51234/#token=abc123')
    expect(takeHandoffConnection(page.location, page.history)).toEqual({
      url: 'http://127.0.0.1:51234',
      token: 'abc123',
    })
  })

  it('takes the token out of the address, so it is not left lying there', () => {
    const page = pageAt('http://localhost:4899/?theme=dark#token=abc123')
    takeHandoffConnection(page.location, page.history)
    expect(page.url()).toBe('http://localhost:4899/?theme=dark')
  })

  it('refuses a token from anywhere but this machine — and still discards it', () => {
    // Someone sends a link that would pair the reader's app with their server.
    const page = pageAt('https://notes.attacker.example/#token=stolen')
    expect(takeHandoffConnection(page.location, page.history)).toBeNull()
    // The refusal is not enough on its own: the token must not survive in the
    // address bar either, where the next thing to read it would be a bookmark,
    // a shared link, or the window title.
    expect(page.url()).toBe('https://notes.attacker.example/')
  })

  it('does nothing when there is no handover, and leaves the address alone', () => {
    for (const href of [
      'http://localhost:4899/',
      'http://localhost:4899/#',
      'http://localhost:4899/#section-two',
      'http://localhost:4899/#tokens=abc',
      'http://localhost:4899/#token=',
    ]) {
      const page = pageAt(href)
      expect(takeHandoffConnection(page.location, page.history), href).toBeNull()
    }
    const untouched = pageAt('http://localhost:4899/#section-two')
    takeHandoffConnection(untouched.location, untouched.history)
    expect(untouched.url()).toBe('http://localhost:4899/#section-two')
  })

  it('refuses rather than proceeding when the address cannot be cleaned', () => {
    const page = pageAt('http://localhost:4899/#token=abc123')
    const history = {
      replaceState() {
        throw new Error('blocked')
      },
    } as unknown as History
    expect(takeHandoffConnection(page.location, history)).toBeNull()
  })
})
