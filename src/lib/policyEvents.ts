import type { Address, Hex } from 'viem'
import { guardAbi } from '../abi'
import { LOGS_BLOCK_RANGE, publicClient } from '../config/client'
import { type Configuration, type Operation, accessKey } from './configurations'

/** A policy binding as last confirmed on-chain (from `PolicyConfirmed`). */
export type ConfirmedPolicy = Configuration & { blockNumber: string }

/**
 * The guard has no getter to enumerate a Safe's policies, so the current set is rebuilt from
 * `PolicyConfirmed` events: the latest event per access selector wins, and a zero policy means
 * the binding was removed. Scans in chunks to stay under public RPC `getLogs` limits.
 */
export async function scanPolicyEvents(
  guard: Address,
  safe: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ConfirmedPolicy[]> {
  const found: ConfirmedPolicy[] = []
  for (let start = fromBlock; start <= toBlock; start += LOGS_BLOCK_RANGE + 1n) {
    const end = start + LOGS_BLOCK_RANGE < toBlock ? start + LOGS_BLOCK_RANGE : toBlock
    const logs = await publicClient.getContractEvents({
      address: guard,
      abi: guardAbi,
      eventName: 'PolicyConfirmed',
      args: { safe },
      fromBlock: start,
      toBlock: end,
    })
    for (const { args, blockNumber } of logs) {
      found.push({
        target: args.target!,
        selector: args.selector!,
        operation: args.operation! as Operation,
        policy: args.policy!,
        data: args.data!,
        blockNumber: blockNumber.toString(),
      })
    }
  }
  return found
}

/**
 * Once applied or invalidated, the guard deletes a root, which then reads the same as a request
 * not executed yet. Its events tell the two apart. A request is only applicable for DELAY + EXPIRY
 * (7 days), so looking back two log chunks (~2 weeks of Sepolia blocks) covers it.
 *
 * Roots are content hashes: re-requesting a configuration applied earlier yields the same root,
 * so only events at or after `since` (unix seconds, when this request was made) count.
 */
export async function rootOutcome(
  guard: Address,
  safe: Address,
  root: Hex,
  since: number,
): Promise<'applied' | 'invalidated' | undefined> {
  const head = await publicClient.getBlockNumber()
  for (const eventName of ['RootApplied', 'RootInvalidated'] as const) {
    for (let end = head, chunk = 0; chunk < 2; chunk++, end -= LOGS_BLOCK_RANGE + 1n) {
      const logs = await publicClient.getContractEvents({
        address: guard,
        abi: guardAbi,
        eventName,
        args: { safe, root },
        fromBlock: end - LOGS_BLOCK_RANGE,
        toBlock: end,
      })
      for (const log of logs) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber })
        if (Number(block.timestamp) >= since) return eventName === 'RootApplied' ? 'applied' : 'invalidated'
      }
    }
  }
  return undefined
}

/** Folds an ordered event history into the active bindings. */
export function activePolicies(history: readonly ConfirmedPolicy[]): ConfirmedPolicy[] {
  const latest = new Map<string, ConfirmedPolicy>()
  for (const entry of history) latest.set(accessKey(entry), entry)
  return [...latest.values()].filter((entry) => !/^0x0+$/.test(entry.policy))
}
