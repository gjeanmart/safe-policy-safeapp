# Policy Engine V2: gas on a real Safe 1.5.0

Measured by `test/v2/compare/Gas.test.ts`, which prints these numbers. Research prototype, unaudited.

## Method

- A real Safe 1.5.0 proxy (vendored `safe-smart-account`), 2-of-3 owners, the real `SafePolicyGuardV2` installed as
  both guard and module guard, the real policies, a USDC-style ERC-20 (`E2eToken`, 6 decimals).
- Numbers are `gasUsed` of the whole `execTransaction` / `execTransactionFromModule` transaction: 21k base, calldata,
  owner signature checks (2 ECDSA), the call itself, the guard hooks, the policies. Differences to the "plain Safe" row
  are the cost of the guard.
- Steady state: each measured transaction follows a warm-up transaction of the same kind, so recipient balances and
  policy storage (Limit `spent`, Timelock slots) are already non-zero. A first transaction costs more (cold 0 → non-0
  writes), with or without a guard.
- The call is `USDC.transfer(vendor, 1)` unless stated. Batches go through MultiSendCallOnly 1.5.0 (DELEGATECALL).
- Hardhat 2.29.1, solc 0.8.30, viaIR, optimizer 10,000,000 runs, EVM cancun; hardhat enforces the EIP-7825 per-transaction
  gas cap (2^24 = 16,777,216).
- V1 is the vendored `SafePolicyGuard` (71b9cb0) with 8ee68a8's `AllowPolicy` bound as the fallback.
- **Before** is the gas pass (1c69a1f: linear dispatch, caps 4 × 8, hot path in assembly), measured again on the same
  machine for this table; **after** is the Sepolia split ([Deployable on Sepolia](#deployable-on-sepolia), SPEC §14
  D-18). Plain and V1 rows only move by a few gas between runs (ECDSA signature bytes).

## Results

| Path   | Configuration                                                           |  Before |   After |       Δ | After vs plain |
| ------ | ----------------------------------------------------------------------- | ------: | ------: | ------: | -------------: |
| owner  | plain Safe, no guard                                                    |  71,467 |  71,443 |       – |              – |
| owner  | V1 guard, fallback AllowPolicy                                          |  91,834 |  91,822 |       – |        +20,379 |
| owner  | V2, Allow `(Owners, *)`                                                 |  90,012 |  89,199 |    −813 |        +17,756 |
| owner  | V2, Allow + Recipients + Limit + Freeze                                 | 153,583 | 160,761 |  +7,178 |        +89,318 |
| owner  | V2, Allow + Freeze + Timelock 24h (execute)                             | 138,870 | 144,326 |  +5,456 |        +72,883 |
| owner  | ↳ `TimelockPolicy.scheduleOwnerTx` (its own transaction)                | 159,246 | 159,364 |    +118 |                |
| owner  | V2, Allow + Co-signer + Safenet (proofs in the policy context)          | 155,612 | 162,182 |  +6,570 |        +90,739 |
| module | plain Safe, no module guard                                             |  49,452 |  49,452 |       – |              – |
| module | V1 guard, fallback AllowPolicy                                          |  86,824 |  86,824 |       – |        +37,372 |
| module | V2, Allow `(Ops, *)`                                                    |  67,674 |  66,677 |    −997 |        +17,225 |
| module | V2 Ops payment: Allow + Recipients + Limit + Freeze                     | 129,193 | 136,101 |  +6,908 |        +86,649 |
| module | V2 Agent CoW order (`signCowOrder`): Allow + Limit + Co-signer + Freeze | 173,395 | 179,939 |  +6,544 |            (1) |
| module | ↳ `CoSignerPolicyV2.cosign` (its own transaction)                       |  58,898 |  58,886 |       – |                |
| module | V2 Recovery `swapOwner`: Allow + Timelock 72h (execute)                 | 107,527 | 113,285 |  +5,758 |            (1) |
| batch5 | plain Safe, owners, 5 transfers                                         |  99,671 |  99,671 |       – |              – |
| batch5 | V1, Allow on MultiSend (the 5 sub-calls are not checked at all)         | 117,984 | 118,044 |       – |        +18,373 |
| batch5 | V2 owners, Allow `(Owners, *)`                                          | 144,335 | 142,794 |  −1,541 |        +43,123 |
| batch5 | V2 Ops: Allow + Recipients + Limit + Freeze                             | 266,283 | 281,801 | +15,518 |       +182,130 |

(1) Not a token transfer, so there is no plain row to subtract: `signCowOrder` writes `signedMessages` (a 0 → 1 SSTORE,
~22k) and `swapOwner` rewrites the owner list.

Reading it:

- **One ALLOW costs ~17.5k** on either path, now 0.8–1.5k less than before the split: the guard no longer carries the
  policy dispatch, and builds nothing for it when no policy matched. V2 stays cheaper than V1's fallback Allow on the
  owner path (+17.8k vs +20.4k) and half of it on the module path (+17.2k vs +37.4k: V1 writes `$checkingSafe` /
  `$checkingModule` to storage; V2 uses a transient lock).
- **A transaction that runs policies pays ~+5.5 to +7k** for the split: one DELEGATECALL to `PolicyEngineV2Runner` per
  check (2,600 cold account access, the guard's calldata copied and forwarded with the matches, the runner's own setup
  and return, ~1.5k) and ~0.5–1k per run over the former inlined dispatch (via-IR spills more of the runner's locals to
  memory). An Ops payment is +86.6k over a plain module transaction (was +79.7k, +5.3% overall).
- A 5-call batch with call-level policies is +15.5k (+5.8%): the same single hop, the 5 calls' runs over it (the guard
  passes the decoded calls instead of letting the runner decode the batch again, −8.6k measured), and the per-run
  overhead × 6.
