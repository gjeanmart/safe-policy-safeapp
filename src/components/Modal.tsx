import { type ReactNode, useEffect, useRef } from 'react'

/** Native modal <dialog>, shown while mounted: focus trap, Esc and backdrop click close it. */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-content">{children}</div>
    </dialog>
  )
}
