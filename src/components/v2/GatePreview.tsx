import { type ReactNode, useState } from 'react'
import { type Hex, isAddressEqual } from 'viem'
import { chain, publicClient } from '../../config/client'
import type { V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import type { Step } from '../../lib/runner'
import {
  type Gate,
  type LabelContext,
  type Need,
  type PreviewResult,
  coSignerCalls,
  gateName,
  levelLabel,
  readPolicySettings,
  runPreview,
  timelockCalls,
} from '../../lib/v2'
import { type Role, logActivity, roleKind, rolesStore } from '../../store'
import { AsyncButton, Badge, Notice } from '../ui'
import { Chip, type ChipTone } from './Chip'
import { type ModuleEntry, ModuleEntryRow } from './QueueRows'
import { relay } from './relayer'
import { useLabelContext, useV2 } from './useV2'

/** Approvals pushed from the playground are valid for an hour. */
const APPROVAL_LIFETIME = 3600n
const approvalDeadline = () => BigInt(Math.floor(Date.now() / 1000)) + APPROVAL_LIFETIME

const TONES: Record<Gate['verdict'], ChipTone> = {
  grant: 'allow',
  'not-counted': 'neutral',
  pass: 'allow',
  deny: 'deny',
}
const VERDICTS: Record<Gate['verdict'], string> = {
  grant: 'grants',
  'not-counted': 'does not count',
  pass: 'pass',
  deny: 'deny',
}
/** A deny that only waits on a step (schedule, delay, approval): not a refusal, so yellow. */
const NEEDS: Record<Need, string> = {
  schedule: 'needs schedule',
  wait: 'waiting for the delay',
  approval: 'needs approval',
  attestation: 'needs attestation',
}

function GateChips({ gates, deciding }: { gates: readonly Gate[]; deciding?: Gate }) {
  return (
    <div className="chip-list">
      {gates.map((g, i) => (
        <span key={i} className={g === deciding ? 'gate gate-deciding' : 'gate'}>
          <Chip
            tone={g.verdict === 'deny' && g.needs ? 'protect' : TONES[g.verdict]}
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
            {gateName(g)}: {g.verdict === 'deny' && g.needs ? NEEDS[g.needs] : VERDICTS[g.verdict]}
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
          <Badge tone="ok">passes</Badge>
        ) : outcome.onlyNeeds ? (
          <Badge tone="warn">{outcome.needs.map((n) => NEEDS[n]).join(', ')}</Badge>
        ) : (
          <Badge tone="bad">denied</Badge>
        )}
        {outcome.deciding?.reasonText && <span className="small">{outcome.deciding.reasonText}</span>}
      </div>
    </div>
  )
}

/** Force-send and other escape hatches, folded away from the main flow. */
export function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="advanced small">
      <summary>Advanced</summary>
      <div className="row wrap">{children}</div>
    </details>
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
 * The playground's V2 flow for a module role: Simulate (every gate as a chip: `matches` plus an
 * `eth_call` of each matched policy's `check` from the engine), then only the next step it needs.
 * All gates pass: Execute. A Timelock asks for a schedule: Schedule, then the countdown, Simulate at
 * ready time and Execute once ready. A co-signer approval is missing and a local key is an
 * approver: Approve.
 */
export function GatePreview({
  role,
  steps,
  engine,
  execute,
  manual,
}: {
  role: Role
  steps: readonly Step[]
  engine: V2Engine
  /** The send once every gate passes; undefined when the role cannot send from here. */
  execute?: { run: () => Promise<boolean>; title: string }
  /** Shown instead of Execute when the role cannot send from here. */
  manual?: ReactNode
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
  const outcomes = current?.map((r) => (r.ok ? r.outcome : undefined))
  const needs = (n: Need) => !!outcomes?.some((o) => o?.needs.includes(n))
  const passes = !!outcomes && outcomes.every((o) => o?.allowed)
  const justScheduled = scheduled?.key === key ? scheduled.value : []
  // Scheduled here, or found waiting on a fresh simulation: follow them in place.
  const waiting: ModuleEntry[] = [
    ...justScheduled,
    ...steps.flatMap((s, i) => {
      const o = outcomes?.[i]
      return o?.needs.includes('wait') && !justScheduled.some((e) => e.txHash === o.txHash)
        ? [{ ...s.tx, txHash: o.txHash, actor: role.address, isConfiguration: false }]
        : []
    }),
  ]

  const send = (from: Role, call: { to: `0x${string}`; data: Hex; description: string }, label: string) =>
    relay(from, call, { label })

  const schedule = async () => {
    const done: ModuleEntry[] = []
    for (const [i, s] of steps.entries()) {
      const o = outcomes?.[i]
      if (!o?.needs.includes('schedule')) continue
      await send(role, timelockCalls.scheduleModuleTx(engine.deployment, safe, s.tx), `Schedule: ${s.label}`)
      done.push({ ...s.tx, txHash: o.txHash, actor: role.address, isConfiguration: false })
    }
    setScheduled({ key, value: done })
    await preview()
  }

  const approve = async () => {
    const until = approvalDeadline()
    let sent = 0
    for (const [i, s] of steps.entries()) {
      const o = outcomes?.[i]
      if (!o) continue
      for (const g of o.denies.filter((d) => d.error?.name === 'MissingApprovals')) {
        const id = g.error!.args[0] as Hex
        const settings = await readPolicySettings(publicClient, engine.deployment, safe, 'coSigner', id)
        if (settings.policy !== 'coSigner') continue
        for (const approver of settings.settings.approvers) {
          const local = roles.find((x) => roleKind(x) === 'eoa' && isAddressEqual(x.address, approver))
          if (!local) continue
          await send(
            local,
            coSignerCalls.approve(engine.deployment, safe, o.txHash, until),
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

  const run = async () => {
    if (!execute) return
    const ok = await execute.run()
    // Spent budgets, consumed approvals: the old verdict no longer holds.
    if (ok) setResults(undefined)
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <AsyncButton
          variant={current ? 'secondary' : 'primary'}
          onClick={simulate}
          busyLabel="Simulating…"
          title="Checks every gate now (eth_call from the engine): nothing is sent"
        >
          {current ? 'Simulate again' : 'Simulate'}
        </AsyncButton>
        {passes &&
          (execute ? (
            <AsyncButton variant="primary" onClick={run} busyLabel="Executing…" title={execute.title}>
              Execute
            </AsyncButton>
          ) : (
            manual
          ))}
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
      {waiting.length > 0 && <Scheduled entries={waiting} />}
    </div>
  )
}
