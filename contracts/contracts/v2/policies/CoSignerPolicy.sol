// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ICoSignerPolicy} from "../interfaces/policies/ICoSignerPolicy.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title CoSignerPolicy (WP0 stub)
 * @notice Compiles against the frozen {ICoSignerPolicy}; every function reverts. WP D replaces
 *         this file. SPEC.md §5.4.
 */
contract CoSignerPolicy is PolicyBase, ICoSignerPolicy {
    error NotImplemented();

    function _configure(address, address, bytes32, Scope calldata, uint8, bytes calldata) internal pure override {
        revert NotImplemented();
    }

    function _check(address, Context calldata, Call[] calldata, Match[] calldata) internal pure override {
        revert NotImplemented();
    }

    function approve(address, address, bytes32, uint64) external pure {
        revert NotImplemented();
    }

    function approveWithSig(address, address, bytes32, address, uint64, bytes calldata) external pure {
        revert NotImplemented();
    }

    function revoke(address, address, bytes32) external pure {
        revert NotImplemented();
    }

    function approvalDigest(address, address, bytes32, uint64) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function useCount(address, address, bytes32) external pure returns (uint256) {
        revert NotImplemented();
    }

    function approvedUntil(address, address, bytes32, address) external pure returns (uint64) {
        revert NotImplemented();
    }

    function getSettings(address, address, bytes32) external pure returns (Settings memory) {
        revert NotImplemented();
    }

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }
}
