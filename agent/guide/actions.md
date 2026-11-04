# Actions

`safe_role_plan` builds one plain CALL from the Safe. Amounts are decimal token units (`"1.5"`,
not wei). `to` and `spender` take an address-book name, `safe`, or an address.

| Goal              | `safe_role_plan` arguments                                              | V2: what it needs                                                       | V1: policy it needs                                                                                                 |
| ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Send USDC or WETH | `action: transfer, token: USDC, to: Alice, amount: 5`                   | an Allow on `USDC.transfer`; budget, conditions and other policies pass | ERC20TransferPolicy on the token with the recipient allowlisted, or AllowedModulePolicy / AllowPolicy on `transfer` |
| Send ETH          | `action: transfer, token: ETH, to: Alice, amount: 0.001`                | an Allow on Alice's plain call (or `(This role, *)`); ETH budget        | NativeTransferPolicy for that recipient                                                                             |
| Approve a spender | `action: approve, token: USDC, spender: Router, amount: 10`             | an Allow on `USDC.approve`; a budget counts the approval in full        | ERC20ApprovePolicy with the spender allowlisted. Revoking (`amount: 0`) is always allowed by that policy.           |
| Swap on CoW       | `action: swap, sell: USDC, buy: WETH, amount: 25`                       | Allows on the approve and on `setPreSignature`                          | ERC20ApprovePolicy on the sell token for the CoW VaultRelayer, plus AllowedModulePolicy on `setPreSignature`        |
| Wrap ETH          | `action: wrap, amount: 0.01`                                            | an Allow on `WETH.deposit`                                              | a policy on WETH `deposit()`, with value                                                                            |
| Unwrap WETH       | `action: unwrap, amount: 0.01`                                          | an Allow on `WETH.withdraw`                                             | a policy on WETH `withdraw(uint256)`                                                                                |
| Anything else     | `action: call, to: <address>, data: 0x..., value: 0.1` (value optional) | whatever is attached for that target and selector                       | whatever the guard has for that target and selector                                                                 |

Use `call` only when the user asks for a specific call, or to show that something is denied. The
plan decodes it and warns when it targets the Safe itself, the guard, or an unknown contract.

## Timelocked actions (V2)

When `safe_role_simulate` returns `needs: ["schedule"]` (and `blocked: false`):

1. Tell the user the delay and that nothing moves now. With their go-ahead,
   `safe_role_schedule {id}` sends `scheduleModuleTx` from the role to the Timelock (the signer asks
   y/N in ask mode). It starts the delay and tells the owners (an on-chain `Scheduled` event). It
   returns `readyAt`, the window and who can cancel.
2. `safe_role_queue` lists the role's schedules: `waiting` (with a countdown), `ready`, `expired`
   or `void` (a freeze happened after it was made). Each has its plan id and the next step.
3. When `ready`: `safe_role_simulate {id}`, then `safe_role_exec {id}`, before the window ends.

The schedule is for the exact call: the same plan id. A different amount or recipient is a new plan
and a new schedule. It is consumed when the call executes. An expired or void schedule is replaced
by scheduling again. `safe_role_cancel {id}` cancels one this role made (only when the user asks).

## Co-signed actions (V2)

When `simulate` returns `needs: ["approval"]`, an approver must approve the call's hash on-chain
before exec. `next` names the approvers, the hash and the EIP-712 digest they can sign instead.
Tell the user; do not contact anyone yourself. Then simulate again. Approvals expire and are
consumed by one execution.

## Duties of this key (V2)

`safe_role_policies` → `duties` lists where this key is itself a Timelock guardian, lifter or
canceller, or a Co-signer approver. Use these tools only when the user explicitly asks:

| Tool                               | What it does                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe_role_approve {id, validFor}` | approves a transaction hash as a co-signer (default 1h). Only a hash the user gave you and reviewed: the hash does not say what it approves. |
| `safe_role_freeze {ids}`           | freezes the attachments it guards (all by default): calls they match are denied                                                              |
| `safe_role_lift {id}`              | ends a freeze early; a cooldown follows                                                                                                      |
| `safe_role_cancel {id}`            | cancels a schedule this role made, or one it is a canceller of                                                                               |

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
- **The policies can't see the order** (V1 AllowedModulePolicy, and V2 for `setPreSignature`,
  which only carries a hash): they only check who pre-signs. The plan carries the full order, so the user sees the receiver,
  amounts and expiry before approving. On V2 the approval still spends from a transfer budget.

## After exec

Exec waits for the transaction to be mined and checks the Safe's `ExecutionFromModuleSuccess`
event. A mined transaction can still report `success: false` if the inner call failed (V1). On V2
a failing inner call reverts the whole transaction instead (`ModuleExecutionFailed`), so nothing
is consumed: no budget, no schedule, no approval.
