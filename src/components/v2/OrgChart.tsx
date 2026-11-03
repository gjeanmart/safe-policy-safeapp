import { type Address, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useNow } from '../../hooks/useNow'
import { formatDuration } from '../../lib/format'
import {
  type Attachment,
  CallMatch,
  Kind,
  type LabelContext,
  OP_DELEGATECALL,
  OWNERS,
  POLICY_INFO,
  type V2Deployment,
  actorLabel,
  amountLabel,
  argsLabel,
  attachmentRole,
  buildModel,
  callPhrase,
  freezePhase,
  levelLabel,
  limitResetsAt,
  opMaskLabel,
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

/** Current attachments next to the draft's projection and the builder's preview: live, added, changed, removed. */
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

/** An Allow and the conditions (Args) at the same scope shown as one row; other attachments alone. */
type Row = { main: ChartAttachment; conditions?: ChartAttachment }

function rowsOf(items: readonly ChartAttachment[]): Row[] {
  const used = new Set<ChartAttachment>()
  const rows: Row[] = []
  for (const a of items) {
    if (used.has(a)) continue
    if (a.kind === Kind.ALLOW) {
      const conditions = items.find(
        (c) => c.policyName === 'args' && c.scopeKey === a.scopeKey && !used.has(c),
      )
      if (conditions) used.add(conditions)
      rows.push({ main: a, conditions })
    } else rows.push({ main: a })
    used.add(a)
  }
  return rows
}

const roleOfRow = (r: Row) => attachmentRole(r.main)

const TONES: Record<ReturnType<typeof attachmentRole>, ChipTone> = {
  canDo: 'allow',
  limitedBy: 'limit',
  protectedBy: 'protect',
}

const ops = (a: Attachment) => {
  const defaultMask = a.kind === Kind.ALLOW ? 1 : 3
  return a.opMask === defaultMask ? '' : ` (${opMaskLabel(a.opMask)})`
}

/** `USDC.transfer to Vendor A`, `Budget 5,000 USDC / month`, `Timelock 24h, guardians G · on Safe.*`. */
export function attachmentText(a: Attachment, ctx: LabelContext, conditions?: Attachment): string {
  const where = callPhrase(a.scope, ctx)
  if (a.kind === Kind.ALLOW) {
    const cond =
      conditions?.settings?.policy === 'args' ? ` · ${argsLabel(conditions.settings.settings, ctx)}` : ''
    return `${where}${a.opMask & OP_DELEGATECALL ? ' (DELEGATECALL too)' : ''}${cond}`
  }
  if (a.kind === Kind.DENY) return `Deny ${where}${ops(a)}`
  const label = a.settings
    ? settingsLabel(a.settings, ctx)
    : a.policyName
      ? `${POLICY_INFO[a.policyName].label} (${a.settingsError ? 'settings unreadable' : 'no settings'})`
      : `Unknown policy ${actorLabel(a.policy, ctx.nameOf)}`
  return a.scope.callMatch === CallMatch.ANY ? `${label}${ops(a)}` : `${label} · on ${where}${ops(a)}`
}

/** "4,200 USDC left, resets in 12d" for each token of a live budget. */
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
        const end = limitResetsAt(r)
        return (
          <span key={tokens[i]}>
            {i > 0 && ' · '}
            {amountLabel(tokens[i]!, r.available, ctx)} left
            {end !== undefined && Number(end) > now ? `, resets in ${formatDuration(Number(end) - now)}` : ''}
            {end === undefined && ' (one-time)'}
          </span>
        )
      })}
    </span>
  )
}

/** Frozen / cooling-down badge of one Timelock attachment. */
export function FreezeBadge({ a, now }: { a: Attachment; now: number }) {
  const phase = freezePhase(a.freeze, BigInt(now))
  if (phase === 'active' || !a.freeze) return null
  return phase === 'frozen' ? (
    <Badge tone="bad">frozen · {formatDuration(Number(a.freeze.frozenUntil) - now)} left</Badge>
  ) : (
    <Badge tone="warn">cooldown · {formatDuration(Number(a.freeze.cooldownUntil) - now)}</Badge>
  )
}

