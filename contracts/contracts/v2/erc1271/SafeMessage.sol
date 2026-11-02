// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafeV2} from "../interfaces/ISafeV2.sol";

/**
 * @title Safe message hash
 * @notice `CompatibilityFallbackHandler.getMessageHashForSafe`: the EIP-712 `SafeMessage(bytes message)`
 *         hash under the Safe's domain separator. Shared by the handler (which reads `signedMessages`)
 *         and the sign library (which writes it), so both always agree on the key.
 */
library SafeMessage {
    bytes32 internal constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");

    function encode(address safe, bytes memory message) internal view returns (bytes memory) {
        bytes32 safeMessageHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(message)));
        return abi.encodePacked(bytes1(0x19), bytes1(0x01), ISafeV2(safe).domainSeparator(), safeMessageHash);
    }

    function hash(address safe, bytes memory message) internal view returns (bytes32) {
        return keccak256(encode(safe, message));
    }
}
