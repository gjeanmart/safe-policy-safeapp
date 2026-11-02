import { expect } from 'chai'
import type { BaseContract, ContractTransactionResponse, Interface, LogDescription } from 'ethers'

/**
 * Plain-chai assertions for V2 tests. hardhat-chai-matchers can't load in the Claude Code sandbox,
 * so V2 tests use these instead of `revertedWithCustomError` / `emit`; they run under both configs.
 */

type Awaitable<T> = Promise<T> | (() => Promise<T>)

/** The raw revert data of a failed call or transaction, wherever ethers/hardhat put it. */
export function revertData(e: unknown): string | undefined {
  const err = e as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } }
  for (const d of [err?.data, err?.info?.error?.data, err?.error?.data]) {
    if (typeof d === 'string' && d.startsWith('0x')) return d
    if (d && typeof (d as { data?: unknown }).data === 'string') return (d as { data: string }).data
  }
  return undefined
}

/** Awaits `action` and asserts it reverted with `errorName` from `contract`'s ABI (and `args`, if given). */
export async function expectRevert(
  action: Awaitable<unknown>,
  contract: BaseContract | { interface: Interface },
  errorName: string,
  args?: unknown[],
): Promise<void> {
  let data: string | undefined
  try {
    await (typeof action === 'function' ? action() : action)
  } catch (e) {
    data = revertData(e)
    if (data === undefined) throw new Error(`expected ${errorName}, got a revert without data: ${String(e)}`)
  }
  if (data === undefined) expect.fail(`expected ${errorName}, but the call succeeded`)
  const parsed = contract.interface.parseError(data)
  expect(parsed?.name, `revert data ${data}`).to.equal(errorName)
  if (args) expect(normalize([...parsed!.args])).to.deep.equal(normalize(args))
}

/** Asserts the call reverted (any reason). */
export async function expectAnyRevert(action: Awaitable<unknown>): Promise<void> {
  try {
    await (typeof action === 'function' ? action() : action)
  } catch {
    return
  }
  expect.fail('expected a revert, but the call succeeded')
}

/** Returns the parsed `eventName` logs `contract` emitted in `tx`. */
export async function eventsOf(
  tx: ContractTransactionResponse,
  contract: BaseContract,
  eventName: string,
): Promise<LogDescription[]> {
  const receipt = await tx.wait()
  const address = (await contract.getAddress()).toLowerCase()
  return (receipt?.logs ?? [])
    .filter((l) => l.address.toLowerCase() === address)
    .map((l) => contract.interface.parseLog(l))
    .filter((l): l is LogDescription => l?.name === eventName)
}

/** Asserts `tx` emitted `eventName` from `contract` exactly once, with `args` if given; returns it. */
export async function expectEvent(
  tx: ContractTransactionResponse,
  contract: BaseContract,
  eventName: string,
  args?: unknown[],
): Promise<LogDescription> {
  const logs = await eventsOf(tx, contract, eventName)
  expect(logs.length, `${eventName} count`).to.equal(1)
  if (args) expect(normalize([...logs[0].args])).to.deep.equal(normalize(args))
  return logs[0]
}

/** Lower-cases hex strings and turns numbers into bigints so ethers results compare with plain values. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string' && v.startsWith('0x')) return v.toLowerCase()
  return v
}
