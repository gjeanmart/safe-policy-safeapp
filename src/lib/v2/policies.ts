import {
  type Address,
  type Hex,
  getAddress,
  isAddress,
  isAddressEqual,
  toFunctionSelector,
  zeroAddress,
} from 'viem'
import { argsPolicyAbi, coSignerPolicyAbi, limitPolicyAbi, safenetPolicyAbi, timelockPolicyAbi } from './abi'
import { Selectors } from './scopes'

/**
 * The rev 3 deployment and policy registry. Addresses come from a {@link V2Deployment} passed in by
 * the caller (the deploy script prints it), so nothing in `src/lib/v2` reads app config: the agent
 * reuses the lib with its own client.
 */

/** One rev 3 deployment, exactly as `contracts/scripts/deploy-v2.ts` prints it. */
export type V2Deployment = {
  /** `PolicyGuard`: guard, module guard and the whole `IPolicyGuard` ABI, one address. */
  engine: Address
  /** `PolicyGuardConfig`, reached by the guard's fallback (never called directly). */
  engineConfig: Address
  /** MultiSendCallOnly contracts the engine decodes (the first one is what the app batches with). */
  trustedBatches: Address[]
  policies: {
    timelock: Address
    /** `TimelockPolicyQueue`, reached by the policy's DELEGATECALL (never called directly). */
    timelockQueue: Address
    args: Address
    limit: Address
    coSigner: Address
    /** 0x0 when the deploy had no Safenet consensus: the app then hides it. */
    safenet: Address
  }
  /** First block worth scanning for events (the deployment block). */
  fromBlock?: bigint
}

/** The policies a Safe can attach (the queue is part of the Timelock). */
export const POLICY_NAMES = ['timelock', 'args', 'limit', 'coSigner', 'safenet'] as const
export type PolicyName = (typeof POLICY_NAMES)[number]

export const POLICY_INFO = {
  timelock: { label: 'Timelock', contract: 'TimelockPolicy', abi: timelockPolicyAbi },
  args: { label: 'Conditions', contract: 'ArgsPolicy', abi: argsPolicyAbi },
  limit: { label: 'Budget', contract: 'LimitPolicy', abi: limitPolicyAbi },
  coSigner: { label: 'Co-signer', contract: 'CoSignerPolicy', abi: coSignerPolicyAbi },
  safenet: { label: 'Safenet', contract: 'SafenetPolicy', abi: safenetPolicyAbi },
} as const satisfies Record<PolicyName, { label: string; contract: string; abi: unknown }>

const isZero = (address: Address): boolean => isAddressEqual(address, zeroAddress)

/** Which known policy `address` is. A policy left at 0x0 (Safenet without consensus) never matches. */
export const policyNameOf = (deployment: V2Deployment, address: Address): PolicyName | undefined =>
  isZero(address)
    ? undefined
    : POLICY_NAMES.find((name) => isAddressEqual(deployment.policies[name], address))

/** Whether the engine exists (the config keeps zero placeholders until the deploy). */
export const isDeployed = (deployment: V2Deployment): boolean => !isZero(deployment.engine)

/** Policies with a non-zero address, in registry order. */
export const deployedPolicies = (deployment: V2Deployment): PolicyName[] =>
  POLICY_NAMES.filter((name) => !isZero(deployment.policies[name]))

/**
 * Validates the JSON block the deploy script prints and returns it checksummed. Throws with the
 * offending field on anything else, so a bad paste fails loudly. `fromBlock` may be a number,
 * a decimal string or a bigint.
 */
export function parseV2Deployment(json: unknown): V2Deployment {
  const fail = (field: string): never => {
    throw new Error(`V2 deployment: ${field} is not an address`)
  }
  const address = (value: unknown, field: string): Address =>
    typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : fail(field)
  const o = (json ?? {}) as Record<string, unknown>
  const batches = Array.isArray(o.trustedBatches) ? o.trustedBatches : fail('trustedBatches')
  const p = (o.policies ?? {}) as Record<string, unknown>
  const from = o.fromBlock
  return {
    engine: address(o.engine, 'engine'),
    engineConfig: address(o.engineConfig, 'engineConfig'),
    trustedBatches: batches.map((b, i) => address(b, `trustedBatches[${i}]`)),
    policies: {
      timelock: address(p.timelock, 'policies.timelock'),
      timelockQueue: address(p.timelockQueue, 'policies.timelockQueue'),
      args: address(p.args, 'policies.args'),
      limit: address(p.limit, 'policies.limit'),
      coSigner: address(p.coSigner, 'policies.coSigner'),
      safenet: address(p.safenet, 'policies.safenet'),
    },
    fromBlock:
      typeof from === 'bigint' || typeof from === 'number' || typeof from === 'string'
        ? BigInt(from)
        : undefined,
  }
}

