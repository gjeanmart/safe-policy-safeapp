// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {IPolicyFallbackHandler} from "../interfaces/IPolicyFallbackHandler.sol";
import {ISafeV2} from "../interfaces/ISafeV2.sol";
import {SafeMessage} from "./SafeMessage.sol";

/**
 * @title Policy fallback handler
 * @notice Safe fallback handler whose ERC-1271 accepts only messages the Safe approved on-chain
 *         (through `PolicySignLib`, i.e. a Safe transaction the V2 engine checked). An owner
 *         signature, however valid, is never enough: that off-chain path is what lets a Permit,
 *         Permit2 or CoW order move funds without any guard check (SPEC.md §10).
 * @dev Reached through the Safe's `FallbackManager`: `msg.sender` is the Safe and the original caller
 *      is appended to the calldata (ignored here: ABI decoding skips trailing bytes). Keeps the token
 *      callbacks and message-hash helpers of `CompatibilityFallbackHandler`; drops its off-chain
 *      `checkSignatures` branch, `simulate` and `getModules`.
 */
contract PolicyFallbackHandler is IPolicyFallbackHandler, IERC165 {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant LEGACY_MAGIC_VALUE = 0x20c13b0b;
    bytes4 internal constant INVALID = 0xffffffff;

    /// @inheritdoc IPolicyFallbackHandler
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _approved(abi.encode(hash), signature) ? MAGIC_VALUE : INVALID;
    }

    /**
     * @inheritdoc IPolicyFallbackHandler
     * @dev Same message as `CompatibilityFallbackHandler`: `data` itself, so an approval made with
     *      Safe's `SignMessageLib.signMessage(data)` validates here too.
     */
    function isValidSignature(bytes calldata data, bytes calldata signature) external view returns (bytes4) {
        return _approved(data, signature) ? LEGACY_MAGIC_VALUE : INVALID;
    }

    /// @inheritdoc IPolicyFallbackHandler
    function getMessageHashForSafe(address safe, bytes calldata message) external view returns (bytes32) {
        return SafeMessage.hash(safe, message);
    }

    /// @inheritdoc IPolicyFallbackHandler
    function getMessageHash(bytes calldata message) external view returns (bytes32) {
        return SafeMessage.hash(msg.sender, message);
    }

    /// @notice The EIP-712 pre-image of {getMessageHashForSafe} (as `CompatibilityFallbackHandler`).
    function encodeMessageDataForSafe(address safe, bytes calldata message) external view returns (bytes memory) {
        return SafeMessage.encode(safe, message);
    }

    /// @notice ERC-1155 single receive hook.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    /// @notice ERC-1155 batch receive hook.
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0xbc197c81;
    }

    /// @notice ERC-721 safe-transfer receive hook.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    /// @notice ERC-777 recipient hook: accepts every transfer, as `CompatibilityFallbackHandler` 1.4.1.
    function tokensReceived(address, address, address, uint256, bytes calldata, bytes calldata) external pure {}

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x4e2312e0 || // ERC1155TokenReceiver
            interfaceId == 0x150b7a02 || // ERC721TokenReceiver
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == type(IPolicyFallbackHandler).interfaceId;
    }

    /// @dev A non-empty signature short-circuits before any external call, so that case never reverts.
    function _approved(bytes memory message, bytes calldata signature) private view returns (bool) {
        if (signature.length != 0) return false;
        return ISafeV2(msg.sender).signedMessages(SafeMessage.hash(msg.sender, message)) != 0;
    }
}
