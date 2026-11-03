# TimelockPolicy: delay, freeze, cancel

Source: `policies/TimelockPolicy.sol`, `policies/TimelockPolicyQueue.sol` (schedule, cancel) and
`policies/TimelockPolicyFreeze.sol` (freeze, lift), both reached by DELEGATECALL from the policy's address; interface
`interfaces/policies/ITimelockPolicy.sol`, SPEC §5.1. Research prototype, unaudited. Deployment: the queue, then the
freeze module `TimelockPolicyFreeze(F, C)`, then `TimelockPolicy(F, C, queue, freezer)` (it checks the freezer's F and
C match).

## What it does

A transaction matched by a Timelock attachment runs only if it was scheduled on-chain at least `delay` before. The
same attachment can be frozen by its guardians, each guardian for at most F per F + C, lifted early by its guardians
or lifters, and a schedule can be cancelled by its cancellers, by the module that made it, or by the owners. One policy, three jobs:

| Settings | Use |
| --- | --- |
| `delay > 0`, guardians | The owners' timelock T with a guardian (template "Owners") |
| `delay = 0`, guardians | A kill switch: nothing waits, the guardian can stop the actor at once (Ops, Agent) |
| `delay = R`, no guardians, a window | Recovery's delay: nobody can freeze it |
| narrow scope, cancellers | Spark: another Safe can cancel queued calls to one contract |

## Settings

`abi.encode(Settings)`, one per attachment, fully replaced by each `configure`.

| Field | Meaning | Rule |
| --- | --- | --- |
| `delay` (uint32, s) | Wait between schedule and execution; 0 = kill switch only | |
| `window` (uint32, s) | How long a matured schedule stays executable; 0 = forever | ignored at `delay = 0` |
| `guardians` | May freeze and lift this attachment | at most 8, none at actor `ANY` |
| `lifters` | May lift only (for example the recovery module) | at most 8, none at actor `ANY` |
| `cancellers` | May cancel a schedule this attachment matched | at most 8 |

No zero address, no duplicate, never the Safe itself (`InvalidSettings`). Immutables of the deployment: `MAX_FREEZE`
(F, 7 days) and `COOLDOWN` (C, 12 hours).

Configuration invariant: a delay at actor `OWNERS` or `ANY` needs an attached Timelock of this policy at `(actor, *)`
or `(ANY, *)`, at least as long, with CALL in its op mask (the new attachment counts when it is that one). Otherwise
`configure` reverts `TimelockNotCoveringConfiguration`. A cover at `engine.*` or `engine.configure` does not count:
it would not delay `setGuard(0)` or `setModuleGuard(0)`, which remove the whole engine. So the owners can never remove
a delay faster than the delay itself, and a narrow owners' delay always sits under an owners-wide one at least as long.
Module attachments are exempt: the owners remove them through their own delay. Order matters inside one `configure`:
attach the `(actor, *)` cover before the narrow one.

## Who calls what, and when

