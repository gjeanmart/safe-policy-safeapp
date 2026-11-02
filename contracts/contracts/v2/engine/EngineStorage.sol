// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {Scope} from "../libraries/Scope.sol";
import {Attachment, AttachmentView, CallMatch, FreezeRole, FreezeState, ScopeData} from "../libraries/Types.sol";

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
        require(!_inCheck(), IPolicyEngineV2.Reentrancy());
    }

    function _inCheck() internal view returns (bool locked) {
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            locked := tload(slot)
        }
    }

    /// @dev Cleared at the end of every hook, so nested executions in one transaction (a module
    ///      call that triggers another Safe's checks) see an unlocked engine.
    function _setLock(bool on) internal {
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    function _isTrustedBatch(address target) internal view returns (bool trusted) {
        (address b0, address b1, address b2, address b3) = (_BATCH_0, _BATCH_1, _BATCH_2, _BATCH_3);
        assembly ("memory-safe") {
            trusted := and(
                iszero(iszero(target)),
                or(or(eq(target, b0), eq(target, b1)), or(eq(target, b2), eq(target, b3)))
            )
        }
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

    /**
     * @dev The attachments of the 8 lookup scopes of `(actor, to, sel)` covering `effOp`, in level
     *      order then storage order; levels with a zero per-Safe counter are skipped. Each match is
     *      its attachment's storage word (`policy | kind << 160 | opMask << 168 | policyLevel << 176`)
     *      with its level at bit `_MATCH_LEVEL_SHIFT`; `keys[level]` is the scope key of each
     *      populated level (`Scope.keyAt`). Assembly: one pass over raw slots, no per-match structs.
     */
    function _match(
        address safe,
        address actor,
        address to,
        bytes4 sel,
        Operation effOp
    ) internal view returns (uint256[] memory matches, bytes32[8] memory keys) {
        uint256 levelCounts = _levelCounts[safe];
        if (levelCounts == 0) {
            return (matches, keys);
        }
        assembly ("memory-safe") {
            let addressMask := 0xffffffffffffffffffffffffffffffffffffffff
            actor := and(actor, addressMask)
            to := and(to, addressMask)
            sel := and(sel, shl(224, 0xffffffff))
            mstore(0, and(safe, addressMask))
            mstore(0x20, _attachments.slot)
            let perSafe := keccak256(0, 0x40)
            let bit := shl(add(168, effOp), 1)
            matches := mload(0x40)
            let n := 0
            for {
                let lvl := 0
            } lt(lvl, 8) {
                lvl := add(lvl, 1)
            } {
                if and(shr(shl(5, lvl), levelCounts), 0xffffffff) {
                    // Scope.keyAt: keccak256(abi.encode(actor | ANY, to | 0, sel | 0, callMatch)),
                    // hashed past the matches written so far.
                    let callMatch := and(lvl, 3)
                    let m := add(matches, shl(5, add(n, 1)))
                    mstore(m, mul(actor, gt(lvl, 3)))
                    mstore(add(m, 0x20), mul(to, and(callMatch, 1)))
                    mstore(add(m, 0x40), mul(sel, shr(1, callMatch)))
                    mstore(add(m, 0x60), callMatch)
                    let key := keccak256(m, 0x80)
                    mstore(add(keys, shl(5, lvl)), key)
                    mstore(0, key)
                    mstore(0x20, perSafe)
                    let slot := keccak256(0, 0x40)
                    let length := sload(slot)
                    mstore(0, slot)
                    let data := keccak256(0, 0x20)
                    let tag := shl(_MATCH_LEVEL_SHIFT, lvl)
                    for {
                        let j := 0
                    } lt(j, length) {
                        j := add(j, 1)
                    } {
                        let word := sload(add(data, j))
                        if and(word, bit) {
                            n := add(n, 1)
                            mstore(add(matches, shl(5, n)), or(word, tag))
                        }
                    }
                }
            }
            mstore(matches, n)
            mstore(0x40, add(matches, shl(5, add(n, 1))))
        }
    }

    /// @dev Bit position of the scope level in a match word of {_match}.
    uint256 internal constant _MATCH_LEVEL_SHIFT = 184;

    /// @dev `Scope.attachmentId` hashing in scratch memory (no `abi.encode` allocation).
    function _attachmentId(bytes32 scopeKey, uint256 kind, address policy) internal pure returns (bytes32 id) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, scopeKey)
            mstore(add(m, 0x20), kind)
            mstore(add(m, 0x40), policy)
            id := keccak256(m, 0x60)
        }
    }

    /// @dev Typed PolicySignLib approvals are matched as CALL (SPEC.md §6.3, §10).
    function _effectiveOperation(address to, Operation operation, bytes4 sel) internal view returns (Operation) {
        (address signLib, bytes4 permit, bytes4 cowOrder, bytes4 permit2) = (
            _SIGN_LIB,
            IPolicySignLib.signPermit.selector,
            IPolicySignLib.signCowOrder.selector,
            IPolicySignLib.signPermit2.selector
        );
        bool typed;
        assembly ("memory-safe") {
            typed := and(
                and(eq(operation, 1), eq(to, signLib)),
                or(or(eq(sel, permit), eq(sel, cowOrder)), eq(sel, permit2))
            )
        }
        return typed ? Operation.CALL : operation;
    }

    function _calldataSelector(bytes calldata data) internal pure returns (bool ok, bytes4 sel) {
        if (data.length >= 4) {
            return (true, bytes4(data[:4]));
        }
        return (data.length == 0, bytes4(0));
    }
}
