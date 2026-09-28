import { type FormEvent, useState } from 'react'
import { type Hex, isAddressEqual } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSandbox } from '../context'
import { detectRoleKind } from '../lib/roleExec'
import { fieldError, parseAddressInput, parsePrivateKeyInput } from '../lib/validation'
import { UNLOCK_CANCELLED, protectKey } from '../lib/vault'
import { rolesStore } from '../store'
import { Modal } from './Modal'
import { Field } from './ui'

const SOURCES = {
  new: 'New EOA',
  import: 'Import EOA',
  contract: 'Safe or contract',
} as const
type Source = keyof typeof SOURCES

const HINTS: Record<Source, string> = {
  new: 'A fresh key is generated in this browser and encrypted with your password. Fund it with a little Sepolia ETH for gas.',
  import: 'Add an existing EOA from its private key, e.g. a role created in another browser.',
  contract:
    'Another Safe acts through its own transactions (executed here when one of your EOA roles owns it alone). Any other contract acts through its own logic: the app simulates what it is allowed to do.',
}

const defaultLabel = (source: Source | 'safe', count: number) =>
  `${source === 'safe' ? 'Safe' : source === 'contract' ? 'Contract' : 'Role'} ${count + 1}`

/** Adds a role from one of three sources: a new key, an imported key, or a Safe / contract address. */
export function AddRoleDialog({ onClose }: { onClose: () => void }) {
  const { safe } = useSandbox()
  const roles = rolesStore.use()
  const [source, setSource] = useState<Source>('new')
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [address, setAddress] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const parsedKey = parsePrivateKeyInput(key)
  const parsedAddress = parseAddressInput(address, 'address')
  const keyError = source === 'import' ? fieldError(parsedKey, submitted) : undefined
  const addressError = source === 'contract' ? fieldError(parsedAddress, submitted) : undefined

  const exists = (a: string) => roles.some((r) => isAddressEqual(r.address, a as Hex))

  const addEoa = async (privateKey: Hex) => {
    const { address: eoa } = privateKeyToAccount(privateKey)
    if (exists(eoa)) throw new Error(`This key is already a role (${eoa}).`)
    const encrypted = await protectKey(privateKey)
    rolesStore.set((list) => [
      ...list,
      {
        address: eoa,
        ...encrypted,
        label: label.trim() || defaultLabel('new', list.length),
        createdAt: Date.now(),
      },
    ])
  }

  const addContract = async (target: Hex) => {
    if (isAddressEqual(target, safe))
      throw new Error('This is the Safe being configured; it cannot be its own role.')
    if (exists(target)) throw new Error('This address is already a role.')
    const kind = await detectRoleKind(target)
    if (kind === 'none')
      throw new Error('No contract at this address. For an EOA, use "Import EOA" with its key.')
    rolesStore.set((list) => [
      ...list,
      {
        kind,
        address: target,
        label: label.trim() || defaultLabel(kind, list.length),
        createdAt: Date.now(),
      },
    ])
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    setError(undefined)
    if (source === 'import' && !parsedKey.ok) return
    if (source === 'contract' && !parsedAddress.ok) return
    setBusy(true)
    try {
      if (source === 'new') await addEoa(generatePrivateKey())
      else if (source === 'import' && parsedKey.ok) await addEoa(parsedKey.value)
      else if (parsedAddress.ok) await addContract(parsedAddress.value)
      onClose()
    } catch (err) {
      // Closing the password prompt is not an error: the dialog simply stays open.
      if ((err as Error).message !== UNLOCK_CANCELLED) setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <h2 className="modal-title">Add role</h2>
        <div className="tabs segmented" role="radiogroup" aria-label="Role source">
          {(Object.keys(SOURCES) as Source[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={key === source}
              className={key === source ? 'tab active' : 'tab'}
              onClick={() => {
                setSource(key)
                setSubmitted(false)
                setError(undefined)
              }}
            >
              {SOURCES[key]}
            </button>
          ))}
        </div>
        <p className="muted small">{HINTS[source]}</p>

        <Field label="Label" hint="Optional">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Trader bot"
            autoFocus
          />
        </Field>
        {source === 'import' && (
          <Field label="Private key" error={keyError}>
            <input
              // Masked and kept out of autofill / spellcheck services.
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={key}
              onChange={(e) => setKey(e.target.value.trim())}
            />
          </Field>
        )}
        {source === 'contract' && (
          <Field label="Address" error={addressError}>
            <input
              className="mono"
              placeholder="0x…"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
            />
          </Field>
        )}
        {error && <p className="field-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Adding…' : source === 'new' ? 'Generate' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
