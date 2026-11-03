# Rev 3 work package hand-off

WP A to D run in parallel in separate worktrees. Each WP edits only the files it owns below; everything else is read
only. If a frozen file is wrong or missing something, make the smallest additive change and list it under "Spec
deviations" in the report.

## Frozen (WP0, nobody edits)

| File | What |
| --- | --- |
| `contracts/contracts/v2/SPEC.md`, `HANDOFF.md` | Rules and this map |
| `contracts/contracts/v2/libraries/Types.sol`, `Scope.sol` (`ScopeLib`), `Constants.sol` | Types, keys, levels, caps, magic values |
| `contracts/contracts/v2/interfaces/IPolicy.sol`, `IPolicyGuard.sol`, `ISafeV2.sol` | Engine and policy ABI |
| `contracts/contracts/v2/interfaces/policies/I*.sol` | Policy settings, functions, events, errors |
| `contracts/contracts/v2/policies/PolicyBase.sol` | Policy boilerplate |
| `contracts/contracts/v2/test/ScopeHarness.sol`, `contracts/test/v2/Scope.test.ts` | Library harness and its test |
| `src/lib/v2/rev3/types.ts` | TS mirror (WP F builds on it) |
| `contracts/test/v2/helpers.ts` | Additive fixes only, reported |

## Reference code from rev 2 (outside the build)

`contracts/rev2/` holds the rev 2 sources kept for adaptation; Hardhat does not compile it and `tsc` does not see it.
Each file belongs to one WP, which copies what it needs into its own files and deletes its `rev2/` files when done.
Everything else from rev 2 is in git: `git show 3c6d740:<path>`.

## WP A: engine

| Owns | Notes |
| --- | --- |
| `contracts/contracts/v2/PolicyGuard.sol` (replace the stub) | Hooks, 6-scope lookup, ALLOW / DENY, batches, dispatch, re-entrancy lock |
| `contracts/contracts/v2/PolicyGuardConfig.sol` (new) | `configure`, views, `matches`, reached by the guard's fallback |
| `contracts/contracts/v2/engine/*` (new) | Storage, lookup, evaluator |
| `contracts/contracts/v2/libraries/MultiSendDecoder.sol` | Adapt freely, keep the accepted encodings |
| `contracts/contracts/v2/test/engine/*` (new, contract names prefixed `Engine`) | Mock policies and targets |
| `contracts/test/v2/engine/*` (new), including `Sizes.test.ts` for the two engine contracts | Every engine error covered, both contracts <= 10,000 bytes |
| `contracts/rev2/SafePolicyGuardV2.sol`, `rev2/engine/*`, `rev2/test/EngineTestTargets.sol`, `rev2/test/MockPolicyV2.sol` | Reference; delete when done |

## WP B: TimelockPolicy

| Owns | Notes |
| --- | --- |
| `contracts/contracts/v2/policies/TimelockPolicy.sol` (replace the stub) | Keep the constructor `(maxFreeze, cooldown)` |
| `contracts/contracts/v2/policies/TimelockPolicyQueue.sol` (new, only if size forces a split) | Same ABI from the policy address |
| `contracts/contracts/v2/test/timelock/*` (new, names prefixed `Timelock`) | An engine stub implementing `matches` and `getAttachment` |
| `contracts/test/v2/policies/Timelock*.test.ts` (new) | Timelines T < R < F with F = 7 d, C = 12 h, T = 24 h, R = 72 h |
| `contracts/rev2/policies/TimelockPolicy.sol`, `TimelockPolicyQueue.sol`, `rev2/test/TimelockEngineStub.sol` | Reference; delete when done |

## WP C: ArgsPolicy and LimitPolicy

| Owns | Notes |
| --- | --- |
| `contracts/contracts/v2/policies/ArgsPolicy.sol`, `LimitPolicy.sol` (replace the stubs) | |
| `contracts/contracts/v2/test/argslimit/*` (new, names prefixed `Args` or `Limit`) | Engine caller stub, tokens if needed |
| `contracts/test/v2/policies/Args.test.ts`, `Limit.test.ts` (new) | Every pricing row of SPEC §5.3; presets as fixtures |
| `contracts/rev2/policies/ArgsPolicy.sol`, `LimitPolicy.sol`, `rev2/test/LimitEngineStub.sol` | Reference; delete when done |

## WP D: CoSignerPolicy (and optional SafenetPolicy)

| Owns | Notes |
| --- | --- |
| `contracts/contracts/v2/policies/CoSignerPolicy.sol`, `SafenetPolicy.sol` (replace the stubs) | Safenet only if time allows; leave the stub otherwise |
| `contracts/contracts/v2/libraries/frost/*` | Only if the Safenet port needs a change |
| `contracts/contracts/v2/test/cosigner/*` (new, names prefixed `CoSigner` or `Safenet`) | ERC-1271 approver stub, FROST challenge helper |
| `contracts/test/v2/policies/CoSigner.test.ts`, `Safenet.test.ts` (new) | Both paths, consumption, expiry, ERC-1271 approver, signature replay |
| `contracts/rev2/policies/SafenetPolicyV2.sol` | Reference; delete when done |

## Later (WP E and after, not A to D)

`contracts/test/v2/fixtures/safe.ts`, `e2e/world.ts`, `compare/v1.ts` (kept, still on the rev 2 API: `world.ts` and
`scripts/lib/v2-deployment.ts` do not typecheck until WP E rewrites them), `contracts/scripts/*`,
`contracts/contracts/v2/COMPARISON.md`, `GAS.md`, `contracts/README.md`, the root `src/` and `agent/`.
