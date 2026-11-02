# Policies

## Policy Engine V2

### How a call is checked

The engine looks up the call at 8 **scopes**, from the widest to the narrowest:

| Who                       | Any call        | Any function of a contract | One function, any contract | One function of a contract  |
| ------------------------- | --------------- | -------------------------- | -------------------------- | --------------------------- |
| Everyone (owners and all) | `(Everyone, *)` | `(Everyone, USDC.*)`       | `(Everyone, *.transfer)`   | `(Everyone, USDC.transfer)` |
| This role                 | `(Role, *)`     | `(Role, USDC.*)`           | `(Role, *.transfer)`       | `(Role, USDC.transfer)`     |

**Every** attachment at every matching scope runs; none overrides another. Each one is a gate
with a verdict:

| Verdict   | From                                             | Means                                         |
| --------- | ------------------------------------------------ | --------------------------------------------- |
| **Allow** | an `Allow` attachment                            | grants the call                               |
| **pass**  | a policy that has no objection                   | does not grant anything; it only did not deny |
| **Deny**  | a `Deny` attachment, a policy, or an engine rule | the call is refused                           |

The call goes through only if **at least one Allow counts and no gate denies**. With no Allow,
the engine denies by default (`NotGranted`). A policy can never grant; it only passes or denies.

When several gates deny, `simulate` names the **deciding** gate: the one a real execution would
revert with (engine rules first, then a `Deny`, then `NotGranted`, then the policies in order,
then the transaction-level policies).

A module calling **the Safe itself** (owners, modules, guards) or **the engine** is granted only by
an Allow on exactly that function for this role (`(Role, Safe.swapOwner)`). A wider Allow shows
as pass with "does not count".

### What each policy checks

| Policy              | Shown as                           | Denies when                                                                  | What you can do                                                                |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Transfer budget** | `Limit 1,000 USDC / day`           | the call spends more than is left in the window, or it cannot price the call | wait for the reset (`safe_role_policies` → `resetsAt`), or the owners raise it |
| **Recipients**      | `Recipients: Alice, Bob`           | the recipient or spender is not on the list; approval above the max          | nothing: owners decide the list                                                |
| **Timelock**        | `Timelock 1h`                      | the call was not scheduled, or the delay has not passed                      | `safe_role_schedule`, wait, then exec                                          |
| **Freeze**          | `Freeze (Safe-wide + actor)`       | the Safe or this role is frozen                                              | nothing: wait, or a guardian lifts it                                          |
| **Co-signer**       | `Co-signer 0x12…ab`                | no co-signature for this exact call                                          | the user asks the co-signer (`next` has the digest to sign)                    |
| **Safenet**         | `Safenet attestation`              | no attestation for this call                                                 | an attestation is submitted, then simulate again                               |
| **Arguments**       | `Arguments: transfer arg 0 in [3]` | an argument is outside the rule                                              | nothing: owners decide                                                         |
| **Quorum**          | `Quorum 3`                         | always, for a module (owner transactions only)                               | nothing                                                                        |
| **Deny**            | `Deny`                             | always                                                                       | nothing                                                                        |

- **Budgets** are per window (`/ day`, `/ month`) on a fixed grid, or `one-time`. A transfer, an
  approval (counted as a reservation), a CoW order (`sellAmount + fee`) and ETH value all spend
  from it. A batch spends the sum.
- **Timelock**: a module's schedule is keyed by its exact call (`callHash`: target, value,
  calldata, operation). Change any byte and it is a different call that needs its own schedule. It
  is consumed when the call executes: the same call again needs a new schedule. A freeze can clear
  schedules (`cleared`); a schedule can expire after its window (`expired`); listed cancellers
  can cancel it. Owners always see it coming (`Scheduled` event).
- **Freeze** is the owners' kill switch: a guardian can freeze the whole Safe or only this role,
  for at most a fixed time; after a lift or the end, a cooldown starts during which it cannot be
  frozen again.
- **Configuration is owners-only** and delayed: a module calling the engine's configuration is
  always denied (`ModuleConfigurationDenied`).

### Reading `safe_role_policies` on V2

- `grants`: the Allow attachments that apply to this role (its own and everyone's). Anything not
  covered is denied.
- `protectionsOnMe`: Deny and policies on this role. `protectionsOnEveryone`: the same for
  everyone, which includes this role.
- `budgets`: per budget and token, `available` of `amount`, `period`, and `resetsAt`.

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
