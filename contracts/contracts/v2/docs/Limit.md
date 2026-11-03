# LimitPolicy: budgets per token

Source: `policies/LimitPolicy.sol`, interface `interfaces/policies/ILimitPolicy.sol`, SPEC §5.3. Shown as "Transfer
budget" in the app. Research prototype, unaudited.

## What it does

Counts what the Safe gives up control of, per attachment and per token, on fixed windows, and denies a transaction
that would go over. A batch is summed: one check per transaction prices every call the attachment matched.

## Settings

`abi.encode(Settings)` with `Settings { TokenLimit[] limits; bool passUnpriced }`.

| Field | Meaning | Rule |
| --- | --- | --- |
| `limits[].token` | An ERC-20, or `address(0)` for the native token | 1 to 16, no duplicate |
| `limits[].amount` | Budget per window, base units | > 0 |
| `limits[].period` | Window length in seconds; 0 = one-time budget | |
| `passUnpriced` | Let calls that are not a spend shape pass (protocol calls, DELEGATECALLs) | default false: deny them |

Windows are a fixed grid anchored at `configure`; re-configuring resets the spent amounts (a configuration change is an
owners' transaction, so their Timelock delays it).

## Pricing of one call

| Call | Counts |
| --- | --- |
| any call with `value > 0` | `value` of native, always, checked first |
| `transfer(to, a)` | `a` of the token called |
| `transferFrom(from, to, a)` | `a` if `from` is the Safe, else 0 |
| `approve(s, a)` with `a > 0`, `increaseAllowance(s, a)` | `a`, in full: no reservation, no give-back |
| `approve(s, 0)`, `decreaseAllowance` | 0 (revocations are free, and give nothing back) |
| empty calldata, zero value | 0 |
| one of the spends above, of a token the attachment does not list (native included) | `Unpriced`, even with `passUnpriced` |
| any other selector, any DELEGATECALL | `Unpriced`, unless `passUnpriced` |

Placement matters: ERC-721 shares `transferFrom` and `approve` with ERC-20, so a Limit at `(A, *)` reads an NFT
transfer as a spend of an unlisted token and denies it. Put the Limit per token contract, `(A, USDC.*)`, when the actor
also moves NFTs (story `Erc721.test.ts`).

## Who calls what, and when

Only the engine (`configure`, `check`). `remaining(engine, safe, id, token)` is a view for the app.

## What it sees and cannot see

| Sees | Cannot see |
| --- | --- |
| Each call's target, value and the ERC-20 head words | Swap outputs and slippage, prices (no oracle, no USD caps), pulls through allowances given before the Limit, operator rights (`setApprovalForAll`, Morpho `setAuthorization`, Aave `approveDelegation`), debt from borrowing, fee-on-transfer and rebasing tokens, Universal Router `execute`, CoW order contents (the approval to the vault relayer is the budget), off-chain permits |

## Errors

| Error | When |
| --- | --- |
| `InvalidSettings` | empty or over 16 limits, a duplicate token, a zero amount |
| `LimitExceeded(callIndex, attachmentId, token, requested, available)` | the call takes the window's spend over the budget |
| `Unpriced(callIndex, attachmentId, token, selector)` | the rows above |

## Example: ops, 10,000 USDC a month

```
attach (Ops, *) LimitPolicy {limits: [{token: USDC, amount: 10000e6, period: 30 days}], passUnpriced: false}
```

Proven by `test/v2/stories/Erc20Payments.test.ts` (budget, batch of 5 summed, the refill attack),
`Erc721.test.ts`, `CowAgent.test.ts`, `Ens.test.ts` (native value), `Committee.test.ts`.
