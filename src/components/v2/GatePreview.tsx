import { useState } from 'react'
import { EXPLORER, type V2Engine } from '../../config/contracts'
import { publicClient } from '../../config/client'
import { useSandbox } from '../../context'
import type { Step } from '../../lib/runner'
import { sendCallAsRole, simulateCallAsRole } from '../../lib/roleExec'
import {
  type Gate,
  GateKind,
  type LabelContext,
  POLICY_INFO,
  type PreviewResult,
  VERDICT_LABELS,
  Verdict,
  collapseGates,
  gateLevelLabel,
  runPreview,
  timelockCalls,
} from '../../lib/v2'
import { type Role, logActivity } from '../../store'
import { AsyncButton, Badge, Notice } from '../ui'
import { Chip, type ChipTone } from './Chip'
import { useLabelContext } from './useV2'

const verdictTone = (v: Verdict): ChipTone =>
  v === Verdict.ALLOW ? 'allow' : v === Verdict.DENY ? 'deny' : 'neutral'

const gateName = (g: Gate): string => {
  if (g.kind === GateKind.ALLOW) return 'Allow'
  if (g.kind === GateKind.DENY) return 'Deny'
  if (g.kind === GateKind.RULE) return g.error?.name ?? 'Engine rule'
  return g.policyName ? POLICY_INFO[g.policyName].label : 'Policy'
}

function GateChips({ gates, deciding }: { gates: readonly Gate[]; deciding?: Gate }) {
  return (
    <div className="chip-list">
      {collapseGates(gates).map((g, i) => {
        const isDeciding =
          deciding !== undefined &&
          g.attachmentIds.includes(deciding.attachmentId) &&
          g.verdict === deciding.verdict &&
          g.callIndex === deciding.callIndex &&
          g.kind === deciding.kind
        return (
          <span key={i} className={isDeciding ? 'gate gate-deciding' : 'gate'}>
            <Chip
              tone={verdictTone(g.verdict)}
              title={
                <>
                  {gateLevelLabel(g)}
                  {g.attachmentIds.length > 1 && ` · ${g.attachmentIds.length} attachments`}
                  {g.reasonText && (
                    <>
                      <br />
                      {g.reasonText}
                    </>
                  )}
                </>
              }
            >
              {gateName(g)}: {VERDICT_LABELS[g.verdict]}
            </Chip>
          </span>
        )
      })}
    </div>
  )
}

/** The per-gate result of `preview` for one step: every gate, the deciding one, what is still needed. */
function PreviewView({ result }: { result: PreviewResult }) {
  if (!result.ok) return <Notice tone="bad">Preview failed: {result.reason}</Notice>
  const { outcome } = result
  return (
    <div className="stack gate-preview">
      {outcome.calls.map((c) => (
        <div key={c.callIndex}>
          {outcome.calls.length > 1 && <span className="field-label">Sub-call {c.callIndex}</span>}
          <GateChips gates={c.gates} deciding={outcome.deciding} />
        </div>
      ))}
      {outcome.transaction.length > 0 && (
        <div>
          <span className="field-label">Transaction</span>
          <GateChips gates={outcome.transaction} deciding={outcome.deciding} />
        </div>
      )}
      <div className="row wrap">
        {outcome.allowed ? (
          <Badge tone="ok">allowed</Badge>
        ) : (
          <Badge tone={outcome.onlyNeeds ? 'warn' : 'bad'}>{outcome.onlyNeeds ? 'needs' : 'denied'}</Badge>
        )}
        {outcome.deciding?.reasonText && <span className="small">{outcome.deciding.reasonText}</span>}
        {!outcome.allowed && outcome.deciding && (
          <span className="muted small">
            deciding gate: {gateName(outcome.deciding)} ({gateLevelLabel(outcome.deciding)})
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * V2 replacement of "Resolve policy" in the playground: runs the engine's `preview` for each step as
 * this role (chips per gate, verdicts, the deciding gate) and, when a Timelock asks for a schedule,
 * a Schedule step sent by the role itself (`scheduleModuleTx`: the module is `msg.sender`).
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
  const ctx: LabelContext = useLabelContext(engine)
  const [results, setResults] = useState<{ key: string; value: PreviewResult[] }>()
  const key =
    steps.map((s) => `${s.tx.to}:${s.tx.value}:${s.tx.data}:${s.tx.operation}`).join('|') + role.address

  const preview = async () => {
    const value = await Promise.all(
      steps.map((s) => runPreview(publicClient, engine.deployment, safe, role.address, s.tx, ctx)),
    )
    setResults({ key, value })
  }
  const current = results?.key === key ? results.value : undefined
  const needsSchedule = current?.some((r) => r.ok && r.outcome.needs.includes('schedule'))

  const schedule = async () => {
    for (const [i, s] of steps.entries()) {
      const r = current?.[i]
      if (!r?.ok || !r.outcome.needs.includes('schedule')) continue
      const call = timelockCalls.scheduleModuleTx(engine.deployment, safe, s.tx)
      const denied = await simulateCallAsRole(role, call)
      if (denied) throw new Error(denied)
      const hash = await sendCallAsRole(role, call)
      logActivity({
        role: role.address,
        mode: 'execute',
        label: `schedule: ${s.label}`,
        status: 'sent',
        txHash: hash,
        link: `${EXPLORER}/tx/${hash}`,
      })
      await publicClient.waitForTransactionReceipt({ hash })
    }
    await preview()
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <AsyncButton
          onClick={preview}
          title="Runs every gate of the V2 engine (preview, eth_call): nothing is sent"
        >
          Preview gates
        </AsyncButton>
        {needsSchedule && (
          <AsyncButton
            variant="primary"
            onClick={schedule}
            title={`${role.label} sends TimelockPolicy.scheduleModuleTx for this exact call; execute it once the delay has passed (Timelock queue)`}
          >
            Schedule (Timelock)
          </AsyncButton>
        )}
      </div>
      {current?.map((r, i) => (
        <div key={i}>
          {steps.length > 1 && <strong className="small">{steps[i]!.label}</strong>}
          <PreviewView result={r} />
        </div>
      ))}
    </div>
  )
}