- The policy context (Co-signer, Safenet) is decoded once, in the runner, in the same call as the policy runs (a separate
  validation call first cost +13.8k on that row; folding it in, +6.6k).
- Each extra policy run costs **~9.4k** (pass-only policy, slope of the worst-case rows below; was ~9.1k). The first
  policy of a transaction also brings the ~7k hop.
- Transaction-level policies run once per transaction: one co-signature and one attestation cost the same for a
  5-call batch as for one call. Call-level policies run per sub-call: the Ops batch of 5 is ~36k per transfer.

## Worst case at the caps

`SPEC §9` caps: 4 attachments per scope × 8 levels = **32 matches per call**, **8 calls per batch**. Measured with a
module batch where every call matches `n` attachments at each level (1 ALLOW + `n − 1` distinct `E2ePassPolicy`, a
pass-only policy with no state, so the numbers are the engine's own cost; real policies add theirs). "Identical" calls
are the same `USDC.transfer` (every call matches the same 8 scopes, so a transaction-level policy runs once); "distinct"
calls each go to their own target with their own selector, so only `(ANY, *)` and `(Ops, *)` are shared and each call
brings 6 scopes of its own: 192 call-level runs, or 150 transaction-level runs that each receive all 8 calls. That is the
most work the caps allow.

| Calls       | Matches per call | Policy level |    Before |         After |
| ----------- | ---------------: | ------------ | --------: | ------------: |
| 1           |  8 (ALLOWs only) | –            |   112,075 |       110,625 |
| 1           |               16 | call         |   185,958 |       193,624 |
| 1           |               32 | call         |   328,931 |       343,806 |
| 1           |               16 | transaction  |   196,980 |       205,061 |
| 1           |               32 | transaction  |   364,974 |       383,009 |
| 8 identical |               32 | call         | 1,327,557 |     1,387,067 |
| 8 identical |               32 | transaction  |   973,480 |       989,819 |
| 8 distinct  |               32 | call         | 2,035,940 |     2,103,742 |
| 8 distinct  |               32 | transaction  | 3,084,511 | **3,089,853** |

Findings:

1. **Dispatch is still linear.** 16 → 32 matches cost 193.6k → 343.8k for one call: ~9.4k per added policy run (the
   test asserts the per-run cost does not grow).
2. **The worst case at the caps is ~3.1M gas**, 18% of the 2^24 cap: 8 distinct calls × 32 matches with
   transaction-level pass-only policies. `Gas.test.ts` asserts every worst-case row at the caps stays below 4M.
3. With real policies the budget left is ~13.6M: e.g. 192 call-level runs of a Limit-like policy (~16k of own work
   each, storage included) add ~3.1M, for ~5M in all.

## Deployable on Sepolia

Measured on Sepolia with `eth_estimateGas` (reth 2.8): a create costs about **210,000 + 1,542 × runtime bytes** (Ethereum
charges 200 per byte), under the EIP-7825 cap of 2^24 = 16,777,216 gas per transaction. One transaction can therefore
deploy at most ~10,400 bytes of runtime, constructor-created contracts included. The gas pass's `SafePolicyGuardV2`
(22,216 B, 34.5M) created `PolicyEngineV2` (19,632 B, 30.5M) in its constructor and could not be deployed;
`TimelockPolicy` (13,698 B, 21.3M) neither. Every V2 contract is now ≤ 10,000 B, deployed in its own transaction
(`scripts/deploy-v2.ts` checks each create against 16,000,000 before sending it; `test/v2/Sizes.test.ts` checks the
sizes):

| Contract                                   | Runtime (B) | Sepolia create gas | Per engine |
| ------------------------------------------ | ----------: | -----------------: | :--------: |
| `PolicySignLib`                            |       3,158 |          5,079,636 |            |
| `PolicyEngineV2Config`                     |       9,693 |         15,156,606 |     ✓      |
| `PolicyEngineV2Freeze`                     |       7,387 |         11,600,754 |     ✓      |
| `PolicyEngineV2Preview`                    |       9,570 |         14,966,940 |     ✓      |
| `PolicyEngineV2Views`                      |       7,672 |         12,040,224 |     ✓      |
| `PolicyEngineV2Runner`                     |       7,504 |         11,781,168 |     ✓      |
| `SafePolicyGuardV2`                        |       9,914 |         15,497,388 |     ✓      |
| `PolicyFallbackHandler`                    |       2,811 |          4,544,562 |            |
| `FreezePolicy`                             |       3,079 |          4,957,818 |            |
| `TimelockPolicyQueue`                      |       7,732 |         12,132,744 |            |
| `TimelockPolicy`                           |       7,641 |         11,992,422 |            |
| `RecipientsPolicy`                         |       7,230 |         11,358,660 |            |
| `LimitPolicy`                              |       9,992 |         15,617,664 |            |
| `ArgsPolicy`                               |       5,390 |          8,521,380 |            |
| `CoSignerPolicyV2`                         |       6,254 |          9,853,668 |            |
| `SafenetPolicyV2`                          |       5,615 |          8,868,330 |            |
| `QuorumPolicyV2`                           |       6,792 |         10,683,264 |            |
| **Two engines + shared contracts, 23 txs** |             |     **≈ 266M gas** |            |

### The split, and the alternatives measured

The hot path needs, in one place or the other: the hooks' ABI and frame (~3 KB of code), the scope lookup and built-in
gates with the engine rules (~4.5 KB), MultiSend decoding (~0.9 KB, frozen library), and the policy dispatch (grouping,
encoding, the calls, `txHash`, policy context: ~5 KB). Sizes are runtime bytes of `SafePolicyGuardV2` unless stated.

| Option                                                                                                                      | Result                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Hot path whole in the guard, everything else (config, freeze, preview, views) in modules behind the `fallback`              | 14,212 B: does not fit                                                                                                                       |
| Same, plus the context decoder and MultiSend decoding moved out                                                             | ≈ 12.3 KB (estimated from the per-function sizes): does not fit                                                                              |
| Compiler: optimizer runs 200 / 1,000 (a change of the shared `hardhat.config.ts`)                                           | 200: stack too deep (via-IR); 1,000: 12,396 B with the first split, no fit                                                                   |
| Hooks in a module, guard as a thin router                                                                                   | the module (hooks + lookup, without dispatch) ≈ 10.7 KB: also needs the runner, two hops on every transaction, ALLOW-only included (+≈ 4–5k) |
| **Lookup and built-in gates in the guard, policy runs in a runner** (one DELEGATECALL per policy-bearing call)              | guard 9,762 B; Ops payment 138,562, Allow 66,983, batch5 Ops 304,250                                                                         |
| ↳ **one DELEGATECALL per check** (runs queued; flushed before a built-in deny), decoded batch passed, context decoded there | guard 9,914 B; Ops payment **136,101**, Allow **66,677**, batch5 Ops **281,801** (chosen)                                                    |

The chosen layout keeps everything every transaction needs in the guard (an ALLOW-only transaction never leaves it) and
pays one DELEGATECALL only when a policy matched. Off the hot path, the guard's `fallback` routes by selector:
configuration to `PolicyEngineV2Config`; `preview` to `PolicyEngineV2Preview` (the same evaluation compiled with a
constant preview flag, so the guard carries no gate reporting and the preview no early revert); the enumeration views
to `PolicyEngineV2Views`; freeze and every other view to `PolicyEngineV2Freeze`. `freezeStatus` and `SIGN_LIB` stay in
the guard: policies read them during a check. `TimelockPolicy` keeps the check, configuration, cancelling and views and
DELEGATECALLs `TimelockPolicyQueue` for scheduling (off the hot path). `LimitPolicy` lost 55 bytes without a split
(calldata loads, the allowance slot tag): 9,992 B.

## What changed in the gas pass (1c69a1f)

- **Linear dispatch** (now `PolicyEngineV2Runner._group`): a call's call-level matches, and the transaction's queued
  transaction-level matches, are grouped by policy in one pass through open-addressing hash tables in memory (policy →
  run, and for the transaction level id → seen). Each distinct policy runs once with its ids in first-match order; runs
  are in first-match order; verdict semantics, preview gates and their order are unchanged.
- **Packed matches** (`EngineStorage._match`): one assembly pass over the 8 levels returns each match as its raw
  attachment slot word with the level in bits 184+, and the scope key per level; no per-match structs.
- **Hand-written ABI encoding** of `checkCall` / `checkTransaction` (`encodeCheck`), attachment ids hashed in scratch
  memory, absent policy context passed without an allocation.
- **TimelockPolicy**: the canceller union of a schedule is deduplicated in memory and written once.
