// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IArgsPolicy} from "../interfaces/policies/IArgsPolicy.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title ArgsPolicy (WP0 stub)
 * @notice Compiles against the frozen {IArgsPolicy}; every function reverts. WP C replaces this
 *         file. SPEC.md §5.2.
 */
contract ArgsPolicy is PolicyBase, IArgsPolicy {
    error NotImplemented();

    function _configure(address, address, bytes32, Scope calldata, uint8, bytes calldata) internal pure override {
        revert NotImplemented();
    }

    function _check(address, Context calldata, Call[] calldata, Match[] calldata) internal pure override {
        revert NotImplemented();
    }

    function getSettings(address, address, bytes32) external pure returns (Settings memory) {
        revert NotImplemented();
    }

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }
}
