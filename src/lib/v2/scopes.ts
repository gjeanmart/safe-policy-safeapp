import {
  type Address,
  type Hex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  size,
  slice,
  zeroAddress,
} from 'viem'
import {
  ACTOR_LEVEL_OFFSET,
  ANY,
  CallMatch,
  Kind,
  LEVEL_COUNT,
  OP_ALL,
  OP_CALL,
  type Operation,
  levelOf as rawLevelOf,
} from './rev3/types'

/**
 * Scopes of the rev 3 engine (SPEC.md §2): 6 keys, `(ANY or actor) × (any call, contract,
 * contract.function)`, shown to people as 4 levels (Everyone / an actor × any call / this call).
 * Every hash here must equal `ScopeLib` byte for byte; the constants come from `rev3/types.ts`,
 * which `contracts/test/v2/Scope.test.ts` pins against the Solidity.
 */

export * from './rev3/types'

export type Scope = { actor: Address; to: Address; selector: Hex; callMatch: CallMatch }

export const NO_SELECTOR: Hex = '0x00000000'

export const isAny = (actor: Address): boolean => BigInt(actor) === 0n
export const isOwners = (actor: Address): boolean => BigInt(actor) === 1n
/** OWNERS or a module: an actor a grant can name. */
export const isNamedActor = (actor: Address): boolean => !isAny(actor)

export const namesTo = (callMatch: CallMatch): boolean => callMatch !== CallMatch.ANY
export const namesSelector = (callMatch: CallMatch): boolean => callMatch === CallMatch.FUNCTION

/** `to` is zero iff `callMatch == ANY`; `selector` is zero unless `FUNCTION` (`InvalidScope` otherwise). */
export const isNormalized = (scope: Scope): boolean =>
  namesTo(scope.callMatch)
    ? BigInt(scope.to) !== 0n && (namesSelector(scope.callMatch) || BigInt(scope.selector) === 0n)
    : BigInt(scope.to) === 0n && BigInt(scope.selector) === 0n

/** Zeroes the parts the scope leaves open and checksums the addresses. */
export const normalizeScope = (scope: Scope): Scope => ({
  actor: getAddress(scope.actor),
  to: namesTo(scope.callMatch) ? getAddress(scope.to) : zeroAddress,
  selector: namesSelector(scope.callMatch) ? (scope.selector.toLowerCase() as Hex) : NO_SELECTOR,
  callMatch: scope.callMatch,
})

