# Policy Engine V2: specification (WP0, frozen interfaces)

Status: authoritative for WP1–WP10. Research prototype, unaudited, Sepolia only. Sources: `PLAN.md` rev 2 (D1–D5,
D4', F1–F13, §3a), `analysis-fable.md`, the V2 design doc. Where this file and the plan differ, this file wins and the
difference is listed in §13.

The words MUST / MUST NOT / MAY are normative. "Engine" means the single contract `SafePolicyGuardV2` (engine +
guard, one address); policies see it as `msg.sender`.

Files frozen by WP0 (change them only together with this spec, the TS mirror and the tests):

| File                                          | What                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `libraries/Types.sol`                         | Enums and structs shared by everything (ABI)                                     |
| `libraries/Scope.sol`                         | Sentinels, keys, levels, op masks, caps, identity hash                           |
| `libraries/MultiSendDecoder.sol`              | Batch decoding (complete implementation)                                         |
| `interfaces/IPolicyEngineV2.sol`              | Engine API, events, errors                                                       |
| `interfaces/IPolicyV2.sol`                    | What every policy implements                                                     |
| `interfaces/ISafeV2.sol`                      | Safe 1.5.0 functions beyond the vendored `ISafe`                                 |
| `interfaces/IPolicySignLib.sol`               | Typed ERC-1271 approvals (§10)                                                   |
| `interfaces/IPolicyFallbackHandler.sol`       | On-chain-only ERC-1271 handler (§10)                                             |
| `interfaces/policies/I*.sol`                  | Per-policy settings, functions, events, errors (§8)                              |
| `PolicyBaseV2.sol`                            | Abstract base for policies                                                       |
| `test/MockPolicyV2.sol`, `test/V2Harness.sol` | Scriptable policy for engine tests; library harness                              |
| `src/lib/v2/abi.ts` (generated), `scopes.ts`  | TS mirror (`pnpm export:v2-abi` in `contracts/`, then `pnpm format` at the root) |

Pinned values (asserted in `test/v2/Scope.test.ts`, mirrored in `scopes.ts`):

- `type(IPolicyEngineV2).interfaceId = 0xdc1727e9`, `type(IPolicyV2).interfaceId = 0x55872811`.
- `Scope.CONTEXT_TYPE_HASH = keccak256("SafePolicyGuardV2.PolicyContext.v1")`.

---

## 1. Model in one paragraph

A Safe transaction has an **actor** (`OWNERS` on `execTransaction`, the module on `execTransactionFromModule`) and one
or more **calls** (one, or the sub-calls of a trusted batch). Each call is looked up at **8 scopes** (actor ∈ {ANY,
actor} × call ∈ {any, `to`.\*, \*.`selector`, `to`.`selector`}). Each scope holds up to 8 **attachments**: the built-ins
ALLOW and DENY, or a POLICY contract with per-attachment settings. Every matching attachment runs. Any deny reverts the
transaction; every call needs at least one ALLOW that counts; policies only pass or deny. Call-level policies run per
call; transaction-level policies run once per transaction with the union of what all calls matched. Configuration is
delayed (`DELAY ≥` the owners' longest timelock), modules can never configure, and the engine holds a bounded freeze
that blocks applying configuration.

## 2. Sentinels and enums

| Name                 | Value                                                | Meaning                                                        |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `Scope.ANY`          | `address(0)`                                         | Actor wildcard: everyone, owners included                      |
| `Scope.OWNERS`       | `address(1)`                                         | The owner path. Safe's module-list sentinel, so never a module |
| `OP_CALL`            | `1`                                                  | Op-mask bit `1 << Operation.CALL`                              |
| `OP_DELEGATECALL`    | `2`                                                  | Op-mask bit `1 << Operation.DELEGATECALL`                      |
| `OP_ALL`             | `3`                                                  |                                                                |
| `Scope.TX_INDEX`     | `65535`                                              | `callIndex` of transaction-level gates / `PolicyDenied`        |
| `Scope.NO_LEVEL`     | `255`                                                | `scopeLevel` of engine-rule gates                              |
| `PASS` (call)        | `IPolicyV2.checkCall.selector` = `0xbfe2dd0d`        | Only value meaning "pass" from `checkCall`                     |
| `PASS` (transaction) | `IPolicyV2.checkTransaction.selector` = `0xe18ffdca` | Only value meaning "pass" from `checkTransaction`              |

Enums (numeric values are ABI; append only): `CallMatch {ANY, TO, SELECTOR, TO_SELECTOR}`, `AttachmentKind {ALLOW, DENY,
POLICY}`, `PolicyLevel {CALL, TRANSACTION}`, `FreezeRole {GUARDIAN, LIFTER}`, `ChangeType {SET, DETACH}`, `Verdict {PASS,
ALLOW, DENY}`, `GateKind {ALLOW, DENY, POLICY, RULE}`, `Operation {CALL, DELEGATECALL}` (vendored).

## 3. Scopes, levels, keys, ids

```
ScopeData { actor, to, selector, callMatch }
level      = (actor == ANY ? 0 : 4) + uint8(callMatch)                       // 0..7
scopeKey   = keccak256(abi.encode(address actor, address to, bytes4 selector, uint8 callMatch))
attachmentId = keccak256(abi.encode(bytes32 scopeKey, uint8 kind, address policy))   // policy = 0 for ALLOW / DENY
```

| Level | Scope           | Level | Scope                              |
| ----- | --------------- | ----- | ---------------------------------- |
| 0     | `(ANY, *)`      | 4     | `(A, *)`                           |
| 1     | `(ANY, to.*)`   | 5     | `(A, to.*)`                        |
| 2     | `(ANY, *.sel)`  | 6     | `(A, *.sel)`                       |
| 3     | `(ANY, to.sel)` | 7     | `(A, to.sel)`: the **exact scope** |

- **Normalized scope**: the parts `callMatch` leaves open are zero (`to = 0` unless `TO`/`TO_SELECTOR`; `selector = 0`
  unless `SELECTOR`/`TO_SELECTOR`). The engine rejects anything else (`InvalidScope`). A named `to` MUST be non-zero
  (`InvalidScope`). A named selector MAY be `0x00000000`: it is the selector of a call with **empty calldata** (as V1);
  `callMatch` keeps it distinct from the wildcard. Known equivalence kept from V1: calldata starting with `0x00000000`
  matches the same scope as empty calldata.
- **Selector of a call**: first 4 bytes; `0x00000000` for empty calldata; 1–3 bytes is invalid (`InvalidSelector`).
- **Lookup key** of a call `(actor, to, selector)` at level L: `Scope.keyAt(L, ...)` = `scopeKey` with actor replaced by
  ANY for L < 4 and the open parts zeroed. A call is looked up only at levels whose per-Safe counter is non-zero.
- **One attachment per (scope, kind, policy)**: the id is the identity. Attaching the same policy twice at one scope is an
  update (§5).

## 4. Policy interface (IPolicyV2)

```solidity
function policyLevel() external view returns (PolicyLevel);   // read at attach, cached; must never change
function configure(address safe, bytes32 attachmentId, ScopeData scope, uint8 opMask, bytes data)
    external returns (uint256 delayFloor);
function checkCall(Context ctx, Call call, bytes32[] attachmentIds) external returns (bytes4);
function checkTransaction(Context ctx, Call[] calls, bytes signatures, bytes policyData, bytes32[] attachmentIds)
    external returns (bytes4);
```

- `Context { safe, actor, txHash, nonce, executor }` (§7 for `txHash`). `executor`: owner path = the `msgSender` the Safe
  passes to the guard (trusted, it comes from the Safe); module path = the module.
- **Verdict.** PASS iff the call succeeds, `returndatasize == 32`, and the word equals the PASS selector of the function
  called, left-aligned with zero padding. Anything else is **DENY**: a revert (reason = revert data, truncated to
  `MAX_REASON_LENGTH = 512` bytes), out of gas, a wrong or malformed return (reason = empty). There is no "allow" from a
  policy contract: ALLOW and DENY are engine built-ins.
- **Settings** live in the policy, keyed `(engine = msg.sender, safe, attachmentId)`. `configure` MUST fully overwrite
  the settings of that id and MAY reset its state (re-attach = reset, as V1 reconfiguration). On DETACH the engine does
  **not** call the policy (a reverting policy must never block its own removal); stale settings stay until a future SET
  of the same id overwrites them.
- `delayFloor`: the delay these settings impose on transactions (TimelockPolicy: `delay`; everything else: 0). §5.3.
- **Grouping.** For one unit (a call for CALL level, the transaction for TRANSACTION level) a policy is called **once**
  with all its matched attachment ids: call level in first-match order for that call; transaction level the union over
  all calls, deduplicated, first-match order. "First-match order": calls in order, levels 0→7, attachments in storage
  order. The policy owns its merge rule (§8). `attachmentIds` is never empty.
- A policy MUST namespace state by `msg.sender`, read external state by STATICCALL only, never make a state-changing call
  to untrusted code, and behave identically under `preview`.
- `PolicyBaseV2` implements ERC-165, the level dispatch (`WrongPolicyLevel`, `NoAttachments`), the PASS return, a
  `_checkEngine` hook (default: any engine) and `_settingsKey(engine, safe, id)`. A policy overrides `policyLevel`,
  `_configure` and one of `_checkCall` / `_checkTransaction`; it passes by returning and denies by reverting.

## 5. Configuration path (D1)

### 5.1 Entry points (msg.sender is the Safe)

| Function                               | Rule                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configureImmediately(changes, roles)` | Only while the engine is neither the Safe's guard nor its module guard (`GuardAlreadyEnabled`); same slot reads as V1. Applies at once, emits `ConfiguredImmediately(safe, root)` first.                                                                                                                                  |
| `requestConfiguration(root)`           | `validFrom = now + DELAY`. Reverts `RootAlreadyRequested` if a request exists that is not expired; an expired one is overwritten. Emits `ConfigRequested(safe, root, validFrom)`. Allowed during a freeze.                                                                                                                |
| `invalidateRoot(root)`                 | Deletes a request in any state (`RootNotRequested` if none). Emits `ConfigInvalidated`. Allowed during a freeze.                                                                                                                                                                                                          |
| `applyConfiguration(changes, roles)`   | `root = keccak256(abi.encode(changes, roles))`. Reverts `RootNotRequested`, `RootPending(root, validFrom)` if `now < validFrom`, `RootExpired` if `now ≥ validFrom + EXPIRY`, `ConfigFrozen(frozenUntil)` while the **Safe-wide** freeze is active. Deletes the request, emits `ConfigApplied(safe, root)`, then applies. |
| `configurationRoot(changes, roles)`    | Pure helper for the root.                                                                                                                                                                                                                                                                                                 |

- `root = keccak256(abi.encode(AttachmentChange[] changes, RoleChange[] roles))` (TS: `configurationRoot` in `scopes.ts`).
- Changes are applied in array order, then role changes in array order. Any failure reverts the whole apply (the request
  is kept).
- The freeze never touches `rootConfigured` (F3): a request made during a freeze can be applied once the freeze ends,
  during the cooldown.
- **Through the guard** (§6.2): a top-level owner-path `CALL` with zero value to the engine with selector
  `requestConfiguration` (`0xa809eb8e`), `invalidateRoot` (`0x3eefdcce`) or `applyConfiguration` (`0x1d4ed8ec`) is the
  configuration path: no scope lookup, no policy, no ALLOW needed (a Safe can never lock itself out). On the module path
  any of them is `ModuleConfigurationDenied`. Anywhere else (in a batch, DELEGATECALL, value) it is `GuardTargetDenied`.

### 5.2 Applying an AttachmentChange

```
validate scope: isNormalized, named `to` != 0                      else InvalidScope
key = scopeKey(scope); level = level(scope); id = attachmentId(key, kind, policy)
SET:
  opMask = (opMask == 0) ? OP_CALL : opMask;  opMask <= 3           else InvalidOpMask(opMask)
  kind ALLOW/DENY: policy == 0 && data empty                        else InvalidPolicy(policy)
  kind ALLOW && opMask has DELEGATECALL: level == 7                 else DelegateCallNotExact
  kind POLICY: policy has code, supportsInterface(0x55872811) true,
               policyLevel() decodes to 0 or 1                     else InvalidPolicy(policy)
  if new: attachments[safe][key].length < 8                        else TooManyAttachments(key)
          push; levelCounts[safe][level]++; if first in scope → add to scope list
  else:   overwrite opMask and policyLevel in place
  kind POLICY: delayFloor = policy.configure(safe, id, scope, opMask, data)
               (revert → PolicyConfigurationFailed(policy, reason))
               if delayFloor > DELAY && scope.actor ∈ {ANY, OWNERS} → DelayBelowTimelock(DELAY, delayFloor)
  emit Attached(safe, id, key, actor, to, selector, callMatch, kind, policy, opMask, policyLevel, data)
DETACH:
  exists                                                            else NotAttached(id)
  swap-and-pop; levelCounts[safe][level]--; if scope empty → remove from scope list (swap-and-pop)
  emit Detached(safe, id, key)                                      (policy not called; data/opMask ignored)
```

`RoleChange { role, account, enabled }`: idempotent; emits `RoleSet` only when membership changes; at most
`MAX_ROLE_MEMBERS = 8` per role (`TooManyRoleMembers(role)`); `account != 0`.

### 5.3 Delay floor (F1)

The engine enforces `DELAY ≥ delayFloor` for every POLICY attachment whose scope actor is `ANY` or `OWNERS`, at SET time
(both `configureImmediately` and `apply`). With `DELAY` immutable, the owners' effective delay for anything (a
transaction, or a configuration change detaching their timelock or granting a fast actor) is at least their timelock.
Timelocks on other actors (Recovery R, Agent) are not bounded by `DELAY`.

### 5.4 Constructor

`constructor(uint256 delay, uint256 expiry, uint256 maxFreeze, uint256 freezeCooldown, address[] trustedBatches, address signLib)`

- `expiry > 0`, `maxFreeze > 0`, `expiry ≥ maxFreeze + freezeCooldown + delay` (F3) else `InvalidTiming`.
- `signLib != 0`, `1 ≤ trustedBatches.length ≤ 4`, no zero, no duplicates, else `InvalidDeployment`. All immutable.
- Deploy (WP7): `DELAY` 5 s (play) and 24 h (freeze story); `MAX_FREEZE` 7 d; `FREEZE_COOLDOWN` 12 h; `EXPIRY` ≥ 8.5 d
  - DELAY (use 9 d for both); trusted batches = MultiSendCallOnly 1.4.1 + MultiSend 1.4.1 (and 1.5.0 if deployed).

## 6. Evaluation

### 6.1 Hooks (Safe 1.5.0)

```
checkTransaction(to, value, data, op, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures, msgSender):
  require(gasPrice == 0)    NonZeroGasPrice
  require(safeTxGas == 0)   NonZeroSafeTxGas
  safe = msg.sender; actor = OWNERS; nonce = ISafe(safe).nonce() - 1
  txHash = ISafe(safe).getTransactionHash(to, value, data, op, safeTxGas, baseGas, gasPrice, gasToken,
                                          refundReceiver, nonce)          // real fields, MAY be computed lazily
  ctx = Context(safe, OWNERS, txHash, nonce, msgSender)
  policyContexts = decodeContext(signatures)                             // §6.6
  evaluate(ctx, to, value, data, op, signatures, policyContexts, PREVIEW=false)

checkAfterExecution(hash, success):              require(success)  ExecutionFailed

checkModuleTransaction(to, value, data, op, module) returns (bytes32 moduleTxHash):
  safe = msg.sender; actor = module
  txHash = Scope.moduleCallHash(safe, module, to, value, data, op)
  ctx = Context(safe, module, txHash, 0, module)
  evaluate(ctx, to, value, data, op, "", none, false)
  return txHash

checkAfterModuleExecution(hash, success):        require(success)  ModuleExecutionFailed
```

`supportsInterface`: `IPolicyEngineV2` (`0xdc1727e9`), `ITransactionGuard` (`0xe6d7a83a`), `IModuleGuard`
(`0x58401ed8`), `IERC165` (`0x01ffc9a7`).

Re-entrancy: a transient-storage flag is set for the duration of `evaluate` (hooks and `preview`). A hook or `preview`
entered while it is set reverts `Reentrancy`; so does every state-changing engine function (configuration, freeze).
Views stay callable (policies read `freezeStatus` during a check). Nothing carries from the pre-hook to the post-hook,
so nested executions (a module call that triggers another Safe's checks) are independent.

### 6.2 Units and engine rules

```
evaluate(ctx, to, value, data, op, signatures, policyContexts, preview):
  // Top level
  if to == ENGINE:                                             // §6.4 engine targets
      sel = selector(data)
      if sel ∈ CONFIG_SELECTORS:
          if ctx.actor != OWNERS                    → ModuleConfigurationDenied
          if op != CALL or value != 0               → GuardTargetDenied
          if sel == applyConfiguration && safe-wide frozen → ConfigFrozen(frozenUntil)   // early; apply re-checks
          return                                     // configuration path: nothing else runs
  if op == DELEGATECALL && isTrustedBatch(to) && selector(data) == multiSend (0x8d80ff0a):
      if value != 0                                 → MalformedBatch
      (ok, tooMany, calls) = MultiSendDecoder.decode(ctx.safe, data)
      tooMany                                       → BatchTooLarge
      !ok                                           → MalformedBatch
  else:
      calls = [Call(to, value, data, op)]

  txMatches = []                                                // (policy, attachmentId), deduped, ordered
  for i, call in calls:
      checkCall(i, call)                                         // §6.3
  for each distinct TRANSACTION-level policy P in txMatches (first-match order):
      run P.checkTransaction(ctx, calls, signatures, policyData[P], ids[P])
      deny → PolicyDenied(TX_INDEX, P, reason)
```

`calls` passed to transaction-level policies is the decoded batch, or the single call. The batch wrapper itself is
**transparent**: it is not looked up, needs no ALLOW, and matches no scope (a DENY at `(A, MultiSend.*)` never fires).

### 6.3 One call

```
checkCall(i, call):
  sel = selector(call.data)                         1..3 bytes → InvalidSelector(i)
  if call.to == ENGINE:
      sel ∈ CONFIG_SELECTORS (inside a batch) → ModuleConfigurationDenied if module, else GuardTargetDenied
      sel ∉ {freeze 0x1d38fcda, freezeActor 0x6a6a89ef, lift 0x05dda954} → GuardTargetDenied
  if call.op == DELEGATECALL && isTrustedBatch(call.to) && i is a batch sub-call → NestedBatch(i)
  effOp = call.op
  if call.op == DELEGATECALL && call.to == SIGN_LIB && sel ∈ {signPermit 0x51bdfa61, signCowOrder 0x3d296e04,
                                                               signPermit2 0xda3c0cb0}:
      effOp = CALL                                   // typed approvals are priced like calls (§10)
  selfTarget = (call.to == ctx.safe || call.to == ENGINE)

  matches = []
  for L in 0..7 with levelCounts[L] != 0:
      for a in attachments[safe][keyAt(L, ctx.actor, call.to, sel)]:
          if a.opMask & (1 << effOp) == 0: continue
          matches.push((L, a))

  for (L, a) in matches with a.kind == DENY:         → Denied(i, id(a))                 (first in order)
  granted = any (L, a) in matches with a.kind == ALLOW and allowCounts(L, a)
  !granted                                           → NotGranted(i, call.to, sel, call.op)
  for each distinct CALL-level policy P in matches (first-match order):
      run P.checkCall(ctx, call, ids of P in matches)
      deny → PolicyDenied(i, P, reason)
  append TRANSACTION-level POLICY matches to txMatches (dedupe by attachmentId)

allowCounts(L, a):
  if effOp == DELEGATECALL and L != 7: false         // unreachable: enforced at attach; kept as defence
  if selfTarget and ctx.actor != OWNERS and L != 7: false     // F5
  true
```

DELEGATECALL summary (F4): there is no op wildcard; an attachment covers only the ops in its mask, and a SET with mask 0
means CALL. A DELEGATECALL is executable only (a) to a trusted batch with `multiSend` at top level (decoded, one level),
(b) to `SIGN_LIB` with a typed selector (matched as CALL), or (c) when an ALLOW at the exact scope `(A, to.selector)`
covers DELEGATECALL. Restrictions (DENY, POLICY) MAY cover DELEGATECALL at any level.

### 6.4 Calls to the Safe itself and to the engine (F5)

- A call whose (resolved) `to` is the Safe (`setGuard`, `setModuleGuard`, `enableModule`, `setFallbackHandler`,
  `swapOwner`, ...) or the engine is granted on the **module path only by an ALLOW at level 7** `(module, to.selector)`.
  On the owner path any matching ALLOW counts (owners' own protections, e.g. their Timelock, still apply). Matching
  restrictions run in all cases.
- Engine targets: configuration selectors take the configuration path (§5.1, top level only). `freeze`, `freezeActor`,
  `lift` are normal calls under the rule above (a guarded guardian Safe freezing another Safe). Every other engine
  selector (guard hooks, `configureImmediately`, `preview`, views) is `GuardTargetDenied`: a Safe transaction aimed at
  the engine could otherwise drive a fabricated check (V1 rationale).
- An ALLOW that matched but does not count is reported by `preview` as verdict PASS with reason `AllowNotExact()`.

### 6.5 Verdict combination

- Any DENY (built-in DENY, a policy deny, an engine rule) reverts the Safe transaction. In a real check the first one in
  the order of §6.2–6.3 is the revert error.
- Each call needs ≥ 1 ALLOW that counts; pass-only is denied by default (`NotGranted`).
- Transaction-level policies run only after every call passed its call-level gates; they cannot grant.

### 6.6 Owner-path policy context

`signatures` MAY end with a `SignatureExtension` envelope of type `Scope.CONTEXT_TYPE_HASH`; its payload is
`abi.encode(PolicyContext[] { address policy; bytes data; })`. Absent → every policy gets empty `policyData`. Present
but malformed (envelope, ABI, or a policy listed twice) → `MalformedContext` (a deny). Each transaction-level policy
receives the `data` of the entry naming it, else empty. Call-level policies receive no context. The context is
**untrusted** (any executor chooses it): only self-authenticating proofs (signatures, attestations) belong there. Module
path and preview: no context.

### 6.7 Preview

`preview(safe, actor, to, value, data, op)` MUST always revert with `Preview(GateResult[] gates)`:

- `actor` is `OWNERS` (owner path) or a module (`InvalidActor(actor)` for `ANY`).
- Same algorithm, `msg.sender` of policies is the engine, but nothing stops at a deny: every engine rule, every matched
  attachment and every policy run produces gates. Context: owner path `txHash = getTransactionHash(..., zero gas fields,
nonce = current nonce)`, `nonce = current`, `executor = address(0)`, no signatures, no policy context; module path as
  the hook. Policies needing signatures/context report their deny reason (useful: "needs co-signature").
- Gates, in evaluation order: per call, the engine-rule denies (`kind RULE`, `scopeLevel NO_LEVEL`, `reason` = encoded
  engine error), then one gate per matched attachment (built-ins: ALLOW → verdict ALLOW or PASS+`AllowNotExact`, DENY →
  DENY), one gate **per attachment** of each call-level policy run (all with that run's verdict and reason), then the
  `NotGranted` RULE gate if no ALLOW counted; finally one gate per attachment of each transaction-level run with
  `callIndex = TX_INDEX`. A malformed batch yields a single RULE gate. A configuration-path call yields no gate (or the
  RULE gate of its denial).
- **The transaction is allowed iff no gate has verdict DENY.**
- Implementations SHOULD keep a gas reserve so an out-of-gas policy is reported rather than aborting the preview.

## 7. Identity and proofs (F7, D5)

| Path    | `ctx.txHash`                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Owner   | Safe transaction hash with the real gas fields and `nonce − 1` (binds chain id, Safe, nonce)                                     |
| Module  | `callHash = keccak256(abi.encode(safe, actor, to, value, data, uint8(op)))` (`Scope.moduleCallHash`; returned as `moduleTxHash`) |
| Preview | Owner: hash at the current nonce, gas fields zero. Module: `callHash`                                                            |

- Module-path proofs (Timelock schedule, co-signature, Safenet attestation) are **pushed before execution** by direct
  calls to the policy, stored under `(engine, safe, callHash)` and **consumed** (deleted) by the check. No nonce: the
  same call twice needs a second proof after the first executed. A failed module execution reverts, so the proof is not
  consumed.
- `callHash` has no chain id and no engine: policies that verify **signatures** over a module transaction sign the
  EIP-712 digest `ModuleTransaction(address engine,address safe,bytes32 callHash)` under their own domain
  `(name, "1", chainid, policy address)`; never the raw `callHash`.
- Owner path: proofs ride in the policy context (§6.6), or (Timelock) are pushed with owner signatures over the Safe
  transaction hash. An owner schedule dies when the Safe nonce moves past it.

### 7.1 Freeze state machine (D2, F2, F3)

State per `(safe, key)`, `key = ANY` (Safe-wide) or a module actor: `FreezeState { frozenAt, frozenUntil, cooldownUntil,
epoch }`. Immutables `MAX_FREEZE` (F) and `FREEZE_COOLDOWN` (C). Roles per Safe, set only through configuration:
guardians (freeze, lift) and lifters (lift only, e.g. the recovery key). "Active" means `now < frozenUntil`.

```
          freeze / freezeActor (guardian)                       lift (guardian or lifter)
 ACTIVE ─────────────────────────────────▶ FROZEN ───────────────────────────────▶ COOLDOWN ──(now ≥ cooldownUntil)──▶ ACTIVE
   ▲      frozenAt = now                    │        frozenUntil = now                │
   │      frozenUntil = now + F             │        cooldownUntil = now + C          │
   │      cooldownUntil = now + F + C       └── now ≥ frozenUntil (expiry) ──────────▶┘
   │      epoch++
```

- `freeze(safes[])`: caller MUST be a guardian of every listed Safe (`NotGuardian(safe)`, whole call reverts). A Safe
  already frozen or cooling down is **skipped** with `FreezeSkipped(safe, guardian, until)`; others get `Frozen(safe,
ANY, guardian, until, epoch)`. An incident freeze of many Safes never fails because of one.
- `freezeActor(safe, actor)`: guardian only; `actor ∉ {ANY, OWNERS}` (`InvalidActor`); reverts `AlreadyFrozen` /
  `FreezeCooldown`. Owners are frozen only Safe-wide: alternating a Safe-wide and an owners-actor freeze would otherwise
  keep the owners frozen beyond F + C.
- `lift(safe, actor)`: guardian or lifter (`NotGuardianOrLifter`); `NotFrozen` unless active; sets `frozenUntil = now`,
  `cooldownUntil = now + C`, emits `Unfrozen`. Owners can never lift (unless an owner address is made lifter — lint).
- **No extension**: a freeze runs at most F from its start; re-freezing while frozen is a no-op/revert; a lift starts
  the cooldown, so lift + re-freeze cannot extend it.
- The freeze **blocks `applyConfiguration`** (Safe-wide only), never request/invalidate, never clears the configuration
  queue. Everything else it affects is by placement: `FreezePolicy` attached where the owners want it (§8.1).
- `freezeStatus(safe, actor) → (safeFrozen, actorFrozen, epoch)`, with `epoch = epoch(ANY) + epoch(actor)` (just
  `epoch(ANY)` for `actor = ANY`): it increases with every freeze that affects the actor. TimelockPolicy uses it.

## 8. Policies: settings, merge rules, behaviour

Settings are always `abi.encode(Settings)` of the struct in the policy's interface (each interface has a pure
`encodeSettings(Settings)` so the ABI carries the type; TS: `encodeAbiParameters(getAbiItem({abi, name:
'encodeSettings'}).inputs, [settings])`). Invalid settings revert `InvalidSettings()` in `configure`. Every policy keys
settings and state by `(engine, safe, attachmentId)` unless stated.

| Policy           | Level       | Settings                                                                                                | Merge over matched attachments                                      | delayFloor |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| FreezePolicy     | TRANSACTION | `{bool safeWide; bool actor}` (≥ 1 set)                                                                 | deny if any attachment's flags hit                                  | 0          |
| TimelockPolicy   | TRANSACTION | `{uint32 delay; uint32 window; bool clearOnFreeze; address[] cancellers}`                               | max delay, min non-zero window, clear if any, union of cancellers   | `delay`    |
| RecipientsPolicy | CALL        | `{address[] recipients; address[] spenders; uint256 maxApproval; bool strict}`                          | every list must contain the party; min `maxApproval`; strict if any | 0          |
| LimitPolicy      | CALL        | `{TokenLimit[] limits; bool passUnpriced}`, `TokenLimit {address token; uint128 amount; uint64 period}` | debit every attachment; each must have room                         | 0          |
| ArgsPolicy       | CALL        | `{ArgConstraint[] constraints; bool strict}`                                                            | every constraint of every attachment holds                          | 0          |
| CoSignerPolicyV2 | TRANSACTION | `{address cosigner}`                                                                                    | every distinct co-signer must have signed                           | 0          |
| SafenetPolicyV2  | TRANSACTION | none (`data` empty)                                                                                     | one attestation                                                     | 0          |
| QuorumPolicyV2   | TRANSACTION | `{uint8 required; Tier[] tiers}`, `Tier {address token; uint256 above; uint8 required}`                 | max requirement                                                     | 0          |

### 8.1 FreezePolicy

Stateless reader. Check: `(safeFrozen, actorFrozen, _) = IPolicyEngineV2(msg.sender).freezeStatus(ctx.safe,
ctx.actor)`; deny `Frozen(safe, actor, until)` if some attachment has `safeWide && safeFrozen` or `actor &&
actorFrozen`. Placement (D2): attach at `(Owners, *)`, `(Ops, *)`, `(Agent, *)`, … with op mask `OP_ALL`, never at
`(Recovery, *)` and not globally; the app adds it when an actor gets its first ALLOW. Recovery's owner change passes a
freeze because nothing froze it, not because of an exemption.

### 8.2 TimelockPolicy

- `delay > 0`, `cancellers.length ≤ 8`, no zero canceller. `delayFloor = delay`.
- **Schedule (owner path)** `scheduleOwnerTx(engine, safe, SafeTransaction, signatures)`: `txHash =
ISafe(safe).getTransactionHash(...)`; `nonce ≥ ISafe(safe).nonce()` else `StaleNonce`;
  `checkNSignatures(address(0), txHash, signatures, getThreshold())` (the same signatures that will execute it;
  a direct call, never a Safe transaction, which would wait for its own timelock). Actor = OWNERS.
- **Schedule (module path)** `scheduleModuleTx(engine, safe, to, value, data, op)`: `msg.sender` is the actor;
  `txHash = moduleCallHash(safe, msg.sender, to, value, data, op)`.
- Both: `AlreadyScheduled` if present. Store `Schedule {actor, scheduledAt = now, readyAt, epoch, frozenAtSchedule}`
  with `(safeFrozen || actorFrozen, epoch) = engine.freezeStatus(safe, actor)`. Resolve the attachments the transaction
  matches with `engine.getMatchingAttachments(safe, actor, to, value, data, op, address(this))`; store the union of
  their `cancellers` (snapshot) and `readyAt = now + max delay` (informational). Emit `Scheduled(engine, safe, txHash,
actor, to, value, data, op, nonce, readyAt)` (nonce 0 on the module path).
- **Check**: `s = schedule[engine][safe][ctx.txHash]`, `s.actor == ctx.actor` else `NotScheduled`.
  `delay = max(attachment delays)` now (current settings), `readyAt = s.scheduledAt + delay`; `now < readyAt` →
  `NotReady(txHash, readyAt)`; `w = min non-zero window`, `w != 0 && now > readyAt + w` → `ScheduleExpired`. If any
  attachment has `clearOnFreeze` and (`s.frozenAtSchedule` or `s.epoch != freezeStatus(safe, actor).epoch`) →
  `ClearedByFreeze`. Pass: delete the schedule; if `ctx.actor == OWNERS` reset `cancelCount[engine][safe] = 0`; emit
  `Executed`.
- **Cancel by owners** `cancelAsOwners(engine, safe, txHash, signatures)`: only `s.actor == OWNERS` (`NotOwnersQueue`);
  `required = min(cancelCount + 1, threshold)`; `checkNSignatures(address(0), cancelDigest, signatures, required)` with
  `cancelDigest = EIP-712("TimelockPolicy", "1", chainid, this) Cancel(address engine,address safe,bytes32 txHash,
uint256 cancelCount)`; delete; `cancelCount++`; emit `Cancelled(..., by = msg.sender, cancelCount)`. A single rogue
  owner gets one cancel; the rising count resets only when an owners' schedule executes.
- **Cancel by a canceller** `cancel(engine, safe, txHash)`: `msg.sender` in the schedule's canceller snapshot
  (`NotCanceller`), any actor's queue (the Spark case: another Safe cancels). Recovery's queue is cancellable only if its
  attachments list cancellers (default: none; owners remove the recovery module instead, T < R).
- `clearOnFreeze`: true at `(Owners, *)`, false at `(Recovery, *)` (doc: the freeze clears the owners' queue, keeps
  recovery's owner change). Schedules made before or during a freeze must be re-made after it.

### 8.3 RecipientsPolicy

Per call, the "party" checked against **every** matched attachment (the Safe itself always passes):

| Call shape (selector)                                | Party / check                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `value > 0` (any selector, incl. empty calldata)     | `call.to` ∈ recipients                                                 |
| `transfer(to, amount)` `0xa9059cbb`                  | `to` ∈ recipients                                                      |
| `transferFrom(from, to, amount)` `0x23b872dd`        | `to` ∈ recipients                                                      |
| `approve(spender, amount)` `0x095ea7b3`              | `spender` ∈ spenders; `amount ≤ maxApproval` unless `amount == 0`      |
| `increaseAllowance(spender, added)` `0x39509351`     | `spender` ∈ spenders; `allowance(safe, spender) + added ≤ maxApproval` |
| `decreaseAllowance(spender, sub)` `0xa457c2d7`       | passes                                                                 |
| `SIGN_LIB.signPermit` / `signPermit2` (DELEGATECALL) | `spender` ∈ spenders; amount ≤ `maxApproval`                           |
| `SIGN_LIB.signCowOrder`                              | `receiver` ∈ recipients (`0` = the Safe)                               |
| anything else                                        | pass, or `UnclassifiedCall(selector)` if any attachment is `strict`    |

Lists ≤ 64 entries each. Native-value check works next to `Allow (Owners, *)` because every matching scope runs (Akshay's
case). Malformed calldata for a known selector → deny.

### 8.4 LimitPolicy ("Transfer budget")

- Per `(engine, safe, attachmentId, token)`: `{amount, period, spent, windowStart}`; fixed-grid windows anchored at
  configure time (V1 `SpendingLimitPolicy`); `period 0` = one-time. ≤ 16 tokens, no duplicates, `amount > 0`.
- Pricing of a call (sum of spends per token; `address(0)` = native):

| Shape                                                    | Spend                                                                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value > 0`                                              | `value` of native (in addition to the data's own spend)                                                                                                                                       |
| empty calldata                                           | nothing else                                                                                                                                                                                  |
| `transfer(to, amount)` on token T                        | `amount` of T                                                                                                                                                                                 |
| `transferFrom(from, to, amount)`                         | `amount` of T if `from == safe`, else 0                                                                                                                                                       |
| `approve(spender, amount)` / `signPermit`, `signPermit2` | reservation: `delta = amount − allowance(safe, spender)` (STATICCALL); `delta > 0` spends it; `delta < 0` gives back `min(−delta, reserved[spender] in the current window)`, never below zero |
| `increaseAllowance(spender, added)`                      | `added` (reservation)                                                                                                                                                                         |
| `decreaseAllowance(spender, sub)`                        | give-back as above, `min(sub, reserved)`                                                                                                                                                      |
| `signCowOrder(order)`                                    | `sellAmount + feeAmount` of `sellToken`                                                                                                                                                       |
| anything else                                            | **unpriced**                                                                                                                                                                                  |

- Per attachment: a priced spend of a token it lists is debited (`LimitExceeded(id, token, requested, available)`); a
  spend of a token it does not list, or an unpriced call, denies with `Unpriced(id, token, selector)` unless
  `passUnpriced`. Batches sum naturally (each sub-call debits in order). `remaining(engine, safe, id, token)` for the app.
- A limit only holds with deny-by-default ALLOWs on calls it can price; lint "Limit next to unpriceable ALLOW".

### 8.5 ArgsPolicy

`ArgConstraint {bytes4 selector; uint16 argIndex; ArgOp op; bytes32[] values}`, `ArgOp {EQ, NEQ, IN, NOT_IN, LTE, GTE,
EQ_SAFE}` on the static word `w = data[4 + 32·i : 4 + 32·(i+1)]` (`ArgMissing` if too short). Constraints whose
selector equals the call's apply (AND across all matched attachments); none applies → pass, or `NoConstraint` if any
attachment is `strict`. ≤ 16 constraints, ≤ 32 values.

### 8.6 CoSignerPolicyV2 (port of V1, both paths)

- Owner path: `policyData = abi.encode(CoSignature[] {address cosigner; bytes signature})`; for each distinct co-signer of
  the matched attachments a valid signature over `ctx.txHash` (ECDSA 65 bytes low-s, or ERC-1271 for a contract), as
  V1. `MissingCoSignature` / `InvalidCoSignature` / `MalformedPolicyData`.
- Module path: `cosign(engine, safe, callHash, cosigner, signature)` (anyone relays) over `moduleTxDigest(engine, safe,
callHash)`; the check requires and consumes one per co-signer.
- One run per transaction: one co-signature covers the whole batch (fixes V1's per-sub-call spend).

### 8.7 SafenetPolicyV2 (port of V1, both paths)

Owner path: `policyData` = V1's 256-byte attestation over the Safe transaction hash (`ctx.txHash`), epoch forest as V1.
Module path: `submitAttestation(engine, safe, callHash, attestation)` over `moduleTxDigest(engine, safe, callHash)` in
place of the safeTxHash; consumed by the check. One attestation per transaction (batches no longer fail closed).
Constructor and `updateEpoch` as V1; WP5 vendors the FROST libraries from 8ee68a8 under `contracts/v2/` (not under
`vendor/policy-engine`).

### 8.8 QuorumPolicyV2 (port of IncreasedThresholdPolicy)

Owner path only (`ModulePathUnsupported` on the module path). `required = max over attachments of max(settings.required,
tiers whose token total across the calls > above)`; totals priced as §8.4 (approvals count their full amount);
clamped to the owner count. Check `ISafe(safe).checkNSignatures(ctx.executor, ctx.txHash, signatures, required)`
(`executor` from the Safe is trusted, so an executing owner's `v = 1` signature counts as in the Safe itself); a revert
→ `QuorumNotMet(required, reason)`. The owners put `required` signatures (sorted) in `signatures`; the Safe reads its
threshold from the front.

## 9. Caps and gas

| Cap                          | Value | Error                            |
| ---------------------------- | ----- | -------------------------------- |
| Attachments per scope        | 8     | `TooManyAttachments`             |
| Lookups per call             | 8     | (levels with zero count skipped) |
| Calls per batch, nesting     | 16, 1 | `BatchTooLarge`, `NestedBatch`   |
| Guardians / lifters per Safe | 8     | `TooManyRoleMembers`             |
| Trusted batch contracts      | 4     | `InvalidDeployment`              |
| Revert reason kept           | 512 B | (truncated)                      |
| Policy settings              | §8    | `InvalidSettings`                |

Worst case: 16 calls × 64 matched attachments. Storage reads on the hot path: one slot (the packed level counters), one
array length per populated level, one slot per attachment. Policies are called with all remaining gas (out of gas =
deny); no per-policy gas stipend. Measured gas is WP7's table (F12 expects ~30–40 k end to end for an ops payment).

## 10. ERC-1271 (§3a)

- `PolicyFallbackHandler.isValidSignature(hash, sig)` returns the magic value iff `sig` is empty and
  `signedMessages[getMessageHashForSafe(safe, abi.encode(hash))] != 0`; never checks owner signatures (no off-chain
  1271). Legacy `isValidSignature(bytes, bytes)` same over `keccak256(data)`.
- `PolicySignLib` (DELEGATECALL, `SIGN_LIB`): writes `signedMessages[msgHash] = 1` in the Safe's storage (slot 7 in
  Safe 1.5.0 `SafeStorage`, as `SignMessageLib`) and emits `SignMsg(msgHash)`, `msgHash = getMessageHashForSafe(safe,
abi.encode(digest))`:
  - `signPermit(token, spender, value, deadline, nonce)`: EIP-2612 `Permit(owner = safe, spender, value, nonce,
deadline)` digest under `token.DOMAIN_SEPARATOR()`.
  - `signCowOrder(GPv2Order)`: `GPv2Order.hash` under the settlement's `domainSeparator()` (settlement immutable).
  - `signPermit2(token, spender, amount, expiration, nonce, sigDeadline)` (stretch): `PermitSingle` digest.
  - `signMessage(bytes32 digest)`: raw; stays DELEGATECALL, so only an exact-scope ALLOW covering DELEGATECALL grants it.
- Engine: a DELEGATECALL to `SIGN_LIB` with a typed selector is matched as CALL (§6.3), so `Allow (Owners, *)` covers
  signing (with the owners' Timelock, Freeze, Co-signer), and Limit / Recipients price the decoded fields.
  `setFallbackHandler` is a call to the Safe (§6.4). The app lints a Safe whose handler is not `PolicyFallbackHandler`.

## 11. Errors (IPolicyEngineV2) and when they fire

| Error                                                                           | When                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Denied(callIndex, attachmentId)`                                               | A built-in DENY matched                                                              |
| `PolicyDenied(callIndex, policy, reason)`                                       | A policy denied (`callIndex = 65535` at transaction level)                           |
| `NotGranted(callIndex, to, selector, operation)`                                | No counting ALLOW                                                                    |
| `AllowNotExact()`                                                               | Preview reason only (§6.4)                                                           |
| `InvalidSelector(callIndex)`                                                    | 1–3 bytes of calldata                                                                |
| `MalformedBatch()`                                                              | Trusted batch that does not decode, is empty, or has value                           |
| `BatchTooLarge()`                                                               | > 16 sub-calls                                                                       |
| `NestedBatch(callIndex)`                                                        | Sub-call DELEGATECALLs a trusted batch                                               |
| `MalformedContext()`                                                            | Bad policy-context envelope or payload                                               |
| `GuardTargetDenied()`                                                           | Engine target outside §6.4, or a config call that is not a top-level zero-value CALL |
| `ModuleConfigurationDenied()`                                                   | Config selector on the module path                                                   |
| `NonZeroGasPrice()` / `NonZeroSafeTxGas()`                                      | Owner path refunds / `safeTxGas`                                                     |
| `ExecutionFailed()` / `ModuleExecutionFailed()`                                 | Post-hooks with `success == false`                                                   |
| `Reentrancy()`                                                                  | Hook, preview or state-changing engine call during a check                           |
| `Preview(gates)`                                                                | Always, from `preview`                                                               |
| `GuardAlreadyEnabled()`                                                         | `configureImmediately` once installed                                                |
| `RootAlreadyRequested` / `RootNotRequested` / `RootPending` / `RootExpired`     | §5.1                                                                                 |
| `ConfigFrozen(frozenUntil)`                                                     | `applyConfiguration` during the Safe-wide freeze                                     |
| `InvalidScope()`                                                                | Not normalized, or named `to == 0`                                                   |
| `InvalidOpMask(opMask)`                                                         | Mask > 3                                                                             |
| `DelegateCallNotExact()`                                                        | ALLOW covering DELEGATECALL below level 7                                            |
| `InvalidPolicy(policy)`                                                         | §5.2 policy validation                                                               |
| `PolicyConfigurationFailed(policy, reason)`                                     | `configure` reverted                                                                 |
| `DelayBelowTimelock(delay, required)`                                           | §5.3                                                                                 |
| `TooManyAttachments(scopeKey)` / `NotAttached(id)` / `TooManyRoleMembers(role)` | §5.2                                                                                 |
| `InvalidTiming()` / `InvalidDeployment()`                                       | Constructor                                                                          |
| `NotGuardian(safe)` / `NotGuardianOrLifter(safe)`                               | Freeze / lift authorization                                                          |
| `AlreadyFrozen` / `FreezeCooldown` / `NotFrozen`                                | `freezeActor` / `lift` state                                                         |
| `InvalidActor(actor)`                                                           | `freezeActor` with ANY/OWNERS; `preview` with ANY                                    |

Policy errors are declared in their interfaces (§8) and surface as `PolicyDenied.reason`; `policyV2ErrorsAbi` in
`abi.ts` decodes all of them.

## 12. Events

| Event                                                                                                             | Emitted                |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `Attached(safe, attachmentId, scopeKey, actor, to, selector, callMatch, kind, policy, opMask, policyLevel, data)` | SET (create or update) |
| `Detached(safe, attachmentId, scopeKey)`                                                                          | DETACH                 |
| `RoleSet(safe, role, account, enabled)`                                                                           | Role membership change |
| `ConfigRequested(safe, root, validFrom)` / `ConfigInvalidated(safe, root)`                                        | §5.1                   |
| `ConfigApplied(safe, root)` / `ConfiguredImmediately(safe, root)`                                                 | Before the change logs |
| `Frozen(safe, actor, guardian, until, epoch)` / `Unfrozen(safe, actor, by, cooldownUntil)`                        | §7.1                   |
| `FreezeSkipped(safe, guardian, until)`                                                                            | `freeze(safes[])` skip |
| Timelock `Scheduled` / `Cancelled` / `Executed`; CoSigner `Cosigned`; Safenet `Attested`; SignLib `SignMsg`       | Policies               |

The app rebuilds a Safe's configuration from `Attached`/`Detached`/`RoleSet` alone, or reads the enumeration views
(`getScopes`, `getAttachments`, `getScopeAttachments`, `getAttachment`, `levelsUsed`, `getRoleMembers`,
`getMatchingAttachments`). Alerts: `ConfigRequested` (who changes what, with DELAY to react), `Frozen`, `Scheduled`
(full call).

## 13. Decisions taken here, and differences from the plan

1. **Legacy V1 mode: none.** §0 of the plan removes it; §3 "Scope" still lists it. Followed §0 and the brief: policy
   contracts return PASS or deny, V1 policies are not attachable.
2. **IPolicyV2 receives attachment ids, not scope keys** (plan §4 says `scopes[]`), because settings are per attachment
   and an id determines its scope. `configure` also receives the scope and op mask, and returns `delayFloor`: that is how
   the engine learns a Timelock's delay for D1 without knowing policy types.
3. **"Exact-scope ALLOW (or to OWNERS)" for Safe/engine targets** read as: module path needs level 7 `(module,
to.selector)`; level 3 `(ANY, to.selector)` does not count (it would grant every module `setGuard`); owner path any
   ALLOW.
4. **DELEGATECALL grants**: only ALLOW at level 7 may cover DELEGATECALL (checked at attach). Op mask 0 = CALL.
5. **Batch wrapper transparent**; config calls only as top-level CALLs (not inside a batch).
6. **`freezeActor(OWNERS)` forbidden** (owners frozen Safe-wide only) to keep the F + C bound against a rogue guardian
   alternating freeze kinds. `freeze(safes[])` skips frozen / cooling Safes instead of reverting.
7. **Only the Safe-wide freeze blocks `applyConfiguration`.**
8. **Owner-path context format changed**: `abi.encode(PolicyContext[])` under a new type hash, because several
   transaction-level policies (Co-signer, Safenet, Quorum) can need context in the same transaction. Co-signer services
   still sign the plain Safe transaction hash.
9. **`callHash` has no chain id / engine** (plan formula kept); signature-based proofs wrap it in an EIP-712
   `ModuleTransaction(engine, safe, callHash)` under the policy's domain.
10. **Timelock**: delay recomputed at execution from current attachments; cancellers snapshotted at schedule time
    (via `getMatchingAttachments`); optional `window` expiry (module-path schedules have no nonce and would otherwise
    live forever); freeze clearing by epoch + "frozen at schedule"; owner cancel digest is EIP-712 under the policy.
11. **QuorumPolicy uses the Safe-provided `executor`** for `checkNSignatures` (V1 used `address(0)` because its context
    was untrusted; here the executor comes from the Safe).
12. **Preview has exactly the 6 parameters of the brief** (no signatures): context-dependent policies report their deny
    reason; the app shows them as "needs …". The `Preview` error carries only gates; allowed iff no DENY gate.
13. **No detach hook** (liveness over hygiene).
14. **EXPIRY ≥ F + C + DELAY** kept from the plan, although `F + C − DELAY` is the tight bound.
15. Plan F8 says ERC-1271 is out of scope; §3a puts it in scope. Followed §3a (§10 here).
16. `afterExecution` dropped (F9); a future hook would be a new `PolicyLevel` value (append-only enum), the "reserved bit".
