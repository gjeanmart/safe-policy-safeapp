import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toFunctionSelector,
  zeroAddress,
} from 'viem'
import { COW, POLICIES } from '../config/contracts'

export const Operation = { CALL: 0, DELEGATECALL: 1 } as const
export type Operation = (typeof Operation)[keyof typeof Operation]

/** How often an allowlisted account may be used (mirrors `Permission.sol`). */
export const Permission = { NONE: 0, ONCE: 1, ALWAYS: 2 } as const
export type Permission = (typeof Permission)[keyof typeof Permission]
export const PERMISSION_LABELS = ['none', 'once', 'always'] as const

/** One entry of `SafePolicyGuard.Configuration`: binds a policy to an access selector. */
export type Configuration = {
  target: Address
  selector: Hex
  operation: Operation
  policy: Address
  data: Hex
}

export const SELECTORS = {
  none: '0x00000000',
  transfer: toFunctionSelector('transfer(address,uint256)'),
  approve: toFunctionSelector('approve(address,uint256)'),
  setPreSignature: toFunctionSelector('setPreSignature(bytes,bool)'),
  multiSend: toFunctionSelector('multiSend(bytes)'),
} as const satisfies Record<string, Hex>

export const SELECTOR_LABELS: Record<string, string> = {
  [SELECTORS.none]: '(none / fallback)',
  [SELECTORS.transfer]: 'transfer(address,uint256)',
  [SELECTORS.approve]: 'approve(address,uint256)',
  [SELECTORS.setPreSignature]: 'setPreSignature(bytes,bool)',
  [SELECTORS.multiSend]: 'multiSend(bytes)',
  [toFunctionSelector('enableModule(address)')]: 'enableModule(address)',
  [toFunctionSelector('setGuard(address)')]: 'setGuard(address)',
  [toFunctionSelector('setModuleGuard(address)')]: 'setModuleGuard(address)',
}

