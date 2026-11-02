# Policy Engine V2: gas on a real Safe 1.5.0

Measured by `test/v2/compare/Gas.test.ts` (WP7), which prints this table. Research prototype, unaudited.

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

## Results

| Path   | Configuration                                                           | Gas used | vs plain |
| ------ | ----------------------------------------------------------------------- | -------: | -------: |
| owner  | plain Safe, no guard                                                    |   71,467 |        – |
| owner  | V1 guard, fallback AllowPolicy                                          |   91,834 |  +20,367 |
| owner  | V2, Allow `(Owners, *)`                                                 |   94,826 |  +23,359 |
| owner  | V2, Allow + Recipients + Limit + Freeze                                 |  168,882 |  +97,415 |
| owner  | V2, Allow + Freeze + Timelock 24h (execute)                             |  148,198 |  +76,731 |
| owner  | ↳ `TimelockPolicy.scheduleOwnerTx` (its own transaction)                |  163,505 |          |
| owner  | V2, Allow + Co-signer + Safenet (proofs in the policy context)          |  164,666 |  +93,199 |
| module | plain Safe, no module guard                                             |   49,452 |        – |
| module | V1 guard, fallback AllowPolicy                                          |   86,824 |  +37,372 |
| module | V2, Allow `(Ops, *)`                                                    |   72,512 |  +23,060 |
| module | V2 Ops payment: Allow + Recipients + Limit + Freeze                     |  145,377 |  +95,925 |
| module | V2 Agent CoW order (`signCowOrder`): Allow + Limit + Co-signer + Freeze |  187,529 |      (1) |
| module | ↳ `CoSignerPolicyV2.cosign` (its own transaction)                       |   58,886 |          |
| module | V2 Recovery `swapOwner`: Allow + Timelock 72h (execute)                 |  115,456 |      (1) |
| batch5 | plain Safe, owners, 5 transfers                                         |   99,671 |        – |
| batch5 | V1, Allow on MultiSend (the 5 sub-calls are not checked at all)         |  117,984 |  +18,313 |
| batch5 | V2 owners, Allow `(Owners, *)`                                          |  170,455 |  +70,784 |
| batch5 | V2 Ops: Allow + Recipients + Limit + Freeze                             |  349,430 | +249,759 |

(1) Not a token transfer, so there is no plain row to subtract: `signCowOrder` writes `signedMessages` (a 0 → 1 SSTORE,
~22k) and `swapOwner` rewrites the owner list.

Reading it:

- **One ALLOW costs ~23k** on either path (engine hooks, one packed level-counter read, one attachment read, the
  owner-path context hash). V1's fallback Allow costs about the same on the owner path (+20k) and more on the module path
  (+37k: V1 writes `$checkingSafe` / `$checkingModule` to storage; V2 uses a transient lock).
- **Each real policy adds ~20–25k**, mostly engine-side dispatch (see the pass-only rows below: a policy that does
  nothing costs ~25–30k per run). An Ops payment (Allow + Recipients + Limit + Freeze) is **+96k** over a plain module
  transaction, not the ~20–25k the design doc estimated (§4) nor F12's ~30–40k.
- Transaction-level policies run once per transaction: one co-signature and one attestation cost the same for a
  5-call batch as for one call. Call-level policies run per sub-call: the Ops batch of 5 is ~50k per transfer.
- V1's batch row is cheap because V1 (71b9cb0) does not look inside a batch: with an Allow on MultiSend any sub-call
  goes through (see COMPARISON.md).

## Worst case at the caps

`SPEC §9` caps: 8 attachments per scope × 8 levels = **64 matches per call**, **16 calls per batch**. Measured with a
module batch of identical transfers, each matching `n` attachments per level (1 ALLOW + `n − 1` distinct
`E2ePassPolicy`, a pass-only policy with no state, so the numbers are the engine's own cost; real policies add theirs).

| Calls | Matches per call | Policy level | Gas used                    |
| ----: | ---------------: | ------------ | --------------------------- |
|     1 |               16 | call         | 313,499                     |
|     1 |               32 | call         | 976,069                     |
|     1 |               64 | call         | 3,555,784                   |
|     1 |               16 | transaction  | 252,050                     |
|     1 |               32 | transaction  | 510,921                     |
|     1 |               64 | transaction  | 1,185,834                   |
|    16 |               64 | call         | **does not fit in 16M gas** |
|     8 |               64 | call         | **does not fit in 16M gas** |
|     4 |               64 | call         | 13,350,515                  |
|    16 |               64 | transaction  | 11,943,030                  |
|    16 |               32 | call         | 13,326,895                  |
|     8 |               32 | call         | 6,564,418                   |
|    16 |               16 | call         | 3,202,147                   |
|     8 |               16 | call         | 1,626,900                   |

Findings:

1. **The current caps admit configurations that cannot execute.** With 64 call-level matches per call, a batch of
   more than 4 calls exceeds the 2^24 per-transaction gas cap (EIP-7825). Single calls still work (3.6M), so this is not
   a lock-out, but the engine accepts a configuration under which a 16-call batch can never run.
2. **Call-level cost is superlinear in matches.** 16 → 32 → 64 matches cost 0.31M → 0.98M → 3.56M for one call. A
   pass-only policy written in raw assembly (no ABI decoding) measured the same within 1% (probe during WP7, not kept),
   so the cost is in the engine. Fitting the single-call rows gives ~25k per call-level policy run plus a quadratic term
   of ~650 gas × policies²; the quadratic part matches `_runCallPolicies`, which for each distinct policy scans the
   whole match list three times (`_seenCallPolicy` plus two counting passes). Transaction-level runs are linear
   (~19k each).

## Proposed caps (not applied: the engine is unchanged)

| Cap                   | Now | Proposed | Why                                                                                     |
| --------------------- | --: | -------: | --------------------------------------------------------------------------------------- |
| Attachments per scope |   8 |    **4** | 32 matches per call; the quadratic term is 4× smaller; 4 is what the §3 org chart needs |
| Calls per batch       |  16 |    **8** | worst case 6.6M engine-only at 4 per scope, leaving ~10M for the policies' own work     |

At 4 × 8 the engine's worst case is 8 calls × 32 matches = 6.56M; adding real policy work (Limit / Recipients ~25k per
run × 24 runs × 8 calls ≈ 4.8M) stays under the 16.7M cap. Keeping 16 calls per batch would need 2 attachments per
scope (16 × 16 = 3.2M) or a cap on distinct call-level policies per call. Independently of the caps, grouping the
matches by policy in one pass (instead of `_seenCallPolicy` + two scans per policy) would remove the quadratic term; not
measured.
