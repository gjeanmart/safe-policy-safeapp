import { type ReactNode, useState } from 'react'
import { ChevronIcon } from '../icons'
import { Badge } from '../ui'

export type ChipTone = 'ok' | 'warn' | 'bad' | 'neutral'

/**
 * One queue line, Safe{Wallet} style: nonce, icon and title, relative time, signatures, status and
 * the one next action. It expands to the decoded call (left) and the audit log with the action
 * under it (right); the action shows in one place at a time, so a click cannot run it twice.
 */
export function QueueItem({
  nonce,
  icon,
  title,
  time,
  signatures,
  status,
  action,
  call,
  log,
  more,
  defaultOpen = false,
}: {
  nonce?: ReactNode
  icon: ReactNode
  title: ReactNode
  time?: string
  signatures?: { count: number; threshold: number }
  status?: { tone: ChipTone; label: string }
  action?: ReactNode
  /** Left of the details: the decoded call and its identifiers. */
  call: ReactNode
  /** Right of the details: the audit log. */
  log: ReactNode
  /** Under the action: simulate, cancel. */
  more?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => setOpen((o) => !o)
  return (
    <li className={open ? 'qi open' : 'qi'}>
      {/* The line toggles on click; the chevron button is its keyboard-accessible twin. */}
      <div className="qi-line" onClick={toggle}>
        <span className="qi-nonce">{nonce}</span>
        <span className="qi-icon">{icon}</span>
        <span className="qi-title">{title}</span>
        {time && <span className="qi-time muted small">{time}</span>}
        {signatures && (
          <Badge tone={signatures.count >= signatures.threshold ? 'ok' : 'neutral'}>
            ✓ {signatures.count}/{signatures.threshold}
          </Badge>
        )}
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
        <span className="qi-action" onClick={(e) => e.stopPropagation()}>
          {!open && action}
          <button
            type="button"
            className="activity-toggle"
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
            onClick={toggle}
          >
            <span className={open ? 'chevron open' : 'chevron'}>
              <ChevronIcon />
            </span>
          </button>
        </span>
      </div>
      {open && (
        <div className="qi-details">
          <div className="qi-call">{call}</div>
          <div className="qi-log">
            {log}
            {action && <div className="qi-primary">{action}</div>}
            {more && <div className="row wrap qi-more">{more}</div>}
          </div>
        </div>
      )}
    </li>
  )
}

/** A group header in the queue list: Next, Queued, Module schedules. */
export const QueueGroup = ({ children }: { children: ReactNode }) => (
  <li className="qi-group" role="presentation">
    {children}
  </li>
)
