# Policy Engine V2, rev 3: specification

Research prototype, unaudited, Sepolia only. Sources: `PLAN-rev3.md` (its decisions table wins), `DESIGN-fable.md`
(base), `DESIGN-opus.md` (§C Timelock, §E.3 Limit pricing). The interfaces in `interfaces/` and the types in
`libraries/Types.sol`, `Scope.sol` (library `ScopeLib`) and `Constants.sol` are frozen; every error, event and NatSpec
detail lives there. This file explains the rules. Work package ownership: `HANDOFF.md`.

## 1. Model

A Safe with this engine as both guard (owner path) and module guard (module path) runs a call only if:

1. every attachment matched by the call is looked up (no "most specific wins"): any DENY or failing policy denies;
2. at least one ALLOW that counts grants it (deny by default); only ALLOW grants, policies only pass or deny;
3. every proof a policy needs (a schedule, an approval, an attestation) was pushed on-chain before execution, keyed
   by the transaction hash, on both paths.

An **actor** is `OWNERS` (address 1, the owner path) or a module. An **attachment** is (scope, kind, policy, op mask,
settings). Configuration is an ordinary Safe transaction to `engine.configure`, judged by the same rules.

## 2. Scopes

A call by actor A to `to.selector` is looked up at 6 scopes, one per level:

| Level | Scope | App label | Example |
| --- | --- | --- | --- |
| 0 | `(ANY, *)` | Everyone, any call | Safenet attestation on every transaction |
| 1 | `(ANY, to.*)` | Everyone, this contract | Timelock on every call to the Safe itself |
| 2 | `(ANY, to.selector)` | Everyone, this function | DENY `Safe.setFallbackHandler` |
| 3 | `(A, *)` | This actor, any call | Ops: Limit, Timelock(0, guardian G) |
| 4 | `(A, to.*)` | This actor, this contract | Limit on one token |
| 5 | `(A, to.selector)` | This actor, this function | ALLOW Ops `USDC.transfer` + Args recipients |

- `level = (actor == ANY ? 0 : 3) + callMatch`, `CallMatch {ANY, CONTRACT, FUNCTION}`. "Any contract, this selector"
  does not exist. `ANY` is address 0 and includes the owners.
- Normalized scope: `to` is zero iff `callMatch == ANY`; `selector` is zero unless `FUNCTION` (`selector == 0` with
  `FUNCTION` names empty calldata). Anything else is `InvalidScope`.
- `scopeKey = keccak256(abi.encode(actor, to, selector, uint8(callMatch)))`;
  `attachmentId = keccak256(abi.encode(scopeKey, uint8(kind), policy))`, policy 0 for ALLOW and DENY.
- Op mask: bit 0 CALL, bit 1 DELEGATECALL; an attachment matches a call only if its mask has the call's op bit. A zero
  mask in a change means the default: CALL for ALLOW, both ops for DENY and POLICY.
- Caps: 8 attachments per scope (all kinds), 8 calls per batch, 4 trusted batch contracts, 8 members per role list,
  revert reasons truncated to 512 bytes. Lookup cost: one packed word of 6 level counters, then per populated level
  one key, one length and one slot per attachment.

## 3. Engine

### 3.1 Hooks and context

| Path | Hook | `ctx.actor` | `ctx.txHash` |
| --- | --- | --- | --- |
| Owner | `checkTransaction` | `OWNERS` | Safe transaction hash at `nonce - 1` (Safe 1.5.0 increments first), real gas fields |
| Module | `checkModuleTransaction` | the module | `keccak256(abi.encode(safe, actor, to, value, data, uint8(op)))` of the top-level call |

`Context` is `(safe, actor, txHash)`. Owner path: `gasPrice` and `safeTxGas` must be 0 (`NonZeroGasPrice`,
`NonZeroSafeTxGas`). After-hooks revert `ExecutionFailed` / `ModuleExecutionFailed` on failure, so policy state written
by a check never survives a failed execution. A hook or `configure` entered during a check reverts `Reentrancy`.

### 3.2 Rules at configure

| Rule | Error |
| --- | --- |
| Scope normalized | `InvalidScope` |
| ALLOW names an actor, never `ANY` | `AllowNotPerActor` |
| An ALLOW covering DELEGATECALL only at level 5 (F4) | `DelegateCallNotExact` |
| Op mask at most 3 | `InvalidOpMask` |
| POLICY: non-zero, ERC-165 `IPolicy`; ALLOW / DENY: no policy, no settings | `InvalidPolicy` |
| `IPolicy.configure` must not revert | `PolicyConfigurationFailed` |
| At most 8 attachments per scope | `TooManyAttachments` |
| Detach an existing attachment | `NotAttached` |

`configure(Change[])` applies in order, at once, for `msg.sender` (the Safe). Attach or update calls the policy's
`configure` and emits `Attached`; detach never calls the policy (liveness) and emits `Detached`.

