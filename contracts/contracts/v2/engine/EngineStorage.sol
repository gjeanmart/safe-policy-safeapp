// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {Scope} from "../libraries/Scope.sol";
import {
    Attachment,
    AttachmentKind,
    AttachmentView,
    CallMatch,
    FreezeRole,
    FreezeState,
    PolicyLevel,
    ScopeData
} from "../libraries/Types.sol";

/**
 * @title Engine storage
 * @notice The storage layout, immutables and small helpers shared by {SafePolicyGuardV2} (the
 *         deployed engine and guard) and {PolicyEngineV2} (its configuration and freeze logic,
 *         reached by DELEGATECALL). Both inherit exactly this layout and declare no other state, so
 *         the logic contract reads and writes the guard's storage.
 */
abstract contract EngineStorage {
    // =============================================================================================
    // Immutables and constants
    // =============================================================================================

    /// @notice Configuration delay; covers the owners' longest timelock (SPEC.md §5.3).
    uint256 internal immutable _DELAY;
    /// @notice How long a matured configuration root stays applicable.
    uint256 internal immutable _EXPIRY;
    /// @notice Longest freeze from its start.
    uint256 internal immutable _MAX_FREEZE;
    /// @notice No new freeze of a key before its last one ended plus this.
    uint256 internal immutable _FREEZE_COOLDOWN;
    /// @notice The PolicySignLib whose typed entry points are matched as CALL (SPEC.md §6.3).
    address internal immutable _SIGN_LIB;

    // Up to `Scope.MAX_TRUSTED_BATCHES` trusted batch contracts, as immutables to keep storage off
    // the hot path. Unused entries are zero (the constructor rejects a zero batch).
    address internal immutable _BATCH_0;
    address internal immutable _BATCH_1;
    address internal immutable _BATCH_2;
    address internal immutable _BATCH_3;

    /// @dev Transient re-entrancy flag, set while a check (hook or preview) evaluates.
    bytes32 private constant _LOCK_SLOT = keccak256("SafePolicyGuardV2.lock");

    // =============================================================================================
    // Storage
    // =============================================================================================

    /// @dev Where an attachment sits: its scope and its index + 1 in that scope's array.
    struct AttachmentRef {
        bytes32 scopeKey;
        uint256 position;
    }

    /// @dev A scope holding attachments, for enumeration; `position` = index + 1 in `_scopeKeys`.
    struct ScopeRecord {
        address actor;
        bytes4 selector;
        CallMatch callMatch;
        uint32 position;
        address to;
    }

    /// @dev The hot path: one array per scope, one slot per attachment.
    mapping(address safe => mapping(bytes32 scopeKey => Attachment[])) internal _attachments;
    /// @dev 8 packed uint32 counters, one per level (`Scope.countAt`).
    mapping(address safe => uint256) internal _levelCounts;
    mapping(address safe => mapping(bytes32 attachmentId => AttachmentRef)) internal _refs;
    mapping(address safe => bytes32[]) internal _scopeKeys;
    mapping(address safe => mapping(bytes32 scopeKey => ScopeRecord)) internal _scopes;
    mapping(address safe => mapping(bytes32 root => uint256 validFrom)) internal _rootConfigured;
    mapping(address safe => mapping(address actor => FreezeState)) internal _freezes;
    mapping(address safe => mapping(FreezeRole role => address[])) internal _roleMembers;
    mapping(address safe => mapping(FreezeRole role => mapping(address account => bool))) internal _hasRole;

    // =============================================================================================
    // Constructor (SPEC.md §5.4)
    // =============================================================================================

    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) {
        require(
            expiry != 0 && maxFreeze != 0 && expiry >= maxFreeze + freezeCooldown + delay,
            IPolicyEngineV2.InvalidTiming()
        );
        uint256 count = trustedBatches.length;
        require(
            signLib != address(0) && count != 0 && count <= Scope.MAX_TRUSTED_BATCHES,
            IPolicyEngineV2.InvalidDeployment()
        );
        for (uint256 i = 0; i < count; i++) {
            require(trustedBatches[i] != address(0), IPolicyEngineV2.InvalidDeployment());
            for (uint256 j = 0; j < i; j++) {
                require(trustedBatches[i] != trustedBatches[j], IPolicyEngineV2.InvalidDeployment());
            }
        }
        _DELAY = delay;
        _EXPIRY = expiry;
        _MAX_FREEZE = maxFreeze;
        _FREEZE_COOLDOWN = freezeCooldown;
        _SIGN_LIB = signLib;
        _BATCH_0 = trustedBatches[0];
        _BATCH_1 = count > 1 ? trustedBatches[1] : address(0);
        _BATCH_2 = count > 2 ? trustedBatches[2] : address(0);
        _BATCH_3 = count > 3 ? trustedBatches[3] : address(0);
    }

    // =============================================================================================
    // Helpers
    // =============================================================================================

    /// @dev Hooks, `preview` and state-changing entry points must not run inside a check (§6.1).
    function _requireNotInCheck() internal view {
        bool locked;
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            locked := tload(slot)
        }
        require(!locked, IPolicyEngineV2.Reentrancy());
    }

    /// @dev Cleared at the end of every hook, so nested executions in one transaction (a module
    ///      call that triggers another Safe's checks) see an unlocked engine.
    function _setLock(bool on) internal {
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    function _isTrustedBatch(address target) internal view returns (bool) {
        return
            target != address(0) &&
            (target == _BATCH_0 || target == _BATCH_1 || target == _BATCH_2 || target == _BATCH_3);
    }

    /// @dev The last call's return data, truncated to `Scope.MAX_REASON_LENGTH` (no return bomb).
    function _boundedReturnData() internal pure returns (bytes memory reason) {
        uint256 maxLength = Scope.MAX_REASON_LENGTH;
        assembly ("memory-safe") {
            let size := returndatasize()
            if gt(size, maxLength) {
                size := maxLength
            }
            reason := mload(0x40)
            mstore(reason, size)
            returndatacopy(add(reason, 0x20), 0, size)
            mstore(0x40, add(add(reason, 0x20), and(add(size, 0x1f), not(0x1f))))
        }
    }

    function _scopeData(address safe, bytes32 key) internal view returns (ScopeData memory) {
        ScopeRecord storage record = _scopes[safe][key];
        return ScopeData(record.actor, record.to, record.selector, record.callMatch);
    }

    function _view(
        bytes32 key,
        ScopeData memory scope,
        Attachment memory a
    ) internal pure returns (AttachmentView memory) {
        return
            AttachmentView({
                attachmentId: Scope.attachmentId(key, a.kind, a.policy),
                scopeKey: key,
                scope: scope,
                kind: a.kind,
                policy: a.policy,
                opMask: a.opMask,
                policyLevel: a.policyLevel
            });
    }

    /// @dev One attachment a call matched (after the op-mask filter).
    struct Match {
        uint8 level;
        AttachmentKind kind;
        uint8 opMask;
        PolicyLevel policyLevel;
        address policy;
        bytes32 scopeKey;
    }

    /// @dev The attachments of the 8 lookup scopes of `(actor, to, sel)` covering `effOp`, in
    ///      level order then storage order. Levels with a zero per-Safe counter are skipped.
    function _match(
        address safe,
        address actor,
        address to,
        bytes4 sel,
        Operation effOp
    ) internal view returns (Match[] memory matches) {
        uint256 levelCounts = _levelCounts[safe];
        if (levelCounts == 0) {
            return matches;
        }
        bytes32[8] memory keys;
        uint256[8] memory lengths;
        uint256 total;
        for (uint8 lvl = 0; lvl < Scope.LEVEL_COUNT; lvl++) {
            if (Scope.countAt(levelCounts, lvl) == 0) {
                continue;
            }
            bytes32 key = Scope.keyAt(lvl, actor, to, sel);
            uint256 length = _attachments[safe][key].length;
            keys[lvl] = key;
            lengths[lvl] = length;
            total += length;
        }
        matches = new Match[](total);
        uint8 bit = Scope.opBit(effOp);
        uint256 n;
        for (uint8 lvl = 0; lvl < Scope.LEVEL_COUNT; lvl++) {
            uint256 length = lengths[lvl];
            if (length == 0) {
                continue;
            }
            Attachment[] storage list = _attachments[safe][keys[lvl]];
            for (uint256 j = 0; j < length; j++) {
                Attachment memory a = list[j];
                if (a.opMask & bit != 0) {
                    matches[n++] = Match(lvl, a.kind, a.opMask, a.policyLevel, a.policy, keys[lvl]);
                }
            }
        }
        assembly ("memory-safe") {
            mstore(matches, n)
        }
    }

    /// @dev Typed PolicySignLib approvals are matched as CALL (SPEC.md §6.3, §10).
    function _effectiveOperation(address to, Operation operation, bytes4 sel) internal view returns (Operation) {
        if (
            operation == Operation.DELEGATECALL &&
            to == _SIGN_LIB &&
            (sel == IPolicySignLib.signPermit.selector ||
                sel == IPolicySignLib.signCowOrder.selector ||
                sel == IPolicySignLib.signPermit2.selector)
        ) {
            return Operation.CALL;
        }
        return operation;
    }

    function _calldataSelector(bytes calldata data) internal pure returns (bool ok, bytes4 sel) {
        if (data.length >= 4) {
            return (true, bytes4(data[:4]));
        }
        return (data.length == 0, bytes4(0));
    }
}
