# TimelockPolicy: delay, freeze, cancel

Source: `policies/TimelockPolicy.sol`, `policies/TimelockPolicyQueue.sol` (schedule, cancel) and
`policies/TimelockPolicyFreeze.sol` (freeze, lift, the covering rule), both reached by DELEGATECALL from the policy's address; interface
`interfaces/policies/ITimelockPolicy.sol`, SPEC §5.1. Research prototype, unaudited. Deployment: the queue, then the
freeze module `TimelockPolicyFreeze(F, C)`, then `TimelockPolicy(F, C, queue, freezer)` (it checks the freezer's F and
C match).

## What it does

A transaction matched by a Timelock attachment runs only if it was scheduled on-chain at least `delay` before. The
same attachment can be frozen by its guardians, an actor's attachments at most F per F + C whoever freezes, lifted early by its guardians
or lifters, and a schedule can be cancelled by its cancellers, by the module that made it, or by the owners. One policy, three jobs:

| Settings                            | Use                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `delay > 0`, guardians              | The owners' timelock T with a guardian (template "Owners")                         |
| `delay = 0`, guardians              | A kill switch: nothing waits, the guardian can stop the actor at once (Ops, Agent) |
| `delay = R`, no guardians, a window | Recovery's delay: nobody can freeze it                                             |
| narrow scope, cancellers            | Spark: another Safe can cancel queued calls to one contract                        |
| route covers ("Admin delay")        | `(Owners, Safe.*)`, `(Owners, engine.configure)`, `(Owners, *)` DELEGATECALL only  |

## Settings

`abi.encode(Settings)`, one per attachment, fully replaced by each `configure`.

| Field                | Meaning                                                   | Rule                           |
| -------------------- | --------------------------------------------------------- | ------------------------------ |
| `delay` (uint32, s)  | Wait between schedule and execution; 0 = kill switch only |                                |
| `window` (uint32, s) | How long a matured schedule stays executable; 0 = forever | ignored at `delay = 0`         |
| `guardians`          | May freeze and lift this attachment                       | at most 8, none at actor `ANY` |
| `lifters`            | May lift only (for example the recovery module)           | at most 8, none at actor `ANY` |
| `cancellers`         | May cancel a schedule this attachment matched             | at most 8                      |

No zero address, no duplicate, never the Safe itself (`InvalidSettings`). Immutables of the deployment: `MAX_FREEZE`
(F, 7 days) and `COOLDOWN` (C, 12 hours).

Covering rule, checked by `validate` after every `configure` that touches this policy, on the final configuration
(order inside the batch does not matter). Let D be the longest delay of this policy's attachments at actor `OWNERS` or
`ANY`. Each owner-path route out of a policy must be delayed at least D by an attachment of this policy that matches it,
with the route's operation in its op mask:

| Route                                                                                    | Covered by (examples)                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| any DELEGATECALL                                                                         | `(Owners, *)` or `(ANY, *)` with DELEGATECALL in the mask, only   |
| `engine.configure`                                                                       | `(Owners, *)`, `(Owners, engine.*)`, `(Owners, engine.configure)` |
| `Safe.setGuard`, `setModuleGuard`, `enableModule`, `disableModule`, `setFallbackHandler` | `(Owners, *)`, `(Owners, Safe.*)`, or each exact function         |

Otherwise `configure` reverts `PolicyConfigurationFailed(timelock, TimelockNotCoveringConfiguration(to, selector, op,
delay))`, naming the first uncovered route (`to == 0` for any DELEGATECALL) and D. An `(Owners, *)` Timelock with the
default mask covers everything by itself. Lowering or detaching a cover while a longer delay stands is refused;
detaching both in one batch passes. Module attachments are exempt: the owners remove them through their own delay.
Owner management is not a route (new owners are delayed the same); `(Owners, Safe.*)` delays it anyway. A Timelock of
another deployment never counts. What a narrow delay still does not bound (other actors, other spend shapes of the same
token, ETH, an ERC-1271 handler kept at install): SPEC "Administration and emergency exits".

## Who calls what, and when

