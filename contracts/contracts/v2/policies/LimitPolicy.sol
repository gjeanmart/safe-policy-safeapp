// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ILimitPolicy} from "../interfaces/policies/ILimitPolicy.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title LimitPolicy (WP0 stub)
 * @notice Compiles against the frozen {ILimitPolicy}; every function reverts. WP C replaces this
 *         file. SPEC.md §5.3.
 */
contract LimitPolicy is PolicyBase, ILimitPolicy {
    error NotImplemented();

    function _configure(address, address, bytes32, Scope calldata, uint8, bytes calldata) internal pure override {
        revert NotImplemented();
    }

    function _check(address, Context calldata, Call[] calldata, Match[] calldata) internal pure override {
        revert NotImplemented();
    }

    function remaining(address, address, bytes32, address) external pure returns (Remaining memory) {
        revert NotImplemented();
    }

    function getSettings(address, address, bytes32) external pure returns (Settings memory) {
        revert NotImplemented();
    }

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }
}