export const anyCall = (actor: Address): Scope => ({
  actor,
  to: zeroAddress,
  selector: NO_SELECTOR,
  callMatch: CallMatch.ANY,
})
export const onContract = (actor: Address, to: Address): Scope => ({
  actor,
  to,
  selector: NO_SELECTOR,
  callMatch: CallMatch.CONTRACT,
})
export const onFunction = (actor: Address, to: Address, selector: Hex): Scope => ({
  actor,
  to,
  selector,
  callMatch: CallMatch.FUNCTION,
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

/** Level 0..5: `(actor == ANY ? 0 : 3) + callMatch`. */
export const levelOf = (scope: Pick<Scope, 'actor' | 'callMatch'>): number =>
  rawLevelOf(scope.actor, scope.callMatch)

/** The scope a call `(actor, to, selector)` is looked up at, for one level (`ScopeLib.keyAt`). */
export const scopeAt = (level: number, actor: Address, to: Address, selector: Hex): Scope =>
  normalizeScope({
    actor: level < ACTOR_LEVEL_OFFSET ? ANY : actor,
    to,
    selector,
    callMatch: (level % ACTOR_LEVEL_OFFSET) as CallMatch,
  })

/** The 6 scopes a call is looked up at, Everyone first. Actor ANY only has levels 0..2. */
export const lookupScopes = (actor: Address, to: Address, selector: Hex): { level: number; scope: Scope }[] =>
  Array.from({ length: isAny(actor) ? ACTOR_LEVEL_OFFSET : LEVEL_COUNT }, (_, level) => ({
    level,
    scope: scopeAt(level, actor, to, selector),
  }))

/** Whether an attachment at `scope` sees a call `(actor, to, selector)` (ignores the op mask). */
export const scopeCovers = (scope: Scope, actor: Address, to: Address, selector: Hex): boolean => {
  if (!isAny(scope.actor) && getAddress(scope.actor) !== getAddress(actor)) return false
  if (scope.callMatch === CallMatch.ANY) return true
  if (getAddress(scope.to) !== getAddress(to)) return false
  return scope.callMatch === CallMatch.CONTRACT || scope.selector.toLowerCase() === selector.toLowerCase()
}

/** `keccak256(abi.encode(scopeKey, uint8(kind), policy))`; `policy` is zero for ALLOW / DENY. */
export const attachmentId = (key: Hex, kind: Kind, policy: Address = zeroAddress): Hex =>
  keccak256(encodeAbiParameters(parseAbiParameters('bytes32, uint8, address'), [key, kind, policy]))

/** Selector a call is matched with: `0x00000000` for empty calldata, `null` for 1..3 bytes (denied). */
export const selectorOf = (data: Hex): Hex | null => {
  const length = size(data)
  if (length >= 4) return slice(data, 0, 4).toLowerCase() as Hex
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

/** The stored mask: 0 means CALL for ALLOW, both ops for DENY and POLICY (`ScopeLib.normalizeOpMask`). */
export const normalizeOpMask = (kind: Kind, opMask: number): number =>
  opMask !== 0 ? opMask : kind === Kind.ALLOW ? OP_CALL : OP_ALL

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

/** The 4 levels people see (SPEC.md §2 "App label"); the 6 keys fold into them. */
export const HumanLevel = { EVERYONE_ANY: 0, EVERYONE_CALL: 1, ACTOR_ANY: 2, ACTOR_CALL: 3 } as const
export type HumanLevel = (typeof HumanLevel)[keyof typeof HumanLevel]

export const HUMAN_LEVEL_LABELS: Record<HumanLevel, string> = {
  0: 'Everyone, any call',
  1: 'Everyone, this call',
  2: 'This actor, any call',
  3: 'This actor, this call',
}

export const humanLevel = (level: number): HumanLevel =>
  ((level >= ACTOR_LEVEL_OFFSET ? 2 : 0) + (level % ACTOR_LEVEL_OFFSET === 0 ? 0 : 1)) as HumanLevel

/** The 6 keys, as SPEC.md §2 names them. */
export const LEVEL_LABELS = [
  'Everyone, any call',
  'Everyone, this contract',
  'Everyone, this function',
  'This actor, any call',
  'This actor, this contract',
  'This actor, this function',
] as const

export const levelLabel = (level: number): string => LEVEL_LABELS[level] ?? `level ${level}`

export const KIND_LABELS: Record<Kind, string> = { 0: 'Allow', 1: 'Deny', 2: 'Policy' }

export const opMaskLabel = (opMask: number): string =>
  ({ 1: 'CALL', 2: 'DELEGATECALL', 3: 'CALL + DELEGATECALL' })[opMask] ?? `ops ${opMask}`

export const OPERATION_LABELS = ['CALL', 'DELEGATECALL'] as const

type NameOf = (address: Address) => string | undefined

const short = (address: Address): string => `${address.slice(0, 6)}…${address.slice(-4)}`

export const actorLabel = (actor: Address, nameOf: NameOf = () => undefined): string => {
  if (isAny(actor)) return 'Everyone'
  if (isOwners(actor)) return 'Owners'
  return nameOf(getAddress(actor)) ?? short(actor)
}

/** `*`, `USDC.*`, `USDC.transfer`: `selectorName` resolves known selectors. */
export const callLabel = (
  scope: Pick<Scope, 'to' | 'selector' | 'callMatch'>,
  nameOf: NameOf = () => undefined,
  selectorName: (selector: Hex) => string | undefined = () => undefined,
): string => {
  if (scope.callMatch === CallMatch.ANY) return '*'
  const target = nameOf(getAddress(scope.to)) ?? short(scope.to)
  const fn = scope.callMatch === CallMatch.FUNCTION ? (selectorName(scope.selector) ?? scope.selector) : '*'
  return `${target}.${fn}`
}

/** `(Ops, USDC.transfer)`, `(Owners, *)`, `(Everyone, *)`. */
export const scopeLabel = (
  scope: Scope,
  nameOf: NameOf = () => undefined,
  selectorName: (selector: Hex) => string | undefined = () => undefined,
): string => `(${actorLabel(scope.actor, nameOf)}, ${callLabel(scope, nameOf, selectorName)})`
