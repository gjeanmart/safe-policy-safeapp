// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";

/**
 * @title TimelockPolicy storage
 * @notice The storage layout and helpers shared by {TimelockPolicy} (the deployed policy) and
 *         {TimelockPolicyQueue} (its scheduling, reached by DELEGATECALL). Both
 *         inherit exactly this layout and declare no other state (`PolicyBaseV2` has none).
 */
abstract contract TimelockPolicyStorage {
    uint256 internal constant _MAX_CANCELLERS = 8;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("TimelockPolicy");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _CANCEL_TYPEHASH =
        keccak256("Cancel(address engine,address safe,bytes32 txHash,uint256 cancelCount)");

    mapping(bytes32 settingsKey => ITimelockPolicy.Settings) internal _settings;

    mapping(address engine => mapping(address safe => mapping(bytes32 txHash => ITimelockPolicy.Schedule)))
        internal _schedules;

    mapping(address engine => mapping(address safe => mapping(bytes32 txHash => address[]))) internal _cancellers;

    mapping(address engine => mapping(address safe => uint256)) internal _cancelCount;

    /// @dev `PolicyBaseV2._settingsKey`: the settings of one attachment of one engine and Safe.
    function _keyOf(address engine, address safe, bytes32 attachmentId) internal pure returns (bytes32) {
        return keccak256(abi.encode(engine, safe, attachmentId));
    }

    function _delete(address engine, address safe, bytes32 txHash) internal {
        delete _schedules[engine][safe][txHash];
        delete _cancellers[engine][safe][txHash];
    }

    /// @dev See {ITimelockPolicy-requiredCancelSignatures}.
    function _requiredCancelSignatures(address engine, address safe) internal view returns (uint256) {
        uint256 next = _cancelCount[engine][safe] + 1;
        uint256 threshold = ISafe(safe).getThreshold();
        return next < threshold ? next : threshold;
    }

    /// @dev See {ITimelockPolicy-cancelDigest}; `address(this)` is the policy (also under DELEGATECALL).
    function _cancelDigest(address engine, address safe, bytes32 txHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(
            abi.encode(_CANCEL_TYPEHASH, engine, safe, txHash, _cancelCount[engine][safe])
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
