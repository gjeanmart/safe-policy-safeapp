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