| Function | Who | When |
| --- | --- | --- |
| `schedule(engine, safe, safeTx, signatures)` | anyone relaying the owners' threshold signatures over the Safe transaction | before an owner transaction; the nonce is part of the hash, so schedule at a future nonce when other transactions come first |
| `scheduleModuleTx(engine, safe, to, value, data, op)` | the module itself | before its own call |
| `cancel(engine, safe, txHash)` | a canceller of a matched attachment (never on a configuration change), or the module that scheduled it | any time before execution |
| `cancelAsOwners(engine, safe, txHash, signatures)` | anyone relaying `threshold` owner signatures over `cancelDigest` | owner-path schedules only (`NotOwnersQueue` for a module's) |
| `freeze(engine, safe, ids[])` | a guardian of every listed id | frozen until the end of the guardian's window (F from its first freeze); frozen or cooling ids, and every id while the guardian cools down, are skipped (`FreezeSkipped`), never extended |
| `lift(engine, safe, id)` | a guardian or lifter of the id | ends the freeze, starts the id's cooldown C; the guardian that froze it, if left with nothing frozen, starts its own cooldown |
| `check` | the engine | during the guarded transaction; consumes the schedule |

## The check (merge over every matched attachment)

1. Frozen if any matched attachment is frozen: `AttachmentFrozen`, even at delay 0.
2. Delay = the longest; 0 passes.
3. A schedule by the same actor must exist (`NotScheduled`); it is ready at `max(scheduledAt, configuredAt) + delay`
   (`NotReady`): re-configuring an attachment restarts the wait.
4. Window = the shortest non-zero one among attachments with a delay (a kill switch's window is ignored); after it the
   schedule is expired (`ScheduleExpired`) and may be replaced.
5. A schedule made before the end of any matched attachment's last freeze is void (`VoidedByFreeze`), unless it is a
   configuration change (a top-level CALL to `engine.configure`): that is the owners' way out of a rogue guardian.
6. On pass the schedule is deleted and `Executed` is emitted.

State of one attachment: `ACTIVE -> FROZEN -> COOLDOWN (C) -> ACTIVE`; `lift` jumps to COOLDOWN.

## Cancel is final on the owner path

An owner-path schedule carries the owners' signatures over the Safe transaction hash in public calldata, and those
are the signatures `execTransaction` accepts. So a cancel (by `cancelAsOwners` or by a canceller) retires the hash for
good: `schedule` reverts `CancelledTransaction`, `isCancelled` returns true. The hash binds the nonce, so this never
blocks a new transaction: the owners sign another one at the same nonce. A module-path hash has no nonce and is not
retired: a cancel resets the clock, and the module may schedule the same call again; to stop a module for good,
freeze its attachment or detach it.

A configuration change (`isConfiguration`) is the owners' way out, so a listed canceller can never cancel it (only
`cancelAsOwners`, or the module that scheduled it). A canceller on `(Owners, *)` therefore vetoes payments one by one,
never the `configure` that removes it.

## Freeze windows: one guardian, at most F per F + C

Freezes are bounded per guardian and Safe, not only per attachment. A guardian's first freeze opens a window that ends
F later; every freeze it makes while the window is open ends with the window (it joins it, never extends it). When the
window ends, or when lifts leave the guardian nothing frozen, the guardian cannot freeze anything in that Safe for C
(`guardianWindow(engine, safe, guardian)` shows `end`, `cooldownUntil` and the count of ids it still holds). Per
attachment, a frozen or cooling id is skipped. So one guardian freezes any attachment at most F per F + C, however
many attachments it guards: staggering two attachments that both match the owners' `configure` (review rev 3, P3)
ends at the first window's end. Two colluding guardians can chain their windows (up to 2F for two attachments): list
one guardian per Safe, or the same one everywhere.

Keep the owners' delay T above the cooldown C: after a window ends, anything an attacker holding the owner keys
schedules is still pending when the guardian can freeze again (C < T), and that freeze voids it.

Freeze state is keyed by attachment id and guardian: `configure`, detach and re-attach keep it, so a re-attach never
shortens a freeze or a cooldown. That is deliberate: a reset would hand whoever can reconfigure a way to shorten a
freeze, and a fresh attachment that inherits a freeze can still be detached by the owners like any other.

## What it sees and cannot see

| Sees | Cannot see |
| --- | --- |
| The transaction hash (`ctx.txHash`), the matched attachment ids, the calls (to tell a configuration change) | Anything off-chain; whether the scheduled call is still a good idea; who signed beyond the Safe's own check |

## Errors

| Error | When |
| --- | --- |
| `InvalidSettings` | a list rule above is broken |
| `TimelockNotCoveringConfiguration` | the configuration invariant |
| `NoTimelock(txHash)` | `schedule`: no attachment of this policy matches the call for that actor |
| `CancelledTransaction(txHash)` | `schedule`: this owner-path transaction was cancelled |
| `AlreadyScheduled(txHash)` | a live schedule exists (expired or void ones are replaced) |
| `GasFieldsNotZero`, `StaleNonce(nonce, current)` | owner schedule with gas fields, or a used nonce |
| `AttachmentFrozen(id, until)`, `NotScheduled`, `NotReady(txHash, readyAt)`, `ScheduleExpired`, `VoidedByFreeze` | the check |
| `NotCanceller`, `NotOwnersQueue`, `NotGuardian`, `NotGuardianOrLifter`, `NotFrozen` | cancel, freeze, lift |

## Example: owners T = 24 h with a guardian, recovery R = 72 h as a lifter

```
attach (Owners, *)   TimelockPolicy {delay: 86400, window: 0, guardians: [G], lifters: [Recovery], cancellers: []}
attach (Recovery, *) TimelockPolicy {delay: 259200, window: 604800, guardians: [], lifters: [], cancellers: []}
```

Proven by `test/v2/stories/OwnersTimelock.test.ts`, `Recovery.test.ts`, `Freeze.test.ts` and `Spark.test.ts`.