### 3.3 Configuration is an ordinary transaction

- Owner path: a top-level CALL with zero value to `engine.configure` is granted without an ALLOW (the owners can never
  lock themselves out by forgetting one). Everything else applies: DENYs and every matched policy run, so the
  owners' Timelock delays it, their freeze blocks it, their co-signer approves it.
- Module path: `configure` needs a level-5 ALLOW `(module, engine.configure)` (F5), e.g. recovery after R.
- Never inside a batch, never with value, never as DELEGATECALL; any other engine function: `GuardTargetDenied`.
- Install: the owners execute `[configure, setModuleGuard, setGuard]` in one batch before any guard runs. Leftovers
  from an earlier install are shown by the app and detached in the same batch.

### 3.4 Verdict order

1. Owner path: gas fields, then `Reentrancy`.
2. A top-level DELEGATECALL to a trusted batch is decoded: `MalformedBatch` (bad encoding, empty, value), `BatchTooLarge`.
   The wrapper itself is not matched; its sub-calls are.
3. Per call, in order: `InvalidSelector(i)` (1 to 3 bytes), `NestedBatch(i)`, engine target rule
   `GuardTargetDenied(i)`, the first matched DENY in level order `Denied(i, id)`, then no counting ALLOW
   `NotGranted(i, to, selector, op)`.
4. Each distinct policy once, in first-match order, with all its `(callIndex, level, attachmentId)` matches. A revert
   or a return other than `IPolicy.check.selector` is `PolicyDenied(policy, reason)`.

An ALLOW counts unless (F4) the call is a DELEGATECALL and the ALLOW is below level 5, or (F5) on the module path the
call targets the Safe or the engine and the ALLOW is below level 5.

### 3.5 Preview

`matches(safe, actor, to, value, data, op)` returns the calls, every matched attachment (`MatchView` with `counts`)
and the ABI-encoded engine error the hook would raise before policies (empty if the built-ins pass). The app then
`eth_call`s `policy.check(ctx, calls, matches)` with `from = engine` for each distinct policy: same code, same state,
nothing persists. TimelockPolicy uses `matches` at schedule time.

## 4. Policy interface

`IPolicy`: `configure(safe, attachmentId, scope, opMask, settings)` and `check(ctx, calls, matches) returns (bytes4)`.
Rules: state keyed by `msg.sender` (the engine) and the Safe; settings keyed `(engine, safe, attachmentId)` and fully
overwritten by `configure`; stale settings after a detach are harmless; one check per Safe transaction with every
match (the policy owns its merge rule); external reads by STATICCALL only; deterministic. `PolicyBase` provides
ERC-165, the PASS return, `_forEachMatch` and `_settingsKey`.

## 5. Policies

### 5.1 TimelockPolicy (delay, freeze, cancel)

Settings `{delay, window, guardians[], lifters[], cancellers[]}`, lists of at most 8, never the Safe, no guardians or
lifters at actor `ANY`. Immutables `MAX_FREEZE` (F) and `COOLDOWN` (C).

| Function | Who | Effect |
| --- | --- | --- |
| `schedule(engine, safe, safeTx, sigs)` | anyone relaying the owners' threshold signatures | queue an owner-path tx (nonce-bound hash) |
| `scheduleModuleTx(engine, safe, to, value, data, op)` | the module itself | queue its own call |
| `cancel(engine, safe, txHash)` | a canceller of a matched id, or the scheduling module | delete the schedule |
| `cancelAsOwners(engine, safe, txHash, sigs)` | anyone relaying `threshold` owner signatures | delete an owner-path schedule only |
| `freeze(engine, safe, ids[])` | a guardian of every id | freeze each id for F; frozen or cooling ids are skipped |
| `lift(engine, safe, id)` | a guardian or lifter of id | end the freeze, start the cooldown |

Merge rule over matched ids: frozen if any is frozen (checked first, even at delay 0); delay = max; start = max(schedule
time, latest `configuredAt`); ready at start + delay; window = min non-zero, expired after start + delay + window; void
if scheduled before any id's `frozenUntil`, unless the schedule is a configuration change; consumed on pass.

State machine per attachment: `ACTIVE -> FROZEN (now + F) -> COOLDOWN (frozenUntil + C) -> ACTIVE`; `lift` jumps to
COOLDOWN at once. No extension. `configure` never resets freeze state.

Invariant `TimelockNotCoveringConfiguration`: a delay at actor `OWNERS` or `ANY` needs an attached Timelock of this
policy, at least as long, covering that actor's call to `engine.configure` (`*`, `engine.*` or `engine.configure`, at
the actor or `ANY`). Narrow owner timelocks (Spark) therefore cannot be detached faster than they delay.

