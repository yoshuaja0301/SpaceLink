/**
 * The app's own prompt/confirm.
 *
 * Native `window.prompt` and `window.confirm` are blocked outright in sandboxed
 * frames and look nothing like the rest of the app, so every question the app
 * needs answered — renaming a note, confirming a delete — goes through the
 * store's `askText`/`askConfirm` and is rendered here.
 */
import type { JSX } from 'react'
import { useEffect, useId, useState } from 'react'

import { useAppStore } from '../state/store'
import { Modal } from './Modal'

export function DialogHost(): JSX.Element | null {
  const dialog = useAppStore((state) => state.dialog)
  const resolveDialog = useAppStore((state) => state.resolveDialog)
  const [value, setValue] = useState('')
  const fieldId = useId()

  // Reload the field whenever a new question opens.
  useEffect(() => {
    setValue(dialog?.kind === 'prompt' ? (dialog.initial ?? '') : '')
  }, [dialog])

  if (!dialog) return null

  const isPrompt = dialog.kind === 'prompt'
  const confirmLabel = dialog.confirmLabel ?? (isPrompt ? 'Rename' : 'OK')
  const disabled = isPrompt && value.trim() === ''

  const accept = (): void => {
    if (disabled) return
    resolveDialog(isPrompt ? value.trim() : true)
  }

  return (
    <Modal open title={dialog.title} onClose={() => resolveDialog(isPrompt ? null : false)} width={420}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          accept()
        }}
      >
        {dialog.message ? <p className="dialog-message">{dialog.message}</p> : null}

        {isPrompt ? (
          <label className="dialog-field" htmlFor={fieldId}>
            <span>{dialog.inputLabel ?? 'Name'}</span>
            <input
            id={fieldId}
            className="input dialog-input"
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                resolveDialog(null)
              }
            }}
            />
          </label>
        ) : null}

        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => resolveDialog(isPrompt ? null : false)}>
            Cancel
          </button>
          <button
            type="submit"
            className={dialog.danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={disabled}
            autoFocus={!isPrompt}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default DialogHost
