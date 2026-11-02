// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title LimitPolicy (call level), "Transfer budget" in the UI
 * @notice Per-attachment, per-token budgets on fixed windows. Counts where the Safe gives up
 *         control: `transfer`, `transferFrom` from the Safe, `approve` / `increaseAllowance` as a
 *         reservation (with same-window give-back), native value on any call, and the
 *         PolicySignLib typed entries. Denies what it cannot price unless `passUnpriced`. SPEC.md §8.4.
 */
interface ILimitPolicy {
    /**
     * @notice One token budget.
     * @custom:member token The ERC-20, or `address(0)` for the native token.
     * @custom:member amount Budget per window, in base units (> 0).
     * @custom:member period Window length in seconds; 0 = one-time budget. Windows are a fixed grid
     *                anchored at configure time (as V1 `SpendingLimitPolicy`).
     */
    struct TokenLimit {
        address token;
        uint128 amount;
        uint64 period;
    }

    /**
     * @notice `abi.encode(Settings)`; at most 16 tokens, no duplicates.
     * @custom:member passUnpriced Let calls this attachment cannot price pass (default: deny).
     */
    struct Settings {
        TokenLimit[] limits;
        bool passUnpriced;
    }

    /// @notice The budget of one token of one attachment, as it applies now.
    struct Remaining {
        uint256 amount;
        uint256 spent;
        uint256 available;
        uint64 period;
        uint64 windowStart;
    }

    error InvalidSettings();
    error LimitExceeded(bytes32 attachmentId, address token, uint256 requested, uint256 available);
    /// @notice `token` is `address(0)` when the call's shape is unknown, else the unlisted token.
    error Unpriced(bytes32 attachmentId, address token, bytes4 selector);

    function remaining(
        address engine,
        address safe,
        bytes32 attachmentId,
        address token
    ) external view returns (Remaining memory);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
