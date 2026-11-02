import {
  type Address,
  type Hex,
  encodeAbiParameters,
  getAbiItem,
  getAddress,
  keccak256,
  parseAbiParameters,
  size,
  slice,
  toHex,
  zeroAddress,
} from 'viem'
import { policyEngineV2Abi } from './abi'

/**
 * Mirror of `contracts/contracts/v2/libraries/Scope.sol` and `Types.sol` (SPEC.md §3): sentinels,
 * enums, levels, keys and ids. Every hash here must equal its Solidity counterpart byte for byte;
 * `contracts/test/v2/Scope.test.ts` pins the Solidity side with the same formulas.
 */

// ---------------------------------------------------------------------------------------------
// Sentinels, enums and caps
// ---------------------------------------------------------------------------------------------

/** Actor wildcard: everyone, owners included. */
export const ANY: Address = zeroAddress
/** The owner path (`execTransaction`); Safe's module-list sentinel, so never a module. */
export const OWNERS: Address = '0x0000000000000000000000000000000000000001'

export const NO_SELECTOR: Hex = '0x00000000'

export const Operation = { CALL: 0, DELEGATECALL: 1 } as const
export type Operation = (typeof Operation)[keyof typeof Operation]

export const CallMatch = { ANY: 0, TO: 1, SELECTOR: 2, TO_SELECTOR: 3 } as const
export type CallMatch = (typeof CallMatch)[keyof typeof CallMatch]

export const AttachmentKind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export type AttachmentKind = (typeof AttachmentKind)[keyof typeof AttachmentKind]

export const PolicyLevel = { CALL: 0, TRANSACTION: 1 } as const
export type PolicyLevel = (typeof PolicyLevel)[keyof typeof PolicyLevel]

export const FreezeRole = { GUARDIAN: 0, LIFTER: 1 } as const
export type FreezeRole = (typeof FreezeRole)[keyof typeof FreezeRole]

export const ChangeType = { SET: 0, DETACH: 1 } as const
export type ChangeType = (typeof ChangeType)[keyof typeof ChangeType]

export const Verdict = { PASS: 0, ALLOW: 1, DENY: 2 } as const
export type Verdict = (typeof Verdict)[keyof typeof Verdict]

export const GateKind = { ALLOW: 0, DENY: 1, POLICY: 2, RULE: 3 } as const
export type GateKind = (typeof GateKind)[keyof typeof GateKind]

/** Op mask bits (`1 << operation`). 0 in a change means CALL only. */
export const OP_CALL = 1
export const OP_DELEGATECALL = 2
export const OP_ALL = 3

export const LEVEL_COUNT = 8
export const ACTOR_LEVEL_OFFSET = 4
/** `(actor, to.selector)`: the only level where DELEGATECALL can be granted. */
export const EXACT_LEVEL = 7

export const MAX_ATTACHMENTS_PER_SCOPE = 4
export const MAX_BATCH_CALLS = 8
export const MAX_ROLE_MEMBERS = 8
export const MAX_TRUSTED_BATCHES = 4
export const MAX_REASON_LENGTH = 512
/** `callIndex` of transaction-level gates and errors. */
export const TX_INDEX = 0xffff
/** `scopeLevel` of engine-rule gates. */
export const NO_LEVEL = 0xff

/** SignatureExtension type of the owner-path policy context. */
export const CONTEXT_TYPE_HASH: Hex = keccak256(toHex('SafePolicyGuardV2.PolicyContext.v1'))

/** `type(IPolicyEngineV2).interfaceId`: `supportsInterface` on the installed guard picks the V2 screens. */
export const ENGINE_V2_INTERFACE_ID: Hex = '0xdc1727e9'
/** `type(IPolicyV2).interfaceId`, required of every attached policy contract. */
export const POLICY_V2_INTERFACE_ID: Hex = '0x55872811'

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

export type Scope = { actor: Address; to: Address; selector: Hex; callMatch: CallMatch }

export const namesTo = (callMatch: CallMatch): boolean =>
  callMatch === CallMatch.TO || callMatch === CallMatch.TO_SELECTOR

export const namesSelector = (callMatch: CallMatch): boolean =>
  callMatch === CallMatch.SELECTOR || callMatch === CallMatch.TO_SELECTOR

/** The engine rejects (`InvalidScope`) a scope whose open parts are not zero. */
export const isNormalized = (scope: Scope): boolean =>
  (namesTo(scope.callMatch) || scope.to === zeroAddress) &&
  (namesSelector(scope.callMatch) || BigInt(scope.selector) === 0n)

/** Zeroes the parts the scope leaves open. */
export const normalizeScope = (scope: Scope): Scope => ({
  actor: scope.actor,
  to: namesTo(scope.callMatch) ? scope.to : zeroAddress,
  selector: namesSelector(scope.callMatch) ? scope.selector : NO_SELECTOR,
  callMatch: scope.callMatch,
})

/** `keccak256(abi.encode(actor, to, selector, uint8(callMatch)))`; pass a normalized scope. */
export const scopeKey = (scope: Scope): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, bytes4, uint8'), [
      scope.actor,
      scope.to,
      scope.selector,
      scope.callMatch,
    ]),
  )

/** Level 0..7: `(actor == ANY ? 0 : 4) + callMatch`. */
export const levelOf = (scope: Pick<Scope, 'actor' | 'callMatch'>): number =>
  (BigInt(scope.actor) === 0n ? 0 : ACTOR_LEVEL_OFFSET) + scope.callMatch

