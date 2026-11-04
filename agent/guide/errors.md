# Errors → meaning → what to do

## Policy Engine V2 (rev 3): why a call was denied

`safe_role_simulate` returns every gate per (call, scope, policy) with `allow`, `pass`, `deny`
(and the decoded reason), the `deciding` one, `needs` (what you may satisfy), `blocked` (something
only the owners or time can change) and `next`. Every policy either passes or reverts with one of
these reasons:

| Gate → reason                                                 | Meaning                                          | Next step                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Engine: NotGranted` → "no Allow for this role covers …"      | No Allow for this call                           | Stop. Tell the user which Allow the owners would add (scope and function).                      |
| `Engine: Denied` → "a Deny matches …"                         | The owners deny it explicitly                    | Stop.                                                                                           |
| `Engine: GuardTargetDenied`                                   | A call to the engine                             | Configuration is the owners', in the Safe App.                                                  |
| `Allow` → `not counted`                                       | Calls to the Safe or engine need an exact Allow  | Stop.                                                                                           |
| `Timelock` → "needs to be scheduled first"                    | Not scheduled (`needs: schedule`)                | With the user's go-ahead: `safe_role_schedule {id}`, then wait the delay.                       |
| `Timelock` → "scheduled; executable from T"                   | The delay is running (`needs: wait`)             | Wait until T (`safe_role_queue` has the countdown), then simulate and exec.                     |
| `Timelock` → "the schedule expired at T"                      | It was not executed within the window            | Schedule again (it replaces the expired one), wait, exec within the window.                     |
| `Timelock` → "the schedule was voided by a freeze"            | A freeze happened after it was scheduled         | Once not frozen, schedule again (it replaces the void one).                                     |
| `Timelock` → "frozen until T"                                 | A guardian froze this attachment                 | Stop. Nothing to retry until T, or a guardian/lifter lifts it (`next` names them).              |
| `Transfer budget` → "over budget: X requested, Y left"        | The window's budget is used                      | Stop. Say when it resets (`next`); one-time budgets never reset. Never split the amount.        |
| `Transfer budget` → "cannot price" / "no budget for"          | Not a known spend, or a token without a budget   | Stop. The owners decide.                                                                        |
| `Conditions` → "breaks condition N" / "no condition covers …" | An argument, target or value is outside the rule | Stop. `next` quotes the condition. Never pick another recipient on your own.                    |
| `Co-signer` → "needs M approval(s), has N"                    | Approvals of this call's hash are missing        | Tell the user: `next` has the hash, the approvers and the digest. Simulate again once approved. |
| `Safenet` → "needs a Safenet attestation" / "expired"         | No (valid) attestation for this call             | Tell the user; `next` has the digest. Simulate again once submitted.                            |
| `execution.reason` with every gate passing (`GS013` …)        | The call itself fails (balance …)                | Check `safe_role_balances`.                                                                     |

Errors of the V2 actions (`schedule`, `cancel`, `approve`, `freeze`, `lift`):

| Error                                                     | Meaning                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `No Timelock applies to this call` / `No schedule needed` | Nothing to schedule; simulate says what decides, or exec it             |
| `Already scheduled and waiting for its delay`             | See `safe_role_queue`                                                   |
| `Frozen: a schedule made now would be void`               | Wait for the freeze to end                                              |
| `Scheduling would not help: …`                            | Something else denies it (no Allow, conditions …): explain and stop     |
| `This role neither made this schedule nor is a canceller` | Only the scheduling module or a listed canceller can cancel             |
| `This role is not an approver …` / `not a guardian of …`  | This key has no such duty (`safe_role_policies` → `duties`)             |
| `Every target is already frozen or cooling down`          | A freeze would be skipped: no extension, by design                      |
| `Nothing frozen that this role can lift`                  | Nothing to do                                                           |
| `Policy Engine V2 rev 3 is not deployed …`                | The CLI has no rev 3 addresses: the user sets `SAFE_ROLE_V2_DEPLOYMENT` |

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
