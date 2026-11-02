// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {MultiSendDecoder} from "../libraries/MultiSendDecoder.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentChange, AttachmentKind, Call, CallMatch, RoleChange, ScopeData} from "../libraries/Types.sol";

/**
 * @title V2 harness
 * @notice Exposes the WP0 libraries and constants so tests (and the TS mirror) can be checked
 *         against the Solidity definitions.
 */
contract V2Harness {
    function key(ScopeData calldata scope) external pure returns (bytes32) {
        return Scope.key(scope);
    }

    function keyAt(uint8 lvl, address actor, address to, bytes4 selector) external pure returns (bytes32) {
        return Scope.keyAt(lvl, actor, to, selector);
    }

    function level(address actor, CallMatch callMatch) external pure returns (uint8) {
        return Scope.level(actor, callMatch);
    }

    function isNormalized(ScopeData calldata scope) external pure returns (bool) {
        return Scope.isNormalized(scope);
    }

    function attachmentId(bytes32 scopeKey, AttachmentKind kind, address policy) external pure returns (bytes32) {
        return Scope.attachmentId(scopeKey, kind, policy);
    }

    function selectorOf(bytes calldata data) external pure returns (bool ok, bytes4 selector) {
        return Scope.selectorOf(data);
    }

    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32) {
        return Scope.moduleCallHash(safe, actor, to, value, data, operation);
    }

    function bitmap(uint256 levelCounts) external pure returns (uint8) {
        return Scope.bitmap(levelCounts);
    }

    function configurationRoot(
        AttachmentChange[] calldata changes,
        RoleChange[] calldata roles
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(changes, roles));
    }

    function decodeMultiSend(
        address safe,
        bytes calldata data
    ) external pure returns (bool ok, bool tooMany, Call[] memory calls) {
        return MultiSendDecoder.decode(safe, data);
    }

    function contextTypeHash() external pure returns (bytes32) {
        return Scope.CONTEXT_TYPE_HASH;
    }

    function interfaceIds() external pure returns (bytes4 engine, bytes4 policy) {
        return (type(IPolicyEngineV2).interfaceId, type(IPolicyV2).interfaceId);
    }

    function signLibSelectors()
        external
        pure
        returns (bytes4 signPermit, bytes4 signCowOrder, bytes4 signPermit2, bytes4 signMessage)
    {
        return (
            IPolicySignLib.signPermit.selector,
            IPolicySignLib.signCowOrder.selector,
            IPolicySignLib.signPermit2.selector,
            IPolicySignLib.signMessage.selector
        );
    }
}
