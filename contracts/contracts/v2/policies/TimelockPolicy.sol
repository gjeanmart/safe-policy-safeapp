// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentKind, Call, Context, MatchView, PolicyLevel, ScopeData} from "../libraries/Types.sol";
import {PolicyBaseV2} from "../PolicyBaseV2.sol";

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
 *      `clearOnFreeze` through the engine's freeze epoch.
 */
contract TimelockPolicy is PolicyBaseV2, ITimelockPolicy {
    uint256 private constant _MAX_CANCELLERS = 8;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("TimelockPolicy");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _CANCEL_TYPEHASH =
        keccak256("Cancel(address engine,address safe,bytes32 txHash,uint256 cancelCount)");

    mapping(bytes32 settingsKey => Settings) private _settings;

    mapping(address engine => mapping(address safe => mapping(bytes32 txHash => Schedule))) private _schedules;

    mapping(address engine => mapping(address safe => mapping(bytes32 txHash => address[]))) private _cancellers;

    mapping(address engine => mapping(address safe => uint256)) private _cancelCount;

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
        _settings[_settingsKey(engine, safe, attachmentId)] = settings;
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

        // Merge (SPEC.md §8): longest delay, shortest non-zero window, clear if any attachment says so.
        uint256 delay;
        uint256 window;
        bool clearOnFreeze;
        for (uint256 i = 0; i < attachmentIds.length; i++) {
            Settings storage settings = _settings[_settingsKey(engine, ctx.safe, attachmentIds[i])];
            if (settings.delay > delay) delay = settings.delay;
            if (settings.window != 0 && (window == 0 || settings.window < window)) window = settings.window;
            clearOnFreeze = clearOnFreeze || settings.clearOnFreeze;
        }

        uint256 readyAt = s.scheduledAt + delay;
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
    // Scheduling
    // =============================================================================================

    /// @inheritdoc ITimelockPolicy
    function scheduleOwnerTx(
        address engine,
        address safe,
        SafeTransaction calldata safeTx,
        bytes calldata signatures
    ) external returns (bytes32 txHash) {
        txHash = ISafe(safe).getTransactionHash(
            safeTx.to,
            safeTx.value,
            safeTx.data,
            safeTx.operation,
            safeTx.safeTxGas,
            safeTx.baseGas,
            safeTx.gasPrice,
            safeTx.gasToken,
            safeTx.refundReceiver,
            safeTx.nonce
        );
        uint256 current = ISafe(safe).nonce();
        require(safeTx.nonce >= current, StaleNonce(safeTx.nonce, current));
        ISafe(safe).checkNSignatures(address(0), txHash, signatures, ISafe(safe).getThreshold());
        _schedule(
            engine,
            safe,
            Scope.OWNERS,
            txHash,
            Call(safeTx.to, safeTx.value, safeTx.data, safeTx.operation),
            safeTx.nonce
        );
    }

    /// @inheritdoc ITimelockPolicy
    function scheduleModuleTx(
        address engine,
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bytes32 txHash) {
        txHash = Scope.moduleCallHash(safe, msg.sender, to, value, data, operation);
        _schedule(engine, safe, msg.sender, txHash, Call(to, value, data, operation), 0);
    }

    /**
     * @dev Snapshots the freeze state and the union of the cancellers of the attachments the
     *      transaction matches now; `readyAt` is informational (the check recomputes the delay).
     *      An existing schedule that a freeze voided (its check would fail `ClearedByFreeze`) is
     *      replaced rather than rejected: schedules must be re-made after a freeze, and a module
     *      cannot cancel its own.
     */
    function _schedule(
        address engine,
        address safe,
        address actor,
        bytes32 txHash,
        Call memory call,
        uint256 nonce
    ) private {
        (bool safeFrozen, bool actorFrozen, uint64 epoch) = IPolicyEngineV2(engine).freezeStatus(safe, actor);
        MatchView[] memory matches = IPolicyEngineV2(engine).getMatchingAttachments(
            safe,
            actor,
            call.to,
            call.value,
            call.data,
            call.operation,
            address(this)
        );

        uint256 delay;
        bool clearOnFreeze;
        for (uint256 i = 0; i < matches.length; i++) {
            // The engine filters by policy already; re-checked because `engine` is caller-chosen.
            if (!_isOurs(matches[i])) continue;
            Settings storage settings = _settings[_settingsKey(engine, safe, matches[i].attachment.attachmentId)];
            if (settings.delay > delay) delay = settings.delay;
            clearOnFreeze = clearOnFreeze || settings.clearOnFreeze;
        }

        Schedule storage s = _schedules[engine][safe][txHash];
        if (s.scheduledAt != 0) {
            require(clearOnFreeze && (s.frozenAtSchedule || s.epoch != epoch), AlreadyScheduled(txHash));
            delete _cancellers[engine][safe][txHash];
        }

        address[] storage cancellers = _cancellers[engine][safe][txHash];
        for (uint256 i = 0; i < matches.length; i++) {
            if (!_isOurs(matches[i])) continue;
            address[] storage listed = _settings[_settingsKey(engine, safe, matches[i].attachment.attachmentId)]
                .cancellers;
            for (uint256 j = 0; j < listed.length; j++) {
                _addUnique(cancellers, listed[j]);
            }
        }

        uint64 readyAt = uint64(block.timestamp + delay);
        s.actor = actor;
        s.scheduledAt = uint64(block.timestamp);
        s.readyAt = readyAt;
        s.epoch = epoch;
        s.frozenAtSchedule = safeFrozen || actorFrozen;
        emit Scheduled(engine, safe, txHash, actor, call.to, call.value, call.data, call.operation, nonce, readyAt);
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
            cancelDigest(engine, safe, txHash),
            signatures,
            requiredCancelSignatures(engine, safe)
        );
        _delete(engine, safe, txHash);
        uint256 count = ++_cancelCount[engine][safe];
        emit Cancelled(engine, safe, txHash, msg.sender, count);
    }

    /// @inheritdoc ITimelockPolicy
    function cancel(address engine, address safe, bytes32 txHash) external {
        require(_schedules[engine][safe][txHash].scheduledAt != 0, NotScheduled(txHash));
        address[] storage cancellers = _cancellers[engine][safe][txHash];
        bool listed;
        for (uint256 i = 0; i < cancellers.length && !listed; i++) {
            listed = cancellers[i] == msg.sender;
        }
        require(listed, NotCanceller(msg.sender));
        _delete(engine, safe, txHash);
        emit Cancelled(engine, safe, txHash, msg.sender, 0);
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
    function requiredCancelSignatures(address engine, address safe) public view returns (uint256) {
        uint256 next = _cancelCount[engine][safe] + 1;
        uint256 threshold = ISafe(safe).getThreshold();
        return next < threshold ? next : threshold;
    }

    /// @inheritdoc ITimelockPolicy
    function cancelDigest(address engine, address safe, bytes32 txHash) public view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(
            abi.encode(_CANCEL_TYPEHASH, engine, safe, txHash, _cancelCount[engine][safe])
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @inheritdoc ITimelockPolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory) {
        return _settings[_settingsKey(engine, safe, attachmentId)];
    }

    /// @inheritdoc ITimelockPolicy
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }

    // =============================================================================================
    // Internals
    // =============================================================================================

    function _delete(address engine, address safe, bytes32 txHash) private {
        delete _schedules[engine][safe][txHash];
        delete _cancellers[engine][safe][txHash];
    }

    function _isOurs(MatchView memory m) private view returns (bool) {
        return m.attachment.kind == AttachmentKind.POLICY && m.attachment.policy == address(this);
    }

    /// @dev Bounded: at most 8 cancellers per attachment, attachments bounded by the engine caps.
    function _addUnique(address[] storage list, address account) private {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == account) return;
        }
        list.push(account);
    }
}
