import { type Hex, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { EXPLORER } from '../../config/contracts'
import { describeError } from '../../lib/errors'
import { shortAddress } from '../../lib/format'
import { type DirectCall, sendCallAsRole, simulateCallAsRole } from '../../lib/roleExec'
import {
  type Activity,
  type Role,
  hasLocalKey,
  logActivity,
  relayStore,
  roleKind,
  rolesStore,
  updateActivity,
} from '../../store'
import { Term } from '../Term'
import { InfoTip } from '../Tooltip'

/** What the activity log keeps about a relayed call, besides its description. */
export type RelayLog = Pick<Activity, 'mode' | 'safeTxHash' | 'nonce' | 'lines'> & { label?: string }

/** Mode from the call's description when the caller gives none (freeze, lift, cancel…). */
const modeOf = (description: string): Activity['mode'] =>
  description.startsWith('schedule') ? 'schedule' : description.startsWith('cancel') ? 'cancel' : 'execute'

/**
 * Simulates then sends a direct call as `role`, logs it (with `log` details) and waits for the
 * receipt. A refused simulation or a failed send is logged too, so every attempt shows in Activity.
 */
export async function relay(
  role: Role,
  call: DirectCall & { description: string },
  log: RelayLog = {},
): Promise<Hex> {
  const { label = call.description, mode = modeOf(call.description), ...details } = log
  const denied = await simulateCallAsRole(role, call)
  if (denied) {
    logActivity({ role: role.address, mode, label, status: 'denied', detail: denied, ...details })
    throw new Error(denied)
  }
  let hash: Hex
  try {
    hash = await sendCallAsRole(role, call)
  } catch (error) {
    logActivity({
      role: role.address,
      mode,
      label,
      status: 'failed',
      detail: describeError(error),
      ...details,
    })
    throw error
  }
  const id = logActivity({
    role: role.address,
    mode,
    label,
    status: 'sent',
    txHash: hash,
    link: `${EXPLORER}/tx/${hash}`,
    ...details,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  updateActivity(id, { status: receipt.status === 'success' ? 'confirmed' : 'reverted' })
  if (receipt.status !== 'success') throw new Error(`Reverted on-chain (${shortAddress(hash)})`)
  return hash
}

/** Keys that can relay, relayer roles first, then the other local EOA roles. */
export function useRelayers(): Role[] {
  const keyed = rolesStore.use().filter(hasLocalKey)
  return [...keyed.filter((r) => roleKind(r) === 'relayer'), ...keyed.filter((r) => roleKind(r) === 'eoa')]
}

/** The relayer picked in the Queue, else the first relayer role, else any local EOA role. */
export function useRelayer(): Role | undefined {
  const relayers = useRelayers()
  const { relayer } = relayStore.use()
  return relayers.find((r) => relayer && isAddressEqual(r.address, relayer)) ?? relayers[0]
}

/** One relayer for every schedule, execute and cancel the app sends, plus the auto-schedule switch. */
export function RelayerBar() {
  const relayers = useRelayers()
  const current = useRelayer()
  const { autoSchedule } = relayStore.use()
  if (relayers.length === 0)
    return (
      <p className="small muted">
        No <Term k="relayer">relayer</Term> yet: add one in Roles (Add role, Relayer) to schedule and execute.
      </p>
    )
  return (
    <div className="row wrap small">
      <label className="row">
        <Term k="relayer">Relayer</Term>
        <select
          value={current?.address ?? ''}
          onChange={(e) => relayStore.set((s) => ({ ...s, relayer: e.target.value as Hex }))}
        >
          {relayers.map((r) => (
            <option key={r.address} value={r.address}>
              {r.label}
              {roleKind(r) === 'relayer' ? ' (relayer)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={autoSchedule}
          onChange={(e) => relayStore.set((s) => ({ ...s, autoSchedule: e.target.checked }))}
        />
        Auto-schedule with {current?.label}
        <InfoTip>
          While the app is open, an owner transaction is scheduled as soon as it has all its signatures. Each
          send is simulated first and logged in Activity.
        </InfoTip>
      </label>
    </div>
  )
}
