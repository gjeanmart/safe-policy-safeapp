// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {CallMatch, Kind, Scope} from "./Types.sol";

/**
 * @title ScopeLib
 * @notice Actor sentinels, scope keys and levels, attachment ids, op masks, the module-path call
 *         hash and the caps of the rev 3 engine. Named `ScopeLib` because `Scope` is the struct.
 *         Mirrored in `src/lib/v2/rev3/types.ts`; both must stay equivalent (SPEC.md §2).
 * @dev A call by actor A to `to.selector` is looked up at 6 scopes, the product of the actor
 *      dimension {ANY, A} and the call dimension {any, to.*, to.selector}:
 *
 *          level = (actor == ANY ? 0 : 3) + uint8(callMatch)
 *
 *          0 (ANY, *)          3 (A, *)
 *          1 (ANY, to.*)       4 (A, to.*)
 *          2 (ANY, to.sel)     5 (A, to.sel)    <- the exact level
 */
library ScopeLib {
    /// @notice Actor wildcard: the scope applies to every actor, owners included.
    address internal constant ANY = address(0);

    /// @notice The owner path (`execTransaction`). Safe uses `address(1)` as its module-list
    ///         sentinel, so no module can have this address.
    address internal constant OWNERS = address(1);

    /// @notice Op mask bits: `1 << uint8(operation)`.
    uint8 internal constant OP_CALL = 1;
    uint8 internal constant OP_DELEGATECALL = 2;
    uint8 internal constant OP_ALL = 3;

    /// @notice Lookups per call, offset of the actor levels, and the exact level `(A, to.selector)`.
    uint8 internal constant LEVEL_COUNT = 6;
    uint8 internal constant ACTOR_LEVEL_OFFSET = 3;
    uint8 internal constant EXACT_LEVEL = 5;

    /// @notice At most this many attachments (ALLOW, DENY and POLICY together) at one scope.
    uint256 internal constant MAX_ATTACHMENTS_PER_SCOPE = 8;
    /// @notice At most this many calls in one trusted batch.
    uint256 internal constant MAX_BATCH_CALLS = 8;
    /// @notice At most this many trusted batch contracts per engine deployment.
    uint256 internal constant MAX_TRUSTED_BATCHES = 4;
    /// @notice A policy's revert data is truncated to this many bytes in `PolicyDenied`.
    uint256 internal constant MAX_REASON_LENGTH = 512;

    /**
     * @notice The storage key of a scope: `keccak256(abi.encode(actor, to, selector, uint8(callMatch)))`.
     * @dev The caller passes a normalized scope (open parts zero, see {isNormalized}).
     */
    function key(address actor, address to, bytes4 selector, CallMatch callMatch) internal pure returns (bytes32) {
        return keccak256(abi.encode(actor, to, selector, uint8(callMatch)));
    }

    function key(Scope memory scope) internal pure returns (bytes32) {
        return key(scope.actor, scope.to, scope.selector, scope.callMatch);
    }

    /**
     * @notice The key a call `(actor, to, selector)` is looked up at, for one level (0..5).
     * @dev Zeroes the parts the level leaves open, so the result equals {key} of the attached scope.
     */
    function keyAt(uint8 lvl, address actor, address to, bytes4 selector) internal pure returns (bytes32) {
        CallMatch callMatch = CallMatch(lvl % ACTOR_LEVEL_OFFSET);
        return
            key(
                lvl < ACTOR_LEVEL_OFFSET ? ANY : actor,
                callMatch == CallMatch.ANY ? address(0) : to,
                callMatch == CallMatch.FUNCTION ? selector : bytes4(0),
                callMatch
            );
    }

    /// @notice The level (0..5) of a scope.
    function level(address actor, CallMatch callMatch) internal pure returns (uint8) {
        return (actor == ANY ? 0 : ACTOR_LEVEL_OFFSET) + uint8(callMatch);
    }

    function level(Scope memory scope) internal pure returns (uint8) {
        return level(scope.actor, scope.callMatch);
    }

    /**
     * @notice Whether a scope is well formed: `to` is zero iff `callMatch == ANY`, and `selector`
     *         is zero unless `callMatch == FUNCTION`. The engine rejects other scopes (`InvalidScope`).
     */
    function isNormalized(Scope memory scope) internal pure returns (bool) {
        if (scope.callMatch == CallMatch.ANY) {
            return scope.to == address(0) && scope.selector == bytes4(0);
        }
        return scope.to != address(0) && (scope.callMatch == CallMatch.FUNCTION || scope.selector == bytes4(0));
    }

    /**
     * @notice The id of an attachment: `keccak256(abi.encode(scopeKey, uint8(kind), policy))`,
     *         `policy == address(0)` for ALLOW and DENY. One attachment per (scope, kind, policy).
     */
    function attachmentId(bytes32 scopeKey, Kind kind, address policy) internal pure returns (bytes32) {
        return keccak256(abi.encode(scopeKey, uint8(kind), policy));
    }

    /// @notice The op mask bit of an operation.
    function opBit(Operation operation) internal pure returns (uint8) {
        return uint8(1) << uint8(operation);
    }

    /**
     * @notice An op mask as stored. 0 is the default: CALL for ALLOW (a grant is narrow unless
     *         asked), both ops for DENY and POLICY (a restriction sees everything unless narrowed).
     * @dev The caller has already rejected masks above `OP_ALL`.
     */
    function normalizeOpMask(Kind kind, uint8 opMask) internal pure returns (uint8) {
        if (opMask != 0) return opMask;
        return kind == Kind.ALLOW ? OP_CALL : OP_ALL;
    }

    /**
     * @notice The selector a call is matched with.
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
     * @notice Module-path transaction identity: `keccak256(abi.encode(safe, actor, to, value, data,
     *         uint8(operation)))` of the top-level call.
     * @dev No nonce and no chain id: proofs keyed by it are namespaced by `(engine, safe)` and
     *      consumed on use; a policy that verifies signatures over it adds its own EIP-712 domain
     *      and a use counter.
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

    /// @notice Count of attachments at one level, from the packed per-Safe counters (6 x uint32).
    function countAt(uint256 levelCounts, uint8 lvl) internal pure returns (uint256) {
        return (levelCounts >> (32 * uint256(lvl))) & type(uint32).max;
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
