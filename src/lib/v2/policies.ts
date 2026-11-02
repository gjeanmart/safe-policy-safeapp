import {
  type Address,
  type Hex,
  getAddress,
  isAddress,
  isAddressEqual,
  toFunctionSelector,
  zeroAddress,
} from 'viem'
import {
  argsPolicyAbi,
  coSignerPolicyV2Abi,
  freezePolicyAbi,
  limitPolicyAbi,
  quorumPolicyV2Abi,
  recipientsPolicyAbi,
  safenetPolicyV2Abi,
  timelockPolicyAbi,
} from './abi'
import { PolicyLevel } from './scopes'

/**
 * The V2 policy registry: which contracts exist, their level (SPEC §8 table) and their ABI. The
 * addresses come from a {@link V2Deployment} passed in by the caller (WP7 prints it), so nothing in
 * `src/lib/v2` reads app config: the agent can reuse the lib with its own client.
 */

export const POLICY_NAMES = [
  'freeze',
  'timelock',
  'recipients',
  'limit',
  'args',
  'coSigner',
  'safenet',
  'quorum',
] as const
export type PolicyName = (typeof POLICY_NAMES)[number]

export type V2Deployment = {
  /** `SafePolicyGuardV2`: engine and guard, one address. */
  engine: Address
  /** `PolicySignLib`, the engine's `SIGN_LIB()`. */
  signLib: Address
  /** `PolicyFallbackHandler` (on-chain-only ERC-1271). */
  fallbackHandler: Address
  /** The engine's trusted batch contracts (MultiSendCallOnly first: the app batches with it). */
  trustedBatches: readonly Address[]
  policies: Record<PolicyName, Address>
}

export const POLICY_INFO = {
  freeze: { label: 'Freeze', contract: 'FreezePolicy', level: PolicyLevel.TRANSACTION, abi: freezePolicyAbi },
  timelock: {
    label: 'Timelock',
    contract: 'TimelockPolicy',
    level: PolicyLevel.TRANSACTION,
    abi: timelockPolicyAbi,
  },
  recipients: {
    label: 'Recipients',
    contract: 'RecipientsPolicy',
    level: PolicyLevel.CALL,
    abi: recipientsPolicyAbi,
  },
  limit: { label: 'Transfer budget', contract: 'LimitPolicy', level: PolicyLevel.CALL, abi: limitPolicyAbi },
  args: { label: 'Arguments', contract: 'ArgsPolicy', level: PolicyLevel.CALL, abi: argsPolicyAbi },
  coSigner: {
    label: 'Co-signer',
    contract: 'CoSignerPolicyV2',
    level: PolicyLevel.TRANSACTION,
    abi: coSignerPolicyV2Abi,
  },
  safenet: {
    label: 'Safenet',
    contract: 'SafenetPolicyV2',
    level: PolicyLevel.TRANSACTION,
    abi: safenetPolicyV2Abi,
  },
  quorum: {
    label: 'Quorum',
    contract: 'QuorumPolicyV2',
    level: PolicyLevel.TRANSACTION,
    abi: quorumPolicyV2Abi,
  },
} as const satisfies Record<PolicyName, { label: string; contract: string; level: PolicyLevel; abi: unknown }>

const isZeroAddress = (address: Address): boolean => isAddressEqual(address, zeroAddress)

/**
 * Which known policy `address` is, if any. A policy left at `0x0` in the deployment (Safenet on
 * Sepolia without a Consensus deployment) is not deployed: the zero address never names it.
 */
export const policyNameOf = (deployment: V2Deployment, address: Address): PolicyName | undefined =>
  isZeroAddress(address)
    ? undefined
    : POLICY_NAMES.find((name) => isAddressEqual(deployment.policies[name], address))

/** Whether the engine of this deployment exists (placeholders are all zero until WP7 deploys). */
export const isDeployed = (deployment: V2Deployment): boolean => !isZeroAddress(deployment.engine)

/** Policies with a non-zero address, in registry order. */
export const deployedPolicies = (deployment: V2Deployment): PolicyName[] =>
  POLICY_NAMES.filter((name) => !isZeroAddress(deployment.policies[name]))

/**
 * Validates the JSON block `contracts/scripts/deploy-v2.ts` prints (one per engine) and returns it
 * checksummed. Throws with the offending field on anything else, so a bad paste fails loudly.
 *
 * @example
 * parseV2Deployment({ engine: '0x…', signLib: '0x…', fallbackHandler: '0x…', trustedBatches: ['0x…'],
 *   policies: { freeze: '0x…', …, safenet: '0x0000000000000000000000000000000000000000', … } })
 */
