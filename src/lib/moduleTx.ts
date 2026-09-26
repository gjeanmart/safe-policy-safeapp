import { type Address, type Hash, type Hex, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { guardAbi, policyErrorsAbi, safeAbi } from '../abi'
import { RPC_URL, chain, publicClient } from '../config/client'
import type { Operation } from './configurations'
import { describeError } from './errors'

/** A transaction a module (here: a local EOA) asks the Safe to execute. */
export type ModuleTx = { to: Address; value: bigint; data: Hex; operation: Operation }

export type SimulationResult = { ok: true } | { ok: false; reason: string }

const execAbi = [...safeAbi, ...policyErrorsAbi]

/** Dry-runs `execTransactionFromModule` from the module's address. */
export async function simulateModuleTx(
  safe: Address,
  module: Address,
  tx: ModuleTx,
): Promise<SimulationResult> {
  try {
    await publicClient.simulateContract({
      account: module,
      address: safe,
      abi: execAbi,
      functionName: 'execTransactionFromModule',
      args: [tx.to, tx.value, tx.data, tx.operation],
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  }
}

/**
 * Sends `execTransactionFromModule` signed by the module EOA. A fixed gas limit skips estimation,
 * so a transaction the policies reject still lands on-chain as a revert when `force` is set.
 */
export async function sendModuleTx(
  safe: Address,
  privateKey: Hex,
  tx: ModuleTx,
  { force = false }: { force?: boolean } = {},
): Promise<Hash> {
  const account = privateKeyToAccount(privateKey)
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
  return wallet.writeContract({
    account,
    address: safe,
    abi: execAbi,
    functionName: 'execTransactionFromModule',
    args: [tx.to, tx.value, tx.data, tx.operation],
    gas: force ? 500_000n : undefined,
  })
}

/** Resolves which policy the guard would consult for `tx` (exact match or operation fallback). */
export async function resolvePolicy(guard: Address, safe: Address, tx: ModuleTx) {
  const [access, policy] = await publicClient.readContract({
    address: guard,
    abi: guardAbi,
    functionName: 'getPolicy',
    args: [safe, tx.to, tx.data, tx.operation],
  })
  // A fallback access selector carries only the operation bit (byte 4): no target, no selector.
  const isFallback = access === BigInt(tx.operation) << 216n
  return { access, policy, isFallback }
}