| Function                                              | Who                                                                                                    | When                                                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule(engine, safe, safeTx, signatures)`          | anyone relaying the owners' threshold signatures over the Safe transaction                             | before an owner transaction; the nonce is part of the hash, so schedule at a future nonce when other transactions come first                                                                  |
| `scheduleModuleTx(engine, safe, to, value, data, op)` | the module itself                                                                                      | before its own call                                                                                                                                                                           |
| `cancel(engine, safe, txHash)`                        | a canceller of a matched attachment (never on a configuration change), or the module that scheduled it | any time before execution                                                                                                                                                                     |
| `cancelAsOwners(engine, safe, txHash, signatures)`    | anyone relaying `threshold` owner signatures over `cancelDigest`                                       | owner-path schedules only (`NotOwnersQueue` for a module's)                                                                                                                                   |
| `freeze(engine, safe, ids[])`                         | a guardian of every listed id                                                                          | frozen until the end of the actor's window (F from the first freeze of any of its ids); frozen or cooling ids, and every id of a cooling actor, are skipped (`FreezeSkipped`), never extended |
| `lift(engine, safe, id)`                              | a guardian or lifter of the id                                                                         | ends the freeze, starts the id's cooldown C; if none of the actor's ids is left frozen, the actor's window closes and its cooldown starts                                                     |
| `check`                                               | the engine                                                                                             | during the guarded transaction; consumes the schedule                                                                                                                                         |

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

## Freeze windows: one actor, at most F per F + C

Freezes are bounded per actor and Safe, whoever the guardian. The first freeze of any of an actor's attachments opens
the actor's window, ending F later; every later freeze of that actor's attachments, by any guardian, ends with the
window (it joins it, never extends it). When the window ends, or when lifts leave none of the actor's attachments
frozen, none of them can be frozen for C (`actorWindow(engine, safe, actor)` shows `end`, `cooldownUntil` and the
count of ids frozen in the window). Per attachment, a frozen or cooling id is skipped. A transaction of an actor
matches only that actor's and `ANY`'s attachments, and `ANY` attachments have no guardians, so the actor's
transactions, the owners' `configure` included, are blocked by freezes at most F per F + C, with any number of
colluding guardians, per TimelockPolicy deployment: a second deployment attached at the same actor keeps its own window
(the app refuses policies outside its deployment) (review rev 3, A4: two guardians alternating over two attachments matching `configure` used to
block the owners indefinitely).

The trade-off: a rogue or hasty guardian's freeze uses up the actor's window. Honest guardians cannot add time after
it, nor freeze during the C that follows; a lift by recovery closes the window for everyone.

Keep the owners' delay T above the cooldown C: after a window ends, anything an attacker holding the owner keys
schedules is still pending when the guardian can freeze again (C < T), and that freeze voids it.

Freeze state is keyed by attachment id (the window by actor): `configure`, detach and re-attach keep it, so a re-attach never
shortens a freeze or a cooldown. That is deliberate: a reset would hand whoever can reconfigure a way to shorten a
freeze, and a fresh attachment that inherits a freeze can still be detached by the owners like any other.

## What it sees and cannot see

| Sees                                                                                                        | Cannot see                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The transaction hash (`ctx.txHash`), the matched attachment ids, the calls (to tell a configuration change) | Anything off-chain; whether the scheduled call is still a good idea; who signed beyond the Safe's own check |

## Errors

| Error                                                                                                           | When                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `InvalidSettings`                                                                                               | a list rule above is broken                                              |
| `TimelockNotCoveringConfiguration(to, selector, op, delay)`                                                     | the covering rule (through `PolicyConfigurationFailed`)                  |
| `NoTimelock(txHash)`                                                                                            | `schedule`: no attachment of this policy matches the call for that actor |
| `CancelledTransaction(txHash)`                                                                                  | `schedule`: this owner-path transaction was cancelled                    |
| `AlreadyScheduled(txHash)`                                                                                      | a live schedule exists (expired or void ones are replaced)               |
| `GasFieldsNotZero`, `StaleNonce(nonce, current)`                                                                | owner schedule with gas fields, or a used nonce                          |
| `AttachmentFrozen(id, until)`, `NotScheduled`, `NotReady(txHash, readyAt)`, `ScheduleExpired`, `VoidedByFreeze` | the check                                                                |
| `NotCanceller`, `NotOwnersQueue`, `NotGuardian`, `NotGuardianOrLifter`, `NotFrozen`                             | cancel, freeze, lift                                                     |

## Example: owners T = 24 h with a guardian, recovery R = 72 h as a lifter

```
attach (Owners, *)   TimelockPolicy {delay: 86400, window: 0, guardians: [G], lifters: [Recovery], cancellers: []}
attach (Recovery, *) TimelockPolicy {delay: 259200, window: 604800, guardians: [], lifters: [], cancellers: []}
```

## Example: a 72 h delay on one function (Spark), every other owner call instant

```
attach (Owners, USDC.transfer)    TimelockPolicy {delay: 259200, guardians: [G], cancellers: [spark]}
attach (Owners, Safe.*)           TimelockPolicy {delay: 259200}
attach (Owners, engine.configure) TimelockPolicy {delay: 259200}
attach (Owners, *) opMask 2       TimelockPolicy {delay: 259200}   // DELEGATECALL only
```

Proven by `test/v2/stories/OwnersTimelock.test.ts`, `Recovery.test.ts`, `Freeze.test.ts`, `Spark.test.ts`,
`Review.test.ts`, and the random orderings of `Configure.test.ts`.
