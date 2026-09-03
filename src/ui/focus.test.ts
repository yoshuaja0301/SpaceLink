/**
 * The rule that keeps a late-arriving view from stealing the keyboard.
 *
 * The end-to-end suite races the real editor chunk against the real quick
 * switcher, which is the honest test. This pins the rule itself, including the
 * cases that are awkward to stage in a browser.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { focusIsInsideModal, mayTakeFocusOnMount } from './focus'

/** Build a focused element, optionally inside a modal, and return it. */
function focusInside(markup: string): HTMLElement {
  document.body.innerHTML = markup
  const target = document.querySelector<HTMLElement>('[data-focus]')
  if (!target) throw new Error('the fixture has no [data-focus] element')
  target.focus()
  return target
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusIsInsideModal', () => {
  it('is false when nothing has been focused', () => {
    document.body.innerHTML = '<input />'
    expect(document.activeElement).toBe(document.body)
    expect(focusIsInsideModal()).toBe(false)
  })

  it('is false for an ordinary field on the page', () => {
    focusInside('<input data-focus />')
    expect(focusIsInsideModal()).toBe(false)
  })

  it('is true for the field inside an open dialog', () => {
    // This is the quick switcher's shape: the input is a descendant, not the
    // element carrying the attribute.
    const input = focusInside('<div role="dialog" aria-modal="true"><input class="palette-input" data-focus /></div>')
    expect(document.activeElement).toBe(input)
    expect(focusIsInsideModal()).toBe(true)
  })

  it('is true for the dialog element itself', () => {
    focusInside('<div role="dialog" aria-modal="true" tabindex="-1" data-focus></div>')
    expect(focusIsInsideModal()).toBe(true)
  })

  it('is false for a dialog that is not modal', () => {
    // A non-modal dialog does not own the keyboard, so nothing should defer to
    // it — that is exactly what `aria-modal` distinguishes.
    focusInside('<div role="dialog"><input data-focus /></div>')
    expect(focusIsInsideModal()).toBe(false)
  })

  it('is false once the dialog has gone', () => {
    focusInside('<div role="dialog" aria-modal="true"><input data-focus /></div>')
    expect(focusIsInsideModal()).toBe(true)
    document.body.innerHTML = ''
    expect(focusIsInsideModal()).toBe(false)
  })
})

describe('mayTakeFocusOnMount', () => {
  it('lets a view focus itself on an ordinary page', () => {
    expect(mayTakeFocusOnMount()).toBe(true)
  })

  it('lets a view focus itself when the reader is in the sidebar', () => {
    // Clicking a search result should still land the caret in the note; only a
    // modal is a reason to hold back.
    focusInside('<aside class="sidebar"><button class="search-result" data-focus>a hit</button></aside>')
    expect(mayTakeFocusOnMount()).toBe(true)
  })

  it('holds back while the quick switcher is open', () => {
    focusInside('<div role="dialog" aria-modal="true"><input class="palette-input" data-focus /></div>')
    expect(mayTakeFocusOnMount()).toBe(false)
  })
})
