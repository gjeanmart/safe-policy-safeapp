import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react'
import { EXPLORER } from '../config/contracts'
import { describeError } from '../lib/errors'
import { shortAddress } from '../lib/format'
import type { SafeTx } from '../lib/safe'
import { useAddressName } from '../hooks/useAddressName'
import { InfoTip, Tooltip } from './Tooltip'

export function Card({
  title,
  actions,
  children,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card">
      <header className="card-header">
        <h2>{title}</h2>
        {actions && <div className="row">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'neutral'
  children: ReactNode
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export type TagTone = 'neutral' | 'info' | 'ok' | 'bad'

/**
 * Small outlined label for categorical values (operation, policy, run mode), distinct from the
 * filled status badges. `caps` renders it uppercase; `fixed` gives every tag the same width.
 */
export function Tag({
  tone = 'neutral',
  caps = false,
  fixed = false,
  children,
}: {
  tone?: TagTone
  caps?: boolean
  fixed?: boolean
  children: ReactNode
}) {
  const classes = ['tag', `tag-${tone}`, caps && 'tag-caps', fixed && 'tag-fixed'].filter(Boolean).join(' ')
  return <span className={classes}>{children}</span>
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>
}

/**
 * Copies text to the clipboard. Inside the Safe{Wallet} iframe the async Clipboard API is denied
 * (no `clipboard-write` permission is delegated), so fall back to the legacy `execCommand` path.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok
  }
}

export function CopyButton({ value }: { value: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    setStatus((await copyText(value)) ? 'copied' : 'failed')
    setTimeout(() => setStatus('idle'), 1200)
  }
  return (
    <Tooltip content={status === 'failed' ? 'Copy failed' : status === 'copied' ? 'Copied' : 'Copy'}>
      <button type="button" className="link" onClick={copy} aria-label="Copy">
        {status === 'copied' ? '✓' : status === 'failed' ? '✗' : '⧉'}
      </button>
    </Tooltip>
  )
}

/**
 * Address with its known name (role, Safe, owner or known contract), a copy button and an
 * Etherscan link.
 * @param name Overrides the resolved name; pass "" to show none (when the name is already shown).
 */
export function AddressView({
  address,
  full = false,
  name: nameOverride,
}: {
  address: string
  full?: boolean
  name?: string
}) {
  const resolved = useAddressName(address)
  const name = nameOverride ?? resolved
  return (
    <span className="address">
      {name && <strong>{name} </strong>}
      <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="mono">
        {full ? address : shortAddress(address)}
      </a>
      <CopyButton value={address} />
    </span>
  )
}

export const TxLink = ({ hash }: { hash: string }) => (
  <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer" className="mono">
    {shortAddress(hash)}
  </a>
)

type AsyncButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onClick: () => Promise<unknown> | unknown
  variant?: 'primary' | 'secondary' | 'danger'
}

/** Button that disables itself while its handler runs and shows the error it throws, if any. */
export function AsyncButton({
  onClick,
  variant = 'secondary',
  children,
  disabled,
  ...rest
}: AsyncButtonProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const handle = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await onClick()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="async-button">
      <button
        type="button"
        className={`btn btn-${variant}`}
        disabled={disabled || busy}
        onClick={handle}
        {...rest}
      >
        {busy ? '…' : children}
      </button>
      {error && <span className="error-text">{error}</span>}
    </span>
  )
}

/** Shows exactly which calls the owners will be asked to sign. */
export function SafeTxPreview({ txs }: { txs: readonly SafeTx[] }) {
  if (txs.length === 0) return null
  return (
    <details className="tx-preview">
      <summary>
        {txs.length} Safe transaction{txs.length > 1 ? 's' : ''} (batched)
      </summary>
      <ol>
        {txs.map((tx, i) => (
          <li key={i}>
            <div>{tx.description}</div>
            <div className="muted">
              to <AddressView address={tx.to} />
            </div>
            <code className="calldata">{tx.data}</code>
          </li>
        ))}
      </ol>
    </details>
  )
}

export function Field({
  label,
  hint,
  info,
  error,
  after,
  children,
}: {
  label: string
  hint?: ReactNode
  /** Explanatory copy behind an ⓘ next to the label. */
  info?: ReactNode
  /** Validation message for the input, shown in red directly under it. */
  error?: string
  /** Extra controls rendered after the error (e.g. address shortcuts). */
  after?: ReactNode
  children: ReactNode
}) {
  return (
    <label className={error ? 'field field-invalid' : 'field'}>
      <span className="field-label">
        {label}
        {info && <InfoTip>{info}</InfoTip>}
      </span>
      {children}
      {error && <span className="field-error">{error}</span>}
      {after}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}
