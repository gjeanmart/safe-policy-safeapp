# Policy Engine V2: specification (WP0, frozen interfaces)

Status: authoritative for WP1–WP10. Research prototype, unaudited, Sepolia only. Sources: `PLAN.md` rev 2 (D1–D5,
D4', F1–F13, §3a), `analysis-fable.md`, the V2 design doc. Where this file and the plan differ, this file wins and the
difference is listed in §13. Deviations accepted after implementation are fixed inline and listed in §14.

The words MUST / MUST NOT / MAY are normative. "Engine" means `SafePolicyGuardV2` (engine + guard, one address);
policies see it as `msg.sender`, Safes install it, the app and guardians call it. Its code is six contracts, each deployed
in its own transaction because a Sepolia transaction cannot deploy more than ≈ 10 KB of code (§14, D-6 and D-18); all
of it runs on the guard's storage at the guard's address, reached by DELEGATECALL, and nobody calls a module directly:

| Contract (`engine/` unless noted) | Holds                                                                                                    | Reached by                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `SafePolicyGuardV2` (`v2/`)       | The hooks: engine rules, scope lookup, built-in DENY / ALLOW, batch decoding; `freezeStatus`, `SIGN_LIB` | Safes, policies (the hot path)              |
| `PolicyEngineV2Runner`            | Policy runs: grouping, owner-path `txHash` and policy context, encoding, the policy calls                | the hooks and `preview`, one call per check |
| `PolicyEngineV2Config`            | `configureImmediately`, `requestConfiguration`, `invalidateRoot`, `applyConfiguration`, roles            | the guard's fallback                        |
| `PolicyEngineV2Freeze`            | `freeze`, `freezeActor`, `lift`, and every small view (immutables, roles, freeze state, ids, batches)    | the guard's fallback (its default)          |
| `PolicyEngineV2Preview`           | `preview`: the hooks' evaluation compiled to report every gate                                           | the guard's fallback                        |
| `PolicyEngineV2Views`             | enumeration views and `getMatchingAttachments`; `supportsInterface` (§14 D-27)                           | the guard's fallback                        |

The guard's compiled ABI is therefore partial; `interfaces/ISafePolicyGuardV2.sol` (`IPolicyEngineV2` + both guard
interfaces + `engineModules()`) is the full ABI of the address.

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
actor} × call ∈ {any, `to`.\*, \*.`selector`, `to`.`selector`}). Each scope holds up to 6 **attachments**: the built-ins
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
| `configureImmediately(changes, roles)` | Only while the engine is neither the Safe's guard nor its module guard (`GuardAlreadyEnabled`); same slot reads as V1. Only on an empty configuration: no attachment and no role (`ConfigurationNotEmpty`, §14 D-25). Applies at once, emits `ConfiguredImmediately(safe, root)` first.                                   |
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
  configuration path: no ALLOW needed, no DENY applies (a Safe can never lock itself out), and only the POLICY
  attachments at the exact scopes of that selector, `(OWNERS, engine.selector)` (level 7) and `(ANY, engine.selector)`
  (level 3), run, call level and transaction level, with the owner-path context (§6.6) (§14 D-19). Policies at broader
  scopes, `(Owners, *)` included, do not run: the owners' Timelock is covered by `DELAY ≥ T` (§5.3) and their Freeze by
  `ConfigFrozen`, and a Co-signer, Safenet or Quorum guarding the owners must also be attached at
  `requestConfiguration` and `applyConfiguration` to have a say over configuration (the app lints it and its Quorum
  template does it). A policy attached there that always denies does lock the owners out: the app blocks a Freeze there
  (it would block the owners' only move against a rogue guardian, §7.1). On the module path any of them is
  `ModuleConfigurationDenied`. Anywhere else (in a batch, DELEGATECALL, value) it is `GuardTargetDenied`.

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
  if new: attachments[safe][key].length < 6                        else TooManyAttachments(key)
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
`MAX_ROLE_MEMBERS = 8` per role (`TooManyRoleMembers(role)`); `account != 0`, else `InvalidActor(address(0))` (the frozen
interface has no dedicated error; §14, D-7).

### 5.3 Delay floor (F1)

The engine enforces `DELAY ≥ delayFloor` for every POLICY attachment whose scope actor is `ANY` or `OWNERS`, at SET time
(both `configureImmediately` and `apply`). With `DELAY` immutable, the owners' effective delay for anything (a
transaction, or a configuration change detaching their timelock or granting a fast actor) is at least their timelock.
Timelocks on other actors (Recovery R, Agent) are not bounded by `DELAY`.

### 5.4 Constructor

`constructor(uint256 delay, uint256 expiry, uint256 maxFreeze, uint256 freezeCooldown, address[] trustedBatches, address signLib, address[5] modules)`

- `expiry > 0`, `maxFreeze > 0`, `expiry ≥ maxFreeze + freezeCooldown + delay` (F3) else `InvalidTiming`.
- `signLib != 0`, `1 ≤ trustedBatches.length ≤ 4`, no zero, no duplicates, else `InvalidDeployment`. All immutable.
- `modules = [config, freeze, preview, views, runner]` (§14, D-18), each deployed first with the same six arguments
  (each module runs the same checks in its own constructor); the guard checks every module's
  `engineParams() == keccak256(abi.encode(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib))`, else
  `InvalidDeployment`. `engineModules()` returns them.
