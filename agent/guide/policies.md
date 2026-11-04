# Policies

## Policy Engine V2 (rev 3)

### How a call is checked

The engine looks the call up at 6 **scopes**:

| Who                       | Any call         | Any function of a contract | One function of a contract   |
| ------------------------- | ---------------- | -------------------------- | ---------------------------- |
| Everyone (owners and all) | `(Everyone, *)`  | `(Everyone, USDC.*)`       | `(Everyone, USDC.transfer)`  |
| This role                 | `(This role, *)` | `(This role, USDC.*)`      | `(This role, USDC.transfer)` |

**Every** attachment at every matching scope applies; none overrides another. There are three
kinds:

| Kind       | Verdict                    | Means                                                         |
| ---------- | -------------------------- | ------------------------------------------------------------- |
| **Allow**  | `allow` (or `not counted`) | grants the call. Only an Allow grants; Allows name this role. |
| **Deny**   | `deny`                     | the owners refuse this call                                   |
| **Policy** | `pass`, or `deny` + reason | a rule (Timelock, budget, conditions, co-signer, Safenet)     |

The call goes through only if **an Allow counts, no Deny matches and every policy passes**. With
no Allow the engine denies by default (`NotGranted`). A policy never grants: it passes or reverts
with a reason. Order of a real execution: engine rules, then `Deny`, then `NotGranted`, then each
policy once, in the order it first matched; `simulate` names that first failure as the **deciding**
gate but runs every policy, so you see all reasons at once. A policy that stopped at its first
failure shows its other attachments as `not reached`.

A module calling **the Safe itself** or **the engine**, or any DELEGATECALL, is granted only by an
Allow on exactly that function for this role (`(This role, Safe.swapOwner)`). A wider Allow shows
as `not counted`. Modules can never configure the engine unless the owners allowed exactly that.

### What each policy checks

| Policy              | Denies with                                                       | What you can do                                                                 |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Timelock**        | not scheduled, not ready yet, expired, voided by a freeze, frozen | schedule (`safe_role_schedule`), wait, exec in the window; frozen: wait or lift |
| **Transfer budget** | over budget (requested vs left), or a call it cannot price        | wait for the reset (`resetsAt`), or the owners raise it. Never split the amount |
| **Conditions**      | a condition on the recipient, spender, amount, target or value    | nothing: the owners decide. Never change the arguments to fit                   |
| **Co-signer**       | needs M approvals of the call's hash, has N                       | the user asks an approver (`next` has the hash and the digest)                  |
| **Safenet**         | no attestation for the call                                       | an attestation is submitted (`next` has the digest), then simulate again        |
| **Deny**            | always                                                            | nothing                                                                         |

- **Timelock**: a module's schedule is keyed by its exact call (the `callHash`: target, value,
  calldata, operation). Change any byte and it is another call. A schedule is consumed when the call
  executes. It becomes ready `delay` after it was made (or after the last re-configuration), and with
  a window it expires `window` after that; a new schedule replaces an expired or voided one. The
  owners see every schedule (`Scheduled` event); the scheduling module and listed cancellers can
  cancel it.
- **Freeze** lives in the Timelock, per attachment: a guardian freezes an attachment for a fixed
  time (every call it matches is denied, and schedules made before are void); a guardian or lifter
  can lift it early; after a freeze a cooldown starts during which it cannot be frozen again. A
  Timelock with delay 0 is a kill switch only.
- **Budgets** run on a fixed grid (`1d`, `30d`) or are one-time. A transfer, an approval (counted
  in full), a `transferFrom` from the Safe and ETH value spend from them; revocations are free. A
  call the budget cannot price is denied unless the owners allowed unpriced calls.
- **Co-signer** approvals are pushed on-chain before execution (`approve` by the approver, or a
  signed approval relayed by anyone), expire at `validUntil`, and are consumed by one execution.

### Reading `safe_role_policies` on V2

- `canDo`: this role's Allows, each with its `conditions` (Args). Anything not covered is denied.
- `budgets`: per budget and token, `available` of `amount`, `period`, `resetsAt`.
- `protections`: Timelock (delay, window, guardians, lifters, cancellers, freeze state), Co-signer
  (M of N approvers), Safenet, Deny.
- `freeze`: the state of every Timelock attachment (`active`, `frozen until`, `cooling down until`)
  and whether it applies to this role.
- `duties`: where this key is itself a guardian, lifter, canceller or approver, and the command.

## V1 SafePolicyGuard (older Safes)

The guard picks ONE policy per access selector `(target, function selector, operation)`. If
there's no exact match, it falls back to the operation-only entry. With neither, the call is
denied. Policies apply to every module and to owners alike: they are per Safe, not per role.

| Policy               | What it checks                                                                        | What it does NOT check                                          |
| -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| AllowPolicy          | nothing: the call is allowed for anyone                                               | any argument                                                    |
| DenyPolicy           | always denies                                                                         | —                                                               |
| AllowedModulePolicy  | the caller is an allowlisted module (one list per Safe)                               | any argument: recipients, amounts, swap outputs                 |
| ERC20TransferPolicy  | the `transfer` recipient is on the token's allowlist (`always`, or `once` then spent) | the amount                                                      |
| ERC20ApprovePolicy   | the `approve` spender is on the token's allowlist; revoking (0) is always allowed     | the amount                                                      |
| NativeTransferPolicy | a plain ETH send (empty calldata) to that target                                      | the amount                                                      |
| MultiSendPolicy      | a MultiSend batch, each inner call checked against its own policy                     | —                                                               |
| CoSignerPolicy       | a co-signature in the transaction context                                             | the module path carries no context, so it always denies modules |

Gaps to mention when relevant on V1:

- **No amount caps.** Once a recipient is allowed, any amount can go to them.
- **AllowedModulePolicy is a blank cheque for that function.** For example, CoW
  `setPreSignature` can sign an order with any receiver and any price. `swap` plans pay the
  Safe, but the policy itself doesn't enforce it.
- **Changes are delayed.** New policies go through `requestConfiguration` → guard delay →
  `applyConfiguration` by the owners. `safe_role_policies` only shows applied ones; pending
  requests are visible in the Safe App.
- `safe_role_policies` rebuilds the V1 list from guard events over the last ~4 weeks. If the Safe
  was configured earlier, pass `fromBlock`.
