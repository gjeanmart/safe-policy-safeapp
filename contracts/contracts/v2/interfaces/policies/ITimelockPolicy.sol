// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicy} from "../IPolicy.sol";

/**
 * @title TimelockPolicy: delay + freeze + cancel
 * @notice A transaction matched by a Timelock attachment runs only if it was scheduled `delay`
 *         before; the attachment's guardians can freeze it for at most `MAX_FREEZE`, its guardians
 *         or lifters can lift the freeze early, and cancellers (or the owners) can cancel a
 *         schedule. `delay == 0` is a kill switch only. Recovery is the same policy attached at a
 *         recovery actor with delay R and no guardians. SPEC.md §5.1.
 * @dev Settings: `abi.encode(Settings)`, keyed `(engine, safe, attachmentId)`.
 *
 *      Merge rule over the attachments a transaction matched (`ids`):
 *      - frozen if any id is frozen (`AttachmentFrozen`), checked first, even when `delay == 0`;
 *      - delay = max delay; if 0, pass without a schedule;
 *      - start = max(schedule time, max `configuredAt` over ids): re-configuring restarts the wait;
 *      - ready at start + delay (`NotReady`); window = min non-zero window over the ids with
 *        `delay > 0` (a kill switch's window is ignored), expired after start + delay + window
 *        (`ScheduleExpired`);
 *      - void if scheduled before the `frozenUntil` of any id (`VoidedByFreeze`), unless the
 *        schedule is a configuration change (a top-level CALL to `IPolicyGuard.configure`);
 *      - cancellers: the union of the cancellers of the ids matched at schedule time, except on a
 *        configuration change (only the owners, or the module that scheduled it, cancel those).
 *      A cancelled owner-path hash can never be scheduled again (`CancelledTransaction`).
 *      On pass the schedule is deleted (consumed) and `Executed` is emitted.
 *
 *      Covering rule (`TimelockNotCoveringConfiguration`), checked by {IPolicy-validate} on the
 *      final configuration of every `configure` touching this policy, whatever the order of its
 *      changes: let D be the longest delay of this policy's attachments whose actor is
 *      `ScopeLib.OWNERS` or `ScopeLib.ANY`. Each owner-path route out of a policy must be delayed
 *      at least D by an attachment of this policy that matches it (any of its lookup scopes, the
 *      route's operation in the op mask): CALLs to `engine.configure`, `Safe.setGuard`,
 *      `Safe.setModuleGuard`, `Safe.enableModule`, `Safe.disableModule`,
 *      `Safe.setFallbackHandler`, and any DELEGATECALL (only `(OWNERS, *)` or `(ANY, *)` with
 *      DELEGATECALL in the mask covers that one). So the owners can never remove or bypass a delay
 *      faster than the delay itself; lowering or detaching a cover under a longer delay is
 *      refused. Module-actor attachments are exempt: the owners remove them through their own
 *      delay. Owner management (`addOwnerWithThreshold`, ...) is not a route: new owners are
 *      delayed the same.
 *
 *      Freeze state per attachment: `ACTIVE -> FROZEN (until the actor's window end) -> COOLDOWN
 *      (until frozenUntil + COOLDOWN) -> ACTIVE`; `lift` ends FROZEN at once and starts the cooldown.
 *      No extension: freezing a frozen or cooling attachment is skipped (`FreezeSkipped`).
 *      Freeze window per scope actor and `(engine, safe)`, whoever the guardian: the first freeze
 *      of any of the actor's attachments opens a window ending MAX_FREEZE later; later freezes of
 *      its attachments end with the window (they join it, never extend it); when the window ends,
 *      or a lift leaves none of them frozen, none can be frozen for COOLDOWN. So an actor's
 *      transactions are frozen at most F per F + C, however many guardians collude, per
 *      TimelockPolicy deployment: a second deployment attached at the same actor keeps its own
 *      window (the app refuses policies outside its deployment).
 *      Freeze state is keyed by attachment id: `configure`, detach and re-attach keep it (they
 *      never shorten a freeze or a cooldown).
 */
interface ITimelockPolicy is IPolicy {
    /**
     * @notice Settings of one attachment.
     * @custom:member delay Seconds between schedule and execution; 0 = kill switch only.
     * @custom:member window Seconds a matured schedule stays executable; 0 = never expires.
     * @custom:member guardians May freeze and lift this attachment. At most `MAX_ROLE_MEMBERS`.
     * @custom:member lifters May lift only (e.g. the recovery actor). At most `MAX_ROLE_MEMBERS`.
     * @custom:member cancellers May cancel a schedule this attachment matched (e.g. another Safe).
     *                At most `MAX_ROLE_MEMBERS`. A guardian is not a canceller unless listed.
     * @dev Rejected (`InvalidSettings`): a zero address, a duplicate within a list, the Safe itself
     *      in any list, a list over the cap, guardians or lifters on an attachment whose actor is
     *      `ScopeLib.ANY` (a global freeze would also stop recovery).
     */
    struct Settings {
        uint32 delay;
        uint32 window;
        address[] guardians;
        address[] lifters;
        address[] cancellers;
    }

