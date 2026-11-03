# Policy Engine V2 (rev 4) cookbook

One section per use case: the exact `Change[]` to pass to `engine.configure`, what it guarantees (and what it does not),
and the story test that proves it on a real Safe 1.5.0 (`test/v2/stories/`). Research prototype, unaudited.

## How to read the tables

- **Scope** is `(actor, call)`: actor `Owners` (the owner path), a module (`Ops`, `Agent`, `Recovery`, a committee
  Safe) or `ANY`; call `*` (any call), `C.*` (any function of contract C) or `C.f` (one function).
- **Kind**: `Allow` and `Deny` are engine built-ins (no policy, no settings); `Timelock`, `Args`, `Limit`, `CoSigner`,
  `Safenet` are the policies.
- **Ops**: the op mask. Default (0): CALL for an Allow, CALL and DELEGATECALL for a Deny or a policy. Every row below
  uses the default unless it says otherwise.
- Times: T = 24 h (owners), R = 72 h (recovery), F = 7 d (max freeze), C = 12 h (cooldown). G is a guardian key.
- The install is one owners' batch: `[configure(changes), enableModule(m)..., setFallbackHandler(TokenCallbackHandler),
setModuleGuard(engine), setGuard(engine)]`. Safe's `TokenCallbackHandler` has no ERC-1271: with the default
  `CompatibilityFallbackHandler` the owners' off-chain signatures (permits, Permit2, CoW orders) move funds around
  every policy below, the Timelock and the freeze included (SPEC §6).
- An Allow grants; a policy only passes or denies; any Deny or failing policy wins; every matching scope runs. Policies
  run once per transaction, in first-match order (level 0 to 5, then attachment order).

Per-policy reference: [`docs/Timelock.md`](docs/Timelock.md), [`docs/Args.md`](docs/Args.md),
[`docs/Limit.md`](docs/Limit.md), [`docs/CoSigner.md`](docs/CoSigner.md), [`docs/Safenet.md`](docs/Safenet.md).

## 1. Owners' everyday: everything waits T, a guardian can stop it

| Scope         | Kind     | Settings                                             |
| ------------- | -------- | ---------------------------------------------------- |
| `(Owners, *)` | Allow    |                                                      |
| `(Owners, *)` | Timelock | delay T, window 0, guardians [G], lifters [Recovery] |

**Guarantees.** Every owner transaction, `configure` included, is public for T before it runs; G can stop new ones for F
per F + C. Not stopped: allowances and operator rights already given, pre-signed orders, module actors.

The owners `schedule` each transaction with their signatures (anyone relays), wait T, then execute. `configure` itself
waits T: the implicit grant does not skip the Timelock. A narrow Allow such as `(Owners, Safe.setGuard)` does not hide
the Timelock (WA-4014): every matching scope runs.

Proven by `OwnersTimelock.test.ts`: "setGuard(0) waits T although an exact Allow (Owners, Safe.setGuard) exists",
"addOwnerWithThreshold waits T", "configure waits T: the implicit grant does not skip the owners Timelock", "two
schedules at nonces n and n + 1 execute in order after T", "a schedule dies when another transaction uses its nonce",
"the owners cancel their own schedule with threshold signatures (cancelAsOwners)", "a narrow (Owners, token.*)
Timelock longer than the covering one is rejected".

## 2. ERC-20 payments by an ops actor within a monthly budget

| Scope                  | Kind     | Settings                                                                                                                               |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `(Ops, USDC.transfer)` | Allow    |                                                                                                                                        |
| `(Ops, USDC.transfer)` | Args     | Recipients preset: `transfer` word 0 IN [vendorA, vendorB]; `transferFrom` word 1 IN [same]; any selector `VALUE_TO` IN [same]; strict |
| `(Ops, USDC.approve)`  | Allow    |                                                                                                                                        |
| `(Ops, USDC.approve)`  | Args     | Spenders preset: `approve` word 0 IN [processor]; `approve` word 1 LTE 10,000 USDC; strict                                             |
| `(Ops, *)`             | Limit    | USDC 10,000 per 30 days; passUnpriced false                                                                                            |
| `(Ops, *)`             | Timelock | delay 0 (kill switch), guardians [G]                                                                                                   |

**Guarantees.** Ops authorizes at most 10,000 USDC per 30 days to listed recipients, approvals counted in full; ETH
(any calldata) only to listed recipients; G stops new Ops transactions at once, not pulls on existing allowances.

A batch is summed; approvals count in full; a revocation is free and gives nothing back, so approve, revoke, approve
again cannot refill the budget. The Recipients preset judges native value by destination whatever the calldata
(`VALUE_TO`): a payable protocol call under a Recipients attachment needs the protocol listed as a recipient.

Proven by `Erc20Payments.test.ts`: "pays a listed vendor; the budget goes down by the amount", "denies an unlisted
recipient (Args ConstraintFailed)", "denies a payment over the budget, and refills it next month (fixed windows)", "sums
a batch of 5 transfers: 5 × 2,000 fits, 5 × 2,001 is denied at the fifth call", "denies approve(attacker, max): the full
amount is priced (Limit), and the spender is not listed (Args)", the "refill attack" group, "the guardian stops ops at
once (Timelock delay 0 is a kill switch); the owners are unaffected".

## 3. ERC-721 transfers to listed recipients

| Scope                                                        | Kind         | Settings                                                  |
| ------------------------------------------------------------ | ------------ | --------------------------------------------------------- |
| `(Ops, NFT.transferFrom)`                                    | Allow        |                                                           |
| `(Ops, NFT.transferFrom)`                                    | Args         | word 1 (to) IN [vendorA]; strict                          |
| `(Ops, NFT.safeTransferFrom(address,address,uint256))`       | Allow + Args | same, word 1                                              |
| `(Ops, NFT.safeTransferFrom(address,address,uint256,bytes))` | Allow + Args | same, word 1                                              |
| `(ANY, NFT.setApprovalForAll)`                               | Deny         | (stops everyone, owners included)                         |
| `(Ops, USDC.*)`                                              | Limit        | USDC budget, placed per token contract, not at `(Ops, *)` |

ERC-721 shares `transferFrom` and `approve` with ERC-20: a Limit at `(Ops, *)` would read an NFT transfer as a spend of
an unlisted token and deny it (`Unpriced`, even with passUnpriced).

Proven by `Erc721.test.ts`: "transfers an NFT to a listed recipient with each transfer function", "denies a transfer to
an unlisted recipient (Args ConstraintFailed)", "denies setApprovalForAll to everyone, owners included: a DENY at (ANY,
NFT.setApprovalForAll) beats any Allow", "the Limit per token contract prices USDC and leaves the NFT alone", "a Limit
at (Ops, *) reads the NFT transfer as an ERC-20 spend of an unlisted token: Unpriced, even with passUnpriced".

## 4. CoW Protocol agent with a co-signer and a kill switch

| Scope                                     | Kind     | Settings                                                          |
| ----------------------------------------- | -------- | ----------------------------------------------------------------- |
| `(Agent, *)`                              | Timelock | delay 0, guardians [G]                                            |
| `(Agent, *)`                              | Limit    | USDC 50,000 per week; passUnpriced true                           |
| `(Agent, *)`                              | CoSigner | approvers [co-signer service], required 1                         |
| `(Agent, USDC.approve)`                   | Allow    |                                                                   |
| `(Agent, USDC.approve)`                   | Args     | `approve` word 0 EQ vault relayer; word 1 LTE 20,000 USDC; strict |
| `(Agent, GPv2Settlement.setPreSignature)` | Allow    |                                                                   |

**Guarantees.** Every agent transaction needs the co-signer; the bound on what an order can sell is every allowance to
the vault relayer; a freeze stops new approvals and pre-signatures, not orders already pre-signed.

Every agent transaction needs the co-signer's approval of its module call hash (`approve`, or `approveWithSig` pushed by
anyone), consumed on use. What the policies cannot see: the order inside the `orderUid` (sell token, amounts,
receiver). A pre-signed order can sell any token the Safe has approved to the vault relayer, so the bound is **every
allowance the Safe gives the vault relayer, whoever gave it**: the agent's approvals (priced by the Limit) and the
owners' own CoW Swap approvals (priced by nothing). Keep the owners' relayer allowances at zero on a Safe that runs this
agent; a `CowOrderHelper` that checks the order itself is the real fix.

Proven by `CowAgent.test.ts`: "approves the vault relayer and pre-signs an order, each approved by the co-signer",
"denies an agent transaction without the co-signer approval (MissingApprovals)", "consumes the approval: the same call
needs a new one; an approval of another call does not count", "caps the approval: only the vault relayer, at most
20,000 (Args), even when co-signed", "the weekly budget bounds the approvals", "the guardian freezes the agent at once;
ops and the owners keep working; the freeze ends after F", "the order contents: a pre-signature of an order paying the
attacker passes; the allowance to the relayer is the bound", "the bound is every allowance to the vault relayer, whoever
gave it: the owners' own approval is in the agent's reach".

## 5. Aave v3 supply and withdraw

| Scope                  | Kind         | Settings                                   |
| ---------------------- | ------------ | ------------------------------------------ |
| `(Ops, *)`             | Limit        | USDC 50,000 per 30 days; passUnpriced true |
| `(Ops, USDC.approve)`  | Allow + Args | `approve` word 0 EQ Pool                   |
| `(Ops, Pool.supply)`   | Allow + Args | word 2 (onBehalfOf) EQ_SAFE                |
| `(Ops, Pool.withdraw)` | Allow + Args | word 2 (to) EQ_SAFE                        |
| `(Ops, Pool.repay)`    | Allow + Args | word 3 (onBehalfOf) EQ_SAFE                |

No Allow for `borrow`. Proven by `Aave.test.ts`: "approves the Pool, supplies on behalf of the Safe, withdraws to the
Safe", "denies supply on behalf of the attacker (Args EQ_SAFE on onBehalfOf)", "denies withdraw to the attacker (Args
EQ_SAFE on to)".

## 6. Morpho Blue supply and withdraw

| Scope                    | Kind         | Settings                                                                                                   |
| ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `(Ops, *)`               | Limit        | USDC 50,000 per 30 days; passUnpriced true                                                                 |
| `(Ops, USDC.approve)`    | Allow + Args | `approve` word 0 EQ Morpho                                                                                 |
| `(Ops, Morpho.supply)`   | Allow + Args | words 0 to 4 EQ the market (loanToken USDC, collateralToken, oracle, irm, lltv); word 7 (onBehalf) EQ_SAFE |
| `(Ops, Morpho.withdraw)` | Allow + Args | words 0 to 4 EQ the market; word 8 (receiver) EQ_SAFE                                                      |

`MarketParams` is five static words, so the arguments after it start at word 5. Pin the whole market, not only the
receiver: Morpho markets are permissionless, so with the loan token alone a compromised key creates a market with its
own oracle, supplies the Safe's USDC to it and borrows it all against worthless collateral. The receiver pin protects
where withdrawals go, not the principal; the budget is the bound on what can be lost. One market per Args: IN lists on
each word would let a key mix the words of two listed markets into a third, unlisted one. No Allow for
`setAuthorization` (operator rights over every position, which no policy can price). Proven by `Morpho.test.ts`: "supplies on behalf of the Safe and withdraws to the Safe", "denies
withdraw to the attacker as receiver (Args EQ_SAFE on word 8)", "denies any other market: each MarketParams word (loan,
collateral, oracle, IRM, LLTV) is pinned".

## 7. Uniswap swap

| Scope                            | Kind         | Settings                                                                                                       |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `(Ops, *)`                       | Limit        | USDC 20,000 per 30 days; passUnpriced true                                                                     |
| `(Ops, USDC.approve)`            | Allow + Args | `approve` word 0 EQ router                                                                                     |
| `(Ops, Router.exactInputSingle)` | Allow + Args | word 0 (tokenIn) EQ USDC; word 1 (tokenOut) IN [WETH]; word 2 (fee) IN [500, 3000]; word 3 (recipient) EQ_SAFE |

Pin the pool, not only the recipient: with the recipient alone a compromised key swaps the budget into its own pool of
a worthless token, and the output lands in the Safe as promised. tokenIn, tokenOut and fee pick the pool; slippage
(`amountOutMinimum`) is still unseen, so the budget is the bound on what can be lost. Only the static-tuple
`exactInputSingle` can be pinned; `exactInput` (a dynamic path) and Universal Router `execute` are opaque to Args.
Proven by `Uniswap.test.ts`: "approves the router and swaps; the output lands in the Safe", "denies a swap whose
recipient is the attacker (Args EQ_SAFE on word 3)", "denies a swap into an unlisted token or fee tier (an attacker
pool): tokenOut and fee are pinned".

## 8. ENS registration paid in ETH

| Scope                        | Kind         | Settings                                                      |
| ---------------------------- | ------------ | ------------------------------------------------------------- |
| `(Ops, *)`                   | Limit        | native 0.02 ETH and USDC 1,000 per 30 days; passUnpriced true |
| `(Ops, Controller.register)` | Allow + Args | word 1 (owner) EQ_SAFE                                        |
| `(Ops, Controller.renew)`    | Allow        |                                                               |

Native value is always priced: list native, even with passUnpriced. Proven by `Ens.test.ts`: "registers a name for the
Safe and renews it; the native value is debited", "denies a registration owned by the attacker (Args EQ_SAFE on word
1)", "prices the native value: a 3-year registration (0.03 ETH) exceeds the 0.02 ETH budget", "native value is never
unpriced: with native unlisted, even passUnpriced denies (Unpriced)".

## 9. Recovery

| Scope                        | Kind     | Settings                                                  |
| ---------------------------- | -------- | --------------------------------------------------------- |
| `(Recovery, Safe.swapOwner)` | Allow    |                                                           |
| `(Recovery, *)`              | Timelock | delay R, window 7 d, no guardians (nothing can freeze it) |
| `(Owners, *)`                | Timelock | (from section 1) lifters [Recovery]                       |

**Guarantees.** Nothing freezes recovery; the owners can detach it within T < R; a rogue recovery is visible for R.

Recovery schedules `swapOwner` (a batch of swaps is one schedule) and executes after R. The owners cannot cancel it
with their signatures; they detach it with a configure, which waits T < R. A payment allowlist never blocks it unless
it is strict at `(ANY, *)`.

Proven by `Recovery.test.ts`: "recovery waits R, then swaps an owner", "the owners detach a rogue recovery within T,
before its R is over", "the owners cannot cancel recovery's schedule with their signatures (NotOwnersQueue)", the
"payment allowlists next to recovery" group, "what to avoid: Recipients strict at (ANY, *) denies every other call,
recovery included (NoConstraint)".

## 10. Freeze timelines

Configuration of sections 1 and 9. Proven by `Freeze.test.ts`:

| Compromise     | Test                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner keys     | "owner keys compromised: G freezes, recovery replaces the owners within R < F, the new owners cancel the attacker configuration, the attacker queue is void"                                                        |
| Guardian       | "guardian compromised: the owners replace G with a configure scheduled during the freeze, executed in the cooldown; G cannot re-freeze", and "... with recovery as lifter: the owners get out after T instead of F" |
| Recovery key   | "recovery key compromised: it must wait R in the open; the owners detach it after T < R"                                                                                                                            |
| Two colluding  | "two colluding (guardian + recovery key): lost, as documented ..."                                                                                                                                                  |
| Voiding        | "the owners' queue is void after a freeze, but a scheduled configure is exempt"                                                                                                                                     |
| Cooldown       | "a lift starts the cooldown at once; a freeze during C is skipped; after C the guardian can freeze again"                                                                                                           |
| Many guardians | "any number of guardians: the owners are frozen at most F per F + C": "the second guardian freeze joins the window ...", "ten cycles of alternating guardians to day 60+ ..."                                       |

## 11. Spark: a delay on one function, another Safe as a canceller

| Scope                            | Kind     | Settings                                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `(Owners, *)`                    | Allow    |                                                                                |
| `(Owners, USDC.transfer)`        | Timelock | delay 72 h, guardians [G], cancellers [spark Safe]                             |
| `(Owners, Safe.*)`               | Timelock | delay 72 h, guardians [G] (setGuard, setModuleGuard, modules, handler, owners) |
| `(Owners, engine.configure)`     | Timelock | delay 72 h, guardians [G]                                                      |
| `(Owners, *)`, DELEGATECALL only | Timelock | delay 72 h, guardians [G]                                                      |
| `(Ops, USDC.transfer)`           | Allow    |                                                                                |
| `(Ops, USDC.*)`                  | Timelock | delay 1 h, cancellers [spark Safe]                                             |

**Guarantees.** Owners' other calls are instant; USDC transfers, Safe administration, configure and DELEGATECALLs wait
72 h; the spark Safe cancels transfers. Not delayed: `approve`, `increaseAllowance` and `transferFrom` of USDC (add them,
or use the "Delay on one function" template, which does), ETH, other actors.

The three route covers are what the covering rule asks for (SPEC §5.1): without one of them `configure` reverts
`TimelockNotCoveringConfiguration` naming the uncovered route and the delay. The app's "Admin delay" template emits the
three. G must be on the covers, not only on the transfer delay: the owners' `configure` that would remove the transfer
delay matches the `(Owners, engine.configure)` cover, so only a freeze of that cover stops it (lint
`configure-cover-unguarded`). An owner-wide `(Owners, *)` Timelock of 72 h replaces all three, at the cost of
delaying every owner call.

Proven by `Spark.test.ts`: "the spark Safe cancels the owners' queued token transfer", "the spark Safe cancels the ops
actor's queued transfer", "the spark Safe cannot cancel what its attachments did not match (NotCanceller)", and the
rev 4 group "each missing route cover is named; with the three the configuration is accepted", "approve, ETH and other
calls are instant; transfers, Safe admin, configure and DELEGATECALLs wait 72 h", "the guardian stops the removal of
the delay only through the configure cover".

## 12. Committee: approval tiers without Quorum

| Scope                        | Kind         | Settings                      |
| ---------------------------- | ------------ | ----------------------------- |
| `(Ops, USDC.transfer)`       | Allow + Args | Recipients [vendorA, vendorB] |
| `(Ops, *)`                   | Limit        | USDC 10,000 per 30 days       |
| `(Committee, USDC.transfer)` | Allow + Args | Recipients [vendorA, vendorB] |
| `(Committee, *)`             | Limit        | USDC 50,000 per 30 days       |

The committee is a 2-of-3 Safe enabled as a module of the main Safe; it executes `main.execTransactionFromModule(...)`
from its own `execTransaction`. Larger amounts go through the main Safe's owners. Proven by `Committee.test.ts`: "the
committee pays 30,000 with 2 of its 3 signatures", "ops cannot pay what the committee can (LimitExceeded at 10,000)",
"above its own budget the committee is denied (LimitExceeded), summed over the month", "one committee signature is not
enough (its own threshold is 2)".

## 13. Batches

No Allow on MultiSendCallOnly is needed: the wrapper is transparent and each sub-call is checked. At most 8 calls, no
nesting, no value on the wrapper, and an owners' Timelock schedules the batch once. Proven by `Batches.test.ts`: "the
wrapper is transparent: no Allow on MultiSend, the sub-calls are granted one by one", "nesting is denied: a sub-call
DELEGATECALLing the trusted batch (NestedBatch)", "caps a batch at 8 calls: 8 pass, 9 are BatchTooLarge", "built-in
gates run for every call before any policy: NotGranted at call 1 wins over an Args failure at call 0", "one Timelock
schedule per batch: the owners schedule the batch once and execute it after T".

## 14. Configuration

| Path     | Rule                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owners   | `configure` is granted without an Allow; Denys and policies still apply, except Limit and Args, which never judge a call to the engine (it moves nothing), so neither can lock the owners out   |
| A module | needs the exact Allow `(module, engine.configure)`; `(module, *)` is not enough                                                                                                                 |
| Anywhere | never in a batch, never with value, never as DELEGATECALL; other engine functions are denied (`GuardTargetDenied`)                                                                              |
| Install  | leftovers of an earlier install stay attached: detach them first in the install batch                                                                                                           |
| Validate | after the batch, `validate` runs for every policy the batch touched that is still attached: a configure that would leave a longer delay uncovered is refused, whatever the order of its changes |

Proven by `Configure.test.ts`: "the owners configure without any Allow (implicit grant on the owner path); nothing else
is granted", "a module with (Ops, *) cannot configure: calls to the engine need the exact Allow (F5, NotGranted)", "a
module with the exact Allow (Recovery, engine.configure) configures", "configure inside a batch is denied
(GuardTargetDenied names the sub-call)", "the install batch detaches the leftovers first, then attaches the new
configuration", "a Limit at (Owners, *) without passUnpriced: payments are priced, configure passes, Safe admin calls
stay Unpriced", "a strict Args at (Owners, *) (Recipients preset): configure passes, Safe admin calls stay NoConstraint",
"200 sequences: the engine accepts a batch exactly when the mirror does; the rule holds after each".

## 15. Preview before signing

The app calls `engine.matches(safe, actor, to, value, data, op)`, then `eth_call`s each matched policy's `check` with
`from = engine`, in first-match order. Same code, same state, nothing persists. Proven by `Preview.test.ts`, which
compares the preview with the real transaction's revert in each scenario. Caveat: each policy is `eth_call`ed alone
against the current state, so a policy reading state another policy writes in the same transaction would preview
differently (none of the five does).
