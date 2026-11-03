import { type Hex, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { EXPLORER } from '../../config/contracts'
import { shortAddress } from '../../lib/format'
import { type DirectCall, sendCallAsRole, simulateCallAsRole } from '../../lib/roleExec'
import { type Role, hasLocalKey, logActivity, relayStore, roleKind, rolesStore } from '../../store'
import { InfoTip } from '../Tooltip'

/** Simulates then sends a direct call as `role`, logs it and waits for the receipt. */
export async function relay(role: Role, call: DirectCall & { description: string }): Promise<Hex> {
  const denied = await simulateCallAsRole(role, call)
  if (denied) throw new Error(denied)
  const hash = await sendCallAsRole(role, call)
  logActivity({
    role: role.address,
    mode: 'execute',
    label: call.description,
    status: 'sent',
    txHash: hash,
    link: `${EXPLORER}/tx/${hash}`,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
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
        No key in this browser can pay gas to schedule or execute. Roles → Add role → Relayer.
      </p>
    )
  return (
    <div className="row wrap small">
      <label className="row">
        Relayer (pays gas)
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
        <InfoTip>
          Scheduling and executing a signed owner transaction are plain calls that carry the owners&apos;
          signatures: any key with some Sepolia ETH can send them, and gains no power by doing so.
        </InfoTip>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={autoSchedule}
          onChange={(e) => relayStore.set((s) => ({ ...s, autoSchedule: e.target.checked }))}
        />
        Auto-schedule with {current?.label}
        <InfoTip>
          While the app is open, a tracked owner transaction is scheduled as soon as it has all its
          signatures. Each send is simulated first and logged in the activity log.
        </InfoTip>
      </label>
    </div>
  )
}