    /**
     * @notice A queued transaction, keyed `(engine, safe, txHash)`.
     * @custom:member actor `ScopeLib.OWNERS` or the module that scheduled it.
     * @custom:member scheduledAt Block time of the schedule.
     * @custom:member isConfiguration A top-level CALL to `IPolicyGuard.configure`: never voided by
     *                a freeze (the owners' way out of a rogue guardian).
     * @custom:member attachmentIds This policy's attachments the transaction matched at schedule
     *                time; their cancellers may cancel it.
     */
    struct Schedule {
        address actor;
        uint64 scheduledAt;
        bool isConfiguration;
        bytes32[] attachmentIds;
    }

    /// @notice A Safe transaction as hashed by `ISafe.getTransactionHash`.
    struct SafeTransaction {
        address to;
        uint256 value;
        bytes data;
        Operation operation;
        uint256 safeTxGas;
        uint256 baseGas;
        uint256 gasPrice;
        address gasToken;
        address refundReceiver;
        uint256 nonce;
    }

    /// @notice Carries the full call, so alerts and the app queue need nothing else.
    /// @param nonce Owner path: the Safe nonce of the transaction; module path: 0.
    /// @param readyAt `scheduledAt` + the longest delay matched at schedule time (informational).
    event Scheduled(
        address indexed engine,
        address indexed safe,
        bytes32 indexed txHash,
        address actor,
        address to,
        uint256 value,
        bytes data,
        Operation operation,
        uint256 nonce,
        uint256 readyAt,
        bool isConfiguration
    );

    /// @notice A schedule was cancelled. `by` is the canceller, the scheduling module, or `safe`
    ///         for a cancel by the owners' signatures.
    event Cancelled(address indexed engine, address indexed safe, bytes32 indexed txHash, address by);

    /// @notice A schedule was consumed by a passing check.
    event Executed(address indexed engine, address indexed safe, bytes32 indexed txHash);

    /// @notice A guardian froze an attachment until `until`.
    event Frozen(
        address indexed engine,
        address indexed safe,
        bytes32 indexed attachmentId,
        address guardian,
        uint64 until
    );

    /// @notice `freeze` skipped an attachment already frozen (`until` = end of the freeze) or
    ///         cooling down (`until` = end of the cooldown).
    event FreezeSkipped(
        address indexed engine,
        address indexed safe,
        bytes32 indexed attachmentId,
        address guardian,
        uint64 until
    );

    /// @notice A freeze was lifted early; no new freeze before `cooldownUntil`.
    event Lifted(
        address indexed engine,
        address indexed safe,
        bytes32 indexed attachmentId,
        address by,
        uint64 cooldownUntil
    );

    // --- configure ---
    error InvalidSettings();
    /// @notice The route `(to, selector)` with operation bit `op` (0 as `to`: any DELEGATECALL) is
    ///         not delayed `delay`, the longest owner-path delay of this policy (invariant above).
    error TimelockNotCoveringConfiguration(address to, bytes4 selector, uint8 op, uint32 delay);

    // --- schedule ---
    /// @notice No attachment of this policy matches the transaction for that actor.
    error NoTimelock(bytes32 txHash);
    /// @notice A schedule exists that is neither expired nor void (those are replaced).
    error AlreadyScheduled(bytes32 txHash);
    /// @notice Owner path: `safeTxGas` or `gasPrice` is not zero (the engine would deny it).
    error GasFieldsNotZero();
    /// @notice Owner path: the nonce was already used.
    error StaleNonce(uint256 nonce, uint256 current);

    /// @notice Owner path: this transaction was cancelled; its signatures cannot schedule it again.
    error CancelledTransaction(bytes32 txHash);

    // --- check ---
    error AttachmentFrozen(bytes32 attachmentId, uint64 until);
    /// @notice No schedule for `txHash`, or one made by another actor.
    error NotScheduled(bytes32 txHash);
    error NotReady(bytes32 txHash, uint256 readyAt);
    error ScheduleExpired(bytes32 txHash, uint256 expiredAt);
    error VoidedByFreeze(bytes32 txHash, bytes32 attachmentId);

    // --- cancel, freeze, lift ---
    error NotCanceller(address account);
    /// @notice `cancelAsOwners` on a schedule whose actor is not the owners.
    error NotOwnersQueue(bytes32 txHash);
    error NotGuardian(bytes32 attachmentId);
    error NotGuardianOrLifter(bytes32 attachmentId);
    error NotFrozen(bytes32 attachmentId);

