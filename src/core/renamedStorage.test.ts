import { beforeEach, describe, expect, it } from 'vitest'

import { adoptRenamedStorage, CURRENT_PREFIX, PREVIOUS_PREFIX } from './renamedStorage'

/** A `Storage` that behaves like the real one, including the index walk. */
function fakeStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries))
  return {
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage
}

beforeEach(() => {
  localStorage.clear()
})

describe('carrying settings across the rename', () => {
  it('copies every old key to its new name', () => {
    const storage = fakeStorage({
      'spacefore.settings': '{"theme":"light"}',
      'spacefore.vault': '{"kind":"browser"}',
      'spacefore.explorer.open': '["Ideas"]',
    })

    expect(adoptRenamedStorage(storage).sort()).toEqual([
      'spacelink.explorer.open',
      'spacelink.settings',
      'spacelink.vault',
    ])
    expect(storage.getItem('spacelink.settings')).toBe('{"theme":"light"}')
    expect(storage.getItem('spacelink.vault')).toBe('{"kind":"browser"}')
    // Nested names keep their whole tail, not just the first segment.
    expect(storage.getItem('spacelink.explorer.open')).toBe('["Ideas"]')
  })

  it('leaves the old keys where they are', () => {
    // Copied, not moved: an older build opened afterwards still finds what it
    // expects rather than an empty profile.
    const storage = fakeStorage({ 'spacefore.settings': '{"theme":"light"}' })
    adoptRenamedStorage(storage)
    expect(storage.getItem('spacefore.settings')).toBe('{"theme":"light"}')
  })

  it('never overwrites something the reader has already changed', () => {
    // The whole reason this is safe to run on every boot. Once a setting has
    // been saved under the new name, the stale one must not come back.
    const storage = fakeStorage({
      'spacefore.settings': '{"theme":"dark"}',
      'spacelink.settings': '{"theme":"light"}',
    })
    expect(adoptRenamedStorage(storage)).toEqual([])
    expect(storage.getItem('spacelink.settings')).toBe('{"theme":"light"}')
  })

  it('copies the one entry that would otherwise ask for a password again', () => {
    // The sync-server pairing. Losing it is not cosmetic: the reader is sent
    // back to the vault picker to sign in on a device that was already signed
    // in, which reads as the app having forgotten them.
    const pairing = '{"url":"http://mac.local:4899","token":"session","email":"me@example.com"}'
    const storage = fakeStorage({ 'spacefore.remote': pairing })
    adoptRenamedStorage(storage)
    expect(storage.getItem('spacelink.remote')).toBe(pairing)
  })

  it('touches nothing that was not filed under the old name', () => {
    const storage = fakeStorage({ 'unrelated': 'x', 'spacefore': 'no dot, not ours' })
    expect(adoptRenamedStorage(storage)).toEqual([])
    expect(storage.getItem('unrelated')).toBe('x')
    expect(storage.getItem('spacelink')).toBeNull()
  })

  it('copies all of them, not just the first', () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`${PREVIOUS_PREFIX}key${index}`, String(index)]),
    )
    const storage = fakeStorage(many)
    expect(adoptRenamedStorage(storage)).toHaveLength(20)
    for (let index = 0; index < 20; index += 1) {
      expect(storage.getItem(`${CURRENT_PREFIX}key${index}`), `key${index}`).toBe(String(index))
    }
  })

  it('runs twice without doing anything the second time', () => {
    const storage = fakeStorage({ 'spacefore.settings': '{"theme":"light"}' })
    expect(adoptRenamedStorage(storage)).toEqual(['spacelink.settings'])
    expect(adoptRenamedStorage(storage)).toEqual([])
  })

  it('gives up quietly on storage that refuses to be used', () => {
    // A private window, or a browser set to block site data. Starting fresh is
    // what that reader would have got anyway; a thrown error is not.
    const hostile = {
      get length(): number {
        throw new Error('access denied')
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    } as unknown as Storage
    expect(() => adoptRenamedStorage(hostile)).not.toThrow()
    expect(adoptRenamedStorage(hostile)).toEqual([])
    expect(() => adoptRenamedStorage(undefined)).not.toThrow()
  })

  it('keeps what it managed to copy when storage fills up part-way', () => {
    const map = new Map([
      ['spacefore.a', '1'],
      ['spacefore.b', '2'],
    ])
    let writes = 0
    const cramped = {
      get length() {
        return map.size
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1
        if (writes > 1) throw new Error('QuotaExceededError')
        map.set(key, value)
      },
      removeItem: () => {},
      clear: () => {},
    } as unknown as Storage

    expect(() => adoptRenamedStorage(cramped)).not.toThrow()
    expect(map.get('spacelink.a')).toBe('1')
  })

  it('works against the real localStorage, which is where it actually runs', () => {
    localStorage.setItem('spacefore.starred', '["Home.md"]')
    localStorage.setItem('spacefore.paneSizes', '[0.5,0.5]')
    localStorage.setItem('spacelink.paneSizes', '[0.3,0.7]')

    adoptRenamedStorage()

    expect(localStorage.getItem('spacelink.starred')).toBe('["Home.md"]')
    // Already set under the new name, so it stands.
    expect(localStorage.getItem('spacelink.paneSizes')).toBe('[0.3,0.7]')
  })
})
