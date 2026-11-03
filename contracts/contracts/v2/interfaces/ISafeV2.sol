// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";

/**
 * @title Safe 1.5.0 functions used by the V2 engine and policies, beyond the vendored {ISafe}.
 * @dev The vendored {ISafe} already has `getTransactionHash`, `nonce`, `getOwners`,
 *      `getThreshold`, `checkNSignatures(executor, ...)` (1.5.0 form), `setGuard`,
 *      `setModuleGuard`, `getStorageAt`, `execTransaction` and `execTransactionFromModule`.
 */
interface ISafeV2 is ISafe {
    function domainSeparator() external view returns (bytes32);

    function isOwner(address owner) external view returns (bool);

    function isModuleEnabled(address module) external view returns (bool);

    function getModulesPaginated(
        address start,
        uint256 pageSize
    ) external view returns (address[] memory array, address next);

    /// @notice Non-zero when the Safe approved `messageHash` on-chain (SignMessageLib).
    function signedMessages(bytes32 messageHash) external view returns (uint256);

    function approvedHashes(address owner, bytes32 hash) external view returns (uint256);

    function setFallbackHandler(address handler) external;

    function enableModule(address module) external;

    function disableModule(address prevModule, address module) external;
}
