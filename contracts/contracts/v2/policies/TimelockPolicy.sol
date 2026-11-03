// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {Scope} from "../libraries/Scope.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";
import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {TimelockPolicyStorage} from "./TimelockPolicyStorage.sol";

/**
 * @title Timelock policy (transaction level)
 * @notice A transaction matched by Timelock attachments runs only once it was scheduled at least
 *         the longest matched `delay` before. Schedules are proofs pushed by direct calls (owners
 *         with their signatures, a module for itself) and consumed by the check, so a schedule
 *         executes at most once. SPEC.md §7, §8.2.
 * @dev Owners cancel their own queue with a rising signature threshold (1, 2, 3, ... capped at
 *      the Safe threshold; reset when an owners' schedule executes), modelled on Optimism's
 *      TimelockGuard. Listed cancellers (e.g. another Safe) cancel any queue a schedule's
 *      attachments named them on. A freeze voids the schedules of attachments with
 *      `clearOnFreeze` through the engine's freeze epoch. Scheduling runs in
 *      {TimelockPolicyQueue}, reached by DELEGATECALL on this storage (SPEC.md §14, D-14).
 */
contract TimelockPolicy is PolicyBaseV2, TimelockPolicyStorage, ITimelockPolicy {
    /// @dev {TimelockPolicyQueue}: `scheduleOwnerTx`, `scheduleModuleTx`.
    address private immutable _QUEUE;

    constructor(address queue_) {
        _QUEUE = queue_;
    }

    // =============================================================================================
    // IPolicyV2
    // =============================================================================================

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.TRANSACTION;
    }

    /// @inheritdoc PolicyBaseV2
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ITimelockPolicy).interfaceId || super.supportsInterface(interfaceId);
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256 delayFloor) {
        Settings memory settings = abi.decode(data, (Settings));
        require(settings.delay != 0 && settings.cancellers.length <= _MAX_CANCELLERS, InvalidSettings());
        for (uint256 i = 0; i < settings.cancellers.length; i++) {
            require(settings.cancellers[i] != address(0), InvalidSettings());
        }
        StoredSettings storage stored = _settings[_keyOf(engine, safe, attachmentId)];
        (stored.delay, stored.window, stored.clearOnFreeze) = (settings.delay, settings.window, settings.clearOnFreeze);
        // A schedule made before this matures only `delay` after it (§14 D-20).
        stored.configuredAt = uint64(block.timestamp);
        stored.cancellers = settings.cancellers;
        return settings.delay;
    }

    function _checkTransaction(
        address engine,
        Context calldata ctx,
        Call[] calldata,
        bytes calldata,
        bytes calldata,
        bytes32[] calldata attachmentIds
    ) internal override {
        Schedule memory s = _schedules[engine][ctx.safe][ctx.txHash];
        require(s.scheduledAt != 0 && s.actor == ctx.actor, NotScheduled(ctx.txHash));

        // Merge (SPEC.md §8): longest delay, shortest non-zero window, clear if any attachment says
        // so; the delay runs from the schedule or the latest (re)configuration, whichever is later.
        uint256 delay;
        uint256 window;
        bool clearOnFreeze;
        uint256 start = s.scheduledAt;
        for (uint256 i = 0; i < attachmentIds.length; i++) {
            StoredSettings storage settings = _settings[_keyOf(engine, ctx.safe, attachmentIds[i])];
            if (settings.delay > delay) delay = settings.delay;
            if (settings.window != 0 && (window == 0 || settings.window < window)) window = settings.window;
            clearOnFreeze = clearOnFreeze || settings.clearOnFreeze;
            if (settings.configuredAt > start) start = settings.configuredAt;
        }

        uint256 readyAt = start + delay;
        require(block.timestamp >= readyAt, NotReady(ctx.txHash, readyAt));
        require(window == 0 || block.timestamp <= readyAt + window, ScheduleExpired(ctx.txHash, readyAt + window));
        if (clearOnFreeze) {
            (, , uint64 epoch) = IPolicyEngineV2(engine).freezeStatus(ctx.safe, ctx.actor);
            require(!s.frozenAtSchedule && s.epoch == epoch, ClearedByFreeze(ctx.txHash));
        }

        _delete(engine, ctx.safe, ctx.txHash);
        if (ctx.actor == Scope.OWNERS) {
            delete _cancelCount[engine][ctx.safe];
        }
        emit Executed(engine, ctx.safe, ctx.txHash);
    }

    // =============================================================================================
    // Cancelling
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function cancelAsOwners(address engine, address safe, bytes32 txHash, bytes calldata signatures) external {
        Schedule storage s = _schedules[engine][safe][txHash];
        require(s.scheduledAt != 0, NotScheduled(txHash));
        require(s.actor == Scope.OWNERS, NotOwnersQueue(txHash));
        ISafe(safe).checkNSignatures(
            address(0),
            _cancelDigest(engine, safe, txHash),
            signatures,
            _requiredCancelSignatures(engine, safe)
        );
        _delete(engine, safe, txHash);
        uint256 count = ++_cancelCount[engine][safe];
        emit Cancelled(engine, safe, txHash, msg.sender, count);
    }

    /// @inheritdoc ITimelockPolicy
    function cancel(address engine, address safe, bytes32 txHash) external {
        Schedule storage s = _schedules[engine][safe][txHash];
        require(s.scheduledAt != 0, NotScheduled(txHash));
        address[] storage cancellers = _cancellers[engine][safe][txHash];
        // A module cancels its own schedule: that removes no protection (§14 D-21). The owners'
        // actor `Scope.OWNERS` is never a caller.
        bool listed = s.actor == msg.sender;
        for (uint256 i = 0; i < cancellers.length && !listed; i++) {
            listed = cancellers[i] == msg.sender;
        }
        require(listed, NotCanceller(msg.sender));
        _delete(engine, safe, txHash);
        emit Cancelled(engine, safe, txHash, msg.sender, 0);
    }

    // =============================================================================================
    // Scheduling: run by {TimelockPolicyQueue} on this contract's storage
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function scheduleOwnerTx(address, address, SafeTransaction calldata, bytes calldata) external returns (bytes32) {
        _delegateToQueue();
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
        _delegateToQueue();
    }

    /// @notice The scheduling module this policy DELEGATECALLs.
    function queue() external view returns (address) {
        return _QUEUE;
    }

    /// @dev Forwards the current call to {TimelockPolicyQueue} and returns or reverts with its result.
    function _delegateToQueue() private {
        address target = _QUEUE;
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
    // Views
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function getSchedule(address engine, address safe, bytes32 txHash) external view returns (Schedule memory) {
        return _schedules[engine][safe][txHash];
    }

    /// @inheritdoc ITimelockPolicy
    function getCancellers(address engine, address safe, bytes32 txHash) external view returns (address[] memory) {
        return _cancellers[engine][safe][txHash];
    }

    /// @inheritdoc ITimelockPolicy
    function cancelCount(address engine, address safe) external view returns (uint256) {
        return _cancelCount[engine][safe];
    }

    /// @inheritdoc ITimelockPolicy
    function requiredCancelSignatures(address engine, address safe) external view returns (uint256) {
        return _requiredCancelSignatures(engine, safe);
    }

    /// @inheritdoc ITimelockPolicy
    function cancelDigest(address engine, address safe, bytes32 txHash) external view returns (bytes32) {
        return _cancelDigest(engine, safe, txHash);
    }

    /// @inheritdoc ITimelockPolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory) {
        StoredSettings storage stored = _settings[_keyOf(engine, safe, attachmentId)];
        return Settings(stored.delay, stored.window, stored.clearOnFreeze, stored.cancellers);
    }

    /// @inheritdoc ITimelockPolicy
    function configuredAt(address engine, address safe, bytes32 attachmentId) external view returns (uint256) {
        return _settings[_keyOf(engine, safe, attachmentId)].configuredAt;
    }

    /// @inheritdoc ITimelockPolicy
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }
}
