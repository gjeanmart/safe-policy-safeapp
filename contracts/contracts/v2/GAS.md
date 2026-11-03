# Policy Engine V2 rev 3: gas on a real Safe 1.5.0

Measured by `test/v2/compare/Gas.test.ts`, which prints these tables. Research prototype, unaudited.

## Method

- A real Safe 1.5.0 proxy (vendored `safe-smart-account`), 2-of-3 owners, the rev 3 engine (`PolicyGuardConfig` +
  `PolicyGuard`) installed as both guard and module guard, the real policies, a USDC-style ERC-20 (`E2eToken`,
  6 decimals). Deployed through `scripts/lib/v2-deployment.ts`, as on Sepolia.
- Numbers are `gasUsed` of the whole `execTransaction` / `execTransactionFromModule` transaction: 21k base, calldata,
  owner signature checks (2 ECDSA), the call itself, the guard hooks, the policies. "vs plain" is the cost of the guard.
- Steady state: each measured transaction follows a warm-up transaction of the same kind, so balances and policy storage
  are already non-zero. The call is `USDC.transfer(vendor, 1)` unless stated. Batches go through MultiSendCallOnly 1.5.0
  (DELEGATECALL).
- Hardhat 2.29.1, solc 0.8.30, viaIR, optimizer 10,000,000 runs, EVM cancun; hardhat enforces the EIP-7825 per-transaction
  gas cap (2^24 = 16,777,216).
- V1 is the vendored `SafePolicyGuard` (71b9cb0) with 8ee68a8's `AllowPolicy` bound as the fallback.
- **Rev 2** is the "Batch B" column of the rev 2 GAS.md (3c6d740), for the closest scenario. Rev 2 rows carried a Freeze
  policy next to every Timelock and Limit; in rev 3 the freeze lives inside the Timelock.

## Results

| Path   | Scenario                                                                |   Rev 3 | vs plain |   Rev 2 | Rev 3 − rev 2 |
| ------ | ----------------------------------------------------------------------- | ------: | -------: | ------: | ------------: |
| owner  | plain Safe, no guard                                                    |  71,431 |          |  71,467 |               |
| owner  | V1 guard, fallback AllowPolicy                                          |  91,834 |  +20,403 |  91,822 |               |
| owner  | V2, Allow `(Owners, *)`                                                 |  87,430 |  +15,999 |  89,302 |        −1,872 |
| owner  | V2, Allow + Timelock 24h with a guardian (execute)                      | 107,367 |  +35,936 | 144,531 |       −37,164 |
| owner  | ↳ `TimelockPolicy.schedule` (its own transaction)                       | 165,886 |          | 159,993 |        +5,893 |
| module | plain Safe, no module guard                                             |  49,452 |          |  49,452 |               |
| module | V1 guard, fallback AllowPolicy                                          |  86,824 |  +37,372 |  86,824 |               |
| module | V2, Allow `(Ops, *)`                                                    |  65,144 |  +15,692 |  66,807 |        −1,663 |
| module | V2 ops payment: Allow + Args recipients + Limit + Timelock(0, guardian) | 124,697 |  +75,245 | 136,217 |       −11,520 |
| module | V2 agent: Allow + CoSigner 1-of-1 (approval consumed)                   |  94,257 |  +44,805 |         |               |
| module | ↳ `CoSignerPolicy.approve` (its own transaction)                        |  50,328 |          |  59,265 |        −8,937 |
| batch5 | plain Safe, owners, 5 transfers                                         |  94,883 |          |  99,671 |      (−4,788) |
| batch5 | plain Safe, module, 5 transfers                                         |  72,694 |          |         |               |
| batch5 | V1, Allow on MultiSend (the 5 sub-calls are not checked at all)         | 113,244 |  +18,361 | 118,044 |      (−4,800) |
| batch5 | V2 owners, Allow `(Owners, *)`                                          | 138,262 |  +43,379 | 143,601 |        −5,339 |
| batch5 | V2 ops payment: Allow + Args + Limit + Timelock(0, guardian)            | 235,434 | +162,740 | 282,629 |       −47,195 |

Measured after the dispatch fix of WP E1 (see [Worst case at the caps](#worst-case-at-the-caps)), which also lowered
every row that runs a policy: the ops payment by ~6k, the 5-call ops batch by ~27k.

The batch "vs plain" figures compare with the plain batch on the same path (owners 94,883, module 72,694). The plain and
V1 batch rows differ from rev 2 by the same 4,788 gas: the vendor's balance is warm here, so that difference is the
set-up, not the engine.

Reading it:

- **One Allow costs ~16k** on either path, ~1.7 to 1.9k less than rev 2, and less than V1's fallback Allow (+20.4k on the
  owner path, +37.4k on the module path, where V1 writes its checking flags to storage).
- **The owners' Timelock is 37k cheaper to execute** than rev 2's Timelock + Freeze pair: one policy, one check, one
  schedule slot. Scheduling costs ~6k more (the schedule stores the matched ids, read through `matches`).
- **An ops payment is +75k** over a plain module transaction (rev 2: +86.6k) with three policies (Args, Limit, Timelock),
  each run once per transaction.
- **A co-signed module transaction is +44.8k**, and the co-signer's own `approve` is 50.3k (rev 2's `cosign` with a
  signature: 59.3k).
