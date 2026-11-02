import { type Address, getAddress, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import {
  type Attachment,
  AttachmentKind,
  type FreezeView,
  type LabelContext,
  OP_DELEGATECALL,
  OWNERS,
  POLICY_INFO,
  type V2Deployment,
  actorLabel,
  amountLabel,
  attachmentRole,
  buildModel,
  callPhrase,
  durationLabel,
  readLimitRemaining,
  settingsLabel,
} from '../../lib/v2'
import { rolesStore } from '../../store'
import { InfoTip } from '../Tooltip'
import { AddressView, Badge, Card } from '../ui'
import { Chip, type ChipStatus, type ChipTone } from './Chip'

export type ChartAttachment = Attachment & { status: ChipStatus }

const settingsKey = (a: Attachment): string =>
  JSON.stringify([a.opMask, a.settings ?? null], (_, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  )

/**
 * Current attachments next to the draft's projection (and the builder's preview): what is live,
 * added, changed or about to be removed.
 */
export function diffAttachments(
  current: readonly Attachment[],
  projected: readonly Attachment[],
  preview: readonly Attachment[] = [],
): ChartAttachment[] {
  const byId = new Map(current.map((a) => [a.attachmentId, a]))
  const result: ChartAttachment[] = projected.map((a) => {
    const before = byId.get(a.attachmentId)
    const status: ChipStatus = !before ? 'added' : settingsKey(before) !== settingsKey(a) ? 'changed' : 'live'
    return { ...a, status }
  })
  for (const a of current)
    if (!projected.some((p) => p.attachmentId === a.attachmentId)) result.push({ ...a, status: 'removed' })
  for (const a of preview)
    if (!result.some((r) => r.attachmentId === a.attachmentId && r.status !== 'removed'))
      result.push({ ...a, status: 'preview' })
  return result
}

const TONES: Record<ReturnType<typeof attachmentRole>, ChipTone> = {
  canDo: 'allow',
  limitedBy: 'limit',
  protectedBy: 'protect',
  denied: 'deny',
}

/** `USDC.transfer`, `Limit 5,000 USDC / month`, `Timelock 24h · on Safe.*`. */
export function attachmentText(a: Attachment, ctx: LabelContext): string {
  const where = callPhrase(a.scope, ctx)
  if (a.kind === AttachmentKind.ALLOW)
    return `${where}${a.opMask & OP_DELEGATECALL ? ' (DELEGATECALL too)' : ''}`
  if (a.kind === AttachmentKind.DENY) return `Deny ${where}`
  const label = a.settings
    ? settingsLabel(a.settings, ctx)
    : a.policyName
      ? POLICY_INFO[a.policyName].label
      : `Unknown policy ${actorLabel(a.policy, ctx.nameOf)}`
  return a.scope.callMatch === 0 ? label : `${label} · on ${where}`
}

/** "4,200 USDC left, resets in 12d" for each token of a live Limit attachment. */
function LimitRemaining({
  a,
  deployment,
  ctx,
}: {
  a: Attachment
  deployment: V2Deployment
  ctx: LabelContext
}) {
  const { safe } = useSandbox()
  const now = useNow(10_000)
  const tokens = a.settings?.policy === 'limit' ? a.settings.settings.limits.map((l) => l.token) : []
  const remaining = useAsync(
    () =>
      Promise.all(tokens.map((t) => readLimitRemaining(publicClient, deployment, safe, a.attachmentId, t))),
    `${a.attachmentId}:${tokens.join(',')}`,
    30_000,
  )
  if (!remaining.data) return null
  return (
    <span className="muted small">
      {remaining.data.map((r, i) => {
        const end = r.period === 0n ? undefined : Number(r.windowStart + r.period)
        return (
          <span key={tokens[i]}>
            {i > 0 && ' · '}
            {amountLabel(tokens[i]!, r.available, ctx)} left
            {end !== undefined &&
              end > now &&
              `, resets in ${durationLabel(Math.max(60, Math.ceil((end - now) / 60) * 60))}`}
          </span>
        )
      })}
    </span>
  )
}

function FreezeBadge({ freeze, now }: { freeze?: FreezeView; now: number }) {
  if (!freeze || freeze.phase === 'none') return null
  const left = durationLabel(Math.max(60, Math.ceil((Number(freeze.until) - now) / 60) * 60))
  return freeze.phase === 'frozen' ? (
    <Badge tone="bad">frozen · {left} left</Badge>
  ) : (
    <Badge tone="warn">cooling down · {left}</Badge>
  )
}

function ChipList({
  items,
  deployment,
  ctx,
  onDetach,
  showRemaining,
}: {
  items: readonly ChartAttachment[]
  deployment: V2Deployment
  ctx: LabelContext
  onDetach?: (a: Attachment) => void
  showRemaining?: boolean
}) {
  return (
    <div className="chip-list">
      {items.map((a) => (
        <span key={`${a.attachmentId}:${a.status}`} className="chip-row">
          <Chip
            tone={TONES[attachmentRole(a)]}
            status={a.status}
            title={`Level ${a.level} · ${a.scopeKey.slice(0, 10)}…`}
            onRemove={onDetach && a.status !== 'preview' ? () => onDetach(a) : undefined}
          >
            {attachmentText(a, ctx)}
          </Chip>
          {showRemaining && a.policyName === 'limit' && a.status === 'live' && (
            <LimitRemaining a={a} deployment={deployment} ctx={ctx} />
          )}
        </span>
      ))}
    </div>
  )
}

const SECTIONS = [
  { role: 'canDo', title: 'Can do' },
  { role: 'limitedBy', title: 'Limited by' },
  { role: 'protectedBy', title: 'Protected by' },
  { role: 'denied', title: 'Denied' },
] as const

function ActorCard({
  actor,
  isModule,
  items,
  everyoneAllows,
  freeze,
  deployment,
  ctx,
  onDetach,
}: {
  actor: Address
  isModule: boolean
  items: ChartAttachment[]
  everyoneAllows: boolean
  freeze?: FreezeView
  deployment: V2Deployment
  ctx: LabelContext
  onDetach?: (a: Attachment) => void
}) {
  const now = useNow(10_000)
  const owners = isAddressEqual(actor, OWNERS)
  const visible = items.filter((a) => a.status !== 'removed')
  const canDo = visible.some((a) => a.kind === AttachmentKind.ALLOW)
  return (
    <div className="actor-card">
      <header className="row wrap">
        <strong>{actorLabel(actor, ctx.nameOf)}</strong>
        {!owners && <AddressView address={actor} name="" />}
        {owners ? (
          <Badge>multisig path</Badge>
        ) : isModule ? (
          <Badge tone="ok">module</Badge>
        ) : (
          <Badge tone="warn">not a module</Badge>
        )}
        <FreezeBadge freeze={freeze} now={now} />
      </header>
      {!canDo && (
        <p className="muted small">
          {everyoneAllows ? 'Can do only what Everyone may.' : 'Can do nothing: no Allow (deny by default).'}
        </p>
      )}
      {SECTIONS.map(({ role, title }) => {
        const list = items.filter((a) => attachmentRole(a) === role)
        if (list.length === 0) return null
        return (
          <div key={role} className="actor-section">
            <span className="field-label">{title}</span>
            <ChipList items={list} deployment={deployment} ctx={ctx} onDetach={onDetach} showRemaining />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Who can do what and what protects them: the "Everyone" band (global and call-wide scopes, the
 * Safe-wide freeze), then one card per actor (Owners, each module, each local role). Draft
 * changes and the builder's preview show in place; × on a chip queues a detach in the draft.
 */
export function OrgChart({
  deployment,
  current,
  items,
  freezeSafe,
  freezes,
  guardians,
  ctx,
  onDetach,
}: {
  deployment: V2Deployment
  current: readonly Attachment[]
  items: readonly ChartAttachment[]
  freezeSafe: FreezeView
  freezes: ReadonlyMap<string, FreezeView>
  guardians: readonly Address[]
  ctx: LabelContext
  onDetach?: (a: Attachment) => void
}) {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  const now = useNow(10_000)
  const modules = state?.modules ?? []
  // Group by actor with buildModel, then put the status back on each attachment.
  const model = buildModel({
    safe,
    engine: deployment.engine,
    attachments: items,
    modules,
    roles: { guardians: [], lifters: [] },
    freezes: new Map(),
    now: 0n,
  })
  const statusOf = (a: Attachment) => (a as ChartAttachment).status
  const withStatus = (list: readonly Attachment[]) => list.map((a) => ({ ...a, status: statusOf(a) }))
  const extraRoles = roles.filter((r) => !model.actors.some((c) => isAddressEqual(c.actor, r.address)))
  const everyone = withStatus(model.everyone)
  const everyoneAllows = everyone.some((a) => a.kind === AttachmentKind.ALLOW && a.status !== 'removed')

  return (
    <Card
      title={
        <span className="row">
          Who can do what
          <InfoTip>
            Every matching scope runs: Everyone&apos;s attachments apply to every actor, owners included. Any
            deny wins, at least one Allow is needed, protections only pass or deny. × queues a detach in the
            draft below; dashed chips are draft changes.
          </InfoTip>
        </span>
      }
    >
      <div className="everyone-band">
        <header className="row wrap">
          <strong>Everyone</strong>
          <span className="muted small">global and call-wide scopes, every actor</span>
          <FreezeBadge freeze={freezeSafe} now={now} />
          {freezeSafe.phase === 'none' && <Badge tone="ok">Safe active</Badge>}
          <span className="muted small">
            {guardians.length} guardian{guardians.length === 1 ? '' : 's'}
          </span>
        </header>
        {everyone.length === 0 ? (
          <p className="muted small">Nothing attached for everyone.</p>
        ) : (
          <ChipList items={everyone} deployment={deployment} ctx={ctx} onDetach={onDetach} />
        )}
      </div>
      <div className="actor-grid">
        {model.actors.map((card) => (
          <ActorCard
            key={card.actor}
            actor={card.actor}
            isModule={card.isModule}
            items={withStatus(card.attachments)}
            everyoneAllows={everyoneAllows}
            freeze={freezes.get(getAddress(card.actor))}
            deployment={deployment}
            ctx={ctx}
            onDetach={onDetach}
          />
        ))}
        {extraRoles.map((r) => (
          <ActorCard
            key={r.address}
            actor={r.address}
            isModule={modules.some((m) => isAddressEqual(m, r.address))}
            items={[]}
            everyoneAllows={everyoneAllows}
            deployment={deployment}
            ctx={ctx}
          />
        ))}
      </div>
      {current.length === 0 && items.length === 0 && (
        <p className="muted small">No attachment yet: start from a template in the builder below.</p>
      )}
    </Card>
  )
}
