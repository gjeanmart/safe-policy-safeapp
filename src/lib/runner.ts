import type { Address } from 'viem'
import { publicClient } from '../config/client'
import { EXPLORER } from '../config/contracts'
import { type Role, logActivity, updateActivity } from '../store'
import { type ModuleTx, sendModuleTx, simulateModuleTx } from './moduleTx'
import { revealKey } from './vault'

export type RunMode = 'simulate' | 'execute' | 'force'

export type Step = { label: string; tx: ModuleTx }

/**
 * Runs module transactions in order, logging each outcome to the activity log.
 * - `simulate`: dry-run only.
 * - `execute`: dry-run, then send only if the policies allow it.
 * - `force`: send even if the dry-run fails, to watch the guard revert on-chain.
 * Stops at the first denied or reverted step. Returns whether every step went through.
 */
export async function runSteps(
  safe: Address,
  role: Role,
  steps: readonly Step[],
  mode: RunMode,
): Promise<boolean> {
  for (const { label, tx } of steps) {
    const simulation = await simulateModuleTx(safe, role.address, tx)
    const reason = simulation.ok ? undefined : simulation.reason

    if (mode === 'simulate' || (mode === 'execute' && !simulation.ok)) {
      logActivity({
        role: role.address,
        mode,
        label,
        status: simulation.ok ? 'allowed' : 'denied',
        detail: reason,
      })
      if (!simulation.ok) return false
      continue
    }

    const privateKey = await revealKey(role, `Enter your password to sign as ${role.label}.`)
    const hash = await sendModuleTx(safe, privateKey, tx, { force: mode === 'force' })
    const id = logActivity({
      role: role.address,
      mode,
      label,
      status: 'sent',
      detail: reason && `simulation: ${reason}`,
      txHash: hash,
      link: `${EXPLORER}/tx/${hash}`,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    updateActivity(id, { status: receipt.status === 'success' ? 'confirmed' : 'reverted' })
    if (receipt.status !== 'success') return false
  }
  return true
}
