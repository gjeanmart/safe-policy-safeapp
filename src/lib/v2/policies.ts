import { type Address, type Hex, getAddress, isAddressEqual, toFunctionSelector } from 'viem'
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

/** Which known policy `address` is, if any. */
export const policyNameOf = (deployment: V2Deployment, address: Address): PolicyName | undefined =>
  POLICY_NAMES.find((name) => isAddressEqual(deployment.policies[name], address))

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
    ...POLICY_NAMES.map((name): [string, string] => [
      getAddress(deployment.policies[name]),
      POLICY_INFO[name].contract,
    ]),
  ])
  return (address) => names.get(getAddress(address))
}