- **A 5-call ops batch is ~33k per transfer**, 47k less than rev 2 in all: every policy runs once per transaction with all of
  its matches, instead of once per call.

## Worst case at the caps

Caps (SPEC §2): 8 attachments per scope × 6 levels = **48 matches per call**, **8 calls per batch**. Measured on the module
path with `StoryPassPolicy` (pass-only, no state, so the numbers are the engine's own cost; real policies add theirs):
at every level of every call, 8 attachments, each a distinct policy contract except one ALLOW at level 5. "Identical"
calls are the same call (47 distinct policies, each receiving every call's match); "distinct" calls each go to their own
target and selector, so only `(ANY, *)` and `(Ops, *)` are shared: 264 distinct policies, 384 matches.

| Shape                                           |           Gas | Before the fix (fa5a7ad) | Rev 2 (8 levels × 6) |
| ----------------------------------------------- | ------------: | -----------------------: | -------------------: |
| 1 call, 48 matches (1 ALLOW + 47 policy runs)   |       504,455 |                  958,882 |   497,545 to 567,432 |
| 2 identical calls                               |       832,576 |                2,338,322 |                      |
| 3 identical calls                               |     1,184,043 |                4,134,941 |                      |
| 4 identical calls                               |     1,478,268 |                6,198,618 |                      |
| 8 identical calls                               |     2,782,344 |    does not fit 2^24 gas |            1,584,433 |
| 8 distinct calls (the most work the caps allow) | **7,461,069** |    does not fit 2^24 gas |            5,512,367 |

**Bug found and fixed in WP E1.** On fa5a7ad the worst case did not fit in one transaction: `PolicyGuard._dispatch`
allocated a new zero-filled `Match[](n − s)` and ABI-encoded a new `check` payload (all the calls again) for every
distinct policy, and never reused that memory, so memory expansion grew quadratically with (runs × matches) and 8
calls ran out of the 2^24 cap. The fix (`PolicyGuard._dispatch`, no change to the ABI or the verdicts): the payload is
encoded once with an empty `matches`, which is its last argument and so its tail; each run writes its matches into
that tail in place (one assembly pass over the queued matches) and calls the policy. Memory is now bounded by one
payload plus `n` matches. `PolicyGuard` went from 9,703 to 9,614 bytes. `Gas.test.ts` asserts every shape stays under
16,000,000.

The worst case is now **7.46M gas, 44% of the 2^24 cap** (rev 2: 5.5M at its caps). What is left above linear: each run
still scans the queued matches after its first one (`runs × matches`, ~100k iterations at the caps), and the lookup
costs ~1.7k of computation per match. Both are bounded by the caps; real policies add their own work (a Limit-like
policy ~16k per run with storage), which leaves ~9M of headroom at the most extreme shape.

## Deployable on Sepolia

Measured on Sepolia (reth 2.8): a create costs about **210,000 + 1,542 × runtime bytes** under the EIP-7825 cap of 2^24 per
transaction, so every contract must stay at most 10,000 bytes (`test/v2/engine/Sizes.test.ts` checks it). Deploy order:
`PolicyGuardConfig`, then `PolicyGuard(batches, config)`; `TimelockPolicyQueue`, then `TimelockPolicy(F, C, queue)`; then
the other policies.

| Contract              | Runtime (B) | Sepolia create gas (est.) |
| --------------------- | ----------: | ------------------------: |
| `PolicyGuardConfig`   |       9,038 |                14,146,596 |
| `PolicyGuard`         |       9,614 |                15,034,788 |
| `TimelockPolicyQueue` |       9,295 |                14,542,890 |
| `TimelockPolicy`      |       9,755 |                15,252,210 |
| `ArgsPolicy`          |       5,632 |                 8,894,544 |
| `LimitPolicy`         |       6,544 |                10,300,848 |
| `CoSignerPolicy`      |       5,803 |                 9,158,226 |
| `SafenetPolicy`       |       5,998 |                 9,458,916 |
| **All 8**             |  **61,679** |           **≈ 96.8M gas** |

Rev 2 needed 17 contracts and ≈ 274M gas for two engines plus the shared contracts; rev 3 deploys one engine (two
contracts) and six policy contracts.
