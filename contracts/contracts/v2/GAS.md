# Policy Engine V2 rev 4: gas on a real Safe 1.5.0

Measured by `test/v2/compare/Gas.test.ts`, which prints these tables. Research prototype, unaudited.

## Method

- A real Safe 1.5.0 proxy (vendored `safe-smart-account`), 2-of-3 owners, the rev 4 engine (`PolicyGuardConfig` +
  `PolicyGuard`) installed as both guard and module guard, the real policies, a USDC-style ERC-20 (`E2eToken`,
  6 decimals). Deployed through `scripts/lib/v2-deployment.ts`, as on Sepolia.
- Numbers are `gasUsed` of the whole `execTransaction` / `execTransactionFromModule` transaction: 21k base, calldata,
  owner signature checks (2 ECDSA), the call itself, the guard hooks, the policies. "vs plain" is the cost of the guard.
- Steady state: each measured transaction follows a warm-up transaction of the same kind, so balances and policy storage
  are already non-zero. The call is `USDC.transfer(vendor, 1)` unless stated. Batches go through MultiSendCallOnly 1.5.0
  (DELEGATECALL).
- Hardhat 2.29.1, solc 0.8.30, viaIR, optimizer **10,000 runs** (rev 3: 10,000,000; see [Optimizer runs](#optimizer-runs)), EVM cancun; hardhat enforces the EIP-7825 per-transaction
  gas cap (2^24 = 16,777,216).
- V1 is the vendored `SafePolicyGuard` (71b9cb0) with 8ee68a8's `AllowPolicy` bound as the fallback.
- **Rev 2** is the "Batch B" column of the rev 2 GAS.md (3c6d740), for the closest scenario. Rev 2 rows carried a Freeze
  policy next to every Timelock and Limit; in rev 3 the freeze lives inside the Timelock.

## Results

| Path   | Scenario                                                                |   Rev 4 | vs plain |   Rev 2 | Rev 4 − rev 2 |
| ------ | ----------------------------------------------------------------------- | ------: | -------: | ------: | ------------: |
| owner  | plain Safe, no guard                                                    |  71,586 |          |  71,467 |               |
| owner  | V1 guard, fallback AllowPolicy                                          |  92,043 |  +20,457 |  91,822 |               |
| owner  | V2, Allow `(Owners, *)`                                                 |  87,633 |  +16,047 |  89,302 |        −1,669 |
| owner  | V2, Allow + Timelock 24h with a guardian (execute)                      | 107,747 |  +36,161 | 144,531 |       −36,784 |
| owner  | ↳ `TimelockPolicy.schedule` (its own transaction)                       | 168,923 |          | 159,993 |        +8,930 |
| config | `configure` (execute, after T): one Allow, no policy touched            | 116,416 |          |         |               |
| config | `configure` (execute, after T): the owners' Timelock re-attached        | 184,508 |  +68,092 |         |               |
| module | plain Safe, no module guard                                             |  49,514 |          |  49,452 |               |
| module | V1 guard, fallback AllowPolicy                                          |  86,910 |  +37,396 |  86,824 |               |
| module | V2, Allow `(Ops, *)`                                                    |  65,251 |  +15,737 |  66,807 |        −1,556 |
| module | V2 ops payment: Allow + Args recipients + Limit + Timelock(0, guardian) | 125,192 |  +75,678 | 136,217 |       −11,025 |
| module | V2 agent: Allow + CoSigner 1-of-1 (approval consumed)                   |  94,450 |  +44,936 |         |               |
| module | ↳ `CoSignerPolicy.approve` (its own transaction)                        |  50,396 |          |  59,265 |        −8,869 |
| batch5 | plain Safe, owners, 5 transfers                                         |  95,026 |          |  99,671 |      (−4,645) |
| batch5 | plain Safe, module, 5 transfers                                         |  72,768 |          |         |               |
| batch5 | V1, Allow on MultiSend (the 5 sub-calls are not checked at all)         | 113,465 |  +18,439 | 118,044 |      (−4,579) |
| batch5 | V2 owners, Allow `(Owners, *)`                                          | 138,501 |  +43,475 | 143,601 |        −5,100 |
| batch5 | V2 ops payment: Allow + Args + Limit + Timelock(0, guardian)            | 237,272 | +164,504 | 282,629 |       −45,357 |

The `config` rows are new in rev 4: the "vs plain" of the second is its cost over the first, i.e. the Timelock's own
`configure` (its settings rewritten, the guardian list included) plus `validate`, which reads `getAttachments` once and
checks the seven routes in memory. It is paid once per `configure` that touches the Timelock, never on a guarded
transaction. The ops payment is ~500 gas above rev 3 (one more Recipients constraint, `VALUE_TO`, and 10,000 runs);
every other row moves by the optimizer setting only (within 0.3 %).

Measured after the dispatch fix of WP E1 (see [Worst case at the caps](#worst-case-at-the-caps)), which also lowered
every row that runs a policy: the ops payment by ~6k, the 5-call ops batch by ~27k.

The batch "vs plain" figures compare with the plain batch on the same path (owners 95,026, module 72,768). The plain and
V1 batch rows differ from rev 2 by about the same 4,600 gas: the vendor's balance is warm here, so that difference is the
set-up, not the engine.

Reading it:

- **One Allow costs ~16k** on either path, ~1.7 to 1.9k less than rev 2, and less than V1's fallback Allow (+20.4k on the
  owner path, +37.4k on the module path, where V1 writes its checking flags to storage).
- **The owners' Timelock is 37k cheaper to execute** than rev 2's Timelock + Freeze pair: one policy, one check, one
  schedule slot. Scheduling costs ~9k more (the schedule stores the matched ids, read through `matches`).
- **An ops payment is +75k** over a plain module transaction (rev 2: +86.6k) with three policies (Args, Limit, Timelock),
  each run once per transaction.
- **A co-signed module transaction is +44.9k**, and the co-signer's own `approve` is 50.4k (rev 2's `cosign` with a
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
| 1 call, 48 matches (1 ALLOW + 47 policy runs)   |       505,785 |                  958,882 |   497,545 to 567,432 |
| 2 identical calls                               |       834,074 |                2,338,322 |                      |
| 3 identical calls                               |     1,185,709 |                4,134,941 |                      |
| 4 identical calls                               |     1,480,090 |                6,198,618 |                      |
| 8 identical calls                               |     2,784,802 |    does not fit 2^24 gas |            1,584,433 |
| 8 distinct calls (the most work the caps allow) | **7,468,301** |    does not fit 2^24 gas |            5,512,367 |

**Bug found and fixed in WP E1.** On fa5a7ad the worst case did not fit in one transaction: `PolicyGuard._dispatch`
allocated a new zero-filled `Match[](n − s)` and ABI-encoded a new `check` payload (all the calls again) for every
distinct policy, and never reused that memory, so memory expansion grew quadratically with (runs × matches) and 8
calls ran out of the 2^24 cap. The fix (`PolicyGuard._dispatch`, no change to the ABI or the verdicts): the payload is
encoded once with an empty `matches`, which is its last argument and so its tail; each run writes its matches into
that tail in place (one assembly pass over the queued matches) and calls the policy. Memory is now bounded by one
payload plus `n` matches. `PolicyGuard` went from 9,703 to 9,614 bytes. `Gas.test.ts` asserts every shape stays under
16,000,000.

The worst case is now **7.47M gas, 45% of the 2^24 cap** (rev 2: 5.5M at its caps). What is left above linear: each run
still scans the queued matches after its first one (`runs × matches`, ~100k iterations at the caps), and the lookup
costs ~1.7k of computation per match. Both are bounded by the caps; real policies add their own work (a Limit-like
policy ~16k per run with storage), which leaves ~9M of headroom at the most extreme shape.

## Deployable on Sepolia

Measured on Sepolia (reth 2.8): a create costs about **210,000 + 1,542 × runtime bytes** under the EIP-7825 cap of 2^24 per
transaction, so every contract must stay at most 10,000 bytes (`test/v2/engine/Sizes.test.ts` checks it). Deploy order
(`scripts/deploy-v2.ts`, one create per transaction): `PolicyGuardConfig`, then `PolicyGuard(batches, config)`;
`TimelockPolicyQueue`, `TimelockPolicyFreeze(F, C)`, then `TimelockPolicy(F, C, queue, freezer)`; then the other
policies. Sizes at 10,000 runs:

| Contract               | Runtime (B) | Sepolia create gas (est.) |
| ---------------------- | ----------: | ------------------------: |
| `PolicyGuardConfig`    |       8,082 |                12,672,444 |
| `PolicyGuard`          |       8,984 |                14,063,328 |
| `TimelockPolicyQueue`  |       8,827 |                13,821,234 |
| `TimelockPolicyFreeze` |       7,649 |                11,804,758 |
| `TimelockPolicy`       |       7,557 |                11,862,894 |
| `ArgsPolicy`           |       5,596 |                 8,839,032 |
| `LimitPolicy`          |       6,390 |                10,063,380 |
| `CoSignerPolicy`       |       5,639 |                 8,905,338 |
| `SafenetPolicy`        |       5,811 |                 9,170,562 |
| **All 9**              |  **64,535** |          **≈ 101.4M gas** |

The largest, `PolicyGuard`, keeps 1,016 B of margin. `TimelockPolicyFreeze` grew from 3,717 B with the covering rule
(`validate` decodes `getAttachments`: in `TimelockPolicy` itself it would not fit). Rev 2 needed 17 contracts and ≈ 274M
gas for two engines plus the shared contracts; rev 4 deploys one engine (two contracts) and seven policy contracts.

## Optimizer runs

Rev 4 compiles with 10,000 runs instead of 10,000,000. Measured with the rev 3 contracts (`Sizes.test.ts`,
`Gas.test.ts`; gas columns are "vs plain" where the table above uses it):

| runs       | Config | Guard | Queue | Freeze | Timelock |  Args | Limit | CoSigner | Safenet | owner Allow | TL execute | schedule | ops payment | batch5 ops | worst case |
| ---------- | -----: | ----: | ----: | -----: | -------: | ----: | ----: | -------: | ------: | ----------: | ---------: | -------: | ----------: | ---------: | ---------: |
| 200        |  6,426 | 7,075 | 7,625 |  2,751 |    6,807 | 4,313 | 4,758 |    4,405 |   4,175 |     +16,379 |    +36,937 |  169,862 |     +76,938 |    242,377 |  8,094,794 |
| 1,000      |  6,825 | 7,924 | 8,019 |  3,049 |    7,292 | 4,550 | 5,158 |    4,679 |   4,734 |     +16,212 |    +36,507 |  169,194 |     +76,265 |    240,476 |  8,094,088 |
| **10,000** |  7,423 | 8,984 | 8,827 |  3,717 |    7,517 | 5,522 | 6,352 |    5,353 |   5,773 |     +16,035 |    +36,226 |  168,913 |     +75,504 |    236,594 |  7,462,505 |
| 10,000,000 |  9,038 | 9,614 | 9,786 |  3,717 |    8,801 | 5,702 | 6,562 |    5,803 |   6,103 |     +15,951 |    +35,968 |  168,328 |     +75,387 |    236,235 |  7,461,081 |

10,000 runs costs within 0.3 % of 10,000,000 on every row and the same at the worst case, and frees 630 B on the guard,
1,600 B on the config, 960 B on the queue and 1,280 B on the Timelock: the room the rev 4 fixes needed. 1,000 runs costs
1 to 2 % on hot paths and 8.5 % at the caps. No split folds back at 10,000 runs (Freeze + Timelock would be ~15 KB).