// ---------------------------------------------------------------------------------------------
// Selectors the builder, policies and lint rules care about
// ---------------------------------------------------------------------------------------------

export const SELECTORS = {
  transfer: Selectors.erc20Transfer,
  transferFrom: Selectors.erc20TransferFrom,
  approve: Selectors.erc20Approve,
  increaseAllowance: Selectors.erc20IncreaseAllowance,
  decreaseAllowance: Selectors.erc20DecreaseAllowance,
  multiSend: Selectors.multiSend,
  configure: Selectors.configure,
  // ERC-721 shapes LimitPolicy cannot tell from ERC-20 (transferFrom / approve) or does not price.
  safeTransferFrom: toFunctionSelector('safeTransferFrom(address,address,uint256)'),
  safeTransferFromData: toFunctionSelector('safeTransferFrom(address,address,uint256,bytes)'),
  setApprovalForAll: toFunctionSelector('setApprovalForAll(address,bool)'),
  // CoW
  setPreSignature: toFunctionSelector('setPreSignature(bytes,bool)'),
  // Safe self-calls (module path: an exact Allow, F5)
  swapOwner: toFunctionSelector('swapOwner(address,address,address)'),
  addOwnerWithThreshold: toFunctionSelector('addOwnerWithThreshold(address,uint256)'),
  removeOwner: toFunctionSelector('removeOwner(address,address,uint256)'),
  changeThreshold: toFunctionSelector('changeThreshold(uint256)'),
  enableModule: toFunctionSelector('enableModule(address)'),
  disableModule: toFunctionSelector('disableModule(address,address)'),
  setGuard: toFunctionSelector('setGuard(address)'),
  setModuleGuard: toFunctionSelector('setModuleGuard(address)'),
  setFallbackHandler: toFunctionSelector('setFallbackHandler(address)'),
  execTransactionFromModule: toFunctionSelector('execTransactionFromModule(address,uint256,bytes,uint8)'),
} as const satisfies Record<string, Hex>

/** Safe owner-management selectors: what a Recovery actor is granted. */
export const OWNER_MANAGEMENT_SELECTORS: readonly Hex[] = [
  SELECTORS.swapOwner,
  SELECTORS.addOwnerWithThreshold,
  SELECTORS.removeOwner,
  SELECTORS.changeThreshold,
]

/** Calls LimitPolicy prices as a spend of `call.to` (SPEC.md §5.3); unlisted tokens are `Unpriced`. */
export const SPEND_SELECTORS: readonly Hex[] = [
  SELECTORS.transfer,
  SELECTORS.transferFrom,
  SELECTORS.approve,
  SELECTORS.increaseAllowance,
]

/** ERC-721 shapes: `transferFrom` / `approve` collide with ERC-20, the others are unpriced. */
export const NFT_SELECTORS: readonly Hex[] = [
  SELECTORS.safeTransferFrom,
  SELECTORS.safeTransferFromData,
  SELECTORS.setApprovalForAll,
]

const SELECTOR_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SELECTORS).map(([name, selector]) => [selector.toLowerCase(), name]),
)

/** Short name of a known selector (`transfer`, `swapOwner`, `configure`, ...). */
export const selectorName = (selector: Hex): string | undefined =>
  BigInt(selector) === 0n ? '(empty calldata)' : SELECTOR_NAMES[selector.toLowerCase()]

/** Names the deployment's own contracts; combine with the app's address book. */
export const deploymentNames = (deployment: V2Deployment): ((address: Address) => string | undefined) => {
  const names = new Map<string, string>([
    [getAddress(deployment.engine), 'Policy engine'],
    [getAddress(deployment.engineConfig), 'PolicyGuardConfig'],
    [getAddress(deployment.policies.timelockQueue), 'TimelockPolicyQueue'],
    ...deployment.trustedBatches.map((batch, i): [string, string] => [
      getAddress(batch),
      `MultiSendCallOnly #${i + 1}`,
    ]),
    ...deployedPolicies(deployment).map((name): [string, string] => [
      getAddress(deployment.policies[name]),
      POLICY_INFO[name].contract,
    ]),
  ])
  names.delete(zeroAddress)
  return (address) => names.get(getAddress(address))
}
