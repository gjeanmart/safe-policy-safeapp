import { useState } from 'react'
import { BaseError, InsufficientFundsError } from 'viem'
import { ADDRESS_BOOK } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { describeError } from '../../lib/errors'
import { resolvePolicy } from '../../lib/moduleTx'
import { type Executor, nestedModuleCall, resolveExecutor } from '../../lib/roleExec'
import { type RunMode, type Step, runSteps } from '../../lib/runner'
import { type Role, logActivity, roleKind } from '../../store'
import { AddressView, AsyncButton, CopyButton, Notice } from '../ui'

type Resolution = { label: string; policy: string; fallback: boolean }

/** Results only apply to the steps they were computed for; a new amount or recipient clears them. */
type Keyed<T> = { key: string; value: T }

const stepsKey = (steps: readonly Step[]) =>
  steps.map(({ tx }) => `${tx.to}:${tx.value}:${tx.data}:${tx.operation}`).join('|')

/** Turns a run failure into a message that says what to do about it. */
function explain(error: unknown, role: Role, executor?: Executor): string {
  if (error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError)) {
    // A Safe role's gas is paid by the owner EOA that sends its transaction.
    const payer = executor?.kind === 'safe-owner' ? executor.signer : role
    return `${payer.label} doesn't have enough Sepolia ETH to pay for gas. Top it up from the Roles tab.`
  }
  return describeError(error)
}

const TX_BUILDER_URL = 'https://apps-portal.safe.global/tx-builder'

/**
 * For roles that cannot send from this app (a multi-owner Safe, a contract): the exact call to make
 * from the role, i.e. `execTransactionFromModule` on the treasury Safe, one per step.
 */
function NestedCalls({ role, steps, reason }: { role: Role; steps: Step[]; reason: string }) {
  const { safe } = useSandbox()
  const isSafe = roleKind(role) === 'safe'
  return (
    <div className="nested-calls">
      <p className="muted small">
        {reason} Make {steps.length > 1 ? 'these calls' : 'this call'} from{' '}
        <AddressView address={role.address} />:
      </p>
      <ol className="plain small">
        {steps.map(({ label, tx }) => {
          const call = nestedModuleCall(safe, tx)
          return (
            <li key={label} className="nested-call">
              <div>
                <strong>{label}</strong>
              </div>
              <div>
                to <AddressView address={call.to} /> · value 0 · execTransactionFromModule
              </div>
              <div className="row">
                <code className="calldata">{call.data}</code>
                <CopyButton value={call.data} />
              </div>
            </li>
          )
        })}
      </ol>
      {isSafe && (
        <a
          className="small"
          href={`https://app.safe.global/apps/open?safe=sep:${role.address}&appUrl=${encodeURIComponent(TX_BUILDER_URL)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open {role.label} in Safe{'{Wallet}'} (Transaction Builder)
        </a>
      )}
    </div>
  )
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
  const [showCalls, setShowCalls] = useState(false)
  const executor = useAsync(() => resolveExecutor(role), `${role.address}:${roleKind(role)}`).data
  const manual = executor?.kind === 'manual' ? executor : undefined
  const sendTitle =
    executor?.kind === 'safe-owner'
      ? `Simulate, then sign as ${executor.signer.label} (owner of ${role.label}) and send it through that Safe`
      : "Simulate, then send from the role's EOA only if the policies allow it"

  const run = async (mode: RunMode) => {
    setError(undefined)
    try {
      if (mode !== 'simulate') await beforeSend?.()
      const ok = await runSteps(safe, role, steps, mode)
      onDone?.(ok)
    } catch (err) {
      const message = explain(err, role, executor)
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
        {manual ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => setShowCalls((v) => !v)}
          >
            {showCalls ? 'Hide transaction' : 'Show transaction'}
          </button>
        ) : (
          <>
            <AsyncButton
              variant="primary"
              disabled={disabled || !executor}
              onClick={() => run('execute')}
              title={sendTitle}
            >
              Execute
            </AsyncButton>
            <AsyncButton
              variant="danger"
              disabled={disabled || !executor}
              onClick={() => run('force')}
              title="Skip the dry-run and send with a fixed gas limit so the revert lands on-chain"
            >
              Force-send
            </AsyncButton>
          </>
        )}
      </div>
      {manual && showCalls && <NestedCalls role={role} steps={steps} reason={manual.reason} />}
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
