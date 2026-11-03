// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {IPolicy} from "../IPolicy.sol";

/**
 * @title ArgsPolicy: conditions on a call's static arguments, target and value
 * @notice "Allow + conditions": attached next to an ALLOW (usually at the same scope), it pins
 *         recipients, spenders, receivers and caps for any protocol. Presets in the app:
 *         Recipients, Spenders, Receiver-is-the-Safe. SPEC.md §5.2.
 * @dev Settings: `abi.encode(Settings)`, keyed `(engine, safe, attachmentId)`. Stateless at check.
 *
 *      Merge rule: every `(call, attachment)` match is judged alone with that attachment's own
 *      constraints and `strict` flag; all must pass (AND). Within one attachment, every constraint
 *      whose `selector` equals the call's selector, or is `ANY_SELECTOR`, must hold (AND). If none
 *      applies, the call passes unless `strict` (`NoConstraint`). Empty calldata has selector
 *      `bytes4(0)` (plain native transfers).
 *
 *      Sees: the call's `to`, `value` and the 32-byte head words of its calldata. Cannot see:
 *      dynamic arguments (bytes, arrays, strings), nested calls, other calls of the batch, state.
 */
interface IArgsPolicy is IPolicy {
    /**
     * @notice What a constraint reads, as one 32-byte word `w`.
     * @dev WORD: `data[4 + 32 * index : 36 + 32 * index]` (missing: `ArgumentMissing`).
     *      CALL_TO: `uint256(uint160(call.to))`. VALUE: `call.value`. `index` must be 0 unless WORD.
     */
    enum Target {
        WORD,
        CALL_TO,
        VALUE
    }

    /**
     * @notice The comparison applied to `w`.
     * @dev EQ / NEQ: `w == values[0]` / `!=` (exactly 1 value). IN / NOT_IN: membership in
     *      `values` (1 to `MAX_ARGS_VALUES`). LTE / GTE: unsigned compare with `values[0]` (exactly 1
     *      value). EQ_SAFE: `w == uint256(uint160(ctx.safe))` (no values).
     */
    enum Op {
        EQ,
        NEQ,
        IN,
        NOT_IN,
        LTE,
        GTE,
        EQ_SAFE
    }

    /**
     * @custom:member selector The function it applies to, or `ANY_SELECTOR` (0xffffffff) for every
     *                call of the attachment.
     * @custom:member values Operands as ABI words (addresses left-padded).
     */
    struct Constraint {
        bytes4 selector;
        Target target;
        uint16 index;
        Op op;
        bytes32[] values;
    }

    /**
     * @custom:member constraints At most `MAX_ARGS_CONSTRAINTS`. An empty list must be `strict`:
     *                a carve-out that denies every matched call.
     * @custom:member strict Deny a call to which no constraint applies.
     * @dev `InvalidSettings`: over a cap, wrong value count for the op, `index != 0` for a non-WORD
     *      target, or an empty non-strict list (it would do nothing).
     */
    struct Settings {
        Constraint[] constraints;
        bool strict;
    }

    error InvalidSettings();
    /// @notice Constraint `constraintIndex` of `attachmentId` does not hold for call `callIndex`.
    error ConstraintFailed(uint16 callIndex, bytes32 attachmentId, uint16 constraintIndex);
    /// @notice The calldata of call `callIndex` is too short for WORD constraint `constraintIndex`.
    error ArgumentMissing(uint16 callIndex, bytes32 attachmentId, uint16 constraintIndex);
    /// @notice `strict` and no constraint of `attachmentId` applies to call `callIndex`.
    error NoConstraint(uint16 callIndex, bytes32 attachmentId);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    /// @notice `abi.encode(settings)`; exists so the ABI carries the settings type.
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