    /**
     * @notice Schedules an owner-path Safe transaction with the owners' signatures over its Safe
     *         transaction hash (`ISafe.checkNSignatures(msg.sender, txHash, signatures, threshold)`).
     *         Who: anyone relaying the signatures. Not a Safe transaction, so it does not wait for
     *         its own delay.
     * @dev Reverts `GasFieldsNotZero`, `StaleNonce` (nonce below the Safe's), `NoTimelock` (no
     *      attachment of this policy matches the call for `ScopeLib.OWNERS`, via
     *      `IPolicyGuard.matches`), `AlreadyScheduled`. Emits `Scheduled`.
     * @return txHash The Safe transaction hash (binds the nonce).
     */
    function schedule(
        address engine,
        address safe,
        SafeTransaction calldata safeTx,
        bytes calldata signatures
    ) external returns (bytes32 txHash);

    /**
     * @notice Schedules a module-path call. Who: the module itself (`msg.sender` is the actor).
     * @dev Same reverts as {schedule} minus the owner-path ones. Emits `Scheduled` (nonce 0).
     * @return txHash `ScopeLib.moduleCallHash(safe, msg.sender, to, value, data, operation)`.
     */
    function scheduleModuleTx(
        address engine,
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bytes32 txHash);

    /**
     * @notice Cancels a schedule. Who: a canceller of one of the schedule's `attachmentIds` (read
     *         from the current settings), or, for a module-path schedule, the module that made it.
     *         A configuration change (`isConfiguration`) is never cancelled by a listed canceller.
     *         An owner-path cancel is final (`CancelledTransaction` on a re-schedule); a module may
     *         re-schedule its own call. Reverts `NotScheduled`, `NotCanceller`. Emits `Cancelled`.
     */
    function cancel(address engine, address safe, bytes32 txHash) external;

    /**
     * @notice Cancels an owner-path schedule with `threshold` owner signatures over
     *         {cancelDigest} (`ISafe.checkNSignatures(msg.sender, digest, signatures, threshold)`).
     *         Who: anyone relaying the signatures. Module-path schedules (recovery included) cannot
     *         be cancelled this way (`NotOwnersQueue`). Final: the hash can never be scheduled
     *         again. Emits `Cancelled` with `by == safe`.
     */
    function cancelAsOwners(address engine, address safe, bytes32 txHash, bytes calldata signatures) external;

    /**
     * @notice Freezes each listed attachment until the end of its actor's freeze window (opened
     *         by the first freeze of any of the actor's attachments, `MAX_FREEZE` long). Who: a
     *         guardian of every listed id (`NotGuardian` otherwise). Ids already frozen or cooling
     *         down, and every id whose actor cools down, are skipped (`FreezeSkipped`), never
     *         extended. Emits `Frozen` per frozen id.
     */
    function freeze(address engine, address safe, bytes32[] calldata attachmentIds) external;

    /**
     * @notice Ends a freeze early and starts its cooldown; if none of the actor's attachments is
     *         left frozen, the actor's window closes and its cooldown starts. Who: a guardian or
     *         lifter of the id, which must be attached (`NotGuardianOrLifter`). Reverts `NotFrozen`
     *         when not frozen. Emits `Lifted`.
     */
    function lift(address engine, address safe, bytes32 attachmentId) external;

    /// @notice F: the longest an actor's freeze window lasts (immutable).
    function MAX_FREEZE() external view returns (uint256);

    /// @notice C: after a freeze ends, no new freeze of that attachment, nor of any attachment of
    ///         that actor in that Safe once its window ends, for this long (immutable).
    function COOLDOWN() external view returns (uint256);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    /// @notice When the attachment's settings were last configured (0 = never).
    function configuredAt(address engine, address safe, bytes32 attachmentId) external view returns (uint256);

    /// @notice The schedule of `txHash`; `scheduledAt == 0` when none.
    function getSchedule(address engine, address safe, bytes32 txHash) external view returns (Schedule memory);

    /// @notice Freeze state of one attachment; frozen iff `block.timestamp < frozenUntil`.
    function freezeState(
        address engine,
        address safe,
        bytes32 attachmentId
    ) external view returns (uint64 frozenUntil, uint64 cooldownUntil);

    /**
     * @notice The freeze window of `actor`'s attachments in `safe`: every freeze of them ends at
     *         `end`; none can start from `end` until `cooldownUntil`; `frozen` ids are frozen in it.
     */
    function actorWindow(
        address engine,
        address safe,
        address actor
    ) external view returns (uint64 end, uint64 cooldownUntil, uint32 frozen);

    /// @notice True once an owner-path `txHash` was cancelled: it can never be scheduled again.
    function isCancelled(address engine, address safe, bytes32 txHash) external view returns (bool);

    /**
     * @notice EIP-712 digest the owners sign to cancel: domain `("TimelockPolicy", "1", chainid,
     *         this)`, `Cancel(address engine,address safe,bytes32 txHash,uint64 scheduledAt)`. Bound
     *         to the current schedule, so a cancel signature cannot cancel a later re-schedule.
     */
    function cancelDigest(address engine, address safe, bytes32 txHash) external view returns (bytes32);

    /// @notice `abi.encode(settings)`; exists so the ABI carries the settings type.
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
