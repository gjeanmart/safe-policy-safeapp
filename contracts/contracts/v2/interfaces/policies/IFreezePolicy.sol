// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title FreezePolicy (transaction level, stateless)
 * @notice Denies while a freeze the attachment reads is active, from the engine's
 *         `freezeStatus(safe, ctx.actor)`. Attached by placement (Owners, Ops, Agent…, never
 *         Recovery): recovery passes because nothing froze it. SPEC.md §8.1.
 */
interface IFreezePolicy {
    /**
     * @notice `abi.encode(Settings)`; at least one flag set.
     * @custom:member safeWide Read the Safe-wide freeze (`freeze(safes[])`).
     * @custom:member actor Read the freeze of the transaction's actor (`freezeActor`).
     */
    struct Settings {
        bool safeWide;
        bool actor;
    }

    /// @notice `until` is the end of the freeze that denied.
    error Frozen(address safe, address actor, uint256 until);

    error InvalidSettings();

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
