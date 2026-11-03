# Policy Engine V1 vs V2: what changes, proven on-chain

Each row runs the same scenario on two real Safes 1.5.0 from the same infrastructure: one guarded by the vendored V1
`SafePolicyGuard` (71b9cb0), one by `SafePolicyGuardV2` with the V2 policies. Source:
`test/v2/compare/V1vsV2.test.ts` (WP7); each test is named `<scenario>: V1 <outcome>, V2 <outcome>`.

V1 policies used: the vendored `ERC20TransferPolicy`, the repo's `SpendingLimitPolicy`, and
`contracts/v2/test/E2eV1Policies.sol`: 8ee68a8's `AllowPolicy` / `DenyPolicy`, a port of 8ee68a8's `CoSignerPolicy`
(same `ModulePathUnsupported` on modules as 8ee68a8's `SafenetPolicy`), and a stand-in timelock (neither V1 commit has
one; it behaves as the "fallback timelock" of WA-4014).

| Design doc row                                  | Scenario                                                                      | V1                                                                               | V2                                                                    | Test (`V1 vs V2 …`)                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| §1.1 a narrow rule hides the fallback (WA-4014) | Owners' fallback is a 24h timelock; an exact Allow exists for `Safe.setGuard` | `setGuard(0)` executes at once                                                   | Delayed: `NotScheduled` (the Timelock at `(Owners, *)` still runs)    | `setGuard(0) under an exact Allow rule: V1 executes at once, V2 delayed (NotScheduled)`                                   |
| §1.1                                            | Same, with an exact Allow for `addOwnerWithThreshold`                         | The attacker is added as owner at once                                           | Delayed: `NotScheduled`                                               | `addOwnerWithThreshold under an exact Allow rule: V1 executes at once, V2 delayed (NotScheduled)`                         |
| §1.1 (control)                                  | A payment with no rule of its own                                             | Delayed (fallback timelock `NotScheduled`)                                       | Delayed (`NotScheduled`)                                              | `a payment with no rule of its own: V1 delayed (fallback timelock), V2 delayed (NotScheduled)`                            |
| §1.2 one rule table for every caller (WA-4016)  | A USDC payment allowlist; the recovery module calls `swapOwner`               | Denied: `AccessDenied(0)` (no rule for `swapOwner`, no fallback)                 | Executes after recovery's 72h timelock                                | `recovery's swapOwner next to a payment allowlist: V1 denied (AccessDenied), V2 executes after R`                         |
| §1.2                                            | Grant `swapOwner` to the recovery module                                      | The rule grants every module: Ops replaces an owner with the attacker            | Only recovery: Ops gets `NotGranted`                                  | `granting recovery's swapOwner: V1 grants every module (ops swaps owners), V2 only recovery (NotGranted)`                 |
| §1.3 Co-signer / Safenet: multisig path only    | A global Co-signer; the recovery module's `swapOwner`                         | Reverts `ModulePathUnsupported`: every module is bricked, recovery included      | Executes with a pushed co-signature (`cosign`, consumed by the check) | `a global Co-signer and a module transaction: V1 reverts (ModulePathUnsupported), V2 executes with a pushed co-signature` |
| §1.4 a freeze cannot cover configuration        | Everything denied by a fallback Deny; a malicious configuration was requested | Applied after DELAY (configuration skips every policy), then the Safe is drained | `ConfigFrozen`: the guardian's freeze blocks `applyConfiguration`     | `a pending malicious configuration under a deny-everything fallback: V1 applies it, V2 ConfigFrozen`                      |
| §1.4 configuration delayed both ways            | Stop the Safe now                                                             | A new Deny rule waits DELAY (`RootConfigurationPending`); payments still go out  | The guardian freezes at once; the next owner transaction is `Frozen`  | `stopping the Safe: V1 a new deny rule waits DELAY (RootConfigurationPending), V2 the guardian freezes at once`           |
| §1.5 the guard conflicts with modules           | Owners' USDC allowlist (vendor A); a spending module pays its own payee (B)   | Denied (`Unauthorized`): the owners' allowlist overrides the module              | Executes: Ops has its own Recipients + Limit                          | `a spending module paying its own payee next to the owners' allowlist: V1 denied, V2 executes (per actor)`                |
| §1.6 limits only cover transfers                | 5,000 USDC/month transfer limit; `approve(attacker, 100,000)`                 | Executes; the attacker pulls 100,000                                             | `LimitExceeded` (approval priced as a reservation)                    | `approve(attacker, 100,000) under a 5,000 limit: V1 executes (unlimited allowance), V2 LimitExceeded`                     |
| §1.6                                            | Same; send 10 ETH                                                             | Executes                                                                         | `LimitExceeded` (native value counted)                                | `10 ETH sent under a token limit: V1 executes, V2 LimitExceeded (native value counted)`                                   |
| §4 batches                                      | Transfer limit + an Allow on MultiSend; a batch of two 50,000 transfers       | Executes: 71b9cb0 does not look inside a batch; the Safe is drained              | `LimitExceeded` at sub-call 0 (every sub-call is checked)             | `transfers inside a MultiSend: V1 (71b9cb0) lets an allowed batch through unchecked, V2 checks every sub-call`            |
| §7 gap 1 ERC-1271 bypasses the guard            | Owners sign a USDC permit off-chain (off-chain permit attack)                 | `isValidSignature` valid → permit + `transferFrom` drain, no guard call          | `0xffffffff`: `PolicyFallbackHandler` accepts only on-chain approvals | `an off-chain owner signature on a permit (off-chain permit attack): V1 valid (drain), V2 INVALID`                        |

Not testable on-chain: the §1.5 half about Safe's AllowanceModule (not vendored; approximated by a module with its own
payee above), and the UI / indexer rows.

## Also proven end to end (V2 only)

`test/v2/e2e/*.test.ts` runs the stories on the real engine and a real Safe 1.5.0:

| File                     | Story                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `OrgChart.test.ts`       | The §3 example organisation: Owners, Ops, Agent, Recovery, Guardian, happy and deny paths         |
| `WA4014.test.ts`         | Owners cannot skip their timelock (guard, module guard, handler, owners, configuration path, F5)  |
| `WA4016.test.ts`         | A payment allowlist (everyone / call-wide / one actor, strict) never blocks recovery              |
| `Compromise.test.ts`     | Owner keys, guardian and recovery key compromised: T < R < F, guardian removed by configuration   |
| `Spark.test.ts`          | Another Safe cancels a queued transaction (owners' and a module's); rising owner cancel threshold |
| `Proofs.test.ts`         | Co-signer + Safenet (real FROST) on both paths; one proof per batch; consumed on the module path  |
| `LimitBatch.test.ts`     | Limit across a MultiSend; approval reservation and give-back; the batch refill attack is denied   |
| `OffchainPermit.test.ts` | Off-chain permit attack on V1 (drain) and V2 (denied); signing through PolicySignLib is priced    |
| `Install.test.ts`        | The app's `installCalls` batch works on Safe 1.5.0 (order matters)                                |
| `Preview.test.ts`        | `preview`'s deciding gate (app decoder `src/lib/v2/preview.ts`) equals the real check's revert    |
| `QuorumTiers.test.ts`    | Approval tiers: 3 of 3 signatures above 10,000 USDC, summed over a batch; owner path only         |
