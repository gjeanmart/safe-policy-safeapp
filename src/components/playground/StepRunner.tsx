import { useState } from 'react'
import { ADDRESS_BOOK } from '../../config/contracts'
import { useSandbox } from '../../context'
import { resolvePolicy } from '../../lib/moduleTx'
import { type RunMode, type Step, runSteps } from '../../lib/runner'
import type { Role } from '../../store'
import { AsyncButton } from '../ui'

type Resolution = { label: string; policy: string; fallback: boolean }

/**
 * Buttons to inspect, simulate and execute a list of module transactions as `role`.
 * `beforeSend` runs before anything is sent (not for simulations), e.g. to post an off-chain order.
 */
export function StepRunner({
  role,
  steps,
  beforeSend,
  onDone,
}: {
  role: Role
  steps: Step[]
  beforeSend?: () => Promise<void>
  onDone?: (ok: boolean) => void
}) {
  const { safe, guard, guardInstalled, reloadState } = useSandbox()
  const [resolutions, setResolutions] = useState<Resolution[]>()

  const run = async (mode: RunMode) => {
    if (mode !== 'simulate') await beforeSend?.()
    const ok = await runSteps(safe, role, steps, mode)
    if (mode !== 'simulate') reloadState()
    onDone?.(ok)
  }

  const check = async () => {
    const results = await Promise.all(
      steps.map(async ({ label, tx }) => {
        const { policy, isFallback } = await resolvePolicy(guard, safe, tx)
        return { label, policy, fallback: isFallback && !/^0x0+$/.test(policy) }
      }),
    )
    setResolutions(results)
  }

  const disabled = steps.length === 0
  return (
    <div className="stack">
      <div className="row wrap">
        <AsyncButton
          disabled={disabled || !guardInstalled}
          onClick={check}
          title="Which policy would the guard consult?"
        >
          Resolve policy
        </AsyncButton>
        <AsyncButton
          disabled={disabled}
          onClick={() => run('simulate')}
          title="Dry-run execTransactionFromModule as this role (eth_call): nothing is sent"
        >
          Simulate
        </AsyncButton>
        <AsyncButton
          variant="primary"
          disabled={disabled}
          onClick={() => run('execute')}
          title="Simulate, then send from the role's EOA only if the policies allow it"
        >
          Execute
        </AsyncButton>
        <AsyncButton
          variant="danger"
          disabled={disabled}
          onClick={() => run('force')}
          title="Skip the dry-run and send with a fixed gas limit so the revert lands on-chain"
        >
          Force-send
        </AsyncButton>
      </div>
      {resolutions && (
        <ul className="plain small">
          {resolutions.map((r) => (
            <li key={r.label}>
              {r.label} →{' '}
              {/^0x0+$/.test(r.policy) ? (
                <strong>no policy: denied</strong>
              ) : (
                <strong>{ADDRESS_BOOK[r.policy.toLowerCase()] ?? r.policy}</strong>
              )}
              {r.fallback && ' (fallback)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
