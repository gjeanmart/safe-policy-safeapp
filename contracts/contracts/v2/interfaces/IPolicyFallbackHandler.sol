// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title Policy fallback handler
 * @notice A Safe fallback handler (CompatibilityFallbackHandler without off-chain ERC-1271) whose
 *         `isValidSignature` accepts only messages the Safe approved on-chain, so every Safe
 *         signature is a Safe transaction the V2 engine checked (SPEC.md §10).
 * @dev Called through the Safe's fallback: `msg.sender` is the Safe. Keeps the token callbacks
 *      (ERC-721 / ERC-1155 receivers) and `getMessageHash*` of CompatibilityFallbackHandler.
 */
interface IPolicyFallbackHandler {
    /**
     * @notice ERC-1271. Returns `0x1626ba7e` iff `signature` is empty and
     *         `safe.signedMessages(getMessageHashForSafe(safe, abi.encode(hash))) != 0`; otherwise
     *         returns `0xffffffff` (never reverts on a non-empty signature, never checks owner signatures).
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);

    /// @notice Legacy ERC-1271 (`bytes` data): same rule over `keccak256(data)`, returns `0x20c13b0b`.
    function isValidSignature(bytes calldata data, bytes calldata signature) external view returns (bytes4);

    /// @notice EIP-712 `SafeMessage(bytes message)` hash under `safe`'s domain separator.
    function getMessageHashForSafe(address safe, bytes calldata message) external view returns (bytes32);

    /// @notice `getMessageHashForSafe(msg.sender, message)`.
    function getMessageHash(bytes calldata message) external view returns (bytes32);
}
