import { type FormEvent, useEffect, useRef, useState } from 'react'
import {
  MIN_PASSWORD_LENGTH,
  UNLOCK_CANCELLED,
  enableVault,
  unlockRequestStore,
  unlockVault,
} from '../lib/vault'

/** Native modal <dialog> that is shown while mounted (focus trap, Esc to close). */
function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
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

/**
 * Answers unlock requests (see lib/vault): shown whenever an action needs a role key while the
 * vault is locked. Mounted once for the whole app.
 */
export function UnlockDialog() {
  const request = unlockRequestStore.use()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  if (!request) return null

  const close = (outcome: 'unlocked' | 'cancelled') => {
    unlockRequestStore.set(undefined)
    setPassword('')
    setError(undefined)
    if (outcome === 'unlocked') request.resolve()
    else request.reject(new Error(UNLOCK_CANCELLED))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await unlockVault(password)
      close('unlocked')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={() => close('cancelled')}>
      <form onSubmit={submit} className="stack">
        <h2 className="modal-title">Unlock role keys</h2>
        <p className="modal-body">{request.reason}</p>
        <label className={error ? 'field field-invalid' : 'field'}>
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setError(undefined)
            }}
          />
          {error && <span className="field-error">{error}</span>}
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => close('cancelled')}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!password || busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Sets the vault password and encrypts every existing role key with it. */
export function SetPasswordDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const tooShort = password.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm !== password
  const passwordError = submitted && tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : undefined
  const confirmError = submitted && !tooShort && mismatch ? 'The passwords do not match.' : undefined

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (tooShort || mismatch) return
    setBusy(true)
    try {
      await enableVault(password)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <h2 className="modal-title">Protect role keys with a password</h2>
        <p className="modal-body">
          Keys are encrypted in this browser (PBKDF2 + AES-GCM) and the password is asked before revealing a
          key or signing. There is no recovery: if you forget it, the keys are lost, so keep a backup of any
          key you need.
        </p>
        <label className={passwordError ? 'field field-invalid' : 'field'}>
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {passwordError && <span className="field-error">{passwordError}</span>}
        </label>
        <label className={confirmError ? 'field field-invalid' : 'field'}>
          <span className="field-label">Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {confirmError && <span className="field-error">{confirmError}</span>}
        </label>
        {error && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Encrypting…' : 'Set password'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
