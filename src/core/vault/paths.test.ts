import {
  baseName,
  comparePaths,
  dirName,
  displayName,
  extensionOf,
  isMarkdown,
  isValidPath,
  joinPath,
  mimeTypeOf,
  normalizePath,
  pathSegments,
  stemOf,
  toVaultFile,
} from './paths'

describe('normalizePath', () => {
  it('leaves an already canonical path untouched', () => {
    expect(normalizePath('notes/Zettelkasten.md')).toBe('notes/Zettelkasten.md')
  })

  it('strips leading ./ and /', () => {
    expect(normalizePath('./notes/a.md')).toBe('notes/a.md')
    expect(normalizePath('/notes/a.md')).toBe('notes/a.md')
    expect(normalizePath('././a.md')).toBe('a.md')
    expect(normalizePath('/./a.md')).toBe('a.md')
  })

  it('collapses repeated slashes and inner "." segments', () => {
    expect(normalizePath('notes//sub///a.md')).toBe('notes/sub/a.md')
    expect(normalizePath('notes/./sub/a.md')).toBe('notes/sub/a.md')
  })

  it('drops trailing slashes', () => {
    expect(normalizePath('notes/sub/')).toBe('notes/sub')
    expect(normalizePath('notes/sub///')).toBe('notes/sub')
  })

  it('treats backslashes as separators and trims surrounding whitespace', () => {
    expect(normalizePath('notes\\sub\\a.md')).toBe('notes/sub/a.md')
    expect(normalizePath('  notes/a.md  ')).toBe('notes/a.md')
  })

  it('rejects ".." segments anywhere in the path', () => {
    expect(() => normalizePath('../secrets.md')).toThrow(/".." segments are not allowed/)
    expect(() => normalizePath('notes/../../secrets.md')).toThrow(/".." segments are not allowed/)
    expect(() => normalizePath('notes/..')).toThrow(/".." segments are not allowed/)
    expect(() => normalizePath('/../a.md')).toThrow(/".." segments are not allowed/)
  })

  it('allows ".." inside a segment name', () => {
    expect(normalizePath('notes/a..b.md')).toBe('notes/a..b.md')
    expect(normalizePath('...md')).toBe('...md')
  })

  it('rejects empty paths', () => {
    expect(() => normalizePath('')).toThrow(/the path is empty/)
    expect(() => normalizePath('   ')).toThrow(/the path is empty/)
    expect(() => normalizePath('///')).toThrow(/the path is empty/)
    expect(() => normalizePath('./')).toThrow(/the path is empty/)
  })

  it('rejects non-string input at runtime', () => {
    expect(() => normalizePath(null as unknown as string)).toThrow(/expected a string/)
    expect(() => normalizePath(undefined as unknown as string)).toThrow(/expected a string/)
  })
})

describe('isValidPath', () => {
  it('never throws and reports traversal as invalid', () => {
    expect(isValidPath('a/b.md')).toBe(true)
    expect(isValidPath('../b.md')).toBe(false)
    expect(isValidPath('')).toBe(false)
  })
})

describe('baseName / dirName / stemOf', () => {
  it('splits a nested path', () => {
    expect(baseName('a/b/note.md')).toBe('note.md')
    expect(dirName('a/b/note.md')).toBe('a/b')
    expect(stemOf('a/b/note.md')).toBe('note')
  })

  it('handles root level files', () => {
    expect(baseName('note.md')).toBe('note.md')
    expect(dirName('note.md')).toBe('')
    expect(stemOf('note.md')).toBe('note')
  })

  it('handles dotfiles and extensionless files', () => {
    expect(baseName('.gitignore')).toBe('.gitignore')
    expect(stemOf('.gitignore')).toBe('.gitignore')
    expect(stemOf('LICENSE')).toBe('LICENSE')
  })

  it('ignores trailing slashes', () => {
    expect(baseName('a/b/')).toBe('b')
    expect(dirName('a/b/')).toBe('a')
  })
})

describe('extensionOf', () => {
  it('lowercases and drops the dot', () => {
    expect(extensionOf('note.MD')).toBe('md')
    expect(extensionOf('img/Photo.JPEG')).toBe('jpeg')
  })

  it('uses the last dot', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz')
  })

  it('returns "" when there is no extension', () => {
    expect(extensionOf('LICENSE')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('a/b/.env')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
  })
})

describe('isMarkdown / displayName', () => {
  it('recognises .md only', () => {
    expect(isMarkdown('a/b.md')).toBe(true)
    expect(isMarkdown('a/b.MD')).toBe(true)
    expect(isMarkdown('a/b.txt')).toBe(false)
    expect(isMarkdown('a/b.markdown')).toBe(false)
  })

  it('drops .md for notes but keeps the extension for attachments', () => {
    expect(displayName('notes/Deep Work.md')).toBe('Deep Work')
    expect(displayName('assets/diagram.png')).toBe('diagram.png')
    expect(displayName('LICENSE')).toBe('LICENSE')
  })
})

describe('joinPath', () => {
  it('joins and normalises', () => {
    expect(joinPath('notes', 'a.md')).toBe('notes/a.md')
    expect(joinPath('notes/', '/a.md')).toBe('notes/a.md')
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('./notes', 'sub', 'a.md')).toBe('notes/sub/a.md')
  })

  it('returns "" when nothing is joined', () => {
    expect(joinPath()).toBe('')
    expect(joinPath('', '')).toBe('')
  })

  it('rejects traversal built out of parts', () => {
    expect(() => joinPath('notes', '..', 'secret.md')).toThrow(/".." segments are not allowed/)
  })
})

describe('pathSegments', () => {
  it('returns the folder chain', () => {
    expect(pathSegments('a/b/c.md')).toEqual(['a', 'b'])
    expect(pathSegments('/a/c.md')).toEqual(['a'])
    expect(pathSegments('c.md')).toEqual([])
  })
})

describe('comparePaths', () => {
  it('sorts by code unit, deterministically', () => {
    const paths = ['b.md', 'a/z.md', 'a.md', 'A.md']
    expect([...paths].sort(comparePaths)).toEqual(['A.md', 'a.md', 'a/z.md', 'b.md'])
  })

  it('returns 0 for equal paths', () => {
    expect(comparePaths('a.md', 'a.md')).toBe(0)
  })
})

describe('mimeTypeOf', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(mimeTypeOf('a.md')).toBe('text/markdown')
    expect(mimeTypeOf('a/b.PNG')).toBe('image/png')
    expect(mimeTypeOf('a.unknownext')).toBe('application/octet-stream')
    expect(mimeTypeOf('LICENSE')).toBe('application/octet-stream')
  })
})

describe('toVaultFile', () => {
  it('describes a markdown note', () => {
    expect(toVaultFile('./notes/Deep Work.md', 12, 5)).toEqual({
      path: 'notes/Deep Work.md',
      name: 'Deep Work',
      extension: 'md',
      isMarkdown: true,
      size: 12,
      mtime: 5,
    })
  })

  it('describes an attachment', () => {
    expect(toVaultFile('assets/Diagram.PNG', 300, 7)).toEqual({
      path: 'assets/Diagram.PNG',
      name: 'Diagram.PNG',
      extension: 'png',
      isMarkdown: false,
      size: 300,
      mtime: 7,
    })
  })

  it('rejects traversal', () => {
    expect(() => toVaultFile('../a.md', 0, 0)).toThrow(/".." segments are not allowed/)
  })
})
