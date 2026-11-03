// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {ScopeLib} from "../libraries/Scope.sol";
import {AttachmentView, CallMatch, Kind, Scope} from "../libraries/Types.sol";

/**
 * @title Engine storage (rev 3)
 * @notice The storage layout and the scope lookup shared by {PolicyGuard} (hooks) and
 *         {PolicyGuardConfig} (configuration, views, `matches`), which the guard reaches by
 *         DELEGATECALL. Both inherit exactly this layout and declare no other state, so the
 *         configuration code reads and writes the guard's storage.
 * @dev An attachment is one storage word: `policy | uint8(kind) << 160 | opMask << 168`.
 */
abstract contract EngineStorage {
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

    /// @dev The hot path: one array per scope, one word per attachment.
    mapping(address safe => mapping(bytes32 scopeKey => uint256[])) internal _attachments;
    /// @dev 6 packed uint32 counters, one per level (`ScopeLib.countAt`).
    mapping(address safe => uint256) internal _levelCounts;
    mapping(address safe => mapping(bytes32 attachmentId => AttachmentRef)) internal _refs;
    mapping(address safe => bytes32[]) internal _scopeKeys;
    mapping(address safe => mapping(bytes32 scopeKey => ScopeRecord)) internal _scopes;
    /// @dev Attachments per policy contract: `configure` validates a policy only while it has some.
    mapping(address safe => mapping(address policy => uint256)) internal _policyCounts;

    /// @dev Transient re-entrancy flag, set while a hook evaluates.
    bytes32 private constant _LOCK_SLOT = keccak256("PolicyGuard.lock");

    /// @dev Bit position of the scope level in a word returned by {_match}.
    uint256 internal constant _LEVEL_SHIFT = 184;

    function _requireNotInCheck() internal view {
        bytes32 slot = _LOCK_SLOT;
        bool locked;
        assembly ("memory-safe") {
            locked := tload(slot)
        }
        require(!locked, IPolicyGuard.Reentrancy());
    }

    /// @dev Cleared at the end of every hook, so a later execution in the same transaction (another
    ///      Safe guarded by this engine, the next transaction of a bundle) sees an unlocked engine.
    function _setLock(bool on) internal {
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    /**
     * @dev The attachments of the 6 lookup scopes of `(actor, to, sel)` whose op mask has `opBit`,
     *      in level order then storage order; levels with a zero counter are skipped. Each match is
     *      its storage word with its level at bit {_LEVEL_SHIFT}; `keys[level]` is the scope key of
     *      each populated level (`ScopeLib.keyAt`). Assembly: one pass over raw slots.
     */
    function _match(
        address safe,
        address actor,
        address to,
        bytes4 sel,
        uint8 opBit
    ) internal view returns (uint256[] memory matches, bytes32[6] memory keys) {
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
            let bit := shl(168, and(opBit, 3))
            matches := mload(0x40)
            let n := 0
            for {
                let lvl := 0
            } lt(lvl, 6) {
                lvl := add(lvl, 1)
            } {
                if and(shr(shl(5, lvl), levelCounts), 0xffffffff) {
                    // ScopeLib.keyAt, hashed past the matches written so far.
                    let callMatch := mod(lvl, 3)
                    let m := add(matches, shl(5, add(n, 1)))
                    mstore(m, mul(actor, gt(lvl, 2)))
                    mstore(add(m, 0x20), mul(to, iszero(iszero(callMatch))))
                    mstore(add(m, 0x40), mul(sel, eq(callMatch, 2)))
                    mstore(add(m, 0x60), callMatch)
                    let key := keccak256(m, 0x80)
                    mstore(add(keys, shl(5, lvl)), key)
                    mstore(0, key)
                    mstore(0x20, perSafe)
                    let slot := keccak256(0, 0x40)
                    let length := sload(slot)
                    mstore(0, slot)
                    let data := keccak256(0, 0x20)
                    let tag := shl(_LEVEL_SHIFT, lvl)
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

    /// @dev `ScopeLib.attachmentId` hashed in scratch memory (no `abi.encode` allocation).
    function _attachmentId(bytes32 scopeKey, uint256 kind, address policy) internal pure returns (bytes32 id) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, scopeKey)
            mstore(add(m, 0x20), kind)
            mstore(add(m, 0x40), policy)
            id := keccak256(m, 0x60)
        }
    }

    /// @dev The view of the attachment at `word` of scope `key`.
    function _view(address safe, bytes32 key, uint256 word) internal view returns (AttachmentView memory) {
        ScopeRecord storage record = _scopes[safe][key];
        address policy = address(uint160(word));
        uint8 kind = uint8(word >> 160);
        return
            AttachmentView({
                attachmentId: _attachmentId(key, kind, policy),
                scopeKey: key,
                scope: Scope(record.actor, record.to, record.selector, record.callMatch),
                kind: Kind(kind),
                policy: policy,
                opMask: uint8(word >> 168)
            });
    }

    /// @dev The last call's return data, truncated to `ScopeLib.MAX_REASON_LENGTH` (no return bomb).
    function _boundedReturnData() internal pure returns (bytes memory reason) {
        uint256 maxLength = ScopeLib.MAX_REASON_LENGTH;
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
}
