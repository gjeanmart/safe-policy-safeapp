import { isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { formatDuration } from '../../lib/format'
import {
  type EngineInfo,
  type FreezeView,
  type LabelContext,
  type V2Deployment,
  describeChange,
  describeRoleChange,
  engineCalls,
  readRootValidFrom,
  rootStatus,
} from '../../lib/v2'
import { type V2PendingConfiguration, v2PendingStore } from '../../store'
import { ProposeButton } from '../ProposeButton'
import { Tooltip } from '../Tooltip'
import { Badge, Card } from '../ui'
import { toSafeTxs } from './ownerCalls'

const REFRESH_MS = 5_000

function PendingRow({
  pending,
  deployment,
  info,
  freeze,
  ctx,
}: {
  pending: V2PendingConfiguration
  deployment: V2Deployment
  info: EngineInfo
  freeze: FreezeView
  ctx: LabelContext
}) {
  const { safe } = useSandbox()
  const now = BigInt(useNow())
  const validFrom = useAsync(
    () => readRootValidFrom(publicClient, deployment.engine, safe, pending.root),
    `${deployment.engine}:${pending.root}`,
    REFRESH_MS,
  )
  const status = validFrom.data === undefined ? undefined : rootStatus(validFrom.data, info.expiry, now)
  const forget = () => v2PendingStore.set((list) => list.filter((p) => p.root !== pending.root))
  return (
    <div className="pending">
      <div className="row wrap">
        <span className="mono small">{pending.root}</span>
        {status === 'none' && (
          <Badge>not requested on-chain: not executed yet, or already applied / invalidated</Badge>
        )}
        {status === 'pending' && (
          <Badge tone="warn">applicable in {formatDuration(validFrom.data! - now)}</Badge>
        )}
        {status === 'ready' && (
          <Badge tone="ok">ready · expires in {formatDuration(validFrom.data! + info.expiry - now)}</Badge>
        )}
        {status === 'expired' && <Badge tone="bad">expired</Badge>}
        {status === 'ready' && freeze.phase === 'frozen' && <Badge tone="bad">frozen: apply refused</Badge>}
      </div>
      <ul className="plain small">
        {pending.set.changes.map((c, i) => (
          <li key={`c${i}`}>{describeChange(c, deployment, ctx)}</li>
        ))}
        {pending.set.roles.map((r, i) => (
          <li key={`r${i}`}>{describeRoleChange(r, ctx)}</li>
        ))}
      </ul>
      <div className="row wrap pending-actions">
        {status === 'ready' && (
          <ProposeButton
            label="Propose apply"
            txs={toSafeTxs([engineCalls.applyConfiguration(deployment.engine, pending.set)])}
            preview={false}
            info="applyConfiguration with this set (alone in its transaction: the engine refuses it inside a batch)."
          />
        )}
        {(status === 'pending' || status === 'ready') && (
          <ProposeButton
            label="Propose invalidate"
            variant="danger"
            txs={toSafeTxs([engineCalls.invalidateRoot(deployment.engine, pending.root)])}
            preview={false}
            info="invalidateRoot: this request can never be applied. Allowed during a freeze."
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

/** V2 configuration requests made from this browser (the engine only stores roots). */
export function PendingV2Configs({
  deployment,
  info,
  freeze,
  ctx,
}: {
  deployment: V2Deployment
  info: EngineInfo | undefined
  freeze: FreezeView
  ctx: LabelContext
}) {
  const { safe } = useSandbox()
  const all = v2PendingStore.use()
  const pending = all.filter(
    (p) => isAddressEqual(p.safe, safe) && isAddressEqual(p.engine, deployment.engine),
  )
  if (pending.length === 0 || !info) return null
  return (
    <Card title={`Pending configuration (${pending.length})`}>
      {pending.map((p) => (
        <PendingRow key={p.root} pending={p} deployment={deployment} info={info} freeze={freeze} ctx={ctx} />
      ))}
    </Card>
  )
}
