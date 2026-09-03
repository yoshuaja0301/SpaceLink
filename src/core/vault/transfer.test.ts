/**
 * Whether a vault survives the trip out to JSON and back.
 *
 * The interesting failure is silent: notes come back and images do not, so the
 * import looks like it worked and the broken pictures are only noticed later,
 * possibly after the original is gone. So the checks here compare bytes, not
 * counts.
 */
import { describe, expect, it, vi } from 'vitest'

import type { NotePath, VaultAdapter, VaultFile } from '../../types'
import { createMemoryVault } from './memoryVault'
import { base64ToBlob, blobToBase64, buildExport, parseImport } from './transfer'

/** The shape `buildExport` reads out of the store. */
function source(
  notes: Record<string, string>,
  attachments: VaultFile[] = [],
  adapter: VaultAdapter | null = null,
): Parameters<typeof buildExport>[0] {
  return {
    vaultName: 'My Vault',
    notes: new Map(Object.entries(notes).map(([path, content]) => [path as NotePath, { content }])),
    attachments,
    adapter,
  }
}

function listed(path: NotePath, size: number): VaultFile {
  return { path, name: path, extension: path.split('.').pop() ?? '', isMarkdown: false, size, mtime: 1 }
}

const bytesOf = async (blob: Blob): Promise<number[]> => [...new Uint8Array(await blob.arrayBuffer())]

describe('blobToBase64 / base64ToBlob', () => {
  it('round-trips bytes that are not valid text', async () => {
    // A PNG header, plus the bytes that break a naive utf-8 round trip.
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80])
    const back = base64ToBlob(await blobToBase64(new Blob([raw])), 'x.png')
    expect(await bytesOf(back)).toEqual([...raw])
  })

  it('types the blob from the path, so a restored image is still an image', () => {
    expect(base64ToBlob('AAA=', 'a/b/diagram.png').type).toBe('image/png')
  })

  it('handles a payload larger than one chunk', async () => {
    // `String.fromCharCode(...bytes)` overflows the call stack somewhere around
    // a hundred thousand arguments, so an unchunked version works on small
    // images and throws on exactly the large ones worth keeping.
    const big = new Uint8Array(300_000)
    for (let index = 0; index < big.length; index += 1) big[index] = index % 256
    const back = base64ToBlob(await blobToBase64(new Blob([big])), 'big.bin')
    expect(await bytesOf(back)).toEqual([...big])
  })
})

describe('buildExport', () => {
  it('writes the notes', async () => {
    const { payload } = await buildExport(source({ 'a.md': '# A', 'sub/b.md': 'B' }))
    expect(payload.notes).toEqual({ 'a.md': '# A', 'sub/b.md': 'B' })
    expect(payload.vault).toBe('My Vault')
  })

  it('leaves the attachments key out when the vault has none', async () => {
    // An export of a notes-only vault stays byte-for-byte the shape it always
    // had, so nothing that reads the old files has to change.
    const { payload } = await buildExport(source({ 'a.md': 'A' }))
    expect('attachments' in payload).toBe(false)
  })

  it('carries the attachment bytes, not just its name', async () => {
    const vault = createMemoryVault({}, { name: 'v' })
    const raw = new Uint8Array([1, 2, 3, 250, 251, 252])
    await vault.writeBinary('img/diagram.png', new Blob([raw]))

    const { payload, skipped } = await buildExport(
      source({ 'a.md': '![[diagram.png]]' }, [listed('img/diagram.png', raw.length)], vault),
    )
    expect(skipped).toEqual([])
    const encoded = payload.attachments?.['img/diagram.png']
    expect(typeof encoded).toBe('string')
    expect(await bytesOf(base64ToBlob(encoded!, 'img/diagram.png'))).toEqual([...raw])
  })

  it('names what it could not read rather than losing the whole export', async () => {
    const vault = createMemoryVault({}, { name: 'v' })
    await vault.writeBinary('good.png', new Blob([new Uint8Array([7])]))
    const broken = {
      ...vault,
      readBinary: vi.fn(async (path: NotePath) => {
        if (path === 'gone.png') throw new Error('no such file')
        return vault.readBinary(path)
      }),
    }

    const { payload, skipped } = await buildExport(
      source({ 'a.md': 'A' }, [listed('good.png', 1), listed('gone.png', 1)], broken),
    )
    // The two hundred notes are worth more than the one missing image.
    expect(payload.notes).toEqual({ 'a.md': 'A' })
    expect(Object.keys(payload.attachments ?? {})).toEqual(['good.png'])
    expect(skipped).toEqual(['gone.png'])
  })

  it('skips everything when there is no adapter to read through', async () => {
    const { payload, skipped } = await buildExport(source({ 'a.md': 'A' }, [listed('x.png', 1)], null))
    expect('attachments' in payload).toBe(false)
    expect(skipped).toEqual(['x.png'])
  })
})

