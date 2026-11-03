// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

/**
 * @title Mock policy V2
 * @notice Scriptable policy for engine tests: settings choose how it answers, and every check
 *         emits what it received. Implements {IPolicyV2} directly (not {PolicyBaseV2}) so it can
 *         return malformed data.
 * @dev Settings: `abi.encode(uint8 behaviour, uint256 delayFloor)`. In a run with several
 *      attachments the first non-PASS behaviour (in id order) decides.
 */
contract MockPolicyV2 is IPolicyV2 {
    enum Behaviour {
        PASS, //            return the magic value
        REVERT, //          revert MockDenied(attachmentId)
        WRONG_MAGIC, //     return 0xdeadbeef
        MALFORMED, //       return no data
        BURN_GAS, //        loop until out of gas
        WRONG_LEVEL_MAGIC // return the other check function's selector
    }

    PolicyLevel public immutable LEVEL;

    mapping(address engine => mapping(address safe => mapping(bytes32 id => Behaviour))) public behaviourOf;
    mapping(address engine => mapping(address safe => mapping(bytes32 id => uint256))) public configured;

    event Configured(address engine, address safe, bytes32 attachmentId, ScopeData scope, uint8 opMask);
    event CallChecked(address engine, Context ctx, Call call, bytes32[] attachmentIds);
    event TransactionChecked(
        address engine,
        Context ctx,
        uint256 callCount,
        bytes signatures,
        bytes policyData,
        bytes32[] attachmentIds
    );

    error MockDenied(bytes32 attachmentId);

    constructor(PolicyLevel level) {
        LEVEL = level;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPolicyV2).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function policyLevel() external view returns (PolicyLevel) {
        return LEVEL;
    }

    function configure(
        address safe,
        bytes32 attachmentId,
        ScopeData calldata scope,
        uint8 opMask,
        bytes calldata data
    ) external returns (uint256 delayFloor) {
        uint8 behaviour;
        (behaviour, delayFloor) = abi.decode(data, (uint8, uint256));
        behaviourOf[msg.sender][safe][attachmentId] = Behaviour(behaviour);
        configured[msg.sender][safe][attachmentId]++;
        emit Configured(msg.sender, safe, attachmentId, scope, opMask);
    }

    function checkCall(
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4) {
        emit CallChecked(msg.sender, ctx, call, attachmentIds);
        _answer(ctx.safe, attachmentIds, IPolicyV2.checkCall.selector, IPolicyV2.checkTransaction.selector);
    }

    function checkTransaction(
        Context calldata ctx,
        Call[] calldata calls,
        bytes calldata signatures,
        bytes calldata policyData,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4) {
        emit TransactionChecked(msg.sender, ctx, calls.length, signatures, policyData, attachmentIds);
        _answer(ctx.safe, attachmentIds, IPolicyV2.checkTransaction.selector, IPolicyV2.checkCall.selector);
    }

    /// @dev Never returns normally: writes the answer with assembly `return` or reverts.
    function _answer(address safe, bytes32[] calldata ids, bytes4 magic, bytes4 otherMagic) private view {
        Behaviour behaviour = Behaviour.PASS;
        bytes32 decidingId;
        for (uint256 i = 0; i < ids.length; i++) {
            Behaviour b = behaviourOf[msg.sender][safe][ids[i]];
            if (b != Behaviour.PASS) {
                (behaviour, decidingId) = (b, ids[i]);
                break;
            }
        }
        if (behaviour == Behaviour.REVERT) {
            revert MockDenied(decidingId);
        }
        if (behaviour == Behaviour.BURN_GAS) {
            uint256 x;
            while (gasleft() > 0) {
                x++;
            }
        }
        bytes4 answer = magic;
        if (behaviour == Behaviour.WRONG_MAGIC) {
            answer = 0xdeadbeef;
        } else if (behaviour == Behaviour.WRONG_LEVEL_MAGIC) {
            answer = otherMagic;
        }
        bool malformed = behaviour == Behaviour.MALFORMED;
        assembly ("memory-safe") {
            if malformed {
                return(0, 0)
            }
            mstore(0, answer)
            return(0, 32)
        }
    }
}
