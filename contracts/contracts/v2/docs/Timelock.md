# TimelockPolicy: delay, freeze, cancel

Source: `policies/TimelockPolicy.sol` and `policies/TimelockPolicyQueue.sol`, interface
`interfaces/policies/ITimelockPolicy.sol`, SPEC §5.1. Research prototype, unaudited.

## What it does

A transaction matched by a Timelock attachment runs only if it was scheduled on-chain at least `delay` before. The
same attachment can be frozen by its guardians for at most F, lifted early by its guardians or lifters, and a schedule
can be cancelled by its cancellers, by the module that made it, or by the owners. One policy, three jobs:

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
| `window` (uint32, s) | How long a matured schedule stays executable; 0 = forever | |
| `guardians` | May freeze and lift this attachment | at most 8, none at actor `ANY` |
| `lifters` | May lift only (for example the recovery module) | at most 8, none at actor `ANY` |
| `cancellers` | May cancel a schedule this attachment matched | at most 8 |

No zero address, no duplicate, never the Safe itself (`InvalidSettings`). Immutables of the deployment: `MAX_FREEZE`
(F, 7 days) and `COOLDOWN` (C, 12 hours).

Configuration invariant: a delay at actor `OWNERS` or `ANY` needs a Timelock of this policy, at least as long, that
covers the same actor's call to `engine.configure` (scope `*`, `engine.*` or `engine.configure`, at that actor or
`ANY`). Otherwise `configure` reverts `TimelockNotCoveringConfiguration`. So the owners can never remove a delay
faster than the delay itself. Module attachments are exempt: the owners remove them through their own delay.

## Who calls what, and when

| Function | Who | When |
| --- | --- | --- |
| `schedule(engine, safe, safeTx, signatures)` | anyone relaying the owners' threshold signatures over the Safe transaction | before an owner transaction; the nonce is part of the hash, so schedule at a future nonce when other transactions come first |
| `scheduleModuleTx(engine, safe, to, value, data, op)` | the module itself | before its own call |
| `cancel(engine, safe, txHash)` | a canceller of a matched attachment, or the module that scheduled it | any time before execution |
| `cancelAsOwners(engine, safe, txHash, signatures)` | anyone relaying `threshold` owner signatures over `cancelDigest` | owner-path schedules only (`NotOwnersQueue` for a module's) |
| `freeze(engine, safe, ids[])` | a guardian of every listed id | frozen for F; frozen or cooling ids are skipped (`FreezeSkipped`), never extended |
| `lift(engine, safe, id)` | a guardian or lifter of the id | ends the freeze, starts the cooldown C |
| `check` | the engine | during the guarded transaction; consumes the schedule |

## The check (merge over every matched attachment)

1. Frozen if any matched attachment is frozen: `AttachmentFrozen`, even at delay 0.
2. Delay = the longest; 0 passes.
3. A schedule by the same actor must exist (`NotScheduled`); it is ready at `max(scheduledAt, configuredAt) + delay`
   (`NotReady`): re-configuring an attachment restarts the wait.
4. Window = the shortest non-zero one; after it the schedule is expired (`ScheduleExpired`) and may be replaced.
5. A schedule made before the end of any matched attachment's last freeze is void (`VoidedByFreeze`), unless it is a
   configuration change (a top-level CALL to `engine.configure`): that is the owners' way out of a rogue guardian.
6. On pass the schedule is deleted and `Executed` is emitted.

State of one attachment: `ACTIVE -> FROZEN (F) -> COOLDOWN (C) -> ACTIVE`; `lift` jumps to COOLDOWN.

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
