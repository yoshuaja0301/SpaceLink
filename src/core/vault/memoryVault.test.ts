import type { VaultAdapter } from '../../types'
import { createMemoryVault } from './memoryVault'

const BASE_MTIME = 1_700_000_000_000

const seed = {
  'Welcome.md': '# Welcome\n\nHello [[Ideas]].',
  'notes/Ideas.md': '# Ideas',
  'assets/diagram.png': 'not really a png',
}

function makeVault(): VaultAdapter {
  return createMemoryVault(seed)
}

describe('createMemoryVault — identity', () => {
  it('is a writable demo vault with a default name', () => {
    const vault = makeVault()
    expect(vault.kind).toBe('demo')
    expect(vault.writable).toBe(true)
    expect(vault.name).toBe('In-memory vault')
  })

  it('honours name and writable options', () => {
    const vault = createMemoryVault({}, { name: 'Docs', writable: false })
    expect(vault.name).toBe('Docs')
    expect(vault.writable).toBe(false)
  })
})

describe('createMemoryVault — list', () => {
  it('lists notes and attachments sorted by path', async () => {
    const files = await makeVault().list()
    expect(files.map((file) => file.path)).toEqual(['Welcome.md', 'assets/diagram.png', 'notes/Ideas.md'])
  })

  it('describes markdown notes and attachments differently', async () => {
    const files = await makeVault().list()
    const [welcome, diagram] = files
    expect(welcome).toMatchObject({ name: 'Welcome', extension: 'md', isMarkdown: true })
    expect(diagram).toMatchObject({ name: 'diagram.png', extension: 'png', isMarkdown: false })
  })

  it('reports byte sizes, not code-unit lengths', async () => {
    const vault = createMemoryVault({ 'a.md': 'héllo' })
    const [file] = await vault.list()
    expect(file?.size).toBe(6)
  })

  it('seeds deterministic mtimes from a fixed base plus the seed index', async () => {
    const files = await makeVault().list()
    const byPath = new Map(files.map((file) => [file.path, file.mtime]))
    expect(byPath.get('Welcome.md')).toBe(BASE_MTIME)
    expect(byPath.get('notes/Ideas.md')).toBe(BASE_MTIME + 1)
    expect(byPath.get('assets/diagram.png')).toBe(BASE_MTIME + 2)
  })

  it('produces identical mtimes for two vaults built from the same seed', async () => {
    const a = await makeVault().list()
    const b = await makeVault().list()
    expect(a).toEqual(b)
  })

  it('normalises seeded paths', async () => {
    const vault = createMemoryVault({ './notes//a.md': 'A', '/b.md': 'B' })
    expect((await vault.list()).map((file) => file.path)).toEqual(['b.md', 'notes/a.md'])
  })
})

describe('createMemoryVault — read', () => {
  it('reads seeded content', async () => {
    expect(await makeVault().read('notes/Ideas.md')).toBe('# Ideas')
  })

  it('accepts non-canonical paths', async () => {
    const vault = makeVault()
    expect(await vault.read('./notes/Ideas.md')).toBe('# Ideas')
    expect(await vault.read('/notes//Ideas.md')).toBe('# Ideas')
  })

  it('throws a showable error for a missing file', async () => {
    await expect(makeVault().read('nope.md')).rejects.toThrow('File not found: nope.md')
  })

  it('rejects path traversal', async () => {
    await expect(makeVault().read('../../etc/passwd')).rejects.toThrow(/".." segments are not allowed/)
  })
})

describe('createMemoryVault — write', () => {
  it('creates a new file, including intermediate folders', async () => {
    const vault = makeVault()
    await vault.write('deep/nested/folder/New.md', '# New')
    expect(await vault.read('deep/nested/folder/New.md')).toBe('# New')
    expect((await vault.list()).map((file) => file.path)).toContain('deep/nested/folder/New.md')
  })

  it('overwrites an existing file addressed by an equivalent path', async () => {
    const vault = makeVault()
    await vault.write('./notes/Ideas.md', 'replaced')
    expect(await vault.read('notes/Ideas.md')).toBe('replaced')
    expect((await vault.list()).filter((file) => file.path === 'notes/Ideas.md')).toHaveLength(1)
  })

  it('advances the mtime by one on every write', async () => {
    const vault = makeVault()
    await vault.write('a.md', '1')
    await vault.write('b.md', '2')
    const mtimes = new Map((await vault.list()).map((file) => [file.path, file.mtime]))
    // Three seeded files occupy BASE..BASE+2.
    expect(mtimes.get('a.md')).toBe(BASE_MTIME + 3)
    expect(mtimes.get('b.md')).toBe(BASE_MTIME + 4)
  })

  it('rejects path traversal', async () => {
    await expect(makeVault().write('../escape.md', 'x')).rejects.toThrow(/".." segments are not allowed/)
  })
})