Sees: the transaction hash, the matched ids, the calls (for `isConfiguration`). Cannot see: anything off-chain.

Timelines (T = 24 h owners, R = 72 h recovery, F = 7 d, C = 12 h; T < R < F):

| Compromise | What happens | Bound |
| --- | --- | --- |
| Owner keys | Attacker schedules; G freezes `(Owners, *)`; their queue is void or blocked; recovery schedules `swapOwner` (R, unfrozen); new owners `cancelAsOwners` the attacker's configuration schedules; G or recovery lifts | R < F |
| Guardian | G freezes; owners schedule `configure(replace the attachment without G)`, exempt from voiding, ready at T, blocked until F (or a lift by recovery), executed in the cooldown; G cannot re-freeze during C | F + C per cycle, T < F |
| Recovery key | It schedules `swapOwner`, visible for R; owners schedule `configure(detach recovery)` and execute at T | T < R |
| Two colluding | Lost, as in rev 2 | documented |

### 5.2 ArgsPolicy (conditions, absorbs Recipients)

Settings `{constraints[], strict}`, constraint `{selector, target, index, op, values[]}`; at most 16 constraints, 32
values; selector `0xffffffff` = any call. Targets WORD (static head word `index`), CALL_TO, VALUE. Ops EQ, NEQ, IN,
NOT_IN, LTE, GTE, EQ_SAFE. Merge rule: each (call, attachment) judged alone; all constraints that apply must hold; none
applies and `strict` denies (`NoConstraint`). Who: engine only. Sees head words, `to`, `value`. Cannot see dynamic
arguments, nested calls, state. App presets: Recipients (`transfer` word 0 IN, `transferFrom` word 1 IN, empty
calldata CALL_TO IN), Spenders (`approve` word 0 IN, word 1 LTE cap), Receiver-is-the-Safe (EQ_SAFE on the receiver
word). Dropped from rev 2 Recipients: `approve(x, 0)` passing for any spender.

### 5.3 LimitPolicy (budgets)

Settings `{limits[{token, amount, period}], passUnpriced}`, at most 16 tokens, token 0 = native, period 0 = one-time.
Windows are a fixed grid anchored at configure; configure resets spending. Who: engine only; `remaining` is a view.

| Call | Counts |
| --- | --- |
| any call with `value > 0` | `value` of native, always, checked first (unlisted native: `Unpriced`, even with `passUnpriced`) |
| `transfer(to, a)` | `a` of `call.to` |
| `transferFrom(from, to, a)` | `a` if `from == safe`, else 0 |
| `approve(s, a)`, `a > 0`; `increaseAllowance(s, a)` | `a` in full: no reservation, no give-back |
| `approve(s, 0)`, `decreaseAllowance` | 0 (revocations are free) |
| empty calldata, zero value | 0 |
| a spend above of an unlisted token | `Unpriced`, even with `passUnpriced`: list the token |
| any other selector, any DELEGATECALL | unpriced: `Unpriced` unless `passUnpriced` |

Merge rule: each attachment prices the calls it matched, summed over the batch; all must fit (`LimitExceeded` names
the call). Out of scope: swap outputs and slippage, USD caps (no oracle), pulls through allowances given before the
Limit, operator rights (`setApprovalForAll`, Morpho `setAuthorization`, Aave `approveDelegation`), debt from
borrowing, fee-on-transfer and rebasing tokens, Universal Router `execute`, CoW order contents (`setPreSignature`
carries only a hash: the approval to the vault relayer is the budget), off-chain permits. List only ERC-20s: ERC-721
shares `transferFrom` and `approve`.

### 5.4 CoSignerPolicy (M-of-N approvals)

Settings `{approvers[], required}`, 1 to 8 approvers, never the Safe; EOAs or ERC-1271 contracts.

| Function | Who | Effect |
| --- | --- | --- |
| `approve(engine, safe, txHash, validUntil)` | the approver (anyone may call; only listed approvers count) | record `msg.sender`'s approval |
| `approveWithSig(engine, safe, txHash, approver, validUntil, sig)` | anyone (relayer) | record `approver`'s approval from an EIP-712 signature, ECDSA or ERC-1271 |
| `revoke(engine, safe, txHash)` | the approver | remove its approval |

Digest `Approval(engine, safe, txHash, useCount, validUntil)`, domain `CoSignerPolicy`, version 1; each digest can be
pushed once. Merge rule: every matched attachment needs `required` unexpired approvals from its own approvers (one
approval counts for every attachment that lists the approver); on pass `useCount` increments, consuming every approval
of the hash. Sees only `ctx.txHash`. 1-of-1 is the classic co-signer; a committee of approvers replaces Quorum's
same-Safe use.

### 5.5 SafenetPolicy (optional, wave 2)