/** The scope a call `(actor, to, selector)` is looked up at, for one level (`Scope.keyAt`). */
export const scopeAt = (level: number, actor: Address, to: Address, selector: Hex): Scope =>
  normalizeScope({
    actor: level < ACTOR_LEVEL_OFFSET ? ANY : actor,
    to,
    selector,
    callMatch: (level % ACTOR_LEVEL_OFFSET) as CallMatch,
  })

/** The 8 scopes a call is looked up at, global first. */
export const lookupScopes = (actor: Address, to: Address, selector: Hex): { level: number; scope: Scope }[] =>
  Array.from({ length: LEVEL_COUNT }, (_, level) => ({ level, scope: scopeAt(level, actor, to, selector) }))

/** `keccak256(abi.encode(scopeKey, uint8(kind), policy))`; `policy` is zero for ALLOW / DENY. */
export const attachmentId = (key: Hex, kind: AttachmentKind, policy: Address = zeroAddress): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint8, address'), [key, kind, policy]))

/** Selector a call is matched with: `0x00000000` for empty calldata, `null` for 1..3 bytes (denied). */
export const selectorOf = (data: Hex): Hex | null => {
  const length = size(data)
  if (length >= 4) return slice(data, 0, 4)
  return length === 0 ? NO_SELECTOR : null
}

/** Module-path transaction identity: `keccak256(abi.encode(safe, actor, to, value, data, uint8(op)))`. */
export const moduleCallHash = (
  safe: Address,
  actor: Address,
  to: Address,
  value: bigint,
  data: Hex,
  operation: Operation,
): Hex =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, address, uint256, bytes, uint8'), [
      safe,
      actor,
      to,
      value,
      data,
      operation,
    ]),
  )

export const opBit = (operation: Operation): number => 1 << operation

export const normalizeOpMask = (opMask: number): number => (opMask === 0 ? OP_CALL : opMask)

/** Bit i set iff level i is populated, from the engine's packed 8 × uint32 counters. */
export const bitmapFromCounts = (levelCounts: bigint): number => {
  let bits = 0
  for (let i = 0; i < LEVEL_COUNT; i++) {
    if (((levelCounts >> BigInt(32 * i)) & 0xffffffffn) !== 0n) bits |= 1 << i
  }
  return bits
}

// ---------------------------------------------------------------------------------------------
// Configuration root
// ---------------------------------------------------------------------------------------------

export type AttachmentChange = {
  changeType: ChangeType
  scope: Scope
  kind: AttachmentKind
  policy: Address
  opMask: number
  data: Hex
}

export type RoleChange = { role: FreezeRole; account: Address; enabled: boolean }

const configurationRootInputs = getAbiItem({ abi: policyEngineV2Abi, name: 'configurationRoot' }).inputs

/** `keccak256(abi.encode(changes, roles))`: what `requestConfiguration` takes. */
export const configurationRoot = (changes: readonly AttachmentChange[], roles: readonly RoleChange[]): Hex =>
  keccak256(encodeAbiParameters(configurationRootInputs, [changes, roles]))

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export const LEVEL_LABELS = [
  'Everyone · any call',
  'Everyone · any function on a contract',
  'Everyone · one function on any contract',
  'Everyone · one function on a contract',
  'Actor · any call',
  'Actor · any function on a contract',
  'Actor · one function on any contract',
  'Actor · one function on a contract',
] as const

export const KIND_LABELS: Record<AttachmentKind, string> = { 0: 'Allow', 1: 'Deny', 2: 'Policy' }

export const VERDICT_LABELS: Record<Verdict, string> = { 0: 'pass', 1: 'allow', 2: 'deny' }

export const opMaskLabel = (opMask: number): string =>
  ({ 1: 'CALL', 2: 'DELEGATECALL', 3: 'CALL + DELEGATECALL' })[normalizeOpMask(opMask)] ?? `ops ${opMask}`

type NameOf = (address: Address) => string | undefined

const short = (address: Address): string => `${address.slice(0, 6)}…${address.slice(-4)}`

export const actorLabel = (actor: Address, nameOf: NameOf = () => undefined): string => {
  if (BigInt(actor) === 0n) return 'Everyone'
  if (BigInt(actor) === 1n) return 'Owners'
  return nameOf(getAddress(actor)) ?? short(actor)
}

/** `*`, `USDC.*`, `*.0xa9059cbb`, `USDC.transfer`: `selectorName` resolves known selectors. */
export const callLabel = (
  scope: Pick<Scope, 'to' | 'selector' | 'callMatch'>,
  nameOf: NameOf = () => undefined,
  selectorName: (selector: Hex) => string | undefined = () => undefined,
): string => {
  if (scope.callMatch === CallMatch.ANY) return '*'
  const target = namesTo(scope.callMatch) ? (nameOf(getAddress(scope.to)) ?? short(scope.to)) : '*'
  const fn = namesSelector(scope.callMatch) ? (selectorName(scope.selector) ?? scope.selector) : '*'
  return `${target}.${fn}`
}

/** `(Ops, USDC.transfer)`, `(Owners, *)`, `(Everyone, *)`. */
export const scopeLabel = (
  scope: Scope,
  nameOf: NameOf = () => undefined,
  selectorName: (selector: Hex) => string | undefined = () => undefined,
): string => `(${actorLabel(scope.actor, nameOf)}, ${callLabel(scope, nameOf, selectorName)})`
