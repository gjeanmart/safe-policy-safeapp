// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title QuorumPolicyV2 (transaction level, owner path)
 * @notice Requires N valid owner signatures over the Safe transaction hash, N per attachment with
 *         optional tiers by amount (port of V1 `IncreasedThresholdPolicy`). Denies on the module
 *         path. SPEC.md §8.8.
 */
interface IQuorumPolicyV2 {
    /**
     * @notice A tier: when the transaction moves more than `above` of `token` in total (summed over
     *         its calls as LimitPolicy prices them; `address(0)` = native), require `required`.
     */
    struct Tier {
        address token;
        uint256 above;
        uint8 required;
    }

    /**
     * @notice `abi.encode(Settings)`; `required >= 1`, at most 8 tiers. The effective requirement is
     *         clamped to the owner count.
     */
    struct Settings {
        uint8 required;
        Tier[] tiers;
    }

    error InvalidSettings();
    error ModulePathUnsupported();
    /// @notice `ISafe.checkNSignatures` rejected the signatures; `reason` is its revert data.
    error QuorumNotMet(uint256 required, bytes reason);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
