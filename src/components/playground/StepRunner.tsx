import { useState } from 'react'
import { BaseError, InsufficientFundsError } from 'viem'
import { ADDRESS_BOOK } from '../../config/contracts'
import { useSandbox } from '../../context'
import { describeError } from '../../lib/errors'
import { resolvePolicy } from '../../lib/moduleTx'
import { type RunMode, type Step, runSteps } from '../../lib/runner'
import { type Role, logActivity } from '../../store'
import { AsyncButton, Notice } from '../ui'

type Resolution = { label: string; policy: string; fallback: boolean }

/** Results only apply to the steps they were computed for; a new amount or recipient clears them. */
type Keyed<T> = { key: string; value: T }

const stepsKey = (steps: readonly Step[]) =>
  steps.map(({ tx }) => `${tx.to}:${tx.value}:${tx.data}:${tx.operation}`).join('|')

/** Turns a run failure into a message that says what to do about it. */
function explain(error: unknown, role: Role): string {
  if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError)) {
    return `${role.label} doesn't have enough Sepolia ETH to pay for gas. Top it up from the Roles tab.`
  }
  return describeError(error)
}

/**
 * Buttons to inspect, simulate and execute a list of module transactions as `role`.
 * `beforeSend` runs before anything is sent (not for simulations), e.g. to post an off-chain order.
 * Policy decisions go to the activity log; failures to run at all (gas, RPC…) show under the buttons.
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
  const key = stepsKey(steps)
  const [resolutions, setResolutions] = useState<Keyed<Resolution[]>>()
  const [error, setError] = useState<Keyed<string>>()

  const run = async (mode: RunMode) => {
    setError(undefined)
    try {
      if (mode !== 'simulate') await beforeSend?.()
      const ok = await runSteps(safe, role, steps, mode)
      onDone?.(ok)
    } catch (err) {
      const message = explain(err, role)
      setError({ key, value: message })
      logActivity({
        role: role.address,
        mode,
        label: steps.map((s) => s.label).join(' → '),
        status: 'failed',
        detail: message,
      })
    } finally {
      if (mode !== 'simulate') reloadState()
    }
  }

  const check = async () => {
    setError(undefined)
    try {
      const results = await Promise.all(
        steps.map(async ({ label, tx }) => {
          const { policy, isFallback } = await resolvePolicy(guard, safe, tx)
          return { label, policy, fallback: isFallback && !/^0x0+$/.test(policy) }
        }),
      )
      setResolutions({ key, value: results })
    } catch (err) {
      setError({ key, value: describeError(err) })
    }
  }

  const disabled = steps.length === 0
  return (
    <div className="stack">
      <div className="row wrap step-actions">
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
      {error?.key === key && <Notice tone="bad">{error.value}</Notice>}
      {resolutions?.key === key && (
        <ul className="plain small">
          {resolutions.value.map((r) => (
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
