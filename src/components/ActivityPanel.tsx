import { useEffect } from 'react'
import { isAddressEqual } from 'viem'
import { publicClient } from '../config/client'
import { useSandbox } from '../context'
import { formatTime, shortAddress } from '../lib/format'
import {
  type Activity,
  type ActivityMode,
  type ActivityStatus,
  activityStore,
  rolesStore,
  uiStore,
  updateActivity,
} from '../store'
import { ChevronIcon } from './icons'
import { Badge, ErrorLine, ShortHash, Tag, type TagTone, TxLink } from './ui'

const TONES: Record<ActivityStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  allowed: 'ok',
  confirmed: 'ok',
  executed: 'ok',
  denied: 'bad',
  reverted: 'bad',
  failed: 'bad',
  sent: 'warn',
  scheduled: 'warn',
  proposed: 'neutral',
  info: 'neutral',
}

const MODE_LABELS: Record<ActivityMode, string> = {
  simulate: 'simulate',
  execute: 'execute',
  force: 'force-send',
  propose: 'propose',
  schedule: 'schedule',
  cancel: 'cancel',
}

const MODE_TONES: Record<ActivityMode, TagTone> = {
  simulate: 'info',
  execute: 'neutral',
  force: 'bad',
  propose: 'info',
  schedule: 'neutral',
  cancel: 'bad',
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

const RECEIPT_POLL_MS = 10_000
const FAILED: readonly ActivityStatus[] = ['failed', 'denied', 'reverted']

/**
 * Entries stay "sent" if the page was closed or reloaded before their receipt arrived. Re-check
 * them on-chain until they settle as confirmed or reverted.
 */
function useSettleSentEntries(activity: readonly Activity[]) {
  const pending = activity.filter((a) => a.status === 'sent' && a.txHash).map((a) => `${a.id}:${a.txHash}`)
  const key = pending.join(',')
  useEffect(() => {
    if (!key) return
    const check = () =>
      key.split(',').forEach(async (entry) => {
        const [id, hash] = entry.split(':') as [string, `0x${string}`]
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash })
          updateActivity(id, { status: receipt.status === 'success' ? 'confirmed' : 'reverted' })
        } catch {
          // Not mined yet (or unknown to this RPC): try again on the next tick.
        }
      })
    check()
    const timer = setInterval(check, RECEIPT_POLL_MS)
    return () => clearInterval(timer)
  }, [key])
}

/** The decoded description, Safe transaction hash and nonce, behind the action. */
function Details({ a }: { a: Activity }) {
  const lines = a.lines ?? []
  const has = lines.length > 0 || a.safeTxHash || a.nonce !== undefined
  if (!has) return null
  return (
    <details className="activity-details">
      <summary>Details</summary>
      {lines.length > 0 && (
        <ul className="activity-lines">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <div className="queue-meta">
        {a.nonce !== undefined && <span>nonce {a.nonce.toString()}</span>}
        {a.safeTxHash && <ShortHash hash={a.safeTxHash} label="Safe tx" />}
      </div>
    </details>
  )
}

/**
 * Everything the app sent, proposed or simulated, newest first: one panel at the bottom of every
 * tab, collapsible (remembered across reloads).
 */
export function ActivityPanel() {
  const { safe } = useSandbox()
  const activity = activityStore.use()
  const { activityOpen } = uiStore.use()
  useSettleSentEntries(activity)
  const roles = rolesStore.use()
  const actorName = (address: string) =>
    isAddressEqual(address as `0x${string}`, safe)
      ? 'Owners'
      : (roles.find((r) => r.address.toLowerCase() === address.toLowerCase())?.label ?? shortAddress(address))
  const inFlight = activity.filter((a) => a.status === 'sent').length

  return (
    <section className="card activity-panel">
      <header className="card-header">
        <button
          type="button"
          className="activity-toggle"
          aria-expanded={activityOpen}
          onClick={() => uiStore.set((s) => ({ ...s, activityOpen: !s.activityOpen }))}
        >
          <span className={activityOpen ? 'chevron open' : 'chevron'}>
            <ChevronIcon />
          </span>
          <h2>Activity</h2>
          <span className="muted small">{activity.length}</span>
          {inFlight > 0 && <Badge tone="warn">{inFlight} pending</Badge>}
        </button>
        {activityOpen && activity.length > 0 && (
          <button type="button" className="btn" onClick={() => activityStore.set([])}>
            Clear
          </button>
        )}
      </header>
      {activityOpen &&
        (activity.length === 0 ? (
          <p className="muted">
            Every transaction the app proposes, sends or simulates shows here, from any tab.
          </p>
        ) : (
          <ul className="activity">
            <li className="activity-row activity-header" aria-hidden="true">
              <span>Date / time</span>
              <span>Mode</span>
              <span>Status</span>
              <span>By</span>
              <span>Action</span>
              <span className="activity-tx">Tx</span>
            </li>
            {activity.map((a) => {
              const { mode, label } = modeAndLabel(a)
              return (
                // Grid row: time | mode | status | by | action | tx, details under the action.
                <li key={a.id} className="activity-row">
                  <span className="muted small mono">{formatTime(a.at)}</span>
                  <span>
                    {mode && (
                      <Tag tone={MODE_TONES[mode]} caps fixed>
                        {MODE_LABELS[mode]}
                      </Tag>
                    )}
                  </span>
                  <span>
                    <Badge tone={TONES[a.status] ?? 'neutral'}>{a.status}</Badge>
                  </span>
                  <strong className="activity-role">{actorName(a.role)}</strong>
                  <span className="activity-label">{label}</span>
                  <span className="activity-tx">{a.txHash && <TxLink hash={a.txHash} />}</span>
                  {(a.detail || a.lines?.length || a.safeTxHash) && (
                    <div className="activity-more small">
                      {a.detail &&
                        (FAILED.includes(a.status) ? (
                          <ErrorLine message={a.detail} />
                        ) : (
                          <span className="muted">{a.detail}</span>
                        ))}
                      <Details a={a} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        ))}
    </section>
  )
}
