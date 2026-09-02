/**
 * Naming a file on its way into the vault.
 *
 * The name matters more than it looks. What goes into the note is the bare
 * name, and the renderer resolves a bare name by searching the whole vault, so
 * a second `chart.png` anywhere turns every existing `![[chart.png]]` into a
 * coin toss between two pictures.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ATTACHMENT_FOLDER,
  attachmentName,
  embedTextFor,
  isImageAttachment,
  uniqueAttachmentPath,
} from './attachments'

const AT = new Date(2026, 8, 2, 7, 5, 9)

describe('isImageAttachment', () => {
  it('believes the MIME type first', () => {
    expect(isImageAttachment({ name: 'no-extension', type: 'image/png' })).toBe(true)
    expect(isImageAttachment({ name: 'report.pdf', type: 'application/pdf' })).toBe(false)
  })

  it('falls back to the extension when there is no type', () => {
    expect(isImageAttachment({ name: 'a/b/Chart.PNG' })).toBe(true)
    expect(isImageAttachment({ name: 'notes.txt' })).toBe(false)
    expect(isImageAttachment({})).toBe(false)
  })
})

describe('attachmentName', () => {
  it('keeps the name a dropped file arrived with', () => {
    // It is what the person will look for in the folder later.
    expect(attachmentName({ name: 'Quarterly chart.png', type: 'image/png' }, AT)).toBe('Quarterly chart.png')
  })

  it('gives a pasted screenshot a timestamp, since every browser calls it image.png', () => {
    expect(attachmentName({ name: 'image.png', type: 'image/png' }, AT)).toBe('Pasted image 20260902070509.png')
    expect(attachmentName({ name: '', type: 'image/png' }, AT)).toBe('Pasted image 20260902070509.png')
  })

  it('recovers an extension from the type when the name has none', () => {
    expect(attachmentName({ name: 'screenshot', type: 'image/jpeg' }, AT)).toBe('screenshot.jpg')
    expect(attachmentName({ name: 'drawing', type: 'image/svg+xml' }, AT)).toBe('drawing.svg')
  })

  it('strips anything that could turn a name into a path', () => {
    // `../` in a file name is how an attachment ends up outside the vault.
    expect(attachmentName({ name: '../../etc/passwd.png', type: 'image/png' }, AT)).toBe('....etcpasswd.png')
    expect(attachmentName({ name: 'a/b:c*d?.png', type: 'image/png' }, AT)).toBe('abcd.png')
  })

  it('never produces a nameless file', () => {
    expect(attachmentName({ name: '///.png', type: 'image/png' }, AT)).toBe('Attachment.png')
  })

  it('keeps a long name usable', () => {
    const name = attachmentName({ name: `${'n'.repeat(400)}.png`, type: 'image/png' }, AT)
    expect(name.length).toBeLessThanOrEqual(104)
    expect(name.endsWith('.png')).toBe(true)
  })
})

describe('uniqueAttachmentPath', () => {
  it('puts the file in the chosen folder', () => {
    expect(uniqueAttachmentPath('attachments', 'a.png', [])).toBe('attachments/a.png')
    expect(uniqueAttachmentPath('', 'a.png', [])).toBe('a.png')
    expect(uniqueAttachmentPath('files/', 'a.png', [])).toBe('files/a.png')
  })

  it('steps aside for a name already used anywhere in the vault', () => {
    // Not just in this folder: a bare name is resolved vault-wide.
    expect(uniqueAttachmentPath('attachments', 'chart.png', ['pictures/chart.png'])).toBe('attachments/chart 1.png')
  })

  it('keeps counting until it finds a free one', () => {
    const taken = ['attachments/chart.png', 'attachments/chart 1.png', 'elsewhere/chart 2.png']
    expect(uniqueAttachmentPath('attachments', 'chart.png', taken)).toBe('attachments/chart 3.png')
  })

  it('compares names without regard to case, as a filesystem would', () => {
    expect(uniqueAttachmentPath('attachments', 'Chart.png', ['CHART.PNG'])).toBe('attachments/Chart 1.png')
  })

  it('avoids a note’s name too, not only another attachment', () => {
    expect(uniqueAttachmentPath('', 'Home.md', ['Notes/Home.md'])).toBe('Home 1.md')
  })

  it('leaves the suffix before the extension where it belongs', () => {
    const taken = ['a.tar.gz']
    expect(uniqueAttachmentPath('', 'a.tar.gz', taken)).toBe('a.tar 1.gz')
  })
})

describe('embedTextFor', () => {
  it('embeds an image so it shows in the note', () => {
    expect(embedTextFor('attachments/chart.png', { type: 'image/png' })).toBe('![[chart.png]]')
  })

  it('links anything else, because an embed of it renders as missing', () => {
    expect(embedTextFor('attachments/paper.pdf', { type: 'application/pdf' })).toBe('[[paper.pdf]]')
  })

  it('writes the bare name, not the path', () => {
    // Which is what keeps the note correct if the file is later moved.
    expect(embedTextFor('deep/nested/folder/a.png', { type: 'image/png' })).toBe('![[a.png]]')
  })
})

describe('DEFAULT_ATTACHMENT_FOLDER', () => {
  it('is a plain folder inside the vault', () => {
    expect(DEFAULT_ATTACHMENT_FOLDER).toBe('attachments')
  })
})
