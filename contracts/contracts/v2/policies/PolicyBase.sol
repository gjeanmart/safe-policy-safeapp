// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {IPolicy} from "../interfaces/IPolicy.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";

/**
 * @title Policy base (rev 3)
 * @notice Boilerplate for policies: ERC-165, the `check` dispatch and its PASS value, a match
 *         iterator and the settings key. A policy implements {_configure} and {_check}; it passes
 *         by returning and denies by reverting with a custom error. SPEC.md §4.
 * @dev The engine is `msg.sender` and is passed down as `engine`: every state access must be
 *      namespaced by it (IPolicy rule 1).
 */
abstract contract PolicyBase is IPolicy {
    /// @notice `check` was called with no match (the engine never does).
    error NoMatches();

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IPolicy).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @inheritdoc IPolicy
    function configure(
        address safe,
        bytes32 attachmentId,
        Scope calldata scope,
        uint8 opMask,
        bytes calldata settings
    ) external override {
        _configure(msg.sender, safe, attachmentId, scope, opMask, settings);
    }

    /// @inheritdoc IPolicy
    function check(
        Context calldata ctx,
        Call[] calldata calls,
        Match[] calldata matches
    ) external override returns (bytes4) {
        require(matches.length != 0, NoMatches());
        _check(msg.sender, ctx, calls, matches);
        return IPolicy.check.selector;
    }

    /// @inheritdoc IPolicy
    function validate(address safe) external virtual override {
        _validate(msg.sender, safe);
    }

    /// @dev Invariants over the final configuration of `safe` (IPolicy.validate); none by default.
    // solhint-disable-next-line no-empty-blocks
    function _validate(address engine, address safe) internal view virtual {}

    /// @dev Validates and stores the settings of `(engine, safe, attachmentId)`, fully overwriting
    ///      earlier ones. Revert to reject.
    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        Scope calldata scope,
        uint8 opMask,
        bytes calldata settings
    ) internal virtual;

    /// @dev Judges the transaction: return to pass, revert to deny. Must handle every match.
    function _check(
        address engine,
        Context calldata ctx,
        Call[] calldata calls,
        Match[] calldata matches
    ) internal virtual;

    /**
     * @dev Calls `fn` once per match, in order, with the matched call. For policies whose merge
     *      rule is "every (call, attachment) pair alone" (Args).
     */
    function _forEachMatch(
        address engine,
        Context calldata ctx,
        Call[] calldata calls,
        Match[] calldata matches,
        function(address, Context calldata, Call calldata, Match calldata) internal fn
    ) internal {
        for (uint256 i = 0; i < matches.length; i++) {
            fn(engine, ctx, calls[matches[i].callIndex], matches[i]);
        }
    }

    /// @dev The settings key of an attachment: `keccak256(abi.encode(engine, safe, attachmentId))`.
    function _settingsKey(address engine, address safe, bytes32 attachmentId) internal pure returns (bytes32) {
        return keccak256(abi.encode(engine, safe, attachmentId));
    }
}
