import { type ChangeEvent, type FormEvent, useRef, useState } from 'react'
import { UNLOCK_CANCELLED, exportRoles, importRoles } from '../lib/vault'
import { rolesStore } from '../store'
import { Modal } from './Modal'

type Ask = { resolve: (password: string) => void; reject: (error: Error) => void }

/** Asks for the password of the browser a roles file comes from. */
function FilePasswordDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const close = (password?: string) => {
    if (password) ask.resolve(password)
    else ask.reject(new Error(UNLOCK_CANCELLED))
    onClose()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    close(password)
  }
  return (
    <Modal onClose={() => close()}>
      <form onSubmit={submit} className="stack">
        <h2 className="modal-title">Password of the roles file</h2>
        <p className="modal-body">
          The keys in this file are encrypted with the password of the browser they were exported from. Enter
          it to add them here, under this browser&apos;s password.
        </p>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!password}>
            Import
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Export / import of the roles as a JSON file; keys stay encrypted as stored. */
export function RolesBackupButtons() {
  const hasRoles = rolesStore.use().length > 0
  const input = useRef<HTMLInputElement>(null)
  const [ask, setAsk] = useState<Ask>()
  const [message, setMessage] = useState<{ text: string; error?: boolean }>()

  const download = () => {
    try {
      const blob = new Blob([JSON.stringify(exportRoles(), null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `safe-policy-sandbox-roles-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setMessage({ text: 'Exported. Keys stay encrypted with your password.' })
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true })
    }
  }

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMessage(undefined)
    try {
      let raw: unknown
      try {
        raw = JSON.parse(await file.text())
      } catch {
        throw new Error('Not a JSON file.')
      }
      const { added, skipped } = await importRoles(
        raw,
        () => new Promise<string>((resolve, reject) => setAsk({ resolve, reject })),
      )
      setMessage({
        text: `Imported ${added} role${added === 1 ? '' : 's'}${skipped ? `, ${skipped} already here` : ''}.`,
      })
    } catch (error) {
      if ((error as Error).message !== UNLOCK_CANCELLED)
        setMessage({ text: (error as Error).message, error: true })
    }
  }

  return (
    <>
      <button type="button" className="btn" onClick={download} disabled={!hasRoles}>
        Export
      </button>
      <button type="button" className="btn" onClick={() => input.current?.click()}>
        Import
      </button>
      <input ref={input} type="file" accept="application/json,.json" hidden onChange={upload} />
      {message && <span className={message.error ? 'error-text' : 'muted small'}>{message.text}</span>}
      {ask && <FilePasswordDialog ask={ask} onClose={() => setAsk(undefined)} />}
    </>
  )
}
