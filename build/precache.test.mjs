/**
 * The list the service worker precaches, and the name of the cache holding it.
 *
 * `e2e/12-offline.mjs` proves the outcome — the app opens with the network
 * down. These pin the parts that are easy to get quietly wrong: what is left
 * out, and whether the cache name really changes when the build does.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildId, precacheList, shouldPrecache, walk } from './precache.mjs'

describe('shouldPrecache', () => {
  it('keeps the things the app is made of', () => {
    for (const file of ['index.html', 'assets/index-abc123.js', 'assets/KaTeX_Main-Regular-x.woff2', 'manifest.webmanifest', 'icon-512.png']) {
      expect({ file, kept: shouldPrecache(file) }).toEqual({ file, kept: true })
    }
  })

  it('never caches the worker itself', () => {
    // A worker served to itself from its own cache is a worker you cannot
    // replace: whatever is wrong with it becomes permanent.
    expect(shouldPrecache('sw.js')).toBe(false)
  })

  it('leaves sourcemaps out', () => {
    // They are twice the weight of everything else and are for a debugger,
    // which is not a thing you have on a train.
    expect(shouldPrecache('assets/index-abc123.js.map')).toBe(false)
    expect(shouldPrecache('assets/index-abc123.css.map')).toBe(false)
  })
})

describe('precacheList', () => {
  it('leads with the shell, which is what a navigation asks for', () => {
    const list = precacheList(['index.html', 'assets/a-1.js'])
    expect(list[0]).toBe('./')
  })

  it('keeps index.html as well as the shell', () => {
    // Different cache keys: `./` answers a navigation, `./index.html` answers
    // anyone who links it directly.
    expect(precacheList(['index.html'])).toEqual(['./', './index.html'])
  })

  it('drops what should not be there and sorts the rest', () => {
    expect(precacheList(['sw.js', 'assets/b-2.js.map', 'assets/b-2.js', 'assets/a-1.js', 'index.html'])).toEqual([
      './',
      './assets/a-1.js',
      './assets/b-2.js',
      './index.html',
    ])
  })

  it('is stable however the build orders its output', () => {
    const files = ['index.html', 'assets/z.js', 'assets/a.js', 'manifest.webmanifest']
    expect(precacheList(files)).toEqual(precacheList([...files].reverse()))
  })
})

describe('buildId', () => {
  const entries = [
    { file: 'index.html', bytes: Buffer.from('<html>one</html>') },
    { file: 'assets/a.js', bytes: Buffer.from('console.log(1)') },
  ]

  it('is the same for the same build', () => {
    expect(buildId(entries)).toBe(buildId([...entries].reverse()))
  })

  it('changes when a file’s contents change', () => {
    // This is what retires the previous cache, so it has to move whenever the
    // bytes do — including for the files whose names carry no hash.
    const edited = [{ ...entries[0], bytes: Buffer.from('<html>two</html>') }, entries[1]]
    expect(buildId(edited)).not.toBe(buildId(entries))
  })

  it('changes when a file is added or removed', () => {
    expect(buildId(entries.slice(0, 1))).not.toBe(buildId(entries))
  })

  it('does not confuse a rename with an edit', () => {
    // Concatenating name and bytes without a separator would let
    // ('ab', 'c') and ('a', 'bc') collide.
    const first = [{ file: 'ab', bytes: Buffer.from('c') }]
    const second = [{ file: 'a', bytes: Buffer.from('bc') }]
    expect(buildId(first)).not.toBe(buildId(second))
  })
})

describe('walk', () => {
  it('finds nested files, with forward slashes whatever the platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spacelink-precache-'))
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), 'x')
    await writeFile(join(root, 'assets', 'a-1.js'), 'y')
    expect(await walk(root)).toEqual(['assets/a-1.js', 'index.html'])
  })
})
