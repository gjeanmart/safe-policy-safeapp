// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title ArgsPolicy (call level)
 * @notice Constraints on decoded static arguments (e.g. ERC-4626 `deposit` receiver == Safe).
 *         SPEC.md §8.5.
 */
interface IArgsPolicy {
    /**
     * @notice Comparison applied to the 32-byte argument word `w`.
     * @dev EQ / NEQ: `w == values[0]`; IN / NOT_IN: membership in `values`; LTE / GTE: unsigned
     *      compare with `values[0]`; EQ_SAFE: `w == uint256(uint160(safe))` (no values).
     */
    enum ArgOp {
        EQ,
        NEQ,
        IN,
        NOT_IN,
        LTE,
        GTE,
        EQ_SAFE
    }

    /**
     * @custom:member selector The function the constraint applies to.
     * @custom:member argIndex Static word index: `data[4 + 32 * argIndex : 4 + 32 * (argIndex + 1)]`.
     * @custom:member values Operands (≤ 32), as ABI words (addresses left-padded).
     */
    struct ArgConstraint {
        bytes4 selector;
        uint16 argIndex;
        ArgOp op;
        bytes32[] values;
    }

    /**
     * @notice `abi.encode(Settings)`; at most 16 constraints.
     * @custom:member strict Deny calls whose selector has no constraint; otherwise they pass.
     */
    struct Settings {
        ArgConstraint[] constraints;
        bool strict;
    }

    error InvalidSettings();
    error ArgViolation(bytes4 selector, uint16 argIndex);
    /// @notice The calldata is too short for the constrained argument.
    error ArgMissing(bytes4 selector, uint16 argIndex);
    error NoConstraint(bytes4 selector);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
