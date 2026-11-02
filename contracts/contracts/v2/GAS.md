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
- **Before** is the engine of WP7 (1d671c2); **after** is the gas pass (linear dispatch, caps 4 × 8, hot path in
  assembly, see [What changed](#what-changed)). Policies are unchanged except the Timelock canceller snapshot.

## Results

| Path   | Configuration                                                           |  Before |   After | After vs plain |
| ------ | ----------------------------------------------------------------------- | ------: | ------: | -------------: |
| owner  | plain Safe, no guard                                                    |  71,467 |  71,467 |              – |
| owner  | V1 guard, fallback AllowPolicy                                          |  91,834 |  91,834 |        +20,367 |
| owner  | V2, Allow `(Owners, *)`                                                 |  94,826 |  90,012 |        +18,545 |
| owner  | V2, Allow + Recipients + Limit + Freeze                                 | 168,882 | 153,595 |        +82,128 |
| owner  | V2, Allow + Freeze + Timelock 24h (execute)                             | 148,198 | 138,870 |        +67,403 |
| owner  | ↳ `TimelockPolicy.scheduleOwnerTx` (its own transaction)                | 163,505 | 159,270 |                |
| owner  | V2, Allow + Co-signer + Safenet (proofs in the policy context)          | 164,666 | 155,600 |        +84,133 |
| module | plain Safe, no module guard                                             |  49,452 |  49,452 |              – |
| module | V1 guard, fallback AllowPolicy                                          |  86,824 |  86,824 |        +37,372 |
| module | V2, Allow `(Ops, *)`                                                    |  72,512 |  67,674 |        +18,222 |
| module | V2 Ops payment: Allow + Recipients + Limit + Freeze                     | 145,377 | 129,193 |        +79,741 |
| module | V2 Agent CoW order (`signCowOrder`): Allow + Limit + Co-signer + Freeze | 187,529 | 173,395 |            (1) |
| module | ↳ `CoSignerPolicyV2.cosign` (its own transaction)                       |  58,886 |  58,898 |                |
| module | V2 Recovery `swapOwner`: Allow + Timelock 72h (execute)                 | 115,456 | 107,539 |            (1) |
| batch5 | plain Safe, owners, 5 transfers                                         |  99,671 |  99,683 |              – |
| batch5 | V1, Allow on MultiSend (the 5 sub-calls are not checked at all)         | 117,984 | 118,056 |        +18,373 |
| batch5 | V2 owners, Allow `(Owners, *)`                                          | 170,455 | 144,335 |        +44,652 |
| batch5 | V2 Ops: Allow + Recipients + Limit + Freeze                             | 349,430 | 266,283 |       +166,600 |

(1) Not a token transfer, so there is no plain row to subtract: `signCowOrder` writes `signedMessages` (a 0 → 1 SSTORE,
~22k) and `swapOwner` rewrites the owner list. V1 rows and the plain rows only move by a few gas between runs (ECDSA
signature bytes).

Reading it:

- **One ALLOW costs ~18k** on either path (was ~23k): engine hooks, one packed level-counter read, one array length
  and one attachment read, the owner-path context hash. V2 is now cheaper than V1's fallback Allow on the owner path
  (+18.5k vs +20.4k) and half of it on the module path (+18.2k vs +37.4k: V1 writes `$checkingSafe` /
  `$checkingModule` to storage; V2 uses a transient lock).
- **An Ops payment (Allow + Recipients + Limit + Freeze) is +80k** over a plain module transaction (was +96k). Where it
  goes (call tree of the measured transaction): the three policies run ~38k (Limit ~16k with its `spent` SSTORE,
  Freeze ~12.6k of which ~5.6k is its `freezeStatus` read back from the engine, Recipients ~9.5k; each includes a
  2,600 cold CALL); the engine ~40k, of which ~19k are cold SLOADs (level counters, 2 array lengths, 4 attachments)
  and ~4k the Safe's own guard call. The design doc's 20–25k (§4) and F12's 30–40k are not reachable with one storage
  slot per attachment and one contract per policy: the cold storage reads and cold calls alone are ~45k.
- Each extra policy run now costs **~9k** (pass-only policy, measured as the slope of the worst-case rows below): ~2.1k
  cold SLOAD of the attachment, ~2.6k cold CALL, ~0.5k in the policy, ~3k engine-side (attachment id, grouping,
  encoding). It was ~25k plus a quadratic term.
- Transaction-level policies run once per transaction: one co-signature and one attestation cost the same for a
  5-call batch as for one call. Call-level policies run per sub-call: the Ops batch of 5 is ~33k per transfer (was
  ~50k).
- V1's batch row is cheap because V1 (71b9cb0) does not look inside a batch: with an Allow on MultiSend any sub-call
  goes through (see COMPARISON.md).

## Worst case at the caps

`SPEC §9` caps, now: 4 attachments per scope × 8 levels = **32 matches per call**, **8 calls per batch** (were 8 and 16).
Measured with a module batch where every call matches `n` attachments at each level (1 ALLOW + `n − 1` distinct
`E2ePassPolicy`, a pass-only policy with no state, so the numbers are the engine's own cost; real policies add theirs).
"Identical" calls are the same `USDC.transfer` (every call matches the same 8 scopes, so a transaction-level policy
runs once); "distinct" calls each go to their own target with their own selector, so only `(ANY, *)` and `(Ops, *)` are
shared and each call brings 6 scopes of its own: 192 call-level runs, or 150 transaction-level runs that each receive
all 8 calls. That is the most work the caps allow.

| Calls        | Matches per call | Policy level | Before                      |         After |
| ------------ | ---------------: | ------------ | --------------------------- | ------------: |
| 1            |  8 (ALLOWs only) | –            | 136,307                     |       112,075 |
| 1            |               16 | call         | 313,499                     |       185,166 |
| 1            |               32 | call         | 976,069                     |       329,327 |
| 1            |               64 | call         | 3,555,784                   |     above cap |
| 1            |               16 | transaction  | 252,050                     |       196,980 |
| 1            |               32 | transaction  | 510,921                     |       366,189 |
| 1            |               64 | transaction  | 1,185,834                   |     above cap |
| 8 identical  |               32 | call         | 6,564,418                   |     1,321,317 |
| 8 identical  |               32 | transaction  | 2,005,082                   |       973,579 |
| 8 distinct   |               32 | call         | 7,279,722                   |     2,035,160 |
| 8 distinct   |               32 | transaction  | 6,490,995                   | **3,088,069** |
| 16 identical |               64 | call         | **does not fit in 16M gas** |     above cap |
| 16 identical |               64 | transaction  | 11,943,030                  |     above cap |

Findings:

1. **Dispatch is linear.** 8 → 16 → 32 matches cost 112k → 185k → 329k for one call: ~9.1k per added policy run at
   either step (the test asserts the per-run cost does not grow). Before, it was 25k per run plus ~650 × runs²
   (`_runCallPolicies` scanned the match list three times per distinct policy).
2. **The worst case at the caps is ~3.1M gas**, 18% of the 2^24 cap: 8 distinct calls × 32 matches with
   transaction-level pass-only policies (each of the 150 runs re-receives the 8 calls). `Gas.test.ts` asserts every
   worst-case row at the caps stays below 4M. Before, the caps admitted batches that could never execute.
3. With real policies the budget left is ~13.6M: e.g. 192 call-level runs of a Limit-like policy (~16k of own work
   each, storage included) add ~3.1M, for ~5M in all.

## Caps

| Cap                   | Before | After | Why                                                                                                                 |
| --------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------------------------- |
| Attachments per scope |      8 | **4** | 32 matches per call; 4 is what the §3 org chart needs (largest scope: `(Owners, *)` with Allow + Freeze + Timelock) |
| Calls per batch       |     16 | **8** | worst case 3.1M engine-only at 4 per scope, leaving >13M for the policies' own work                                 |

The linear engine alone would also fit the old caps (16 calls × 64 matches, call-level: ~6.7M engine-only, measured
during this change), but not with real policies behind 896 runs (~14M more at 16k each).

## What changed

- **Linear dispatch** (`SafePolicyGuardV2._group`): a call's call-level matches, and the transaction's queued
  transaction-level matches, are grouped by policy in one pass through open-addressing hash tables in memory (policy →
  run, and for the transaction level id → seen). Each distinct policy runs once with its ids in first-match order; runs
  are in first-match order; verdict semantics, preview gates and their order are unchanged.
- **Packed matches** (`EngineStorage._match`): one assembly pass over the 8 levels returns each match as its raw
  attachment slot word with the level in bits 184+, and the scope key per level; no per-match structs.
- **Hand-written ABI encoding** of `checkCall` / `checkTransaction` (`_encodeCheck`), attachment ids hashed in scratch
  memory, absent policy context passed without an allocation.
- **TimelockPolicy**: the canceller union of a schedule is deduplicated in memory and written once (was an O(n²) scan
  of the storage array per canceller).
- Runtime size of `SafePolicyGuardV2`: **22,216 bytes** (was 22,892; limit 24,576).
