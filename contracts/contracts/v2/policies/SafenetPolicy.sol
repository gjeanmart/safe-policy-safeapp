// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafenetPolicy} from "../interfaces/policies/ISafenetPolicy.sol";
import {FROST} from "../libraries/frost/FROST.sol";
import {Secp256k1} from "../libraries/frost/Secp256k1.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title SafenetPolicy (WP0 stub, optional)
 * @notice Compiles against the frozen {ISafenetPolicy}; every function reverts. WP D replaces this
 *         file if time allows (port of `contracts/rev2/policies/SafenetPolicyV2.sol`). SPEC.md §5.5.
 */
contract SafenetPolicy is PolicyBase, ISafenetPolicy {
    error NotImplemented();

    function _configure(address, address, bytes32, Scope calldata, uint8, bytes calldata) internal pure override {
        revert NotImplemented();
    }

    function _check(address, Context calldata, Call[] calldata, Match[] calldata) internal pure override {
        revert NotImplemented();
    }

    function submitAttestation(address, address, bytes32, uint256, bytes calldata) external pure {
        revert NotImplemented();
    }

    function isAttested(address, address, bytes32) external pure returns (bool) {
        revert NotImplemented();
    }

    function attestationDigest(address, address, bytes32, uint256) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function updateEpoch(
        Secp256k1.Point calldata,
        uint64,
        uint64,
        uint64,
        Secp256k1.Point calldata,
        FROST.Signature calldata
    ) external pure {
        revert NotImplemented();
    }

    function isKnownEpoch(Secp256k1.Point calldata, uint64) external pure returns (bool) {
        revert NotImplemented();
    }

    function getConsensusDomainSeparator() external pure returns (bytes32) {
        revert NotImplemented();
    }

    function isAttestationSpent(FROST.Signature calldata) external pure returns (bool) {
        revert NotImplemented();
    }
}
