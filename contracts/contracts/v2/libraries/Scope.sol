// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {AttachmentKind, CallMatch, ScopeData} from "./Types.sol";

/**
 * @title Scope
 * @notice Sentinels, scope keys, scope levels, op masks and caps of the V2 engine. The app mirrors
 *         this file in `src/lib/v2/scopes.ts`; both must stay byte-for-byte equivalent (SPEC.md §3).
 * @dev Levels: a call by actor A to `to.selector` is looked up at 8 scopes, the product of the
 *      actor dimension {ANY, A} and the call dimension {any, to.*, *.selector, to.selector}:
 *
 *          level = (actor == ANY ? 0 : 4) + uint8(callMatch)
 *
 *          0 (ANY, *)          4 (A, *)
 *          1 (ANY, to.*)       5 (A, to.*)
 *          2 (ANY, *.sel)      6 (A, *.sel)
 *          3 (ANY, to.sel)     7 (A, to.sel)    ← the "exact scope"
 */
library Scope {
    /// @notice Actor wildcard: the scope applies to every actor, owners included.
    address internal constant ANY = address(0);

    /// @notice The owner path (`execTransaction`). Safe uses `address(1)` as its module-list
    ///         sentinel, so no module can have this address.
    address internal constant OWNERS = address(1);

    /// @notice Op mask bits: `1 << uint8(operation)`.
    uint8 internal constant OP_CALL = 1;
    uint8 internal constant OP_DELEGATECALL = 2;
    uint8 internal constant OP_ALL = 3;

    /// @notice Number of lookups per call and the offset of the actor-specific levels.
    uint8 internal constant LEVEL_COUNT = 8;
    uint8 internal constant ACTOR_LEVEL_OFFSET = 4;
    /// @notice The exact scope `(A, to.selector)`.
    uint8 internal constant EXACT_LEVEL = 7;

    /// @notice Caps (SPEC.md §9).
    uint256 internal constant MAX_ATTACHMENTS_PER_SCOPE = 8;
    uint256 internal constant MAX_BATCH_CALLS = 16;
    uint256 internal constant MAX_ROLE_MEMBERS = 8;
    uint256 internal constant MAX_TRUSTED_BATCHES = 4;
    uint256 internal constant MAX_REASON_LENGTH = 512;

    /// @notice `GateResult.callIndex` / error index for transaction-level runs.
    uint16 internal constant TX_INDEX = type(uint16).max;
    /// @notice `GateResult.scopeLevel` for engine rules.
    uint8 internal constant NO_LEVEL = type(uint8).max;

    /// @notice `keccak256("SafePolicyGuardV2.PolicyContext.v1")`: the SignatureExtension type of the
    ///         owner-path policy context.
    bytes32 internal constant CONTEXT_TYPE_HASH = keccak256("SafePolicyGuardV2.PolicyContext.v1");

    /**
     * @notice The storage key of a scope.
     * @dev `keccak256(abi.encode(actor, to, selector, uint8(callMatch)))`. The caller passes a
     *      normalized scope (wildcard parts zero, see {isNormalized}).
     */
    function key(address actor, address to, bytes4 selector, CallMatch callMatch) internal pure returns (bytes32) {
        return keccak256(abi.encode(actor, to, selector, uint8(callMatch)));
    }

    function key(ScopeData memory scope) internal pure returns (bytes32) {
        return key(scope.actor, scope.to, scope.selector, scope.callMatch);
    }

    /**
     * @notice The key of the scope a call `(actor, to, selector)` is looked up at, for one level.
     * @dev Zeroes the parts the level leaves open, so the result equals {key} of the attached scope.
     */
    function keyAt(uint8 lvl, address actor, address to, bytes4 selector) internal pure returns (bytes32) {
        CallMatch callMatch = CallMatch(lvl % ACTOR_LEVEL_OFFSET);
        return
            key(
                lvl < ACTOR_LEVEL_OFFSET ? ANY : actor,
                namesTo(callMatch) ? to : address(0),
                namesSelector(callMatch) ? selector : bytes4(0),
                callMatch
            );
    }

    /// @notice The level (0..7) of a scope.
    function level(address actor, CallMatch callMatch) internal pure returns (uint8) {
        return (actor == ANY ? 0 : ACTOR_LEVEL_OFFSET) + uint8(callMatch);
    }

    function level(ScopeData memory scope) internal pure returns (uint8) {
        return level(scope.actor, scope.callMatch);
    }

    function namesTo(CallMatch callMatch) internal pure returns (bool) {
        return callMatch == CallMatch.TO || callMatch == CallMatch.TO_SELECTOR;
    }

    function namesSelector(CallMatch callMatch) internal pure returns (bool) {
        return callMatch == CallMatch.SELECTOR || callMatch == CallMatch.TO_SELECTOR;
    }

    /// @notice Whether the parts a scope leaves open are zero. The engine rejects other scopes.
    function isNormalized(ScopeData memory scope) internal pure returns (bool) {
        return
            (namesTo(scope.callMatch) || scope.to == address(0)) &&
            (namesSelector(scope.callMatch) || scope.selector == bytes4(0));
    }

    /// @notice The id of an attachment; settings are keyed `(engine, safe, attachmentId)`.
    function attachmentId(bytes32 scopeKey, AttachmentKind kind, address policy) internal pure returns (bytes32) {
        return keccak256(abi.encode(scopeKey, uint8(kind), policy));
    }

    /// @notice The op mask bit of an operation.
    function opBit(Operation operation) internal pure returns (uint8) {
        return uint8(1) << uint8(operation);
    }

    /// @notice An op mask as stored: 0 means CALL only.
    function normalizeOpMask(uint8 opMask) internal pure returns (uint8) {
        return opMask == 0 ? OP_CALL : opMask;
    }

    /**
     * @notice The selector a call is matched with, as V1's `_decodeSelector`.
     * @return ok False for 1..3 bytes of calldata, which the engine denies (`InvalidSelector`).
     * @return selector The first 4 bytes, or `bytes4(0)` for empty calldata.
     */
    function selectorOf(bytes memory data) internal pure returns (bool ok, bytes4 selector) {
        if (data.length >= 4) {
            return (true, bytes4(data));
        }
        return (data.length == 0, bytes4(0));
    }

    /**
     * @notice Module-path transaction identity, bound to everything the module executes.
     * @dev No nonce and no chain id: proofs keyed by it are namespaced by `(engine, safe)` and
     *      consumed on use; policies that verify signatures over it wrap it in their own EIP-712
     *      domain (SPEC.md §7).
     */
    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes memory data,
        Operation operation
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(safe, actor, to, value, data, uint8(operation)));
    }

    /// @notice Count of attachments at one level, from the packed per-Safe counters (8 × uint32).
    function countAt(uint256 levelCounts, uint8 level_) internal pure returns (uint256) {
        return (levelCounts >> (32 * uint256(level_))) & type(uint32).max;
    }

    /// @notice Bit i set iff level i has at least one attachment.
    function bitmap(uint256 levelCounts) internal pure returns (uint8 bits) {
        for (uint8 i = 0; i < LEVEL_COUNT; i++) {
            if (countAt(levelCounts, i) != 0) {
                bits |= uint8(1) << i;
            }
        }
    }
}
