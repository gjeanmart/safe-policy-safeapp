import { useEffect } from 'react'
import { isAddressEqual } from 'viem'
import { guardAbi } from '../../abi'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useGuardTiming } from '../../hooks/useGuardTiming'
import { useNow } from '../../hooks/useNow'
import { formatDuration } from '../../lib/format'
import { rootOutcome } from '../../lib/policyEvents'
import { safeTxs } from '../../lib/safe'
import { type PendingConfiguration, pendingStore } from '../../store'
import { ProposeButton } from '../ProposeButton'
import { Badge, Card } from '../ui'
import { ConfigurationTable, useActiveKeys } from './PolicyBuilder'
import { Tooltip } from '../Tooltip'

const REFRESH_MS = 5_000
const OUTCOME_REFRESH_MS = 15_000

type Status =
  | { kind: 'unknown' }
  | { kind: 'not-requested' }
  | { kind: 'pending'; secondsLeft: number }
  | { kind: 'ready'; secondsLeft: number }
  | { kind: 'expired' }

function statusOf(validFrom: bigint | undefined, expiry: bigint | undefined, now: number): Status {
  if (validFrom === undefined || expiry === undefined) return { kind: 'unknown' }
  if (validFrom === 0n) return { kind: 'not-requested' }
  const from = Number(validFrom)
  if (now < from) return { kind: 'pending', secondsLeft: from - now }
  const until = from + Number(expiry)
  return now < until ? { kind: 'ready', secondsLeft: until - now } : { kind: 'expired' }
}

function PendingRow({ pending, expiry }: { pending: PendingConfiguration; expiry?: bigint }) {
  const { safe } = useSandbox()
  const now = useNow()
  const activeKeys = useActiveKeys()
  const validFrom = useAsync(
    () =>
      publicClient.readContract({
        address: pending.guard,
        abi: guardAbi,
        functionName: 'rootConfigured',
        args: [safe, pending.root],
      }),
    `${pending.guard}:${pending.root}:${safe}`,
    REFRESH_MS,
  )
  const status = statusOf(validFrom.data, expiry, now)
  const forget = () => pendingStore.set((list) => list.filter((p) => p.root !== pending.root))

  // A zero `rootConfigured` is ambiguous; the root's events tell whether it is already settled.
  const outcome = useAsync(
    async () =>
      validFrom.data === 0n
        ? rootOutcome(pending.guard, safe, pending.root, Math.floor(pending.createdAt / 1000))
        : undefined,
    `${pending.guard}:${pending.root}:${safe}:${validFrom.data === 0n}`,
    OUTCOME_REFRESH_MS,
  )
  useEffect(() => {
    if (outcome.data) pendingStore.set((list) => list.filter((p) => p.root !== pending.root))
  }, [outcome.data, pending.root])

  return (
    <div className="pending">
      <div className="row wrap">
        <span className="mono small">{pending.root}</span>
        {status.kind === 'not-requested' && (
          <Badge>
            {outcome.loading ? 'checking…' : 'request not executed yet: sign it in the Safe{Wallet} queue'}
          </Badge>
        )}
        {status.kind === 'pending' && (
          <Badge tone="warn">matures in {formatDuration(status.secondsLeft)}</Badge>
        )}
        {status.kind === 'ready' && (
          <Badge tone="ok">ready · expires in {formatDuration(status.secondsLeft)}</Badge>
        )}
        {status.kind === 'expired' && <Badge tone="bad">expired</Badge>}
      </div>
      <ConfigurationTable configurations={pending.configurations} activeKeys={activeKeys} />
      <div className="row wrap pending-actions">
        {status.kind === 'ready' && (
          <ProposeButton
            label="Propose apply"
            title="Propose applyConfiguration with these configurations: they take effect once executed"
            txs={[safeTxs.applyConfiguration(pending.guard, pending.configurations)]}
            preview={false}
          />
        )}
        {(status.kind === 'pending' || status.kind === 'ready') && (
          <ProposeButton
            label="Propose invalidate"
            title="Propose invalidateRoot: cancels this request so it can never be applied"
            variant="danger"
            txs={[safeTxs.invalidateRoot(pending.guard, pending.root)]}
            preview={false}
          />
        )}
        <Tooltip content="Drop this entry from the browser only; nothing changes on-chain">
          <button type="button" className="btn" onClick={forget}>
            Forget locally
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * Configuration requests created from this browser. The guard only stores roots, so the full
 * configuration list is kept locally to be able to apply it after the delay.
 */
export function PendingConfigs() {
  const { safe, guard } = useSandbox()
  const all = pendingStore.use()
  const timing = useGuardTiming(guard)
  const pending = all.filter((p) => isAddressEqual(p.safe, safe) && isAddressEqual(p.guard, guard))

  if (pending.length === 0) return null
  return (
    <Card title={`Pending policy changes (${pending.length})`}>
      {pending.map((p) => (
        <PendingRow key={p.root} pending={p} expiry={timing.data?.expiry} />
      ))}
    </Card>
  )
}
