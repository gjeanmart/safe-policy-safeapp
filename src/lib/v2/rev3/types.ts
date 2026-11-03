/**
 * Policy Engine V2 rev 3: pure constants mirroring `contracts/contracts/v2/libraries/Types.sol`,
 * `Scope.sol` (library `ScopeLib`), `Constants.sol` and the policy interfaces (SPEC.md §2 to §5).
 * No imports, so the contracts tests can load it: `contracts/test/v2/Scope.test.ts` checks every
 * value against the Solidity harness.
 */

type Hex = `0x${string}`

// ---------------------------------------------------------------------------------------------
// Actors, operations, scopes
// ---------------------------------------------------------------------------------------------

/** Actor wildcard: everyone, owners included. */
export const ANY: Hex = '0x0000000000000000000000000000000000000000'
/** The owner path (`execTransaction`); Safe's module-list sentinel, so never a module. */
export const OWNERS: Hex = '0x0000000000000000000000000000000000000001'

export const Operation = { CALL: 0, DELEGATECALL: 1 } as const
export type Operation = (typeof Operation)[keyof typeof Operation]

/** The call dimension of a scope. "Any contract, this selector" does not exist in rev 3. */
export const CallMatch = { ANY: 0, CONTRACT: 1, FUNCTION: 2 } as const
export type CallMatch = (typeof CallMatch)[keyof typeof CallMatch]

export const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
export type Kind = (typeof Kind)[keyof typeof Kind]

/** Op mask bits (`1 << operation`). 0 in a change = default: CALL for ALLOW, both for DENY and POLICY. */
export const OP_CALL = 1
export const OP_DELEGATECALL = 2
export const OP_ALL = 3

/** level = (actor === ANY ? 0 : ACTOR_LEVEL_OFFSET) + callMatch */
export const LEVEL_COUNT = 6
export const ACTOR_LEVEL_OFFSET = 3
export const EXACT_LEVEL = 5

export const Level = {
  ANY_ANY: 0, //           (ANY, *)
  ANY_CONTRACT: 1, //      (ANY, to.*)
  ANY_FUNCTION: 2, //      (ANY, to.selector)
  ACTOR_ANY: 3, //         (A, *)
  ACTOR_CONTRACT: 4, //    (A, to.*)
  ACTOR_FUNCTION: 5, //    (A, to.selector), the exact level
} as const
export type Level = (typeof Level)[keyof typeof Level]

export const levelOf = (actor: string, callMatch: CallMatch): number =>
  (actor.toLowerCase() === ANY ? 0 : ACTOR_LEVEL_OFFSET) + callMatch

// ---------------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------------

export const MAX_ATTACHMENTS_PER_SCOPE = 8
export const MAX_BATCH_CALLS = 8
export const MAX_TRUSTED_BATCHES = 4
export const MAX_REASON_LENGTH = 512
export const MAX_ROLE_MEMBERS = 8
export const MAX_ARGS_CONSTRAINTS = 16
export const MAX_ARGS_VALUES = 32
export const MAX_LIMIT_TOKENS = 16

// ---------------------------------------------------------------------------------------------
// Selectors, magic values, interface ids
// ---------------------------------------------------------------------------------------------

export const Selectors = {
  multiSend: '0x8d80ff0a',
  erc20Transfer: '0xa9059cbb',
  erc20TransferFrom: '0x23b872dd',
  erc20Approve: '0x095ea7b3',
  erc20IncreaseAllowance: '0x39509351',
  erc20DecreaseAllowance: '0xa457c2d7',
  /** `IPolicyGuard.configure(Change[])` */
  configure: '0xada59cb2',
  /** `IPolicy.check(Context,Call[],Match[])`: the PASS value a policy returns. */
  check: '0x45f1bacd',
} as const satisfies Record<string, Hex>

/** ArgsPolicy: a constraint with this selector applies to every call. */
export const ANY_SELECTOR: Hex = '0xffffffff'
export const ERC1271_MAGIC_VALUE: Hex = '0x1626ba7e'

/** ERC-165 ids (`type(I).interfaceId`, own functions only). */
export const InterfaceIds = {
  IPolicyGuard: '0x0f8d6033',
  IPolicy: '0xedd49bcb',
  ITimelockPolicy: '0xa46bc64f',
  IArgsPolicy: '0x365878b9',
  ILimitPolicy: '0x64ad8ac4',
  ICoSignerPolicy: '0x9c977234',
  ISafenetPolicy: '0x1f1cd9d7',
} as const satisfies Record<string, Hex>

// ---------------------------------------------------------------------------------------------
// Policy enums
// ---------------------------------------------------------------------------------------------

/** `IArgsPolicy.Target` */
export const ArgsTarget = { WORD: 0, CALL_TO: 1, VALUE: 2 } as const
export type ArgsTarget = (typeof ArgsTarget)[keyof typeof ArgsTarget]

/** `IArgsPolicy.Op` */
export const ArgsOp = { EQ: 0, NEQ: 1, IN: 2, NOT_IN: 3, LTE: 4, GTE: 5, EQ_SAFE: 6 } as const
export type ArgsOp = (typeof ArgsOp)[keyof typeof ArgsOp]

// ---------------------------------------------------------------------------------------------
// ABI tuple types (for viem `encodeAbiParameters`), in Solidity field order
// ---------------------------------------------------------------------------------------------

export const SCOPE_TUPLE = '(address actor,address to,bytes4 selector,uint8 callMatch)'
export const CHANGE_TUPLE = `(bool detach,${SCOPE_TUPLE} scope,uint8 kind,address policy,uint8 opMask,bytes settings)`
export const CALL_TUPLE = '(address to,uint256 value,bytes data,uint8 operation)'
export const CONTEXT_TUPLE = '(address safe,address actor,bytes32 txHash)'
export const MATCH_TUPLE = '(uint16 callIndex,uint8 level,bytes32 attachmentId)'