- Deploy (`scripts/deploy-v2.ts`): `DELAY` 5 s (play) and 24 h (freeze story); `MAX_FREEZE` 7 d; `FREEZE_COOLDOWN`
  12 h; `EXPIRY` 9 d for both (F3 needs ≥ 8.5 d for the 24 h engine, so V1's 7 d does not fit); trusted batches = the
  canonical MultiSendCallOnly 1.4.1 and 1.5.0, no full `MultiSend` (§14, D-11). `PolicySignLib` is deployed first (its
  address is a constructor argument), then per engine its five modules and the guard, one transaction each
  (`scripts/lib/v2-deployment.ts`, also used by the tests). A Safe installs the engine as **both** guard and module
  guard (`setGuard` and `setModuleGuard`).

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

checkAfterExecution(hash, success):              require(success)  ExecutionFailed        // unreachable, below

checkModuleTransaction(to, value, data, op, module) returns (bytes32 moduleTxHash):
  safe = msg.sender; actor = module
  txHash = Scope.moduleCallHash(safe, module, to, value, data, op)
  ctx = Context(safe, module, txHash, 0, module)
  evaluate(ctx, to, value, data, op, "", none, false)
  return txHash

checkAfterModuleExecution(hash, success):        require(success)  ModuleExecutionFailed
```

Post-hooks on Safe 1.5.0 (§14, D-10):

- **Owner path**: `ExecutionFailed` is unreachable. The engine requires `safeTxGas == 0` and `gasPrice == 0`, and with
  both zero the Safe reverts a failed inner call itself (`GS013`) before the post-hook. Kept as defence.
- **Module path**: a failing inner call no longer makes `execTransactionFromModule` return `false`: the post-hook
  reverts `ModuleExecutionFailed`, so the module's whole call reverts. Module authors that branch on the returned
  `success` get a revert instead (and a pushed proof is not consumed, §7).

`supportsInterface`: `IPolicyEngineV2` (`0xdc1727e9`), `ITransactionGuard` (`0xe6d7a83a`), `IModuleGuard`
(`0x58401ed8`), `IERC165` (`0x01ffc9a7`); answered by `PolicyEngineV2Views` through the guard's `fallback` (§14 D-27).

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
          calls = [Call(to, 0, data, CALL)]; checkCall(0, ...) as the configuration path:
              no ALLOW needed, only POLICY attachments at levels 3 and 7 match (§5.1, §14 D-19)
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
      sel ∈ CONFIG_SELECTORS inside a batch → ModuleConfigurationDenied if module, else GuardTargetDenied
      (top level: the configuration path, §5.1)
      sel ∉ {freeze 0x1d38fcda, freezeActor 0x6a6a89ef, lift 0x05dda954} → GuardTargetDenied
  if call.op == DELEGATECALL && isTrustedBatch(call.to) && i is a batch sub-call → NestedBatch(i)
  effOp = call.op
  if call.op == DELEGATECALL && call.to == SIGN_LIB && sel ∈ {signPermit 0x51bdfa61, signCowOrder 0x3d296e04,
                                                               signPermit2 0xda3c0cb0, signMessage}:
      effOp = CALL                                   // sign-lib approvals are matched like calls (§10, D-22)
  selfTarget = (call.to == ctx.safe || call.to == ENGINE)

  matches = []
  for L in 0..7 with levelCounts[L] != 0:
      for a in attachments[safe][keyAt(L, ctx.actor, call.to, sel)]:
          ALLOW: if a.opMask & (1 << effOp) == 0: continue                 // grants by the effective op
          DENY / POLICY: if a.opMask & ((1 << effOp) | (1 << call.op)) == 0: continue   // either op (D-23)
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
(b) to `SIGN_LIB` with a typed selector or `signMessage` (matched as CALL), or (c) when an ALLOW at the exact scope
`(A, to.selector)` covers DELEGATECALL. Restrictions (DENY, POLICY) MAY cover DELEGATECALL at any level; for a
`SIGN_LIB` entry they match whether their mask names DELEGATECALL (the raw op) or CALL (the effective op), an ALLOW only
by the effective op (§14 D-23).

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
- F5 protects only the Safe and the engine (review L-6). Other contracts that trust `msg.sender == safe` (Permit2 once
  the Safe approved it, `GPv2Settlement.setPreSignature`, other modules' admin functions, a TimelockPolicy `cancel` if
  the Safe lists itself) are reachable through a module's `(X, to.*)` Allow; the app warns on such an Allow for Permit2,
  GPv2Settlement and the Safe's other modules.

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
  `callIndex = TX_INDEX`. A malformed batch yields a single RULE gate. A configuration-path call yields the gates of
  its exact-scope policies (§5.1), or the RULE gate of its denial.
- **The transaction is allowed iff no gate has verdict DENY.**
- Implementations SHOULD keep a gas reserve so an out-of-gas policy is reported rather than aborting the preview. The
  engine forwards `gasleft() − 300 000` to each policy in `preview` (`gasleft() / 2` below 600 000); real checks forward
  all remaining gas (§9, §14, D-8).

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
- `callHash` has no chain id and no engine: policies that verify **signatures** over a module transaction sign an
  EIP-712 `ModuleTransaction` digest under their own domain `(name, "1", chainid, policy address)`; never the raw
  `callHash`. SafenetPolicyV2: `ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 deadline)`.
  CoSignerPolicyV2 adds its own use counter: `ModuleTransaction(address engine,address safe,bytes32 callHash,uint256
nonce,uint256 deadline)` with `nonce = moduleTxNonce(engine, safe, callHash)` (§8.6, §14, D-1). Both proofs can only be
  pushed and consumed while `block.timestamp <= deadline` (`CoSignatureExpired`, `AttestationExpired`): an approval
  given long ago does not authorise the call today (§14, D-15).
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
- **A rogue guardian, cycling** (review F14, `Compromise.test.ts`): it can freeze at most F, then not for C; lifting
  its own freeze only starts the cooldown sooner. So in every `F + C` the owners get at least `C` unfrozen, in which a
  matured configuration request (made during the freeze, allowed) applies: removing the guardian. With the deployed
  `C = 12h < T = 24h`, a guardian that freezes again as soon as each cooldown ends bumps the epoch every `C`, so **no
  owners' timelocked transaction with `clearOnFreeze` can ever execute** while it cycles (each schedule is voided
  before its T passes); the configuration path, which runs neither the owners' Freeze nor their Timelock (§5.1), is
  their only move, and it is enough.
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
- **Schedule (owner path)** `scheduleOwnerTx(engine, safe, SafeTransaction, signatures)`: `safeTxGas == 0` and
  `gasPrice == 0` else the engine's `NonZeroSafeTxGas` / `NonZeroGasPrice` (the engine refuses both at execution, so
  such a schedule could never run; §14 D-24); `txHash = ISafe(safe).getTransactionHash(...)`; `nonce ≥ ISafe(safe).nonce()` else `StaleNonce`;
  `checkNSignatures(address(0), txHash, signatures, getThreshold())` (the same signatures that will execute it;
  a direct call, never a Safe transaction, which would wait for its own timelock). Actor = OWNERS.
- **Schedule (module path)** `scheduleModuleTx(engine, safe, to, value, data, op)`: `msg.sender` is the actor;
  `txHash = moduleCallHash(safe, msg.sender, to, value, data, op)`.
- Both: `NoTimelock(txHash)` unless at least one attachment of this policy matches the transaction (a schedule made
  with no Timelock would be ready at once when one is attached later; §14 D-20). `AlreadyScheduled` if present, except
  when the existing schedule can never pass its check again, under the current merged settings: voided by a freeze
  (§14, D-3: some matched attachment has `clearOnFreeze` and `s.frozenAtSchedule || s.epoch != epoch now`), or expired
  (§14, D-21: `w != 0 && now > max(s.scheduledAt, configuredAt) + delay + w`, merged as in the check); it is then
  replaced. Without this, a voided or expired module-path schedule (no nonce) would block the same call forever. Store `Schedule {actor, scheduledAt = now, readyAt, epoch, frozenAtSchedule}`
  with `(safeFrozen || actorFrozen, epoch) = engine.freezeStatus(safe, actor)`. Resolve the attachments the transaction
  matches with `engine.getMatchingAttachments(safe, actor, to, value, data, op, address(this))`; store the union of
  their `cancellers` (snapshot) and `readyAt = now + max delay` (informational). Emit `Scheduled(engine, safe, txHash,
actor, to, value, data, op, nonce, readyAt)` (nonce 0 on the module path).
- **Check**: `s = schedule[engine][safe][ctx.txHash]`, `s.actor == ctx.actor` else `NotScheduled`.
  `delay = max(attachment delays)` now (current settings), `readyAt = max(s.scheduledAt, configuredAt) + delay`
  where `configuredAt` is the latest time a matched attachment was configured (`configure` records it per attachment;
  view `configuredAt(engine, safe, id)`; §14 D-20): attaching, raising or re-configuring a Timelock restarts the wait
  of every pending schedule it matches; `now < readyAt` →
  `NotReady(txHash, readyAt)`; `w = min non-zero window`, `w != 0 && now > readyAt + w` → `ScheduleExpired`. If any
  attachment has `clearOnFreeze` and (`s.frozenAtSchedule` or `s.epoch != freezeStatus(safe, actor).epoch`) →
  `ClearedByFreeze`. Pass: delete the schedule; if `ctx.actor == OWNERS` reset `cancelCount[engine][safe] = 0`; emit
  `Executed`.
- **Cancel by owners** `cancelAsOwners(engine, safe, txHash, signatures)`: only `s.actor == OWNERS` (`NotOwnersQueue`);
  `required = min(cancelCount + 1, threshold)`; `checkNSignatures(address(0), cancelDigest, signatures, required)` with
  `cancelDigest = EIP-712("TimelockPolicy", "1", chainid, this) Cancel(address engine,address safe,bytes32 txHash,
uint256 cancelCount)`; delete; `cancelCount++`; emit `Cancelled(..., by = msg.sender, cancelCount)`. A single rogue
  owner gets **one cancel per executed owners' transaction**, not one ever: the count resets to 0 whenever an owners'
  schedule executes (review F3). So one rogue owner can make every owners' transaction wait `2T` (cancel once, the
  owners re-schedule, the rogue now needs two signatures), the `removeOwner` that evicts it included; it cannot block
  any of them. The app's Cancel tooltip says so.
- **Cancel by a canceller** `cancel(engine, safe, txHash)`: `msg.sender` in the schedule's canceller snapshot, or the
  module that scheduled it (`s.actor`; removing its own queued call removes no protection, §14 D-21), else
  `NotCanceller`; any actor's queue (the Spark case: another Safe cancels). Recovery's queue is cancellable by others
  only if its attachments list cancellers (default: none; owners remove the recovery module instead, T < R).
- `clearOnFreeze`: true at `(Owners, *)`, false at `(Recovery, *)` (doc: the freeze clears the owners' queue, keeps
  recovery's owner change). Schedules made before or during a freeze must be re-made after it.

### 8.3 RecipientsPolicy

Per call, the "party" checked against **every** matched attachment (the Safe itself always passes):

| Call shape (selector)                                | Party / check                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `value > 0` (any selector, incl. empty calldata)     | `call.to` ∈ recipients                                                 |
| `transfer(to, amount)` `0xa9059cbb`                  | `to` ∈ recipients                                                      |
| `transferFrom(from, to, amount)` `0x23b872dd`        | `to` ∈ recipients                                                      |
| `approve(spender, 0)` `0x095ea7b3`                   | passes for **any** spender (revocation; §14, D-5)                      |
| `approve(spender, amount)`, `amount > 0`             | `spender` ∈ spenders; `amount ≤ maxApproval`                           |
| `increaseAllowance(spender, added)` `0x39509351`     | `spender` ∈ spenders; `allowance(safe, spender) + added ≤ maxApproval` |
| `decreaseAllowance(spender, sub)` `0xa457c2d7`       | passes                                                                 |
| `SIGN_LIB.signPermit` / `signPermit2` (DELEGATECALL) | `spender` ∈ spenders; amount ≤ `maxApproval`                           |
| `SIGN_LIB.signCowOrder`                              | `receiver` ∈ recipients (`0` = the Safe)                               |
| anything else                                        | pass, or `UnclassifiedCall(selector)` if any attachment is `strict`    |

Lists ≤ 64 entries each. Native-value check works next to `Allow (Owners, *)` because every matching scope runs (Akshay's
case). Malformed calldata for a known selector → deny with the contract-level error `MalformedCall(selector)` (also in
LimitPolicy; not in the frozen interfaces, so the app's error ABI declares it). Inside a batch, `increaseAllowance` is
checked against the allowance expected after the earlier `approve` / `increaseAllowance` of the same pair (transient
storage, keyed by the Safe transaction `ctx.txHash`) when there is one, else the on-chain one: `[approve(x, 0),
increaseAllowance(x, a)]` is judged as `a` (§14, D-17).

### 8.4 LimitPolicy ("Transfer budget")

- Per `(engine, safe, attachmentId, token)`: `{amount, period, spent, windowStart}`; fixed-grid windows anchored at
  configure time (V1 `SpendingLimitPolicy`); `period 0` = one-time. ≤ 16 tokens, no duplicates, `amount > 0`.
- Pricing of a call (sum of spends per token; `address(0)` = native):

| Shape                                      | Spend                                                                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value > 0`                                | `value` of native (in addition to the data's own spend)                                                                                                                            |
| empty calldata                             | nothing else                                                                                                                                                                       |
| `transfer(to, amount)` on token T          | `amount` of T                                                                                                                                                                      |
| `transferFrom(from, to, amount)`           | `amount` of T if `from == safe`, else 0                                                                                                                                            |
| `approve(spender, amount)`                 | reservation: `delta = amount − allowance(safe, spender)` (STATICCALL); `delta > 0` spends it; `delta < 0` gives back `min(−delta, reserved[spender] in the current window, spent)` |
| `signPermit` (DELEGATECALL to `SIGN_LIB`)  | plain spend of the full `value` of `token`: no reservation, no give-back, the token is never read (anyone can submit the permit at any time before its deadline)                   |
| `signPermit2` (DELEGATECALL to `SIGN_LIB`) | plain spend of the full `amount` (a Permit2 allowance is not the ERC-20 allowance): no reservation, no give-back                                                                   |
| `increaseAllowance(spender, added)`        | `added` (reservation)                                                                                                                                                              |
| `decreaseAllowance(spender, sub)`          | give-back `min(sub, allowance, reserved, spent)`                                                                                                                                   |
| `signCowOrder(order)`                      | `sellAmount + feeAmount` of `sellToken`                                                                                                                                            |
| anything else                              | **unpriced**                                                                                                                                                                       |

- Per attachment: a priced spend of a token it lists is debited (`LimitExceeded(id, token, requested, available)`); a
  spend of a token it does not list, or an unpriced call, denies with `Unpriced(id, token, selector)` unless
  `passUnpriced`. Batches sum naturally (each sub-call debits in order). `remaining(engine, safe, id, token)` for the app.
- Give-back is capped by what the window actually spent. Inside a batch an allowance is read as the smaller of the
  on-chain value and the value expected after the earlier sub-calls (transient storage), so `[approve(x, 0),
approve(x, a)]` cannot give back without spending (§14, D-4).
- ERC-20 shapes are priced only as CALLs; the typed sign-lib entries only as DELEGATECALLs to the engine's `SIGN_LIB()`.
- Reconfiguring an attachment resets its budget (re-attach = reset, §4): owners can refill a limit through a delayed
  configuration change.
- A limit only holds with deny-by-default ALLOWs on calls it can price; lint "Limit next to unpriceable ALLOW".

### 8.5 ArgsPolicy

`ArgConstraint {bytes4 selector; uint16 argIndex; ArgOp op; bytes32[] values}`, `ArgOp {EQ, NEQ, IN, NOT_IN, LTE, GTE,
EQ_SAFE}` on the static word `w = data[4 + 32·i : 4 + 32·(i+1)]` (`ArgMissing` if too short). Constraints whose
selector equals the call's apply (AND across all matched attachments); none applies → pass. `strict` is per attachment:
a strict attachment none of whose own constraints applies denies with `NoConstraint`, whatever other attachments
constrain (§14, D-16). ≤ 16 constraints, ≤ 32 values.

### 8.6 CoSignerPolicyV2 (port of V1, both paths)

- Owner path: `policyData = abi.encode(CoSignature[] {address cosigner; bytes signature})`; for each distinct co-signer of
  the matched attachments a valid signature over `ctx.txHash` (ECDSA 65 bytes low-s, or ERC-1271 for a contract), as
  V1. `MissingCoSignature` / `InvalidCoSignature` / `MalformedPolicyData`.
- Module path: `cosign(engine, safe, callHash, cosigner, deadline, signature)` (anyone relays) over
  `moduleTxDigest(engine, safe, callHash, deadline)`; the check requires and consumes one per co-signer. The digest is
  `ModuleTransaction(engine, safe, callHash, nonce, deadline)` (§7), `nonce = moduleTxNonce(engine, safe, callHash)`, a
  use counter the check increments: a consumed co-signature can never be pushed again (deterministic ECDSA would
  reproduce the same bytes; ERC-1271 approvals are usually permanent), and the same call executed twice needs two (§14,
  D-1). A co-signature is pushed and consumed only while `block.timestamp <= deadline`, else
  `CoSignatureExpired(cosigner, deadline)` (§14, D-15).
- One run per transaction: one co-signature covers the whole batch (fixes V1's per-sub-call spend).

### 8.7 SafenetPolicyV2 (port of V1, both paths)

Owner path: `policyData` = V1's 256-byte attestation over the Safe transaction hash (`ctx.txHash`), epoch forest as V1.
Module path: `submitAttestation(engine, safe, callHash, deadline, attestation)` over `moduleTxDigest(engine, safe,
callHash, deadline)` in place of the safeTxHash; consumed by the check. One attestation per transaction (batches no
longer fail closed). Each FROST signature can be submitted once (`AttestationAlreadySpent`, keyed by the signature hash)
and credits one execution of `callHash`: the same call twice needs two signatures (§14, D-2). Credits are submitted and
consumed only while `block.timestamp <= deadline` (`AttestationExpired(deadline)`); the credits of one call share the
earliest deadline, and an expired credit is dropped when a new attestation arrives (§14, D-15).
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
| Attachments per scope        | 6     | `TooManyAttachments`             |
| Lookups per call             | 8     | (levels with zero count skipped) |
| Calls per batch, nesting     | 8, 1  | `BatchTooLarge`, `NestedBatch`   |
| Guardians / lifters per Safe | 8     | `TooManyRoleMembers`             |
| Trusted batch contracts      | 4     | `InvalidDeployment`              |
| Revert reason kept           | 512 B | (truncated)                      |
| Policy settings              | §8    | `InvalidSettings`                |

Worst case: 8 calls × 48 matched attachments (8 levels × 6, §14 D-26). Dispatch is linear in the matches: each call's call-level
matches and the transaction's transaction-level matches are grouped by policy in one pass (hash tables in memory), so
every distinct policy runs once per call (call level) or once per transaction (transaction level) at a constant engine
cost per run. Measured engine-only worst case at the caps (pass-only policies, 8 distinct calls with transaction-level
policies, the most runs and the least deduplication): ≈ 5.5 M gas (≈ 3.1 M at 4 per scope), against the 2^24 per-transaction cap of EIP-7825; the rest is left to the policies' own work.
Storage reads on the hot path: one slot (the packed level counters), one array length per populated level, one slot per
attachment. Policies are called with
all remaining gas (out of gas = deny); no per-policy gas stipend (`preview` keeps a 300 k reserve, §6.7). Measured
gas: [`GAS.md`](GAS.md) (F12 expects ~30–40 k end to end for an ops payment).

## 10. ERC-1271 (§3a)

- `PolicyFallbackHandler.isValidSignature(hash, sig)` returns the magic value iff `sig` is empty and
  `signedMessages[getMessageHashForSafe(safe, abi.encode(hash))] != 0`; never checks owner signatures (no off-chain
  1271). Legacy `isValidSignature(bytes data, bytes)`: the same check over the message `data` itself
  (`signedMessages[getMessageHashForSafe(safe, data)]`), exactly as Safe's `CompatibilityFallbackHandler`, so a message
  approved with Safe's `SignMessageLib.signMessage(data)` validates here too, and the bytes32 overload equals the legacy
  one over `abi.encode(hash)` (§14, D-9). Approvals are permanent (no revoke).
- `PolicySignLib` (DELEGATECALL, `SIGN_LIB`): writes `signedMessages[msgHash] = 1` in the Safe's storage (slot 7 in
  Safe 1.5.0 `SafeStorage`, as `SignMessageLib`) and emits `SignMsg(msgHash)`, `msgHash = getMessageHashForSafe(safe,
abi.encode(digest))`:
  - `signPermit(token, spender, value, deadline, nonce)`: EIP-2612 `Permit(owner = safe, spender, value, nonce,
deadline)` digest under `token.DOMAIN_SEPARATOR()`, which must be the token's own domain: it must equal an
    `EIP712Domain` rebuilt with `verifyingContract = token` and `block.chainid`, from ERC-5267 `eip712Domain()` (fields
    `0x0f` or `0x0d`) or `name()` / `version()` (`"1"` when there is no `version()`), with or without a version field;
    otherwise `DomainMismatch(token)`. Without it, a contract returning another token's domain would make the Safe sign
    that token's permit while Limit, Recipients and Quorum price it under the contract's address (§14, D-14).
  - `signCowOrder(GPv2Order)`: `GPv2Order.hash` under the settlement's `domainSeparator()` (settlement immutable).
  - `signPermit2(token, spender, amount, expiration, nonce, sigDeadline)` (stretch): `PermitSingle` digest.
  - `signMessage(bytes32 digest)`: raw approval of any digest: another Safe's transaction hash (this Safe as its
    owner, via a `v = 0` contract signature), a login, unknown typed data. Matched as CALL like the typed entries
    (§14 D-22), so `Allow (Owners, *)` grants it and the owners' Timelock, Freeze, Co-signer, Safenet and Quorum judge
    it; Limit sees it as unpriced and Recipients as unclassified (it can approve a permit of any token, so the app
    blocks it for modules and warns when the owners also rely on a budget or a recipients list).
