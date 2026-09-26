import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TrashIcon } from './icons'

/**
 * Icon button for destructive actions: it opens a small modal and runs `onConfirm` only if the
 * user confirms. Uses a native `<dialog>` (focus trap, Esc to cancel) rather than
 * `window.confirm`, which the Safe{Wallet} iframe sandbox may block.
 *
 * @param title Tooltip of the icon, and the modal's question unless `message` is given.
 */
export function ConfirmIconButton({
  title,
  message,
  confirmLabel = 'Confirm',
  onConfirm,
  icon = <TrashIcon />,
  disabled = false,
}: {
  title: string
  message?: ReactNode
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
  icon?: ReactNode
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) dialog.current?.showModal()
  }, [open])

  const close = () => {
    dialog.current?.close()
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        className="link icon"
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {icon}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="modal"
          // Esc closes the dialog natively; keep React state in sync.
          onClose={() => setOpen(false)}
          // A click on the backdrop lands on the dialog element itself.
          onClick={(e) => e.target === e.currentTarget && close()}
        >
          <div className="modal-content">
            <h2 className="modal-title">Are you sure?</h2>
            <p className="modal-body">{message ?? title}</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                autoFocus
                onClick={async () => {
                  close()
                  await onConfirm()
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  )
}
