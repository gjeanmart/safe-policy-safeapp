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
 *      - ready at start + delay (`NotReady`); window = min non-zero window, expired after
 *        start + delay + window (`ScheduleExpired`);
 *      - void if scheduled before the `frozenUntil` of any id (`VoidedByFreeze`), unless the
 *        schedule is a configuration change (a top-level CALL to `IPolicyGuard.configure`);
 *      - cancellers: the union of the cancellers of the ids matched at schedule time.
 *      On pass the schedule is deleted (consumed) and `Executed` is emitted.
 *
 *      Configuration invariant (`TimelockNotCoveringConfiguration`): an attachment with
 *      `delay > 0` whose actor is `ScopeLib.OWNERS` or `ScopeLib.ANY` needs an attached Timelock
 *      attachment of this policy, with `delay >=` its delay and CALL in its op mask, that matches
 *      that actor's call to `engine.configure`: at actor `actor` or `ANY`, scope `*`, `engine.*`
 *      or `engine.configure`. The attachment itself qualifies when it covers `configure`. So the
 *      owners can never remove a delay faster than the delay itself. Module-actor attachments
 *      are exempt: the owners remove them through their own delay.
 *
 *      Freeze state per attachment: `ACTIVE -> FROZEN (until now + MAX_FREEZE) -> COOLDOWN (until
 *      frozenUntil + COOLDOWN) -> ACTIVE`; `lift` ends FROZEN at once and starts the cooldown.
 *      No extension: freezing a frozen or cooling attachment is skipped (`FreezeSkipped`).
 *      `configure` keeps the freeze state of an id (it never shortens a freeze or a cooldown).
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
    /// @notice See the configuration invariant above.
    error TimelockNotCoveringConfiguration();

    // --- schedule ---
    /// @notice No attachment of this policy matches the transaction for that actor.
    error NoTimelock(bytes32 txHash);
    /// @notice A schedule exists that is neither expired nor void (those are replaced).
    error AlreadyScheduled(bytes32 txHash);
    /// @notice Owner path: `safeTxGas` or `gasPrice` is not zero (the engine would deny it).
    error GasFieldsNotZero();
    /// @notice Owner path: the nonce was already used.
    error StaleNonce(uint256 nonce, uint256 current);

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
     *         Reverts `NotScheduled`, `NotCanceller`. Emits `Cancelled`.
     */
    function cancel(address engine, address safe, bytes32 txHash) external;

    /**
     * @notice Cancels an owner-path schedule with `threshold` owner signatures over
     *         {cancelDigest} (`ISafe.checkNSignatures(msg.sender, digest, signatures, threshold)`).
     *         Who: anyone relaying the signatures. Module-path schedules (recovery included) cannot
     *         be cancelled this way (`NotOwnersQueue`). Emits `Cancelled` with `by == safe`.
     */
    function cancelAsOwners(address engine, address safe, bytes32 txHash, bytes calldata signatures) external;

    /**
     * @notice Freezes each listed attachment for `MAX_FREEZE`. Who: a guardian of every listed id
     *         (`NotGuardian` otherwise). Ids already frozen or cooling down are skipped
     *         (`FreezeSkipped`), never extended. Emits `Frozen` per frozen id.
     */
    function freeze(address engine, address safe, bytes32[] calldata attachmentIds) external;

    /**
     * @notice Ends a freeze early and starts its cooldown. Who: a guardian or lifter of the id
     *         (`NotGuardianOrLifter`). Reverts `NotFrozen` when not frozen. Emits `Lifted`.
     */
    function lift(address engine, address safe, bytes32 attachmentId) external;

    /// @notice F: the longest a freeze lasts (immutable).
    function MAX_FREEZE() external view returns (uint256);

    /// @notice C: after a freeze ends, no new freeze of that attachment for this long (immutable).
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
     * @notice EIP-712 digest the owners sign to cancel: domain `("TimelockPolicy", "1", chainid,
     *         this)`, `Cancel(address engine,address safe,bytes32 txHash,uint64 scheduledAt)`. Bound
     *         to the current schedule, so a cancel signature cannot cancel a later re-schedule.
     */
    function cancelDigest(address engine, address safe, bytes32 txHash) external view returns (bytes32);

    /// @notice `abi.encode(settings)`; exists so the ABI carries the settings type.
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