- Engine: a DELEGATECALL to `SIGN_LIB` with a typed selector or `signMessage` is matched as CALL (§6.3), so
  `Allow (Owners, *)` covers signing (with the owners' Timelock, Freeze, Co-signer), and Limit / Recipients price the
  decoded fields of the typed ones. Without it, a Safe with this handler could not be an owner of another Safe nor
  sign a dapp login short of an exact DELEGATECALL Allow (review F2).
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
| `BatchTooLarge()`                                                               | > 8 sub-calls                                                                        |
| `NestedBatch(callIndex)`                                                        | Sub-call DELEGATECALLs a trusted batch                                               |
| `MalformedContext()`                                                            | Bad policy-context envelope or payload                                               |
| `GuardTargetDenied()`                                                           | Engine target outside §6.4, or a config call that is not a top-level zero-value CALL |
| `ModuleConfigurationDenied()`                                                   | Config selector on the module path                                                   |
| `NonZeroGasPrice()` / `NonZeroSafeTxGas()`                                      | Owner path refunds / `safeTxGas`                                                     |
| `ExecutionFailed()` / `ModuleExecutionFailed()`                                 | Post-hooks with `success == false` (owner path: unreachable on 1.5.0, §6.1)          |
| `Reentrancy()`                                                                  | Hook, preview or state-changing engine call during a check                           |
| `Preview(gates)`                                                                | Always, from `preview`                                                               |
| `GuardAlreadyEnabled()`                                                         | `configureImmediately` once installed                                                |
| `ConfigurationNotEmpty()`                                                       | `configureImmediately` on a Safe with an attachment or a role (§14 D-25)             |
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
| `InvalidActor(actor)`                                                           | `freezeActor` with ANY/OWNERS; `preview` with ANY; a `RoleChange` with account 0     |

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
   `ModuleTransaction(engine, safe, callHash, ...)` under the policy's domain (with a `deadline` since D-15).
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

## 14. Deviations after implementation

Accepted when the work packages were merged. Each is already applied in the sections above; this table is the index.

| #    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                  | Who   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| D-1  | CoSigner module digest `ModuleTransaction(engine, safe, callHash, nonce, deadline)` with a per-`callHash` use counter (`moduleTxNonce`); `deadline` since D-15 (§7, §8.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `callHash` has no nonce: a consumed co-signature (deterministic ECDSA, permanent ERC-1271 approval) could be pushed again for the next identical call                                                                                                                                                                                                                | WP5   |
| D-2  | Safenet module path: one submission per FROST signature (`AttestationAlreadySpent`), one credit each (§8.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Same replay problem as D-1: without a spent set one attestation would credit any number of executions                                                                                                                                                                                                                                                                | WP5   |
| D-3  | Timelock `AlreadyScheduled` relaxed: a schedule voided by a freeze (`clearOnFreeze`, would fail `ClearedByFreeze`) can be replaced (§8.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Otherwise a voided module-path schedule blocks the same call forever                                                                                                                                                                                                                                                                                                 | WP3   |
| D-4  | Limit: give-back capped at `min(sub, allowance, reserved, spent)`; `signPermit` and `signPermit2` are now plain spends of the full value; batch-aware expected allowance kept in transient storage (§8.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A signature may never be used (no give-back); `value - allowance` pricing let each permit re-arm a drained allowance (review M-1); the transient allowance stops batch give-and-re-spend                                                                                                                                                                             | WP4   |
| D-5  | Recipients: `approve(x, 0)` passes for any spender (§8.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Revoking an approval must never be blocked by a recipients list                                                                                                                                                                                                                                                                                                      | WP4   |
| D-6  | Engine code split: `SafePolicyGuardV2` (hooks, preview, views) + `PolicyEngineV2` (configuration, freeze) reached by DELEGATECALL, one address and one storage (header). Split further by D-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | One contract does not fit 24 KiB (guard alone is ≈ 22.9 KiB)                                                                                                                                                                                                                                                                                                         | WP2   |
| D-7  | `RoleChange` with `account == 0` reverts `InvalidActor(address(0))` (§5.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The frozen interface has no dedicated error                                                                                                                                                                                                                                                                                                                          | WP2   |
| D-8  | `preview` keeps a 300 000 gas reserve per policy call (§6.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | An out-of-gas policy is reported as a gate instead of aborting the whole preview                                                                                                                                                                                                                                                                                     | WP2   |
| D-9  | Closed: legacy `isValidSignature(bytes data, bytes)` checks the message `data` itself, as Safe's `CompatibilityFallbackHandler` (§10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `abi.encode(keccak256(data))` matched no integrator's approvals (review F6); `SignMessageLib.signMessage(data)` approvals now validate, and both overloads agree as in Compat                                                                                                                                                                                        | WP6   |
| D-10 | Post-hooks: owner-path `ExecutionFailed` unreachable on 1.5.0; module-path failure reverts `ModuleExecutionFailed` instead of returning `false` (§6.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A post-hook can only revert; failing closed means a failed module call consumes no proof and no budget                                                                                                                                                                                                                                                               | WP1   |
| D-11 | Deploy: `EXPIRY` 9 d; trusted batches = MultiSendCallOnly 1.4.1 and 1.5.0 only, no full `MultiSend` (§5.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | F3 needs ≥ 8.5 d; the app batches with MultiSendCallOnly, which refuses DELEGATECALL sub-calls itself                                                                                                                                                                                                                                                                | WP7   |
| D-12 | `MalformedCall(bytes4)` in RecipientsPolicy and LimitPolicy, outside the frozen interfaces (§8.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Malformed calldata for a known selector needs a named deny reason                                                                                                                                                                                                                                                                                                    | WP4   |
| D-13 | Caps lowered to 4 attachments per scope and 8 calls per batch; policy dispatch grouped by policy in linear time (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | At 8 × 16 the engine (then quadratic in the matches) could not fit a full batch in the 2^24 gas cap; at 4 × 8 the linear engine needs ≈ 3.1 M in the worst case, leaving room for the policies                                                                                                                                                                       | Gas   |
| D-14 | `PolicySignLib.signPermit` requires `token.DOMAIN_SEPARATOR()` to be the token's own domain (`verifyingContract == token`, this chain), else `DomainMismatch(token)`, a contract-level error (§10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A contract returning USDC's separator made the Safe sign a real USDC permit that Limit, Recipients and Quorum priced under that contract (review H-1). CoW / Permit2 domains are pinned                                                                                                                                                                              | Rev   |
| D-15 | Module-path proofs expire: `deadline` in both `ModuleTransaction` digests and in `cosign` / `submitAttestation` / `moduleTxDigest`; `CoSignatureExpired`, `AttestationExpired` (§7, §8.6, §8.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A pushed co-signature or Safenet credit authorised the same call forever, even once the co-signer or validators would refuse it (review L-1 / F4). Interface change                                                                                                                                                                                                  | Rev   |
| D-16 | ArgsPolicy `strict` is evaluated per attachment (§8.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Merged strictness let another attachment's constraint satisfy a strict attachment with none for the selector (review L-2)                                                                                                                                                                                                                                            | Rev   |
| D-17 | Recipients: once an earlier sub-call set the expected allowance (transient, keyed by `ctx.txHash`), `increaseAllowance` uses it instead of `max(on-chain, expected)` (§8.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `[approve(x, 0), increaseAllowance(x, a)]` was judged as on-chain + a, a false `ApprovalTooLarge` (review F8); the key keeps other Safe transactions' values out                                                                                                                                                                                                     | Rev   |
| D-18 | Deployable on Sepolia: every contract ≤ 10,000 B of runtime, one create per transaction. The engine is the guard plus five DELEGATECALLed modules (header, §5.4): policy runs in `PolicyEngineV2Runner`, one call per check and only when a policy matched or an owner-path policy context is present; the runner decodes the context before any other deny, so `MalformedContext` still comes first, and before a built-in deny of call `i` the guard sends the runs of the calls before `i`, so the same deny wins as before. `preview`, the enumeration views, configuration, freeze and the small views move to modules routed by the guard's `fallback`. The constructor takes the modules (`InvalidDeployment` if their arguments differ). `TimelockPolicy` DELEGATECALLs `TimelockPolicyQueue` for `scheduleOwnerTx` / `scheduleModuleTx` (shared `TimelockPolicyStorage`). Interfaces, errors, events, ids and hashes unchanged; `ISafePolicyGuardV2` is the guard's full ABI | Sepolia charges ≈ 1,542 gas per byte of code plus ≈ 210 k per create, under the 2^24 cap: ≈ 10.4 KB per transaction. The guard (22.2 KB) and the logic its constructor created (19.6 KB) needed ≈ 65 M gas in one transaction, TimelockPolicy (13.7 KB) 21 M. Cost: +5 to +7 k gas on a transaction that runs policies, −0.9 to −1.6 k on an ALLOW-only one (GAS.md) | Split |
| D-19 | Configuration path runs the owners' exact-scope policies: a top-level owner-path call to `requestConfiguration` / `invalidateRoot` / `applyConfiguration` runs the POLICY attachments at `(OWNERS` or `ANY, engine.selector)` (levels 3 and 7), with the policy context; no ALLOW needed, DENY never applies, nothing at broader scopes runs; `preview` and `getMatchingAttachments` show the same (§5.1, §6.2, §6.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Co-signer, Safenet and Quorum on the owners had no say over configuration: two owners could detach them through the delay (review M-2). Exact scopes are opt-in, so the owners' `(Owners, *)` Timelock and Freeze keep their §5.3 / `ConfigFrozen` treatment and nothing locks the owners out by default; the app lints the gap and the Quorum template covers it    | Rev   |
| D-20 | TimelockPolicy records `configuredAt` per attachment in `configure` (view `configuredAt`, interface addition); a schedule is ready `delay` after `max(scheduledAt, latest configuredAt of the matched attachments)`; scheduling with no matching attachment reverts `NoTimelock(txHash)` (new error) (§8.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Schedules were not bound to the Timelock that checks them: one made before a Timelock was attached, or long before a delay was raised, passed at once (review M-3). Stored in the delay's slot: no extra read at check time                                                                                                                                          | Rev   |
| D-21 | A schedule whose window passed under the current merged settings is replaced by a new schedule of the same call, and a module may `cancel` its own schedule (§8.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | An expired module-path schedule (no nonce) blocked that exact call forever, e.g. the recovery template's `swapOwner` (review M-4 / F1). Neither removes a protection: the new schedule waits the full delay                                                                                                                                                          | Rev   |
| D-22 | `PolicySignLib.signMessage` is matched as CALL like the typed entries (§6.3, §10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | With `PolicyFallbackHandler` a V2 Safe could neither own another Safe nor sign a login without an exact DELEGATECALL Allow the app blocks (review F2). `SIGN_LIB` is pinned and only writes `signedMessages`; the raw digest stays opaque to Limit / Recipients, so the app blocks it for modules and warns for owners with a budget                                 | Rev   |
| D-23 | DENY and POLICY attachments match if their op mask covers the effective op or the raw op; ALLOW only the effective op (§6.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A DELEGATECALL-only restriction on `SIGN_LIB` never fired for typed signing (review F5). Filtered after the lookup, only when the two ops differ, so the hot path tests one mask per attachment as before                                                                                                                                                            | Rev   |
| D-24 | `scheduleOwnerTx` requires `safeTxGas == 0` and `gasPrice == 0` (the engine's `NonZeroSafeTxGas` / `NonZeroGasPrice`) (§8.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Such a schedule sat "ready" and could never execute (review F7)                                                                                                                                                                                                                                                                                                      | Rev   |
| D-25 | `configureImmediately` requires an empty configuration: no attachment, no role (`ConfigurationNotEmpty`, new error) (§5.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | It was additive: an earlier install's leftovers, or attachments a module added before the module guard was set, survived the owners' install (review L-3). The app routes a Safe with leftovers to the delayed path                                                                                                                                                  | Rev   |
| D-26 | 6 attachments per scope (was 4) (§9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `(Owners, *)` with Allow + Timelock + Freeze + Quorum + Co-signer did not fit (review F13). Measured worst case at the caps ≈ 5.5 M gas (under 6 M, GAS.md); no size change (the cap is a constant of the config module)                                                                                                                                             | Rev   |
| D-27 | `supportsInterface` moved from the guard to `PolicyEngineV2Views`, routed by the guard's `fallback`; the guard no longer inherits the vendored guard interfaces (same ABI, same answers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Room in the guard for D-19, D-22 and D-23 under 10,000 B; Safe reads it only in `setGuard` / `setModuleGuard`                                                                                                                                                                                                                                                        | Rev   |
