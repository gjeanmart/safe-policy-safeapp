import type { ReactNode } from 'react'
import { Tooltip } from '../Tooltip'

export type ChipTone = 'allow' | 'limit' | 'protect' | 'deny' | 'neutral'
/** Where a chip stands relative to the on-chain configuration. */
export type ChipStatus = 'live' | 'added' | 'changed' | 'removed' | 'preview'

const STATUS_HINTS: Record<ChipStatus, string | undefined> = {
  live: undefined,
  added: 'In the draft: attached once the configuration is applied',
  changed: 'In the draft: new settings once the configuration is applied',
  removed: 'In the draft: detached once the configuration is applied',
  preview: 'What the scope builder would add',
}

/** One attachment (or gate) as a coloured pill; `onRemove` shows an × (queues a detach). */
export function Chip({
  tone,
  status = 'live',
  title,
  onRemove,
  removeTitle = 'Queue a detach in the draft',
  children,
}: {
  tone: ChipTone
  status?: ChipStatus
  title?: ReactNode
  onRemove?: () => void
  removeTitle?: string
  children: ReactNode
}) {
  const hint = STATUS_HINTS[status]
  const body = (
    <span className={`chip chip-${tone} chip-${status}`}>
      <span>{children}</span>
      {onRemove && status !== 'removed' && (
        <button
          type="button"
          className="chip-x"
          aria-label={removeTitle}
          title={removeTitle}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  )
  const content =
    title || hint ? (
      <>
        {title}
        {title && hint && <br />}
        {hint && <em>{hint}</em>}
      </>
    ) : undefined
  return content ? <Tooltip content={content}>{body}</Tooltip> : body
}
