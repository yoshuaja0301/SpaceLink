import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from '../state/store'
import { DialogHost } from './DialogHost'

const PRISTINE = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState({ ...PRISTINE, dialog: null }, true)
})
afterEach(cleanup)

describe('DialogHost', () => {
  it('renders nothing until something asks a question', () => {
    const { container } = render(<DialogHost />)
    expect(container.firstChild).toBeNull()
  })

  it('resolves askText with the typed answer', async () => {
    render(<DialogHost />)
    let answer: string | null | undefined
    await act(async () => {
      void useAppStore.getState().askText('Rename note', 'Old name', { inputLabel: 'New name' }).then((value) => { answer = value })
    })

    const field = screen.getByLabelText('New name') as HTMLInputElement
    expect(field.value).toBe('Old name')

    await act(async () => {
      fireEvent.change(field, { target: { value: 'New name' } })
      fireEvent.submit(field.closest('form')!)
    })

    expect(answer).toBe('New name')
    expect(useAppStore.getState().dialog).toBeNull()
  })

  it('resolves askText with null when cancelled', async () => {
    render(<DialogHost />)
    let answer: string | null | undefined = 'untouched'
    await act(async () => {
      void useAppStore.getState().askText('Rename note', 'Old', { inputLabel: 'New name' }).then((value) => { answer = value })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(answer).toBeNull()
  })

  it('will not submit an empty name', async () => {
    render(<DialogHost />)
    await act(async () => {
      void useAppStore.getState().askText('Rename note', 'Old', { inputLabel: 'New name' })
    })
    const field = screen.getByLabelText('New name')
    await act(async () => {
      fireEvent.change(field, { target: { value: '   ' } })
    })
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true)
    expect(useAppStore.getState().dialog).not.toBeNull()
  })

  it('resolves askConfirm true only when confirmed', async () => {
    render(<DialogHost />)
    let yes: boolean | undefined
    await act(async () => {
      void useAppStore.getState().askConfirm('Delete "A"?', { message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })
        .then((value) => { yes = value })
    })
    expect(screen.getByText('This cannot be undone.')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    })
    expect(yes).toBe(true)

    let no: boolean | undefined
    await act(async () => {
      void useAppStore.getState().askConfirm('Delete "B"?').then((value) => { no = value })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(no).toBe(false)
  })

  it('settles a pending question when a second one opens', async () => {
    render(<DialogHost />)
    let first: string | null | undefined = 'untouched'
    await act(async () => {
      void useAppStore.getState().askText('First', 'a').then((value) => { first = value })
    })
    await act(async () => {
      void useAppStore.getState().askText('Second', 'b')
    })
    expect(first).toBeNull()
    expect(useAppStore.getState().dialog?.title).toBe('Second')
  })
})
