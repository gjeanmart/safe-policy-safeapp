import type { ReactNode } from 'react'

/** One line of a queue item's audit log. */
export type AuditEvent = {
  key: string
  label: ReactNode
  detail?: ReactNode
  /** done: happened; current: the step it waits on; todo: later; bad: the step that failed. */
  state: 'done' | 'current' | 'todo' | 'bad'
}

/**
 * Created, signed, scheduled, ready, executed: a vertical log of what happened to a delayed
 * transaction and what comes next, the current step highlighted.
 */
export function AuditLog({ events }: { events: readonly AuditEvent[] }) {
  return (
    <ol className="audit-log" aria-label="Transaction log">
      {events.map((e) => (
        <li key={e.key} className={e.state} aria-current={e.state === 'current' ? 'step' : undefined}>
          <span className="audit-dot" aria-hidden="true" />
          <div>
            <div className="audit-label">{e.label}</div>
            {e.detail && <div className="audit-detail">{e.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}