const configurationsParam = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'operation', type: 'uint8' },
      { name: 'policy', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const

/** `keccak256(abi.encode(configurations))`, the root `requestConfiguration` commits to. */
export function configurationRoot(configurations: readonly Configuration[]): Hex {
  return keccak256(encodeAbiParameters(configurationsParam, [configurations]))
}

const allowlistParam = [
  {
    type: 'tuple[]',
    components: [
      { name: 'account', type: 'address' },
      { name: 'permission', type: 'uint8' },
    ],
  },
] as const

export type AllowlistEntry = { account: Address; permission: Permission }

const encodeAllowlist = (entries: readonly AllowlistEntry[]): Hex =>
  encodeAbiParameters(allowlistParam, [entries])

/**
 * Builders for the policies used in this sandbox. Each returns one `Configuration`; the guard
 * keeps a single policy per `(target, selector, operation)`, so a later entry for the same access
 * selector replaces an earlier one.
 */
export const templates = {
  /** Any transaction on the selector, only if authorised by an allowlisted module. */
  allowedModule: (target: Address, selector: Hex, module: Address, allowed = true): Configuration => ({
    target,
    selector,
    operation: Operation.CALL,
    policy: POLICIES.allowedModule,
    data: encodeAbiParameters([{ type: 'address' }, { type: 'bool' }], [module, allowed]),
  }),

  /** `token.transfer` restricted to recipients (the allowlist is per token, not per selector). */
  erc20Transfer: (token: Address, recipients: readonly AllowlistEntry[]): Configuration => ({
    target: token,
    selector: SELECTORS.transfer,
    operation: Operation.CALL,
    policy: POLICIES.erc20Transfer,
    data: encodeAllowlist(recipients),
  }),

  /** `token.approve` restricted to spenders. Revoking (amount 0) is always allowed by the policy. */
  erc20Approve: (token: Address, spenders: readonly AllowlistEntry[]): Configuration => ({
    target: token,
    selector: SELECTORS.approve,
    operation: Operation.CALL,
    policy: POLICIES.erc20Approve,
    data: encodeAllowlist(spenders),
  }),

  /** Plain ETH transfers (empty calldata, value > 0) to one recipient. */
  nativeTransfer: (recipient: Address): Configuration => ({
    target: recipient,
    selector: SELECTORS.none,
    operation: Operation.CALL,
    policy: POLICIES.nativeTransfer,
    data: '0x',
  }),

  allow: (target: Address, selector: Hex, operation: Operation = Operation.CALL): Configuration => ({
    target,
    selector,
    operation,
    policy: POLICIES.allow,
    data: '0x',
  }),

  deny: (target: Address, selector: Hex, operation: Operation = Operation.CALL): Configuration => ({
    target,
    selector,
    operation,
    policy: POLICIES.deny,
    data: '0x',
  }),

  /** Detaching a policy is binding the zero address; the engine then falls back or denies. */
  remove: (target: Address, selector: Hex, operation: Operation = Operation.CALL): Configuration => ({
    target,
    selector,
    operation,
    policy: zeroAddress,
    data: '0x',
  }),

  /**
   * CoW swap selling `sellToken`: approve the VaultRelayer and pre-sign orders. Pre-signing is
   * gated on the module only — no deployed policy can check the order's receiver.
   */
  cowSwap: (sellToken: Address, module: Address): Configuration[] => [
    templates.erc20Approve(sellToken, [{ account: COW.vaultRelayer, permission: Permission.ALWAYS }]),
    templates.allowedModule(COW.settlement, SELECTORS.setPreSignature, module),
  ],
}

/** Human-readable summary of a configuration's `data`, per policy. */
export function describeConfigurationData({ policy, data }: Pick<Configuration, 'policy' | 'data'>): string {
  try {
    switch (policy.toLowerCase()) {
      case POLICIES.allowedModule.toLowerCase(): {
        const [module, allowed] = decodeAbiParameters([{ type: 'address' }, { type: 'bool' }], data)
        return `${allowed ? 'allow' : 'revoke'} module ${module}`
      }
      case POLICIES.erc20Transfer.toLowerCase():
      case POLICIES.erc20Approve.toLowerCase(): {
        const [entries] = decodeAbiParameters(allowlistParam, data)
        if (entries.length === 0) return 'empty allowlist'
        return entries
          .map((e) => `${e.account} (${PERMISSION_LABELS[e.permission] ?? e.permission})`)
          .join(', ')
      }
      case POLICIES.coSigner.toLowerCase(): {
        const [cosigner] = decodeAbiParameters([{ type: 'address' }], data)
        return `co-signer ${cosigner}`
      }
      default:
        return data === '0x' ? '—' : data
    }
  } catch {
    return data
  }
}

/** Stable key for an access selector, used to deduplicate configurations. */
export const accessKey = (c: Pick<Configuration, 'target' | 'selector' | 'operation'>): string =>
  `${c.target.toLowerCase()}:${c.selector.toLowerCase()}:${c.operation}`

/**
 * Configurations that cleanly remove an active binding: first revoke the grants the policy holds
 * for it (they outlive the binding and would come back if it were re-attached), then detach it.
 * AllowedModulePolicy keeps one allowlist per Safe, so its module is only revoked when no other
 * active binding still relies on it.
 */
export function removalConfigurations(
  entry: Configuration,
  active: readonly Configuration[],
): Configuration[] {
  const detach = templates.remove(entry.target, entry.selector, entry.operation)
  const policy = entry.policy.toLowerCase()
  try {
    if (policy === POLICIES.erc20Transfer.toLowerCase() || policy === POLICIES.erc20Approve.toLowerCase()) {
      const [entries] = decodeAbiParameters(allowlistParam, entry.data)
      const revoked = entries.map(({ account }) => ({ account, permission: Permission.NONE }))
      return [{ ...entry, data: encodeAllowlist(revoked) }, detach]
    }
    if (policy === POLICIES.allowedModule.toLowerCase()) {
      const [module] = decodeAbiParameters([{ type: 'address' }, { type: 'bool' }], entry.data)
      const stillUsed = active.some(
        (other) =>
          accessKey(other) !== accessKey(entry) &&
          other.policy.toLowerCase() === policy &&
          other.data.toLowerCase() === entry.data.toLowerCase(),
      )
      if (!stillUsed) return [templates.allowedModule(entry.target, entry.selector, module, false), detach]
    }
  } catch {
    // Undecodable data: detaching alone is still correct.
  }
  return [detach]
}
