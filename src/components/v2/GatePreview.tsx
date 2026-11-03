import { useState } from 'react'
import { type Hex, isAddressEqual } from 'viem'
import { chain, publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import type { Step } from '../../lib/runner'
import {
  type Gate,
  type LabelContext,
  type PreviewResult,
  coSignerCalls,
  gateName,
  levelLabel,
  readPolicySettings,
  runPreview,
  timelockCalls,
} from '../../lib/v2'
import { type Role, logActivity, roleKind, rolesStore } from '../../store'
import { Term } from '../Term'
import { AsyncButton, Badge, Notice } from '../ui'
import { Chip, type ChipTone } from './Chip'
import { type ModuleEntry, ModuleEntryRow } from './QueueRows'
import { relay } from './relayer'
import { useLabelContext, useV2 } from './useV2'

/** Approvals pushed from the playground are valid for an hour. */
const APPROVAL_LIFETIME = 3600n

const TONES: Record<Gate['verdict'], ChipTone> = {
  grant: 'allow',
  'not-counted': 'neutral',
  pass: 'protect',
  deny: 'deny',
}
const VERDICTS: Record<Gate['verdict'], string> = {
  grant: 'grants',
  'not-counted': 'does not count',
  pass: 'pass',
  deny: 'deny',
}

function GateChips({ gates, deciding }: { gates: readonly Gate[]; deciding?: Gate }) {
  return (
    <div className="chip-list">
      {gates.map((g, i) => (
        <span key={i} className={g === deciding ? 'gate gate-deciding' : 'gate'}>
          <Chip
            tone={TONES[g.verdict]}
            title={
              <>
                {g.level !== undefined && levelLabel(g.level)}
                {g.callIndex !== undefined && ` · call ${g.callIndex}`}
                {g.matches && ` · ${g.matches.length} match${g.matches.length === 1 ? '' : 'es'}`}
                <br />
                {g.reasonText}
              </>
            }
          >
            {gateName(g)}: {VERDICTS[g.verdict]}
          </Chip>
        </span>
      ))}
    </div>
  )
}

export function PreviewView({ result }: { result: PreviewResult }) {
  if (!result.ok)
    return (
      <Notice tone="bad" title="Could not simulate">
        {result.reason}
      </Notice>
    )
  const { outcome } = result
  return (
    <div className="stack gate-preview">
      {outcome.calls.length > 1 && <span className="field-label">Batch of {outcome.calls.length} calls</span>}
      <GateChips gates={outcome.gates} deciding={outcome.deciding} />
      <div className="row wrap">
        {outcome.allowed ? (
          <Badge tone="ok">allowed</Badge>
        ) : (
          <Badge tone={outcome.onlyNeeds ? 'warn' : 'bad'}>{outcome.onlyNeeds ? 'needs' : 'denied'}</Badge>
        )}
        {outcome.deciding?.reasonText && <span className="small">{outcome.deciding.reasonText}</span>}
        {!outcome.allowed && outcome.deciding && (
          <span className="muted small">deciding gate: {gateName(outcome.deciding)}</span>
        )}
      </div>
    </div>
  )
}

/** The schedules a role just made, followed in place: countdown, simulate at ready time, execute. */
function Scheduled({ entries }: { entries: readonly ModuleEntry[] }) {
  const view = useV2()
  if (!view.model) return null
  return (
    <ul className="plain inline-row">
      {entries.map((e) => (
        <ModuleEntryRow
          key={e.txHash}
          entry={e}
          engine={view.engine}
          model={view.model!}
          ctx={view.ctx}
          onChange={view.reload}
        />
      ))}
    </ul>
  )
}

/**
 * The playground's V2 gate preview: `matches` plus an `eth_call` of each matched policy's `check`
 * from the engine (chips per gate, the deciding one, what is still needed). When a Timelock asks
 * for a schedule, the role schedules its own call (`scheduleModuleTx`); when a co-signer approval
 * is missing and a local key is an approver, it approves on-chain.
 */
export function GatePreview({
  role,
  steps,
  engine,
}: {
  role: Role
  steps: readonly Step[]
  engine: V2Engine
}) {
  const { safe } = useSandbox()
  const roles = rolesStore.use()
  const ctx: LabelContext = useLabelContext(engine)
  const [results, setResults] = useState<{ key: string; value: PreviewResult[] }>()
  const [scheduled, setScheduled] = useState<{ key: string; value: ModuleEntry[] }>()
  const key =
    steps.map((s) => `${s.tx.to}:${s.tx.value}:${s.tx.data}:${s.tx.operation}`).join('|') + role.address

  const preview = async () => {
    const value = await Promise.all(
      steps.map((s) =>
        runPreview(publicClient, engine.deployment, safe, role.address, s.tx, { chainId: chain.id, ctx }),
      ),
    )
    setResults({ key, value })
    return value
  }

  const simulate = async () => {
    const value = await preview()
    for (const [i, r] of value.entries()) {
      const label = steps[i]!.label
      if (!r.ok) {
        logActivity({ role: role.address, mode: 'simulate', label, status: 'failed', detail: r.reason })
        continue
      }
      const { outcome } = r
      logActivity({
        role: role.address,
        mode: 'simulate',
        label,
        status: outcome.allowed ? 'allowed' : 'denied',
        detail: outcome.allowed ? undefined : outcome.deciding?.reasonText,
      })
    }
  }
  const current = results?.key === key ? results.value : undefined
  const needs = (n: string) => current?.some((r) => r.ok && r.outcome.needs.includes(n as never))

  const send = (from: Role, call: { to: `0x${string}`; data: Hex; description: string }, label: string) =>
    relay(from, call, { label })

  const schedule = async () => {
    const done: ModuleEntry[] = []
    for (const [i, s] of steps.entries()) {
      const r = current?.[i]
      if (!r?.ok || !r.outcome.needs.includes('schedule')) continue
      await send(role, timelockCalls.scheduleModuleTx(engine.deployment, safe, s.tx), `Schedule: ${s.label}`)
      done.push({ ...s.tx, txHash: r.outcome.txHash, actor: role.address, isConfiguration: false })
    }
    setScheduled({ key, value: done })
    await preview()
  }

  const approve = async () => {
    const until = BigInt(Math.floor(Date.now() / 1000)) + APPROVAL_LIFETIME
    let sent = 0
    for (const [i, s] of steps.entries()) {
      const r = current?.[i]
      if (!r?.ok) continue
      for (const g of r.outcome.denies.filter((d) => d.error?.name === 'MissingApprovals')) {
        const id = g.error!.args[0] as Hex
        const settings = await readPolicySettings(publicClient, engine.deployment, safe, 'coSigner', id)
        if (settings.policy !== 'coSigner') continue
        for (const approver of settings.settings.approvers) {
          const local = roles.find((x) => roleKind(x) === 'eoa' && isAddressEqual(x.address, approver))
          if (!local) continue
          await send(
            local,
            coSignerCalls.approve(engine.deployment, safe, r.outcome.txHash, until),
            `Approve: ${s.label}`,
          )
          sent++
        }
      }
    }
    if (sent === 0)
      throw new Error(
        'No local key is an approver of the missing co-signer: approve from the co-signer service',
      )
    await preview()
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <AsyncButton
          onClick={simulate}
          busyLabel="Simulating…"
          title="Checks every gate now (eth_call from the engine): nothing is sent"
        >
          Simulate
        </AsyncButton>
        {needs('schedule') && (
          <AsyncButton
            variant="primary"
            onClick={schedule}
            busyLabel="Scheduling…"
            title={`${role.label} schedules this exact call; it can execute once the delay has passed`}
          >
            Schedule
          </AsyncButton>
        )}
        {needs('schedule') && (
          <span className="small muted">
            A <Term k="timelock">Timelock</Term> applies: <Term k="schedule">schedule</Term>, wait, then
            execute.
          </span>
        )}
        {needs('approval') && (
          <AsyncButton
            variant="primary"
            busyLabel="Approving…"
            onClick={approve}
            title="A local key listed as approver calls CoSignerPolicy.approve for this transaction hash (valid 1h, consumed on execution)"
          >
            Approve (Co-signer)
          </AsyncButton>
        )}
      </div>
      {current?.map((r, i) => (
        <div key={i}>
          {steps.length > 1 && <strong className="small">{steps[i]!.label}</strong>}
          <PreviewView result={r} />
        </div>
      ))}
      {scheduled?.key === key && scheduled.value.length > 0 && <Scheduled entries={scheduled.value} />}
    </div>
  )
}
