# Policies (Solidity)

Experimental policies for the [Safe Policy Engine](https://github.com/safe-research/policy-engine), built with
Hardhat. Same compiler settings as the engine (solc 0.8.30, Cancun, via-IR).

> [!CAUTION]
> Unaudited research code. Sepolia only.

| Contract                                                   | What it does                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`SpendingLimitPolicy`](contracts/SpendingLimitPolicy.sol) | Caps an ERC-20 `transfer` amount per token: a budget per recurring period, or a one-time budget.   |
| [`AllOfPolicy`](contracts/AllOfPolicy.sol)                 | Combines several policies on one access selector; a transaction passes only if all of them accept. |

## SpendingLimitPolicy

Bind it to `(token, transfer(address,uint256), CALL)`. Configuration data: `abi.encode(uint256 amount, uint256 period)`.

| Field    | Meaning                                                                               |
| -------- | ------------------------------------------------------------------------------------- |
| `amount` | Budget per window, in token base units. `0` removes the limit (transfers are denied). |
| `period` | Window length in seconds (e.g. `86400` = daily). `0` = one-time budget, never resets. |

- Windows are a fixed grid anchored when the limit is configured (reset at `T0 + P`, `T0 + 2P`, …), not a sliding window.
- Reconfiguring a token starts a fresh window with nothing spent.
- The spend is recorded during the pre-execution check; the guard reverts failed executions, so a transfer that does
  not happen does not consume budget.
- Only `transfer` is accepted (not `transferFrom`), with `CALL` and no ETH value.
- `getLimit(policyGuard, safe, token)` returns `amount, spent, available, period, windowStart` as they apply now.

It caps the **amount only**. To also restrict **recipients**, combine it with `ERC20TransferPolicy` through
`AllOfPolicy`.

## AllOfPolicy

The engine binds a single policy per access selector; `AllOfPolicy` is that policy and runs several inner ones in order.
Configuration data: `abi.encode(address[] policies, bytes[] configurations)`, where `configurations[i]` is forwarded to
`policies[i].configure`. Up to 5 inner policies.

Example, "USDC only to Alice, at most 100 USDC per day":

```
target   USDC
selector transfer(address,uint256)
policy   AllOfPolicy
data     abi.encode(
           [ERC20TransferPolicy, SpendingLimitPolicy],
           [abi.encode([(alice, ALWAYS)]), abi.encode(100e6, 86400)]
         )
```

Things to know:

- **One instance per guard.** Inner policies key their state by their caller, which is the combinator. To keep the
  engine's `(policyGuard, safe)` namespacing, an `AllOfPolicy` serves only the guard it was deployed for
  (`POLICY_GUARD`) and rejects every other caller.
- **Configure inner policies through it.** Their state lives in the combinator's namespace; configuring them directly
  has no effect on this binding.
- **All or nothing.** If any inner policy denies or reverts, the whole check reverts, including spends staged by
  earlier inner policies. Reverts are reported as `InnerPolicyReverted(policy, reason)`.
- **No recursive policies inside.** `MultiSendPolicy` calls back into its caller, which here is the combinator, so it
  fails closed when nested.
- **Detaching leaves inner state.** As with any policy, revoke the inner configuration explicitly before detaching.

## Policy Engine V2

[`contracts/v2`](contracts/v2) holds the V2 prototype: scopes per actor, every match runs, built-in Allow/Deny,
pass-or-deny policies, a bounded freeze, delayed configuration, on-chain-only ERC-1271. It targets Safe 1.5.0 (the engine
is installed as both guard and module guard).

- [`SPEC.md`](contracts/v2/SPEC.md): the specification; §14 lists what changed during implementation.
- [`GAS.md`](contracts/v2/GAS.md): measured gas. [`COMPARISON.md`](contracts/v2/COMPARISON.md): V1 vs V2.

