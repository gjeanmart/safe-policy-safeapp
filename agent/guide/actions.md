# Actions

`safe_role_plan` builds one plain CALL from the Safe. Amounts are decimal token units (`"1.5"`,
not wei). `to` and `spender` take an address-book name, `safe`, or an address.

| Goal              | `safe_role_plan` arguments                                              | Policy it needs                                                                                                     |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Send USDC or WETH | `action: transfer, token: USDC, to: Alice, amount: 5`                   | ERC20TransferPolicy on the token with the recipient allowlisted, or AllowedModulePolicy / AllowPolicy on `transfer` |
| Send ETH          | `action: transfer, token: ETH, to: Alice, amount: 0.001`                | NativeTransferPolicy for that recipient                                                                             |
| Approve a spender | `action: approve, token: USDC, spender: Router, amount: 10`             | ERC20ApprovePolicy with the spender allowlisted. Revoking (`amount: 0`) is always allowed by that policy.           |
| Swap on CoW       | `action: swap, sell: USDC, buy: WETH, amount: 25`                       | ERC20ApprovePolicy on the sell token for the CoW VaultRelayer, plus AllowedModulePolicy on `setPreSignature`        |
| Wrap ETH          | `action: wrap, amount: 0.01`                                            | a policy on WETH `deposit()`, with value                                                                            |
| Unwrap WETH       | `action: unwrap, amount: 0.01`                                          | a policy on WETH `withdraw(uint256)`                                                                                |
| Anything else     | `action: call, to: <address>, data: 0x..., value: 0.1` (value optional) | whatever the guard has for that target and selector                                                                 |

Use `call` only when the user asks for a specific call, or to show that something is denied. The
plan decodes it and warns when it targets the Safe itself, the guard, or an unknown contract.

## Swaps (CoW)

`swap` gets a CoW quote for a sell order **paid to the Safe** and returns one or two plans. Both
go through simulate and exec, in the order given:

1. `approve` the CoW VaultRelayer for exactly the sell amount. This step is skipped if the
   allowance already covers it.
2. `swap` = `setPreSignature(orderUid, true)`. Exec first posts the order to the CoW order book,
   where it's inert until pre-signed, then signs.

- **Orders:** valid for 20 minutes; `slippage` in basis points (default 50).
- **Minimum amount:** Sepolia liquidity is thin, so small amounts return `NoLiquidity`. Around
  20 USDC or more usually gets a quote.
- **Sell ETH:** wrap it first; CoW only trades ERC-20s.
- **After exec:** the result has `cowExplorer`, a link to the order. It settles within a few
  minutes if a solver picks it up. If it expires unfilled, nothing is spent: plan again.
- **The policies can't see the order.** AllowedModulePolicy only checks who pre-signs. The plan
  carries the full order, so the user sees the receiver, amounts and expiry before approving.

## After exec

Exec waits for the transaction to be mined and checks the Safe's `ExecutionFromModuleSuccess`
event. A mined transaction can still report `success: false` if the inner call failed.
