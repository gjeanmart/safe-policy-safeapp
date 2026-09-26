import { formatTime } from '../../lib/format'
import { type Activity, type ActivityMode, activityStore, rolesStore } from '../../store'
import { Badge, Card, TxLink } from '../ui'

const TONES: Record<Activity['status'], 'ok' | 'warn' | 'bad' | 'neutral'> = {
  allowed: 'ok',
  confirmed: 'ok',
  denied: 'bad',
  reverted: 'bad',
  sent: 'warn',
  info: 'neutral',
}

const MODE_LABELS: Record<ActivityMode, string> = {
  simulate: 'simulate',
  execute: 'execute',
  force: 'force-send',
}

const LEGACY_PREFIXES: Record<string, ActivityMode> = {
  'Simulate: ': 'simulate',
  'Execute: ': 'execute',
  'Force-send: ': 'force',
}

/** Splits entries logged before `mode` existed ("Execute: transfer …") into mode + label. */
function modeAndLabel(activity: Activity): { mode?: ActivityMode; label: string } {
  if (activity.mode) return { mode: activity.mode, label: activity.label }
  for (const [prefix, mode] of Object.entries(LEGACY_PREFIXES)) {
    if (activity.label.startsWith(prefix)) return { mode, label: activity.label.slice(prefix.length) }
  }
  return { label: activity.label }
}

export function ActivityLog() {
  const activity = activityStore.use()
  const roles = rolesStore.use()
  const roleLabel = (address: string) =>
    roles.find((r) => r.address === address)?.label ?? address.slice(0, 8)

  return (
    <Card
      title="Activity"
      actions={
        activity.length > 0 && (
          <button
            type="button"
            className="btn"
            title="Clear the local activity log"
            onClick={() => activityStore.set([])}
          >
            Clear
          </button>
        )
      }
    >
      {activity.length === 0 ? (
        <p className="muted">Simulate or execute an action to see what the policies decide.</p>
      ) : (
        <ul className="activity">
          <li className="activity-row activity-header" aria-hidden="true">
            <span>Date / time</span>
            <span>Mode</span>
            <span>Status</span>
            <span>Role</span>
            <span>Action</span>
            <span className="activity-tx">Tx</span>
          </li>
          {activity.map((a) => {
            const { mode, label } = modeAndLabel(a)
            return (
              // Grid row: time | mode | status | role | action | tx, with the detail line under the action.
              <li key={a.id} className="activity-row">
                <span className="muted small mono">{formatTime(a.at)}</span>
                <span>{mode && <span className={`tag tag-${mode}`}>{MODE_LABELS[mode]}</span>}</span>
                <span>
                  <Badge tone={TONES[a.status]}>{a.status}</Badge>
                </span>
                <strong className="activity-role">{roleLabel(a.role)}</strong>
                <span className="activity-label" title={label}>
                  {label}
                </span>
                <span className="activity-tx">{a.txHash && <TxLink hash={a.txHash} />}</span>
                {a.detail && <div className="detail mono small">{a.detail}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
