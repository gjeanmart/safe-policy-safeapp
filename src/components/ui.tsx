import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react'
import type { Hash } from 'viem'
import { EXPLORER } from '../config/contracts'
import { describeError } from '../lib/errors'
import { shortAddress } from '../lib/format'
import type { SafeTx } from '../lib/safe'
import { useAddressName } from '../hooks/useAddressName'
import { CheckCircleIcon, ErrorIcon, InfoIcon, SpinnerIcon, WarningIcon } from './icons'
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

export type NoticeTone = 'info' | 'ok' | 'warn' | 'bad'

const NOTICE_ICONS: Record<NoticeTone, ReactNode> = {
  info: <InfoIcon />,
  ok: <CheckCircleIcon />,
  warn: <WarningIcon />,
  bad: <ErrorIcon />,
}

/**
 * A callout: an icon per tone, an optional bold title, a short body, and long explanations behind
 * "Learn more" (`more`) so the notice stays one or two lines.
 */
export function Notice({
  tone = 'info',
  title,
  more,
  children,
}: {
  tone?: NoticeTone
  title?: ReactNode
  /** Folded explanation under the body. */
  more?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <span className="notice-icon">{NOTICE_ICONS[tone]}</span>
      <div className="notice-content">
        {title && <div className="notice-title">{title}</div>}
        {children && <div className="notice-body">{children}</div>}
        {more && (
          <details className="notice-more">
            <summary>Learn more</summary>
            {more}
          </details>
        )}
      </div>
    </div>
  )
}

/** A failure on one line, with the full message folded under it when it is long. */
export function ErrorLine({ message }: { message: string }) {
  const first = message.split('\n')[0]!
  const short = first.length > 140 ? `${first.slice(0, 137)}…` : first
  if (short === message) return <span className="error-text">{message}</span>
  return (
    <span className="error-text error-line">
      {short}
      <details>
        <summary>Details</summary>
        <pre className="error-details">{message}</pre>
      </details>
    </span>
  )
}

/** Inline progress: a spinner and what is happening ("Scheduling…"). */
export const Pending = ({ children }: { children: ReactNode }) => (
  <span className="pending-label">
    <SpinnerIcon /> {children}
  </span>
)

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
    <button type="button" className="link" onClick={copy} aria-label="Copy">
      {status === 'copied' ? '✓' : status === 'failed' ? '✗' : '⧉'}
    </button>
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

/** A 32-byte hash shortened, with a copy button (Safe transaction hashes, attachment ids). */
export const ShortHash = ({ hash, label }: { hash: string; label?: string }) => (
  <span className="short-hash">
    {label && <span className="muted">{label} </span>}
    <span className="mono">{shortAddress(hash)}</span>
    <CopyButton value={hash} />
  </span>
)

type AsyncButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onClick: () => Promise<unknown> | unknown
  variant?: 'primary' | 'secondary' | 'danger'
  /** Shown with a spinner while the handler runs ("Executing…"). */
  busyLabel?: string
  /**
   * Replaces the button once the handler succeeds ("Executed"); when it resolved to a transaction
   * hash, that links to the explorer.
   */
  doneLabel?: string
}

const isTxHash = (value: unknown): value is Hash =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

/** Button that disables itself while its handler runs and shows the error it throws, if any. */
export function AsyncButton({
  onClick,
  variant = 'secondary',
  children,
  disabled,
  title,
  busyLabel,
  doneLabel,
  ...rest
}: AsyncButtonProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<{ hash?: Hash }>()
  const handle = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await onClick()
      if (doneLabel) setDone({ hash: isTxHash(result) ? result : undefined })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  if (done)
    return (
      <span className="done-label">
        <CheckCircleIcon /> {doneLabel}
        {done.hash && (
          <>
            {' · '}
            <TxLink hash={done.hash} />
          </>
        )}
      </span>
    )
  return (
    <span className="async-button">
      {/* The title becomes an instant tooltip rather than the delayed native one. */}
      <Tooltip content={title}>
        <button
          type="button"
          className={`btn btn-${variant}`}
          disabled={disabled || busy}
          onClick={handle}
          aria-label={typeof children === 'string' ? undefined : title}
          {...rest}
        >
          {busy ? busyLabel ? <Pending>{busyLabel}</Pending> : <SpinnerIcon /> : children}
        </button>
      </Tooltip>
      {error && <ErrorLine message={error} />}
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
