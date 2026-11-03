// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyGuard} from "./interfaces/IPolicyGuard.sol";
import {AttachmentView, Call, Change, Kind, MatchView, Scope} from "./libraries/Types.sol";

/**
 * @title Policy Guard (WP0 stub)
 * @notice Compiles against the frozen {IPolicyGuard}; every function reverts. WP A replaces this
 *         file (and may add `PolicyGuardConfig.sol` and `engine/*`). SPEC.md §3.
 */
contract PolicyGuard is IPolicyGuard {
    error NotImplemented();

    function supportsInterface(bytes4) external pure returns (bool) {
        revert NotImplemented();
    }

    function checkTransaction(
        address,
        uint256,
        bytes calldata,
        Operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes calldata,
        address
    ) external pure {
        revert NotImplemented();
    }

    function checkAfterExecution(bytes32, bool) external pure {
        revert NotImplemented();
    }

    function checkModuleTransaction(
        address,
        uint256,
        bytes calldata,
        Operation,
        address
    ) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function checkAfterModuleExecution(bytes32, bool) external pure {
        revert NotImplemented();
    }

    function configure(Change[] calldata) external pure {
        revert NotImplemented();
    }

    function matches(
        address,
        address,
        address,
        uint256,
        bytes calldata,
        Operation
    ) external pure returns (Call[] memory, MatchView[] memory, bytes memory) {
        revert NotImplemented();
    }

    function getScopes(address) external pure returns (bytes32[] memory, Scope[] memory) {
        revert NotImplemented();
    }

    function getAttachments(address) external pure returns (AttachmentView[] memory) {
        revert NotImplemented();
    }

    function getScopeAttachments(address, bytes32) external pure returns (AttachmentView[] memory) {
        revert NotImplemented();
    }

    function getAttachment(address, bytes32) external pure returns (bool, AttachmentView memory) {
        revert NotImplemented();
    }

    function levelsUsed(address) external pure returns (uint8) {
        revert NotImplemented();
    }

    function trustedBatches() external pure returns (address[] memory) {
        revert NotImplemented();
    }

    function isTrustedBatch(address) external pure returns (bool) {
        revert NotImplemented();
    }

    function scopeKey(Scope calldata) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function attachmentId(bytes32, Kind, address) external pure returns (bytes32) {
        revert NotImplemented();
    }

    function moduleCallHash(
        address,
        address,
        address,
        uint256,
        bytes calldata,
        Operation
    ) external pure returns (bytes32) {
        revert NotImplemented();
    }
}
