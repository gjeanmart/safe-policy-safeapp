// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title TimelockPolicy (WP0 stub)
 * @notice Compiles against the frozen {ITimelockPolicy}; every function reverts. WP B replaces
 *         this file (and may add `TimelockPolicyQueue.sol`). SPEC.md §5.1.
 */
contract TimelockPolicy is PolicyBase, ITimelockPolicy {
    error NotImplemented();

    uint256 public immutable override MAX_FREEZE;
    uint256 public immutable override COOLDOWN;

    constructor(uint256 maxFreeze, uint256 cooldown) {
        MAX_FREEZE = maxFreeze;
        COOLDOWN = cooldown;
    }

    function _configure(address, address, bytes32, Scope calldata, uint8, bytes calldata) internal pure override {
        revert NotImplemented();
    }

    function _check(address, Context calldata, Call[] calldata, Match[] calldata) internal pure override {
        revert NotImplemented();
    }

    function schedule(address, address, SafeTransaction calldata, bytes calldata) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function scheduleModuleTx(
        address,
        address,
        address,
        uint256,
        bytes calldata,
        Operation
    ) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function cancel(address, address, bytes32) external pure {
        revert NotImplemented();
    }

    function cancelAsOwners(address, address, bytes32, bytes calldata) external pure {
        revert NotImplemented();
    }

    function freeze(address, address, bytes32[] calldata) external pure {
        revert NotImplemented();
    }

    function lift(address, address, bytes32) external pure {
        revert NotImplemented();
    }

    function getSettings(address, address, bytes32) external pure returns (Settings memory) {
        revert NotImplemented();
    }

    function configuredAt(address, address, bytes32) external pure returns (uint256) {
        revert NotImplemented();
    }

    function getSchedule(address, address, bytes32) external pure returns (Schedule memory) {
        revert NotImplemented();
    }

    function freezeState(address, address, bytes32) external pure returns (uint64, uint64) {
        revert NotImplemented();
    }

    function cancelDigest(address, address, bytes32) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }
}