| Path                                                     | What                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `SafePolicyGuardV2.sol`, `PolicyEngineV2.sol`, `engine/` | The engine: guard hooks, `preview` and views in the guard; configuration and freeze in `PolicyEngineV2`, reached by DELEGATECALL  |
| `PolicyBaseV2.sol`, `policies/`                          | Base contract and the 8 policies: Freeze, Timelock, Recipients, Limit, Args, CoSignerV2, SafenetV2, QuorumV2                      |
| `erc1271/`                                               | `PolicyFallbackHandler` (ERC-1271 from approved messages only) and `PolicySignLib` (typed Permit / Permit2 / CoW order approvals) |
| `interfaces/`, `libraries/`                              | Frozen ABI: engine, policy and per-policy interfaces; scopes, types, MultiSend decoding                                           |
| `libraries/frost/`                                       | FROST libraries for Safenet, [vendored](contracts/v2/libraries/frost/VENDORED.md) unmodified from policy-engine 8ee68a8           |
| `test/`                                                  | Mocks and stubs for the tests (not deployed)                                                                                      |

The app's TypeScript mirror is generated from the interfaces:

```bash
pnpm export:v2-abi     # compile, then write ../src/lib/v2/abi.ts (run `pnpm format` at the root afterwards)
```

### Tests

The V2 tests live in [`test/v2`](test/v2) (engine, policies, ERC-1271, and end-to-end through a real Safe 1.5.0).
They use plain chai plus [`test/v2/helpers.ts`](test/v2/helpers.ts) (`expectRevert`, `expectEvent`, …), never
hardhat-chai-matchers, so they run under both configs:

```bash
pnpm test                                         # V1 + V2, with hardhat-toolbox (what CI runs)
npx hardhat test test/v2/policies/Limit.test.ts   # one file
# V2 only, without hardhat-toolbox (the V1 tests need chai-matchers):
npx hardhat --config hardhat.sandbox.config.ts test test/v2/*.test.ts test/v2/*/*.test.ts
```

`hardhat.sandbox.config.ts` is `hardhat.config.ts` without hardhat-toolbox. It exists for the Claude Code sandbox, which
cannot read a file of hardhat-chai-matchers that toolbox loads (`properPrivateKey.js`). It is local only: git-excluded
via `.git/info/exclude`, not committed. `test/v2/engine/ZzErrorCoverage.test.ts` checks that the engine
tests assert every engine error; it runs last and skips itself when the engine tests run one file at a time.

### Deploy (Sepolia)

```bash
npx hardhat vars set SEPOLIA_DEPLOYER_KEY   # stored outside the repo, read only by hardhat.config.ts
DRY_RUN=1 npx hardhat run scripts/deploy-v2.ts   # rehearsal on the in-process network, no key needed
pnpm deploy:v2:sepolia
```

[`scripts/deploy-v2.ts`](scripts/deploy-v2.ts) prints the deployer and its balance first (aborts below 0.02 ETH; the
full run is ≈ 33 M gas), then deploys `PolicySignLib`, two engines (`DELAY` 5 s and 24 h; `EXPIRY` 9 d, `MAX_FREEZE`
7 d, `FREEZE_COOLDOWN` 12 h, trusted batches MultiSendCallOnly 1.4.1 and 1.5.0), `PolicyFallbackHandler` and the 8
policies, which both engines share. It ends with one `V2Deployment` JSON block per engine for
`src/config/contracts.ts`. `SafenetPolicyV2` needs a real Consensus deployment: set `SAFENET_CONSENSUS_CHAIN_ID`,
`SAFENET_CONSENSUS_ADDRESS`, `SAFENET_INITIAL_EPOCH`, `SAFENET_GROUP_KEY_X` and `SAFENET_GROUP_KEY_Y`, otherwise it is
skipped (address `0x0`; a dry run uses a placeholder key instead).

## Develop

```bash
cd contracts
pnpm install
pnpm build        # compile + typechain types
pnpm test         # unit tests + end-to-end tests through the real SafePolicyGuard
pnpm typecheck
```

The engine sources used by the policies and the tests are vendored, unmodified, in
[`contracts/vendor/policy-engine`](contracts/vendor/policy-engine/VENDORED.md).

## Deploy (Sepolia)

```bash
npx hardhat vars set SEPOLIA_DEPLOYER_KEY   # stored outside the repo
npx hardhat vars set SEPOLIA_RPC_URL        # optional, defaults to PublicNode
POLICY_GUARD=0x5202B1ebE100812437d47eae769e155945fbba6a pnpm deploy:sepolia
```

`POLICY_GUARD` is the guard the `AllOfPolicy` instance will serve (default: the 5-second-delay guard).
