import {
  type Address,
  type Hash,
  type Hex,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddressEqual,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { policyErrorsAbi, safeAbi } from '../abi'
import { chain, publicClient, rpcUrl } from '../config/client'
import { type Role, roleKind, rolesStore } from '../store'
import { Operation } from './configurations'
import { type ModuleTx, sendModuleTx } from './moduleTx'
import { revealKey } from './vault'

/** Enough about a Safe used as a role to decide how it can act. */
export type SafeInfo = { version: string; owners: Address[]; threshold: number }

/** Reads a Safe's version, owners and threshold; `undefined` if the address is not a Safe. */
export async function readSafeInfo(address: Address): Promise<SafeInfo | undefined> {
  try {
    const [version, owners, threshold] = await Promise.all([
      publicClient.readContract({ address, abi: safeAbi, functionName: 'VERSION' }),
      publicClient.readContract({ address, abi: safeAbi, functionName: 'getOwners' }),
      publicClient.readContract({ address, abi: safeAbi, functionName: 'getThreshold' }),
    ])
    return { version, owners: [...owners], threshold: Number(threshold) }
  } catch {
    return undefined
  }
}

/** Classifies an address added as a role: a Safe, another contract, or nothing deployed. */
export async function detectRoleKind(address: Address): Promise<'safe' | 'contract' | 'none'> {
  const code = await publicClient.getCode({ address })
  if (!code || code === '0x') return 'none'
  return (await readSafeInfo(address)) ? 'safe' : 'contract'
}

/**
 * How a role can send its module call from this app:
 * - `eoa`: its own key signs;
 * - `safe` with a local EOA role that owns it alone (threshold 1): that EOA signs the Safe
 *   transaction and sends it;
 * - otherwise `manual`: the nested call has to be proposed from elsewhere (e.g. Safe{Wallet}).
 */
export type Executor =
  | { kind: 'eoa' }
  | { kind: 'safe-owner'; signer: Role; info: SafeInfo }
  | { kind: 'manual'; reason: string; info?: SafeInfo }

export async function resolveExecutor(role: Role): Promise<Executor> {
  const kind = roleKind(role)
  if (kind === 'eoa') return { kind: 'eoa' }
  if (kind === 'contract') {
    return {
      kind: 'manual',
      reason: 'A contract role acts through its own logic; the app can only simulate its calls.',
    }
  }
  const info = await readSafeInfo(role.address)
  if (!info) return { kind: 'manual', reason: 'Could not read this Safe.' }
  const signer = rolesStore
    .get()
    .find((r) => roleKind(r) === 'eoa' && info.owners.some((owner) => isAddressEqual(owner, r.address)))
  if (signer && info.threshold === 1) return { kind: 'safe-owner', signer, info }
  return {
    kind: 'manual',
    info,
    reason: signer
      ? `This Safe needs ${info.threshold} signatures; propose the transaction from it in Safe{Wallet}.`
      : 'No local role owns this Safe; propose the transaction from it in Safe{Wallet}.',
  }
}

/** The call a Safe or contract role makes on the treasury Safe: `execTransactionFromModule(tx)`. */
export const nestedModuleCall = (treasury: Address, tx: ModuleTx) => ({
  to: treasury,
  value: 0n,
  data: encodeFunctionData({
    abi: safeAbi,
    functionName: 'execTransactionFromModule',
    args: [tx.to, tx.value, tx.data, tx.operation],
  }),
})

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/**
 * Executes the nested module call through a 1-of-1 role Safe: the owner signs the Safe
 * transaction (EIP-712) and sends `execTransaction` itself. No gas refund (all gas fields 0).
 */
async function sendViaSafe(
  treasury: Address,
  roleSafe: Address,
  signer: Role,
  tx: ModuleTx,
  force: boolean,
): Promise<Hash> {
  const call = nestedModuleCall(treasury, tx)
  const nonce = await publicClient.readContract({ address: roleSafe, abi: safeAbi, functionName: 'nonce' })
  const account = privateKeyToAccount(
    await revealKey(signer, `Enter your password to sign as ${signer.label}.`),
  )
  const signature: Hex = await account.signTypedData({
    domain: { chainId: chain.id, verifyingContract: roleSafe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      ...call,
      operation: Operation.CALL,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce,
    },
  })
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })
  return wallet.writeContract({
    account,
    address: roleSafe,
    abi: [...safeAbi, ...policyErrorsAbi],
    functionName: 'execTransaction',
    args: [call.to, call.value, call.data, Operation.CALL, 0n, 0n, 0n, zeroAddress, zeroAddress, signature],
    gas: force ? 800_000n : undefined,
  })
}

/** Sends the module call as `role`, whatever its kind; throws for roles that cannot send from here. */
export async function sendAsRole(
  treasury: Address,
  role: Role,
  tx: ModuleTx,
  { force = false } = {},
): Promise<Hash> {
  const executor = await resolveExecutor(role)
  switch (executor.kind) {
    case 'eoa': {
      const privateKey = await revealKey(role, `Enter your password to sign as ${role.label}.`)
      return sendModuleTx(treasury, privateKey, tx, { force })
    }
    case 'safe-owner':
      return sendViaSafe(treasury, role.address, executor.signer, tx, force)
    case 'manual':
      throw new Error(executor.reason)
  }
}