export function parseV2Deployment(json: unknown): V2Deployment {
  const fail = (field: string): never => {
    throw new Error(`V2 deployment: ${field} is not an address`)
  }
  const address = (value: unknown, field: string): Address =>
    typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : fail(field)
  const o = (json ?? {}) as Record<string, unknown>
  const batches = Array.isArray(o.trustedBatches) ? o.trustedBatches : fail('trustedBatches')
  const policies = (o.policies ?? {}) as Record<string, unknown>
  return {
    engine: address(o.engine, 'engine'),
    signLib: address(o.signLib, 'signLib'),
    fallbackHandler: address(o.fallbackHandler, 'fallbackHandler'),
    trustedBatches: batches.map((b, i) => address(b, `trustedBatches[${i}]`)),
    policies: Object.fromEntries(
      POLICY_NAMES.map((name) => [name, address(policies[name], `policies.${name}`)]),
    ) as Record<PolicyName, Address>,
  }
}

// ---------------------------------------------------------------------------------------------
// Selectors the policies and lint rules care about
// ---------------------------------------------------------------------------------------------

export const SELECTORS = {
  transfer: toFunctionSelector('transfer(address,uint256)'),
  transferFrom: toFunctionSelector('transferFrom(address,address,uint256)'),
  approve: toFunctionSelector('approve(address,uint256)'),
  increaseAllowance: toFunctionSelector('increaseAllowance(address,uint256)'),
  decreaseAllowance: toFunctionSelector('decreaseAllowance(address,uint256)'),
  multiSend: toFunctionSelector('multiSend(bytes)'),
  // PolicySignLib typed entries (matched as CALL, SPEC §6.3) and the raw one (DELEGATECALL only).
  signPermit: '0x51bdfa61',
  signCowOrder: '0x3d296e04',
  signPermit2: '0xda3c0cb0',
  signMessage: toFunctionSelector('signMessage(bytes32)'),
  // Safe self-calls (SPEC §6.4: module path needs an exact-scope ALLOW).
  swapOwner: toFunctionSelector('swapOwner(address,address,address)'),
  addOwnerWithThreshold: toFunctionSelector('addOwnerWithThreshold(address,uint256)'),
  removeOwner: toFunctionSelector('removeOwner(address,address,uint256)'),
  changeThreshold: toFunctionSelector('changeThreshold(uint256)'),
  enableModule: toFunctionSelector('enableModule(address)'),
  disableModule: toFunctionSelector('disableModule(address,address)'),
  setGuard: toFunctionSelector('setGuard(address)'),
  setModuleGuard: toFunctionSelector('setModuleGuard(address)'),
  setFallbackHandler: toFunctionSelector('setFallbackHandler(address)'),
  // Engine targets reachable from a guarded Safe (SPEC §6.4).
  freeze: '0x1d38fcda',
  freezeActor: '0x6a6a89ef',
  lift: '0x05dda954',
  requestConfiguration: '0xa809eb8e',
  invalidateRoot: '0x3eefdcce',
  applyConfiguration: '0x1d4ed8ec',
} as const satisfies Record<string, Hex>

/** Safe owner-management selectors: what a Recovery actor is granted. */
export const OWNER_MANAGEMENT_SELECTORS: readonly Hex[] = [
  SELECTORS.swapOwner,
  SELECTORS.addOwnerWithThreshold,
  SELECTORS.removeOwner,
  SELECTORS.changeThreshold,
]

/** Selectors LimitPolicy prices (SPEC §8.4), besides empty calldata; sign-lib ones only on `SIGN_LIB`. */
export const PRICED_TOKEN_SELECTORS: readonly Hex[] = [
  SELECTORS.transfer,
  SELECTORS.transferFrom,
  SELECTORS.approve,
  SELECTORS.increaseAllowance,
  SELECTORS.decreaseAllowance,
]
export const PRICED_SIGN_LIB_SELECTORS: readonly Hex[] = [
  SELECTORS.signPermit,
  SELECTORS.signPermit2,
  SELECTORS.signCowOrder,
]

const SELECTOR_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SELECTORS).map(([name, selector]) => [selector.toLowerCase(), name]),
)

/** Short name of a known selector (`transfer`, `swapOwner`, `signCowOrder`, ...). */
export const selectorName = (selector: Hex): string | undefined =>
  BigInt(selector) === 0n ? '(empty calldata)' : SELECTOR_NAMES[selector.toLowerCase()]

/** Names the deployment's own contracts; combine with the app's address book. */
export const deploymentNames = (deployment: V2Deployment): ((address: Address) => string | undefined) => {
  const names = new Map<string, string>([
    [getAddress(deployment.engine), 'Policy engine'],
    [getAddress(deployment.signLib), 'PolicySignLib'],
    [getAddress(deployment.fallbackHandler), 'PolicyFallbackHandler'],
    ...deployment.trustedBatches.map((batch, i): [string, string] => [
      getAddress(batch),
      `MultiSend #${i + 1}`,
    ]),
    ...deployedPolicies(deployment).map((name): [string, string] => [
      getAddress(deployment.policies[name]),
      POLICY_INFO[name].contract,
    ]),
  ])
  names.delete(zeroAddress)
  return (address) => names.get(getAddress(address))
}