function RowList({
  rows,
  deployment,
  ctx,
  onDetach,
}: {
  rows: readonly Row[]
  deployment: V2Deployment
  ctx: LabelContext
  onDetach?: (attachments: Attachment[]) => void
}) {
  const now = useNow(10_000)
  return (
    <div className="chip-list">
      {rows.map(({ main, conditions }) => (
        <span key={`${main.attachmentId}:${main.status}`} className="chip-row">
          <Chip
            tone={TONES[attachmentRole(main)]}
            status={
              conditions && conditions.status !== 'live' && main.status === 'live'
                ? conditions.status
                : main.status
            }
            title={`${levelLabel(main.level)} · ${opMaskLabel(main.opMask)} · ${main.attachmentId.slice(0, 10)}…`}
            onRemove={
              onDetach && main.status !== 'preview'
                ? () => onDetach(conditions ? [main, conditions] : [main])
                : undefined
            }
          >
            {attachmentText(main, ctx, conditions)}
          </Chip>
          {main.policyName === 'timelock' && <FreezeBadge a={main} now={now} />}
          {main.policyName === 'limit' && main.status === 'live' && (
            <LimitRemaining a={main} deployment={deployment} ctx={ctx} />
          )}
        </span>
      ))}
    </div>
  )
}

const SECTIONS = [
  { role: 'canDo', title: 'Can do', empty: 'Nothing: no Allow (deny by default).' },
  { role: 'limitedBy', title: 'Limited by' },
  { role: 'protectedBy', title: 'Protected by' },
] as const

function ActorCard({
  actor,
  isModule,
  items,
  deployment,
  ctx,
  onDetach,
}: {
  actor: Address
  isModule: boolean
  items: ChartAttachment[]
  deployment: V2Deployment
  ctx: LabelContext
  onDetach?: (attachments: Attachment[]) => void
}) {
  const owners = isAddressEqual(actor, OWNERS)
  const rows = rowsOf(items)
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
      </header>
      {SECTIONS.map((s) => {
        const list = rows.filter((r) => roleOfRow(r) === s.role && r.main.status !== 'removed')
        const removed = rows.filter((r) => roleOfRow(r) === s.role && r.main.status === 'removed')
        if (list.length === 0 && removed.length === 0) {
          return 'empty' in s ? (
            <p key={s.role} className="muted small">
              {s.title}: {s.empty}
            </p>
          ) : null
        }
        return (
          <div key={s.role} className="actor-section">
            <span className="field-label">{s.title}</span>
            <RowList rows={[...list, ...removed]} deployment={deployment} ctx={ctx} onDetach={onDetach} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Who can do what and what protects them: the "Everyone" band (actor ANY), then one card per actor
 * (Owners, each module, each local role) with Can do / Limited by / Protected by. Draft changes
 * and the builder's preview show in place; × queues a detach in the draft.
 */
export function OrgChart({
  deployment,
  items,
  ctx,
  onDetach,
}: {
  deployment: V2Deployment
  items: readonly ChartAttachment[]
  ctx: LabelContext
  onDetach?: (attachments: Attachment[]) => void
}) {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  const modules = state?.modules ?? []
  const model = buildModel({ safe, engine: deployment.engine, attachments: items, modules, now: 0n })
  const statusOf = (a: Attachment) => (a as ChartAttachment).status
  const withStatus = (list: readonly Attachment[]) => list.map((a) => ({ ...a, status: statusOf(a) }))
  const extraRoles = roles.filter((r) => !model.actors.some((c) => isAddressEqual(c.actor, r.address)))
  const everyone = withStatus(model.everyone)

  return (
    <Card
      title={
        <span className="row">
          Who can do what
          <InfoTip>
            Every matching scope runs: Everyone&apos;s attachments apply to every actor, owners included. Any
            deny wins, an Allow is needed, policies only pass or deny. × queues a detach in the draft; dashed
            chips are draft changes.
          </InfoTip>
        </span>
      }
    >
      <div className="everyone-band">
        <header className="row wrap">
          <strong>Everyone</strong>
          <span className="muted small">applies to every actor, owners included</span>
        </header>
        {everyone.length === 0 ? (
          <p className="muted small">Nothing attached for everyone.</p>
        ) : (
          <RowList rows={rowsOf(everyone)} deployment={deployment} ctx={ctx} onDetach={onDetach} />
        )}
      </div>
      <div className="actor-grid">
        {model.actors.map((card) => (
          <ActorCard
            key={card.actor}
            actor={card.actor}
            isModule={card.isModule}
            items={withStatus(card.attachments)}
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
            deployment={deployment}
            ctx={ctx}
          />
        ))}
      </div>
      {items.length === 0 && (
        <p className="muted small">No attachment yet: start from the Owners template in the builder below.</p>
      )}
    </Card>
  )
}
