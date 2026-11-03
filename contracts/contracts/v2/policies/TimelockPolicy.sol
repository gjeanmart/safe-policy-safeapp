// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {MAX_ROLE_MEMBERS} from "../libraries/Constants.sol";
import {ScopeLib} from "../libraries/Scope.sol";
import {AttachmentView, Call, CallMatch, Context, Kind, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";
import {TimelockPolicyFreeze} from "./TimelockPolicyFreeze.sol";
import {TimelockPolicyStorage} from "./TimelockPolicyQueue.sol";

/**
 * @title TimelockPolicy: delay, freeze, cancel
 * @notice Matched transactions wait `delay` after a schedule pushed on-chain; guardians freeze an
 *         attachment for at most `MAX_FREEZE`; guardians or lifters lift; cancellers, the
 *         scheduling module or the owners cancel. Rules and merge: {ITimelockPolicy}, SPEC.md §5.1.
 * @dev Scheduling and cancelling run in {TimelockPolicyQueue}, freeze and lift in
 *      {TimelockPolicyFreeze}, each deployed separately, passed in, and reached by DELEGATECALL on
 *      this storage, so each contract stays under 10,000 bytes.
 */
contract TimelockPolicy is PolicyBase, TimelockPolicyStorage, ITimelockPolicy {
    uint256 public immutable override MAX_FREEZE;
    uint256 public immutable override COOLDOWN;

    /// @dev {TimelockPolicyQueue}: `schedule`, `scheduleModuleTx`, `cancel`, `cancelAsOwners`.
    address private immutable _QUEUE;
    /// @dev {TimelockPolicyFreeze}: `freeze`, `lift`.
    address private immutable _FREEZER;

    /// @param queue A deployed {TimelockPolicyQueue}, deployed on its own: a child create would
    ///        push this deployment over the 2^24 per-transaction gas cap.
    /// @param freezer A deployed {TimelockPolicyFreeze} built with the same `maxFreeze` and `cooldown`.
    /// @dev `InvalidSettings` if a module has no code or the freezer's F or C differ.
    constructor(uint256 maxFreeze, uint256 cooldown, address queue, address freezer) {
        require(
            queue.code.length != 0 &&
                freezer.code.length != 0 &&
                TimelockPolicyFreeze(freezer).MAX_FREEZE() == maxFreeze &&
                TimelockPolicyFreeze(freezer).COOLDOWN() == cooldown,
            InvalidSettings()
        );
        MAX_FREEZE = maxFreeze;
        COOLDOWN = cooldown;
        _QUEUE = queue;
        _FREEZER = freezer;
    }

    /// @inheritdoc PolicyBase
    function supportsInterface(bytes4 interfaceId) public view override(IERC165, PolicyBase) returns (bool) {
        return interfaceId == type(ITimelockPolicy).interfaceId || super.supportsInterface(interfaceId);
    }

    // =============================================================================================
    // IPolicy
    // =============================================================================================

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        Scope calldata scope,
        uint8 opMask,
        bytes calldata data
    ) internal override {
        Settings memory s = abi.decode(data, (Settings));
        address actor = scope.actor;
        // A guardian at actor ANY could freeze recovery too.
        _validate(s.guardians, safe, actor == ScopeLib.ANY);
        _validate(s.lifters, safe, actor == ScopeLib.ANY);
        _validate(s.cancellers, safe, false);
        if (s.delay != 0 && (actor == ScopeLib.ANY || actor == ScopeLib.OWNERS)) {
            _requireCovered(engine, safe, attachmentId, actor, opMask, s.delay);
        }
        // The freeze state is kept: re-configuring never shortens a freeze or a cooldown.
        Attachment storage a = _attachments[_keyOf(engine, safe, attachmentId)];
        (a.delay, a.window, a.configuredAt) = (s.delay, s.window, uint64(block.timestamp));
        (a.guardians, a.lifters, a.cancellers) = (s.guardians, s.lifters, s.cancellers);
    }

    function _check(address engine, Context calldata ctx, Call[] calldata, Match[] calldata matches) internal override {
        Merged memory m;
        for (uint256 i = 0; i < matches.length; i++) {
            _merge(m, engine, ctx.safe, matches[i].attachmentId, true);
        }
        if (m.delay == 0) return;

        Schedule storage s = _schedules[engine][ctx.safe][ctx.txHash];
        uint256 scheduledAt = s.scheduledAt;
        require(scheduledAt != 0 && s.actor == ctx.actor, NotScheduled(ctx.txHash));
        uint256 readyAt = (scheduledAt > m.configuredAt ? scheduledAt : m.configuredAt) + m.delay;
        require(block.timestamp >= readyAt, NotReady(ctx.txHash, readyAt));
        require(m.window == 0 || block.timestamp <= readyAt + m.window, ScheduleExpired(ctx.txHash, readyAt + m.window));
        require(s.isConfiguration || scheduledAt >= m.frozenUntil, VoidedByFreeze(ctx.txHash, m.frozenId));

        delete _schedules[engine][ctx.safe][ctx.txHash];
        emit Executed(engine, ctx.safe, ctx.txHash);
    }

    // =============================================================================================
    // Scheduling and cancelling: run by {TimelockPolicyQueue} on this storage
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function schedule(address, address, SafeTransaction calldata, bytes calldata) external returns (bytes32) {
        _delegate(_QUEUE);
    }

    /// @inheritdoc ITimelockPolicy
    function scheduleModuleTx(
        address,
        address,
        address,
        uint256,
        bytes calldata,
        Operation
    ) external returns (bytes32) {
        _delegate(_QUEUE);
    }

    /// @inheritdoc ITimelockPolicy
    function cancel(address, address, bytes32) external {
        _delegate(_QUEUE);
    }

    /// @inheritdoc ITimelockPolicy
    function cancelAsOwners(address, address, bytes32, bytes calldata) external {
        _delegate(_QUEUE);
    }

    /// @notice The scheduling module this policy DELEGATECALLs.
    function queue() external view returns (address) {
        return _QUEUE;
    }

    /// @notice The freeze module this policy DELEGATECALLs.
    function freezer() external view returns (address) {
        return _FREEZER;
    }

    /// @dev Forwards the current call to `target` and returns or reverts with its result.
    function _delegate(address target) private {
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    // =============================================================================================
    // Freeze and lift: run by {TimelockPolicyFreeze} on this storage
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function freeze(address, address, bytes32[] calldata) external {
        _delegate(_FREEZER);
    }

    /// @inheritdoc ITimelockPolicy
    function lift(address, address, bytes32) external {
        _delegate(_FREEZER);
    }

    // =============================================================================================
    // Views
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory) {
        Attachment storage a = _attachments[_keyOf(engine, safe, attachmentId)];
        return Settings(a.delay, a.window, a.guardians, a.lifters, a.cancellers);
    }

    /// @inheritdoc ITimelockPolicy
    function configuredAt(address engine, address safe, bytes32 attachmentId) external view returns (uint256) {
        return _attachments[_keyOf(engine, safe, attachmentId)].configuredAt;
    }

    /// @inheritdoc ITimelockPolicy
    function getSchedule(address engine, address safe, bytes32 txHash) external view returns (Schedule memory) {
        return _schedules[engine][safe][txHash];
    }

    /// @inheritdoc ITimelockPolicy
    function freezeState(
        address engine,
        address safe,
        bytes32 attachmentId
    ) external view returns (uint64 frozenUntil, uint64 cooldownUntil) {
        Attachment storage a = _attachments[_keyOf(engine, safe, attachmentId)];
        return (a.frozenUntil, a.cooldownUntil);
    }

    /// @inheritdoc ITimelockPolicy
    function guardianWindow(
        address engine,
        address safe,
        address guardian
    ) external view returns (uint64 end, uint64 cooldownUntil, uint32 frozen) {
        GuardianWindow storage w = _windows[engine][safe][guardian];
        return (w.end, w.end == 0 ? 0 : uint64(w.end + COOLDOWN), w.frozen);
    }

    /// @inheritdoc ITimelockPolicy
    function isCancelled(address engine, address safe, bytes32 txHash) external view returns (bool) {
        return _cancelled[engine][safe][txHash];
    }

    /// @inheritdoc ITimelockPolicy
    function cancelDigest(address engine, address safe, bytes32 txHash) external view returns (bytes32) {
        return _cancelDigest(engine, safe, txHash);
    }

    /// @inheritdoc ITimelockPolicy
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }

    // =============================================================================================
    // Configuration checks
    // =============================================================================================

    /**
     * @dev `TimelockNotCoveringConfiguration` unless an attachment of this policy at `(actor, *)`
     *      or `(ANY, *)`, with CALL in its mask and a delay of at least `delay`, is attached (or is
     *      the new attachment itself). Only an actor-wide delay covers `engine.configure` and every
     *      other way out (`setGuard`, `setModuleGuard`) alike.
     */
    function _requireCovered(
        address engine,
        address safe,
        bytes32 attachmentId,
        address actor,
        uint8 opMask,
        uint256 delay
    ) private view {
        for (address a = actor; ; a = ScopeLib.ANY) {
            bytes32 id = ScopeLib.attachmentId(
                ScopeLib.key(a, address(0), bytes4(0), CallMatch.ANY),
                Kind.POLICY,
                address(this)
            );
            if (id == attachmentId) {
                if (opMask & ScopeLib.OP_CALL != 0) return;
            } else if (_attachments[_keyOf(engine, safe, id)].delay >= delay) {
                (bool attached, AttachmentView memory v) = IPolicyGuard(engine).getAttachment(safe, id);
                if (attached && v.opMask & ScopeLib.OP_CALL != 0) return;
            }
            if (a == ScopeLib.ANY) revert TimelockNotCoveringConfiguration();
        }
    }

    /// @dev `InvalidSettings`: over the cap (0 with `empty`), a zero address, the Safe, a duplicate.
    function _validate(address[] memory list, address safe, bool empty) private pure {
        require(list.length <= (empty ? 0 : MAX_ROLE_MEMBERS), InvalidSettings());
        for (uint256 i = 0; i < list.length; i++) {
            require(list[i] != address(0) && list[i] != safe, InvalidSettings());
            for (uint256 j = 0; j < i; j++) {
                require(list[j] != list[i], InvalidSettings());
            }
        }
    }
}
