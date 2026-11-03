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

[`contracts/v2`](contracts/v2) holds the V2 prototype (rev 3): scopes per actor, every match runs, built-in Allow/Deny,
pass-or-deny policies, a bounded freeze and owner timelocks as policies, every proof pushed on-chain before execution.
It targets Safe 1.5.0 (the engine is installed as both guard and module guard).

- [`SPEC.md`](contracts/v2/SPEC.md): the specification.
- [`GAS.md`](contracts/v2/GAS.md): measured gas. [`COMPARISON.md`](contracts/v2/COMPARISON.md): V1 vs V2.

| Path                                       | What                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PolicyGuard.sol`, `PolicyGuardConfig.sol` | The engine, one address: `PolicyGuard` (hooks, scope lookup, Allow/Deny, policy dispatch, `matches`) DELEGATECALLs the rest (`configure`, views, ERC-165) to `PolicyGuardConfig` |
| `engine/`                                  | Engine storage and the evaluator shared by the hooks and `matches`                                                                                                               |
| `policies/`                                | `PolicyBase` and the policies: Timelock (with its `TimelockPolicyQueue`), Args, Limit, CoSigner, Safenet                                                                         |
| `interfaces/`, `libraries/`                | Frozen ABI and types: `IPolicyGuard` is the full ABI of the engine; scopes, constants, MultiSend decoding                                                                        |
| `libraries/frost/`                         | FROST libraries for Safenet, [vendored](contracts/v2/libraries/frost/VENDORED.md) unmodified from policy-engine 8ee68a8                                                          |
| `test/`                                    | Mocks and stubs for the tests (not deployed)                                                                                                                                     |

The app's TypeScript mirror is generated from the interfaces:

```bash
pnpm export:v2-abi     # compile, then write ../src/lib/v2/abi.ts (run `pnpm format` at the root afterwards)
```

### Tests

The V2 tests live in [`test/v2`](test/v2) (engine, policies, and stories through a real Safe 1.5.0). They use plain
chai plus [`test/v2/helpers.ts`](test/v2/helpers.ts) (`expectRevert`, `expectEvent`, …), never hardhat-chai-matchers,
so they run under both configs:

```bash
pnpm test                                         # V1 + V2, with hardhat-toolbox (what CI runs)
npx hardhat test test/v2/policies/Limit.test.ts   # one file
# V2 only, without hardhat-toolbox (the V1 tests need chai-matchers):
npx hardhat --config hardhat.sandbox.config.ts \
  test test/v2/*.test.ts test/v2/*/*.test.ts
```

`hardhat.sandbox.config.ts` is `hardhat.config.ts` without hardhat-toolbox. It exists for the Claude Code sandbox, which
cannot read a file of hardhat-chai-matchers that toolbox loads (`properPrivateKey.js`). It is local only: git-excluded
via `.git/info/exclude`, not committed. `test/v2/engine/ZzErrorCoverage.test.ts` checks that the engine
tests assert every engine error; it runs last and skips itself when the engine tests run one file at a time.

### Deploy (Sepolia)

Rehearse on the in-process network first (no key, no RPC, same code path; CI runs it too):

```bash
pnpm deploy:v2:dry-run
```

Then deploy:

```bash
npx hardhat vars set SEPOLIA_DEPLOYER_KEY   # stored outside the repo, read only by hardhat.config.ts
npx hardhat vars set SEPOLIA_RPC_URL        # optional, defaults to PublicNode
pnpm deploy:v2:sepolia
```

With Safenet (all five variables, otherwise `SafenetPolicy` is skipped and left at `0x0`), a fee cap and a label:

```bash
SAFENET_CONSENSUS_CHAIN_ID=11155111 \
SAFENET_CONSENSUS_ADDRESS=0x… \
SAFENET_INITIAL_EPOCH=0 \
SAFENET_GROUP_KEY_X=0x… \
SAFENET_GROUP_KEY_Y=0x… \
MAX_FEE_GWEI=1 \
V2_LABEL='rev 3' \
  pnpm deploy:v2:sepolia
