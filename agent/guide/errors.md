# Errors → meaning → what to do

## Policy Engine V2: why a call was denied

`safe_role_simulate` lists every gate and names the `deciding` one; `next` says what to do. The
deciding gate's reason is one of these:

| Deciding gate → reason                                            | Meaning                                                      | Next step                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `Engine: NotGranted` → "No Allow covers …: denied by default"     | No Allow for this role on this call                          | Stop. Tell the user which Allow the owners would need (scope and function).                             |
| `Deny`                                                            | The owners denied this explicitly                            | Stop.                                                                                                   |
| `Timelock …` → "Needs to be scheduled first"                      | A Timelock applies and the call is not scheduled             | With the user's go-ahead: `safe_role_schedule {id}`, then wait.                                         |
| `Timelock …` → "Scheduled, executable from …"                     | Scheduled, the delay is still running                        | Wait. `safe_role_queue` shows the countdown; then simulate and exec.                                    |
| `Timelock …` → "The schedule was cleared by a freeze"             | A freeze voided the schedule                                 | Once not frozen (`safe_role_status`), schedule again.                                                   |
| `Timelock …` → "The schedule expired …"                           | Ready too long ago (the Timelock has an execution window)    | It cannot be rescheduled until a canceller cancels it. Tell the user.                                   |
| `Limit …` → "Over budget: X requested, Y left"                    | The transfer budget for this window is used up               | Stop. Say when it resets (`next`, or `safe_role_policies` → `resetsAt`). Never split the amount to fit. |
| `Limit …` → "The budget cannot price …" / "No budget for token …" | The budget only allows calls it can price, in its tokens     | Stop. Owners decide.                                                                                    |
| `Recipients …` → "Recipient/Spender … is not on the list"         | The counterparty is not allowed                              | Stop. Never pick another recipient on your own.                                                         |
| `Recipients …` → "Approval … above the maximum"                   | Approval too large                                           | Stop, or ask the user for an amount within the max.                                                     |
| `Freeze …` → "Frozen until …"                                     | The Safe or this role is frozen (kill switch)                | Stop. Nothing to retry until it ends or a guardian lifts it.                                            |
| `Co-signer …` → "Needs a co-signature from …"                     | A co-signer must approve this exact call                     | Tell the user; `next` has the digest the co-signer signs and how it is relayed. Then simulate again.    |
| `Safenet …` → "Needs a Safenet attestation"                       | An attestation for this call is missing                      | Tell the user; simulate again once submitted.                                                           |
| `Quorum …` → "Quorum only applies to owner transactions"          | Quorum always denies modules                                 | Stop.                                                                                                   |
| `Arguments …` → "argument N not allowed"                          | An argument is outside the owners' rule                      | Stop.                                                                                                   |
| `Engine: AllowNotExact` (pass, "does not count")                  | A module calling the Safe or the engine needs an exact Allow | Stop.                                                                                                   |
| `Engine: ModuleConfigurationDenied` / `GuardTargetDenied`         | Modules can never configure the engine                       | Configuration is for owners, in the Safe App.                                                           |
| `ModuleExecutionFailed` / `GS013` in `execution.reason`           | Every gate passed, but the call itself reverts (balance…)    | Check `safe_role_balances`.                                                                             |

Schedule errors (`safe_role_schedule`):

| Error                                                                 | Meaning                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `No Timelock applies to this call`                                    | Nothing to schedule; simulate says what decides                                |
| `No schedule needed: the call is allowed now`                         | Exec it instead                                                                |
| `Scheduling would not help: …`                                        | Another gate denies (budget, recipient, freeze, no Allow): explain it and stop |
| `Already scheduled (waiting / ready / expired)`                       | See `safe_role_queue`                                                          |
| `Frozen: a schedule made now would be cleared`                        | Wait for the freeze to end                                                     |
| `Policy Engine V2 is not deployed` / `no V2 addresses are configured` | The CLI lacks V2 addresses: the user sets `SAFE_ROLE_V2_DEPLOYMENT`            |

## V1 SafePolicyGuard

| Error (in `error` or a simulation `reason`)                                                           | Meaning                                              | Next step                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `AccessDenied: no policy configured for this access selector`                                         | Default deny: no policy for this target and function | Tell the user which policy an owner would need to add (topic `policies`). Stop.    |
| `AccessDenied by <Policy>`                                                                            | A policy exists and said no                          | Explain that policy's rule, e.g. recipient not allowlisted. Stop.                  |
| `PolicyReverted by <Policy> → InvalidTransfer / InvalidApproval / UnauthorizedModule / InvalidModule` | The policy rejected the arguments or the caller      | Same as above; `once` grants may already be spent (`safe_role_policies` shows it). |
| `ModuleConfigurationDenied`                                                                           | Modules cannot configure the guard                   | Configuration is for owners, in the Safe App.                                      |

## Both engines

| Error                                                               | Meaning                                                                 | Next step                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GS104: Method can only be called from an enabled module`           | The role is not a module of this Safe                                   | An owner enables it (Safe App → Roles). Nothing to retry.                             |
| `GS013: Safe transaction failed`                                    | The inner call reverted, e.g. a token transfer above the Safe's balance | Check `safe_role_balances`.                                                           |
| `Signer refused: declined by the user` / `not approved by the user` | The user said no, or didn't answer in the signer terminal within 2 min  | Ask the user; don't retry on your own.                                                |
| `Signer refused: simulation failed: ...`                            | The policies deny it (checked again just before signing)                | Explain the denial, as above.                                                         |
| `The signer is not running`                                         | No signer process                                                       | Ask the user to run `safe-role signer` in a terminal and unlock it.                   |
| `Cannot reach the RPC`                                              | Network                                                                 | Ask the user to check their connection or the `rpcUrl` in `~/.safe-role/config.json`. |
| `No configuration at ...`                                           | Not set up                                                              | The user runs `safe-role init` in a terminal.                                         |
| `Plan file was modified` / `plan hash does not match`               | A plan was changed after creation                                       | Make a new plan.                                                                      |
| `No CoW quote: ... NoLiquidity`                                     | No route on Sepolia for that pair or size                               | Suggest a larger amount (around 20 USDC) or another pair.                             |
| `the attached CoW order does not match the pre-signed UID`          | The order shown is not the one being signed                             | Plan the swap again.                                                                  |
| `CoW rejected the order: ...`                                       | The order book refused it (quote moved, balance…)                       | Plan the swap again; check `safe_role_balances`.                                      |
| `Not enough Sepolia ETH to pay for gas`                             | The role EOA has no gas                                                 | The user sends a little Sepolia ETH to the role address (`safe_role_status`).         |
