// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentKind, Call, MatchView} from "../libraries/Types.sol";
import {TimelockPolicyStorage} from "./TimelockPolicyStorage.sol";

/**
 * @title TimelockPolicy: scheduling
 * @notice The proof-pushing side of {TimelockPolicy} (SPEC.md §7, §8.2): owners and modules schedule.
 *         Not a policy of its own: {TimelockPolicy} reaches it by DELEGATECALL, so it runs on the
 *         policy's storage, at the policy's address. Split out because one Sepolia transaction
 *         cannot deploy the whole policy (SPEC.md §14, D-14).
 */
contract TimelockPolicyQueue is TimelockPolicyStorage {
    address private immutable _SELF = address(this);

    /// @notice Called directly instead of through {TimelockPolicy}.
    error NotDelegated();

    /// @dev A direct call would act on this contract's own, unused storage: reject it.
    modifier onlyDelegated() {
        require(address(this) != _SELF, NotDelegated());
        _;
    }

    /// @notice See {ITimelockPolicy-scheduleOwnerTx}.
    function scheduleOwnerTx(
        address engine,
        address safe,
        ITimelockPolicy.SafeTransaction calldata safeTx,
        bytes calldata signatures
    ) external onlyDelegated returns (bytes32 txHash) {
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
        require(safeTx.nonce >= current, ITimelockPolicy.StaleNonce(safeTx.nonce, current));
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

    /// @notice See {ITimelockPolicy-scheduleModuleTx}.
    function scheduleModuleTx(
        address engine,
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external onlyDelegated returns (bytes32 txHash) {
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
        uint256 listedCount;
        for (uint256 i = 0; i < matches.length; i++) {
            // The engine filters by policy already; re-checked because `engine` is caller-chosen.
            if (!_isOurs(matches[i])) continue;
            ITimelockPolicy.Settings storage settings = _settings[
                _keyOf(engine, safe, matches[i].attachment.attachmentId)
            ];
            if (settings.delay > delay) delay = settings.delay;
            clearOnFreeze = clearOnFreeze || settings.clearOnFreeze;
            listedCount += settings.cancellers.length;
        }

        ITimelockPolicy.Schedule storage s = _schedules[engine][safe][txHash];
        if (s.scheduledAt != 0) {
            require(
                clearOnFreeze && (s.frozenAtSchedule || s.epoch != epoch),
                ITimelockPolicy.AlreadyScheduled(txHash)
            );
        }

        // The union is deduplicated in memory, then written once (replacing a voided schedule's).
        address[] memory cancellers = new address[](listedCount);
        uint256 count;
        for (uint256 i = 0; i < matches.length; i++) {
            if (!_isOurs(matches[i])) continue;
            address[] storage listed = _settings[_keyOf(engine, safe, matches[i].attachment.attachmentId)]
                .cancellers;
            for (uint256 j = 0; j < listed.length; j++) {
                count = _addUnique(cancellers, count, listed[j]);
            }
        }
        assembly ("memory-safe") {
            mstore(cancellers, count)
        }
        _cancellers[engine][safe][txHash] = cancellers;

        uint64 readyAt = uint64(block.timestamp + delay);
        s.actor = actor;
        s.scheduledAt = uint64(block.timestamp);
        s.readyAt = readyAt;
        s.epoch = epoch;
        s.frozenAtSchedule = safeFrozen || actorFrozen;
        emit ITimelockPolicy.Scheduled(
            engine,
            safe,
            txHash,
            actor,
            call.to,
            call.value,
            call.data,
            call.operation,
            nonce,
            readyAt
        );
    }

    /// @dev `address(this)` is the policy: this code only runs under its DELEGATECALL.
    function _isOurs(MatchView memory m) private view returns (bool) {
        return m.attachment.kind == AttachmentKind.POLICY && m.attachment.policy == address(this);
    }

    /// @dev Appends `account` to the first `count` entries of `list` unless present; returns the new
    ///      count. Bounded: at most 8 cancellers per attachment, attachments bounded by the engine caps.
    function _addUnique(address[] memory list, uint256 count, address account) private pure returns (uint256) {
        for (uint256 i = 0; i < count; i++) {
            if (list[i] == account) return count;
        }
        list[count] = account;
        return count + 1;
    }
}
