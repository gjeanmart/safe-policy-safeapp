// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicy} from "../interfaces/IPolicy.sol";
import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {IArgsPolicy} from "../interfaces/policies/IArgsPolicy.sol";
import {ICoSignerPolicy} from "../interfaces/policies/ICoSignerPolicy.sol";
import {ILimitPolicy} from "../interfaces/policies/ILimitPolicy.sol";
import {ISafenetPolicy} from "../interfaces/policies/ISafenetPolicy.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import "../libraries/Constants.sol" as C;
import {MultiSendDecoder} from "../libraries/MultiSendDecoder.sol";
import {ScopeLib} from "../libraries/Scope.sol";
import {Call, CallMatch, Kind, Scope} from "../libraries/Types.sol";

/**
 * @title Scope harness
 * @notice Exposes the frozen libraries, constants, selectors and interface ids so tests (and the
 *         TS mirror `src/lib/v2/rev3/types.ts`) are checked against the Solidity definitions.
 */
contract ScopeHarness {
    function key(Scope calldata scope) external pure returns (bytes32) {
        return ScopeLib.key(scope);
    }

    function keyAt(uint8 lvl, address actor, address to, bytes4 selector) external pure returns (bytes32) {
        return ScopeLib.keyAt(lvl, actor, to, selector);
    }

    function level(address actor, CallMatch callMatch) external pure returns (uint8) {
        return ScopeLib.level(actor, callMatch);
    }

    function isNormalized(Scope calldata scope) external pure returns (bool) {
        return ScopeLib.isNormalized(scope);
    }

    function attachmentId(bytes32 scopeKey, Kind kind, address policy) external pure returns (bytes32) {
        return ScopeLib.attachmentId(scopeKey, kind, policy);
    }

    function opBit(Operation operation) external pure returns (uint8) {
        return ScopeLib.opBit(operation);
    }

    function normalizeOpMask(Kind kind, uint8 opMask) external pure returns (uint8) {
        return ScopeLib.normalizeOpMask(kind, opMask);
    }

    function selectorOf(bytes calldata data) external pure returns (bool ok, bytes4 selector) {
        return ScopeLib.selectorOf(data);
    }

    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32) {
        return ScopeLib.moduleCallHash(safe, actor, to, value, data, operation);
    }

    function countAt(uint256 levelCounts, uint8 lvl) external pure returns (uint256) {
        return ScopeLib.countAt(levelCounts, lvl);
    }

    function bitmap(uint256 levelCounts) external pure returns (uint8) {
        return ScopeLib.bitmap(levelCounts);
    }

    function decodeMultiSend(
        address safe,
        bytes calldata data
    ) external pure returns (bool ok, bool tooMany, Call[] memory calls) {
        return MultiSendDecoder.decode(safe, data);
    }

    /// @notice `[ANY, OWNERS]` and `[OP_CALL, OP_DELEGATECALL, OP_ALL, LEVEL_COUNT,
    ///         ACTOR_LEVEL_OFFSET, EXACT_LEVEL, MAX_ATTACHMENTS_PER_SCOPE, MAX_BATCH_CALLS,
    ///         MAX_TRUSTED_BATCHES, MAX_REASON_LENGTH, MAX_ROLE_MEMBERS, MAX_ARGS_CONSTRAINTS,
    ///         MAX_ARGS_VALUES, MAX_LIMIT_TOKENS]`.
    function constants() external pure returns (address[2] memory actors, uint256[14] memory values) {
        actors = [ScopeLib.ANY, ScopeLib.OWNERS];
        values = [
            uint256(ScopeLib.OP_CALL),
            ScopeLib.OP_DELEGATECALL,
            ScopeLib.OP_ALL,
            ScopeLib.LEVEL_COUNT,
            ScopeLib.ACTOR_LEVEL_OFFSET,
            ScopeLib.EXACT_LEVEL,
            ScopeLib.MAX_ATTACHMENTS_PER_SCOPE,
            ScopeLib.MAX_BATCH_CALLS,
            ScopeLib.MAX_TRUSTED_BATCHES,
            ScopeLib.MAX_REASON_LENGTH,
            C.MAX_ROLE_MEMBERS,
            C.MAX_ARGS_CONSTRAINTS,
            C.MAX_ARGS_VALUES,
            C.MAX_LIMIT_TOKENS
        ];
    }

    /// @notice `[MULTI_SEND, ERC1271_MAGIC, ANY_SELECTOR, transfer, transferFrom, approve,
    ///         increaseAllowance, decreaseAllowance, IPolicyGuard.configure, IPolicy.check]`.
    function selectors() external pure returns (bytes4[10] memory) {
        return [
            C.MULTI_SEND_SELECTOR,
            C.ERC1271_MAGIC_VALUE,
            C.ANY_SELECTOR,
            C.ERC20_TRANSFER,
            C.ERC20_TRANSFER_FROM,
            C.ERC20_APPROVE,
            C.ERC20_INCREASE_ALLOWANCE,
            C.ERC20_DECREASE_ALLOWANCE,
            IPolicyGuard.configure.selector,
            IPolicy.check.selector
        ];
    }

    /// @notice ERC-165 ids: `[IPolicyGuard, IPolicy, ITimelockPolicy, IArgsPolicy, ILimitPolicy,
    ///         ICoSignerPolicy, ISafenetPolicy]`.
    function interfaceIds() external pure returns (bytes4[7] memory) {
        return [
            type(IPolicyGuard).interfaceId,
            type(IPolicy).interfaceId,
            type(ITimelockPolicy).interfaceId,
            type(IArgsPolicy).interfaceId,
            type(ILimitPolicy).interfaceId,
            type(ICoSignerPolicy).interfaceId,
            type(ISafenetPolicy).interfaceId
        ];
    }
}