describe('parseImport', () => {
  it('reads attachments back as blobs', async () => {
    const parsed = parseImport({ notes: { 'a.md': 'A' }, attachments: { 'p.png': 'AQID' } })
    expect(parsed.notes).toEqual([['a.md', 'A']])
    expect(parsed.attachments.map(([path]) => path)).toEqual(['p.png'])
    expect(await bytesOf(parsed.attachments[0]![1])).toEqual([1, 2, 3])
  })

  it('reads an export written before attachments existed', async () => {
    const parsed = parseImport({ vault: 'v', exportedAt: 'then', notes: { 'a.md': 'A' } })
    expect(parsed.notes).toEqual([['a.md', 'A']])
    expect(parsed.attachments).toEqual([])
    expect(parsed.unreadable).toEqual([])
  })

  it('names an attachment it cannot decode instead of throwing', () => {
    const parsed = parseImport({ notes: {}, attachments: { 'bad.png': '!!!not base64!!!', 'ok.png': 'AQ==' } })
    expect(parsed.unreadable).toEqual(['bad.png'])
    expect(parsed.attachments.map(([path]) => path)).toEqual(['ok.png'])
  })

  it('names a note whose path the vault cannot hold, instead of importing it as a phantom', () => {
    const parsed = parseImport({ notes: { '../outside.md': 'x', 'ok.md': 'y', 'a//b.md': 'z', ' padded.md ': 'p' } })
    expect(parsed.notes).toEqual([
      ['ok.md', 'y'],
      ['a/b.md', 'z'],
      ['padded.md', 'p'],
    ])
    expect(parsed.unreadable).toEqual(['../outside.md'])
  })

  it('ignores a malformed attachments block', () => {
    for (const attachments of [null, 'nope', 42, ['a.png']]) {
      expect(parseImport({ notes: { 'a.md': 'A' }, attachments }).attachments).toEqual([])
    }
  })
})

describe('a whole vault, out and back', () => {
  it('arrives byte-for-byte, through real JSON', async () => {
    const original = createMemoryVault({}, { name: 'original' })
    await original.write('Home.md', '# Home\n\nSee ![[img/diagram.png]] and [[Ideas/Seed]].\n')
    await original.write('Ideas/Seed.md', '---\ntag: pkm\n---\n\n# Seed — ünïcödé ✅\n')
    const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 254, 255])
    await original.writeBinary('img/diagram.png', new Blob([picture]))
    await original.writeBinary('docs/paper.pdf', new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]))

    const files = await original.list()
    const notes = new Map<NotePath, { content: string }>()
    for (const file of files.filter((file) => file.isMarkdown)) {
      notes.set(file.path, { content: await original.read(file.path) })
    }

    const { payload, skipped } = await buildExport({
      vaultName: 'original',
      notes,
      attachments: files.filter((file) => !file.isMarkdown),
      adapter: original,
    })
    expect(skipped).toEqual([])

    // Through the actual file a person would carry around.
    const parsed = parseImport(JSON.parse(JSON.stringify(payload)) as unknown)
    expect(parsed.unreadable).toEqual([])

    const restored = createMemoryVault({}, { name: 'restored' })
    for (const [path, content] of parsed.notes) await restored.write(path, content)
    for (const [path, blob] of parsed.attachments) await restored.writeBinary(path, blob)

    const paths = (list: VaultFile[]): string[] => list.map((file) => file.path).sort()
    expect(paths(await restored.list())).toEqual(paths(files))
    for (const file of files) {
      if (file.isMarkdown) expect(await restored.read(file.path)).toBe(await original.read(file.path))
      else expect(await bytesOf(await restored.readBinary(file.path))).toEqual(await bytesOf(await original.readBinary(file.path)))
    }
  })
})
