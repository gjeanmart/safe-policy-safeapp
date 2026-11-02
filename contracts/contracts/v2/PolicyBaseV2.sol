// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../vendor/policy-engine/interfaces/IERC165.sol";
import {IPolicyV2} from "./interfaces/IPolicyV2.sol";
import {Call, Context, PolicyLevel, ScopeData} from "./libraries/Types.sol";

/**
 * @title Policy V2 base
 * @notice Boilerplate for V2 policies: ERC-165, level dispatch, the PASS magic values and settings
 *         keying. A policy overrides {policyLevel}, {_configure} and exactly one of {_checkCall} /
 *         {_checkTransaction}; it passes by returning and denies by reverting (with a custom error,
 *         which the engine reports as the reason).
 * @dev The engine is `msg.sender`: every state access is namespaced by it, so a direct call by
 *      anyone else only touches that caller's own namespace (IPolicyV2 rule 1). {_checkEngine} is
 *      the hook for a policy that wants to serve specific engines only; the default accepts any.
 */
abstract contract PolicyBaseV2 is IPolicyV2 {
    /// @notice The check function called does not match {policyLevel}.
    error WrongPolicyLevel();

    /// @notice The engine passed no attachment ids.
    error NoAttachments();

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IPolicyV2).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @inheritdoc IPolicyV2
    function policyLevel() public view virtual override returns (PolicyLevel);

    /// @inheritdoc IPolicyV2
    function configure(
        address safe,
        bytes32 attachmentId,
        ScopeData calldata scope,
        uint8 opMask,
        bytes calldata data
    ) external override returns (uint256 delayFloor) {
        _checkEngine(msg.sender);
        return _configure(msg.sender, safe, attachmentId, scope, opMask, data);
    }

    /// @inheritdoc IPolicyV2
    function checkCall(
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) external override returns (bytes4) {
        _checkEngine(msg.sender);
        require(policyLevel() == PolicyLevel.CALL, WrongPolicyLevel());
        require(attachmentIds.length != 0, NoAttachments());
        _checkCall(msg.sender, ctx, call, attachmentIds);
        return IPolicyV2.checkCall.selector;
    }

    /// @inheritdoc IPolicyV2
    function checkTransaction(
        Context calldata ctx,
        Call[] calldata calls,
        bytes calldata signatures,
        bytes calldata policyData,
        bytes32[] calldata attachmentIds
    ) external override returns (bytes4) {
        _checkEngine(msg.sender);
        require(policyLevel() == PolicyLevel.TRANSACTION, WrongPolicyLevel());
        require(attachmentIds.length != 0, NoAttachments());
        _checkTransaction(msg.sender, ctx, calls, signatures, policyData, attachmentIds);
        return IPolicyV2.checkTransaction.selector;
    }

    /**
     * @dev Validates and stores the settings of `(engine, safe, attachmentId)`, fully overwriting
     *      any previous ones. Revert to reject. Return the delay floor (0 unless a timelock).
     */
    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata scope,
        uint8 opMask,
        bytes calldata data
    ) internal virtual returns (uint256 delayFloor);

    /**
     * @dev Call-level check: return to pass, revert to deny. Only reached when {policyLevel} is
     *      CALL (checked in {checkCall}), so a transaction-level policy need not override it.
     */
    function _checkCall(address, Context calldata, Call calldata, bytes32[] calldata) internal virtual {}

    /**
     * @dev Transaction-level check: return to pass, revert to deny. Only reached when
     *      {policyLevel} is TRANSACTION, so a call-level policy need not override it.
     */
    function _checkTransaction(
        address,
        Context calldata,
        Call[] calldata,
        bytes calldata,
        bytes calldata,
        bytes32[] calldata
    ) internal virtual {}

    /// @dev Hook to restrict which engines may use the policy. Default: any (namespacing suffices).
    function _checkEngine(address) internal view virtual {}

    /// @dev The settings key of an attachment, for policies that flatten their mappings.
    function _settingsKey(address engine, address safe, bytes32 attachmentId) internal pure returns (bytes32) {
        return keccak256(abi.encode(engine, safe, attachmentId));
    }
}