```

Resume after a failure, reusing what is already deployed (file shape below):

```bash
V2_REUSE=./reuse-sepolia.json \
  pnpm deploy:v2:sepolia
```

Sepolia charges ≈ 1,542 gas per byte of deployed code plus ≈ 210 k per create (Ethereum: 200 per byte), and caps a
transaction at 2^24 gas (EIP-7825): one transaction cannot deploy more than ≈ 10.4 KB of runtime. So every V2 contract
stays ≤ 10,000 bytes ([`test/v2/engine/Sizes.test.ts`](test/v2/engine/Sizes.test.ts) checks the list the script
deploys, from the artifacts and after a dry deploy) and each is its own transaction.

[`scripts/deploy-v2.ts`](scripts/deploy-v2.ts) deploys one engine (it has no configuration delay of its own: the
owners' Timelock is the delay) and the policies, which key their state by engine and serve every Safe:

| Order | Contract              | Constructor                                                     | Runtime | Sepolia create gas |
| ----- | --------------------- | --------------------------------------------------------------- | ------- | ------------------ |
| 1     | `PolicyGuardConfig`   | none                                                            | 9,038 B | 14,146,596         |
| 2     | `PolicyGuard`         | trusted batches (MultiSendCallOnly 1.4.1 and 1.5.0), the config | 9,703 B | 15,172,026         |
| 3     | `TimelockPolicyQueue` | none                                                            | 9,295 B | 14,542,890         |
| 4     | `TimelockPolicy`      | `MAX_FREEZE` 7 d, `COOLDOWN` 12 h, the queue                    | 9,755 B | 15,252,210         |
| 5     | `ArgsPolicy`          | none                                                            | 5,632 B | 8,894,544          |
| 6     | `LimitPolicy`         | none                                                            | 6,544 B | 10,300,848         |
| 7     | `CoSignerPolicy`      | none                                                            | 5,803 B | 9,158,226          |
| 8     | `SafenetPolicy`       | the `SAFENET_*` variables (a dry run uses a placeholder key)    | 5,998 B | 9,458,916          |

Sepolia create gas is `210,000 + 1,542 × runtime bytes`: ≈ 97 M gas for the 8 creates. Before the first transaction
the script prints the deployer and its balance, checks that every create stays under 16,000,000 and that the balance
covers the plan at the current max fee, and aborts otherwise. Fees come from the network: tip = max(2 ×
`eth_maxPriorityFeePerGas`, `PRIORITY_FEE_GWEI`, default 0.001), max fee = 2 × base fee + tip, refused above
`MAX_FEE_GWEI` (default 1). Each create is checked again before it is sent and printed with its address, runtime size,
Sepolia estimate, gas used and block.

`V2_REUSE` maps a contract name as printed to `{ "address": "0x…", "block": 123 }`, e.g.
`{ "PolicyGuardConfig": { "address": "0x…", "block": 9000000 } }`; the script checks the code length matches and does
not deploy it again.

It ends with the `V2Deployment` JSON block and a ready-to-paste `V2_ENGINES` entry for `src/config/contracts.ts`:

```json
{
  "engine": "0x…",
  "engineConfig": "0x…",
  "trustedBatches": [
    "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
    "0xA83c336B20401Af773B6219BA5027174338D1836"
  ],
  "policies": {
    "timelock": "0x…",
    "timelockQueue": "0x…",
    "args": "0x…",
    "limit": "0x…",
    "coSigner": "0x…",
    "safenet": "0x…"
  },
  "fromBlock": 9000001
}
```

`fromBlock` is the engine's deployment block, where the app starts scanning for engine and Timelock events.
[`scripts/lib/v2-deployment.ts`](scripts/lib/v2-deployment.ts) is the plan (`FQN`, `DEPLOYED`, `deployEngine`,
`deployPolicies`, the `V2Deployment` type): the tests deploy through it too.

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
