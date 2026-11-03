// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {IPolicy} from "../IPolicy.sol";

/**
 * @title LimitPolicy: per-token budgets ("Transfer budget" in the app)
 * @notice Counts what the Safe gives up control of, per attachment and token, on fixed windows.
 *         SPEC.md §5.3 (pricing table).
 * @dev Settings: `abi.encode(Settings)`, keyed `(engine, safe, attachmentId)`. `configure` resets
 *      the spent amounts and anchors every window at the configure time.
 *
 *      Pricing of one call (no reservation, no give-back):
 *      - `value > 0`: `value` of the native token (`address(0)`), on any call;
 *      - ERC-20 `transfer(to, a)`: `a` of token `call.to`;
 *      - `transferFrom(from, to, a)`: `a` if `from == safe`, else free;
 *      - `approve(s, a)` with `a > 0`, `increaseAllowance(s, a)`: `a`, in full;
 *      - `approve(s, 0)`, `decreaseAllowance`: free (revocations);
 *      - empty calldata with zero value: free;
 *      - anything else, and a spend of a token the attachment does not list: unpriced.
 *      An unpriced call denies (`Unpriced`) unless the attachment has `passUnpriced`.
 *
 *      Merge rule: each matched attachment keeps its own budgets and prices only the calls it
 *      matched, in call order, summed over the batch; all must fit (AND). `passUnpriced` applies
 *      per attachment. Debits are written only when the whole check passes.
 *
 *      Sees: each call's target, value and the ERC-20 head words. Cannot see: swap outputs,
 *      prices (no oracle, no USD caps), pulls through allowances given earlier, operator rights
 *      (`setApprovalForAll`, Morpho `setAuthorization`), off-chain signatures (permits). List only
 *      ERC-20 tokens: ERC-721 shares `transferFrom` and `approve`.
 */
interface ILimitPolicy is IPolicy {
    /**
     * @notice One token budget.
     * @custom:member token The ERC-20, or `address(0)` for the native token.
     * @custom:member amount Budget per window, in base units (> 0).
     * @custom:member period Window length in seconds; 0 = one-time budget (never refills).
     */
    struct TokenLimit {
        address token;
        uint128 amount;
        uint64 period;
    }

    /**
     * @custom:member limits 1 to `MAX_LIMIT_TOKENS`, no duplicate token (`InvalidSettings`).
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
    /// @notice Call `callIndex` brings the attachment's spend of `token` in this window above its budget.
    error LimitExceeded(uint16 callIndex, bytes32 attachmentId, address token, uint256 requested, uint256 available);
    /// @notice Call `callIndex` cannot be priced by `attachmentId`: `token` is the unlisted token
    ///         (`address(0)` for unlisted native value or an unknown shape).
    error Unpriced(uint16 callIndex, bytes32 attachmentId, address token, bytes4 selector);

    function remaining(
        address engine,
        address safe,
        bytes32 attachmentId,
        address token
    ) external view returns (Remaining memory);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    /// @notice `abi.encode(settings)`; exists so the ABI carries the settings type.
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