No settings. `submitAttestation(engine, safe, txHash, deadline, attestation)` by anyone: deadline 0 means the owner
path (signed over the Safe transaction hash), otherwise the module path (signed over `attestationDigest`, expires at
the deadline). Merge rule: one credit per transaction, consumed by the check. Epochs as V1 (`updateEpoch`, anyone).

## 6. Security

| Simplification | Risk | Answer |
| --- | --- | --- |
| Freeze is a policy; configuration an ordinary call | Owners detach the policy to escape it | Detach is a `configure` call: delayed by the same Timelock, blocked while frozen, announced by `Scheduled`; narrow timelocks need a covering one |
| Freeze state per attachment | A guardian of `(Owners, *)` cannot stop `(Ops, *)` | By design; templates list G on every non-recovery attachment; lint "actor without a guardian" |
| Rogue guardian | Permanent freeze | F and C immutable, no extension, skip while frozen or cooling; the owners' `configure` schedule survives the freeze and runs in the cooldown; recovery as lifter shortens it |
| Compromised owners during a freeze | Their `configure` schedule survives too | Same exposure as rev 2's surviving request; recovery (R < F) replaces them and `cancelAsOwners` removes it |
| Owners could cancel recovery | Compromised owners block the way back | `cancelAsOwners` works on owner-path schedules only (`NotOwnersQueue`) |
| No rising owner cancel threshold | One honest owner cannot stall a compromised threshold | The guardian's freeze voids the owners' queue: freeze, then recover |
| No engine delay | A Safe without an owners' Timelock reconfigures at once | Their choice; lint warns; every template attaches `(Owners, *)` Timelock |
| One contract holds T, the freeze and R | One bug hits all three | Recovery is still a separate actor; timeline tests on T < R < F; audit priority |
| Policies run on `configure`, DENY applies | A deny-all rule or a dead co-signer locks configuration | Lint blocks; recovery with `(Recovery, engine.configure)` after R is the way back |
| Safe in a role list | An actor with an ALLOW on the policy makes the Safe freeze, cancel or approve | `configure` rejects the Safe as guardian, lifter, canceller or approver |
| Restrictions default to both ops | A CALL-only Timelock would miss a granted DELEGATECALL | Zero mask on DENY and POLICY means both ops; ALLOW stays CALL unless asked |
| One check per transaction | A policy that forgets some matches | `PolicyBase._forEachMatch`; batch tests for every policy |
| Approvals pushed early | An approval sits until used | `validUntil`, `revoke`, consumed on pass; a digest is usable once |
| Full-amount approvals | Re-approvals over-count | Accepted: removes the reservation and refill bug class (rev 2 D-4, D-17) |
| `passUnpriced` for protocol calls | It could hide an unbounded spend | It passes only selectors that are not a spend shape; a spend of an unlisted token (native included) always denies |
| CoW pre-sign | Receiver and amounts unseen | Budget-bounded by the approval; a `CowOrderHelper` is a later add-on |
| Preview off-chain | TS drifts from the engine; RPC refuses `eth_call` from a contract | The app never matches in TS (`matches` view); state-override call as fallback |
| Quorum dropped | Same-Safe tiers by amount | Committee Safe as a module actor with its own Limit, or CoSigner with owners as approvers |
| ERC-1271 dropped | Owners' off-chain signatures (permits, Permit2, CoW orders) bypass every policy | Install leaves the fallback handler alone; the app recommends Safe's `TokenCallbackHandler` and shows a notice; one documented test keeps the attack visible |
| WA-4014, WA-4016 | | Unchanged: every matching scope runs; the actor is in the key |

## 7. Removed from rev 2 and why

| Removed | Why |
| --- | --- |
| Engine freeze, guardian and lifter roles, `ConfigFrozen` | The freeze has one home: TimelockPolicy, per attachment |
| Engine configuration delay, request / apply / expiry, `configureImmediately`, `delayFloor` | Configuration is an owner transaction; the owners' Timelock is the delay |
| Policy levels (call / transaction), two check functions | One `check` per transaction with all matches |
| Owner-path context in the signatures tail | Every proof is pushed on-chain, both paths |
| Preview contract, runner, routing modules | `matches` view plus `eth_call`; dispatch back in the guard |
| ERC-1271 handler, sign library, effective op, Permit2 shapes | Out of scope for rev 3 (decision 12) |
| `*.selector` scope (8 levels to 6) | Its uses are covered by Args and Limit at `(A, *)`; a grant on any contract is a footgun |
| FreezePolicy, RecipientsPolicy, QuorumPolicyV2, CoSignerPolicyV2 | Merged into Timelock, Args, a committee actor, and CoSignerPolicy |
| Limit reservation and give-back, rising cancel threshold | Bug classes for little value (Opus E.3, G.12) |
| The deviations list | History is in git (`git show 3c6d740:contracts/contracts/v2/SPEC.md`) |
