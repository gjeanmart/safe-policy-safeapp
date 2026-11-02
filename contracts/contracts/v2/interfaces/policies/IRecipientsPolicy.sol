// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title RecipientsPolicy (call level)
 * @notice Restricts where value goes: ERC-20 `transfer` / `transferFrom` recipients, `approve` /
 *         `increaseAllowance` spenders and amounts, the native-value recipient (`to` whenever
 *         `value > 0`, any selector), and the PolicySignLib typed entries. SPEC.md §8.3.
 */
interface IRecipientsPolicy {
    /**
     * @notice `abi.encode(Settings)`.
     * @custom:member recipients Allowed `transfer`/`transferFrom` recipients, native-value targets
     *                and CoW order receivers. The Safe itself is always allowed.
     * @custom:member spenders Allowed `approve`/`increaseAllowance`/permit spenders.
     * @custom:member maxApproval Largest approval amount; `type(uint256).max` allows unlimited.
     *                Approvals of 0 always pass the amount check.
     * @custom:member strict Deny calls the policy cannot classify (any selector other than the
     *                ones above, with or without value); otherwise they pass this policy.
     */
    struct Settings {
        address[] recipients;
        address[] spenders;
        uint256 maxApproval;
        bool strict;
    }

    error InvalidSettings();
    error RecipientNotAllowed(address recipient);
    error SpenderNotAllowed(address spender);
    error ApprovalTooLarge(uint256 amount, uint256 maxApproval);
    error UnclassifiedCall(bytes4 selector);

    function isRecipient(address engine, address safe, bytes32 attachmentId, address account) external view returns (bool);

    function isSpender(address engine, address safe, bytes32 attachmentId, address account) external view returns (bool);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