describe('createMemoryVault — binary files', () => {
  it('round-trips a blob', async () => {
    const vault = makeVault()
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
    await vault.writeBinary('assets/logo.png', blob)

    const stored = await vault.readBinary('assets/logo.png')
    expect(stored.size).toBe(4)
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))

    const file = (await vault.list()).find((entry) => entry.path === 'assets/logo.png')
    expect(file).toMatchObject({ size: 4, extension: 'png', isMarkdown: false })
  })

  it('decodes a binary entry when read as text', async () => {
    const vault = makeVault()
    await vault.writeBinary('notes/raw.md', new Blob(['# From a blob']))
    expect(await vault.read('notes/raw.md')).toBe('# From a blob')
  })

  it('wraps a text entry into a typed blob', async () => {
    const blob = await makeVault().readBinary('notes/Ideas.md')
    expect(blob.type).toBe('text/markdown')
    expect(await blob.text()).toBe('# Ideas')
  })

  it('throws for a missing binary file', async () => {
    await expect(makeVault().readBinary('nope.png')).rejects.toThrow('File not found: nope.png')
  })
})

describe('createMemoryVault — rename', () => {
  it('moves content to the new path', async () => {
    const vault = makeVault()
    await vault.rename('notes/Ideas.md', 'archive/Old Ideas.md')
    expect(await vault.read('archive/Old Ideas.md')).toBe('# Ideas')
    expect(await vault.exists('notes/Ideas.md')).toBe(false)
    expect((await vault.list()).map((file) => file.path)).toEqual([
      'Welcome.md',
      'archive/Old Ideas.md',
      'assets/diagram.png',
    ])
  })

  it('bumps the mtime of the renamed file', async () => {
    const vault = makeVault()
    await vault.rename('Welcome.md', 'Start.md')
    const file = (await vault.list()).find((entry) => entry.path === 'Start.md')
    expect(file?.mtime).toBe(BASE_MTIME + 3)
  })

  it('throws when the source does not exist', async () => {
    await expect(makeVault().rename('ghost.md', 'other.md')).rejects.toThrow('File not found: ghost.md')
  })

  it('throws when the target already exists', async () => {
    await expect(makeVault().rename('Welcome.md', 'notes/Ideas.md')).rejects.toThrow(/already exists/)
  })

  it('is a no-op when the target normalises to the source', async () => {
    const vault = makeVault()
    await vault.rename('Welcome.md', './Welcome.md')
    expect(await vault.read('Welcome.md')).toBe(seed['Welcome.md'])
  })

  it('keeps binary payloads intact', async () => {
    const vault = makeVault()
    await vault.writeBinary('a.bin', new Blob([new Uint8Array([9, 9])]))
    await vault.rename('a.bin', 'sub/b.bin')
    expect((await vault.readBinary('sub/b.bin')).size).toBe(2)
  })
})

describe('createMemoryVault — remove', () => {
  it('deletes a file', async () => {
    const vault = makeVault()
    await vault.remove('assets/diagram.png')
    expect(await vault.exists('assets/diagram.png')).toBe(false)
    expect(await vault.list()).toHaveLength(2)
  })

  it('throws for a missing file', async () => {
    await expect(makeVault().remove('ghost.md')).rejects.toThrow('File not found: ghost.md')
  })
})

describe('createMemoryVault — exists', () => {
  it('never throws', async () => {
    const vault = makeVault()
    expect(await vault.exists('Welcome.md')).toBe(true)
    expect(await vault.exists('./Welcome.md')).toBe(true)
    expect(await vault.exists('ghost.md')).toBe(false)
    expect(await vault.exists('../escape.md')).toBe(false)
    expect(await vault.exists('')).toBe(false)
  })
})

describe('createMemoryVault — read-only mode', () => {
  const readOnly = (): VaultAdapter => createMemoryVault(seed, { name: 'Read only', writable: false })

  it('still lists and reads', async () => {
    const vault = readOnly()
    expect(await vault.list()).toHaveLength(3)
    expect(await vault.read('Welcome.md')).toBe(seed['Welcome.md'])
  })

  it('refuses every mutation with a showable message', async () => {
    const vault = readOnly()
    await expect(vault.write('a.md', 'x')).rejects.toThrow('The "Read only" vault is read-only.')
    await expect(vault.writeBinary('a.bin', new Blob(['x']))).rejects.toThrow(/read-only/)
    await expect(vault.remove('Welcome.md')).rejects.toThrow(/read-only/)
    await expect(vault.rename('Welcome.md', 'Other.md')).rejects.toThrow(/read-only/)
  })

  it('leaves the contents untouched after a refused write', async () => {
    const vault = readOnly()
    await expect(vault.write('Welcome.md', 'nope')).rejects.toThrow(/read-only/)
    expect(await vault.read('Welcome.md')).toBe(seed['Welcome.md'])
    expect(await vault.list()).toHaveLength(3)
  })
})
