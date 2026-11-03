// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../../vendor/policy-engine/interfaces/IERC165.sol";
import {IPolicy} from "../../interfaces/IPolicy.sol";
import {IPolicyGuard} from "../../interfaces/IPolicyGuard.sol";
import {AttachmentView, Call, Context, Match, Scope} from "../../libraries/Types.sol";

/// @title Engine test target: records calls (CALL or DELEGATECALL), accepts value, and reverts
///        on the selector `0xbaadf00d`.
contract EngineTarget {
    event Hit(address sender, address self, uint256 value, bytes data);

    error TargetFailed();

    fallback() external payable {
        require(msg.data.length < 4 || bytes4(msg.data[:4]) != 0xbaadf00d, TargetFailed());
        emit Hit(msg.sender, address(this), msg.value, msg.data);
    }

    receive() external payable {
        emit Hit(msg.sender, address(this), msg.value, "");
    }
}

/**
 * @title Engine mock policy
 * @notice Scriptable policy for engine tests: the settings of each attachment choose how a check
 *         answers, and every check emits what it received. Implements {IPolicy} directly (not
 *         {PolicyBase}) so it can return malformed data.
 * @dev Settings: `abi.encode(uint8 behaviour, bytes callback)`. In one check the first non-PASS
 *      behaviour, in match order, decides. `CONFIG_REVERT` makes `configure` itself revert.
 */
contract EngineMockPolicy is IPolicy {
    enum Behaviour {
        PASS, //          return the magic value
        REVERT, //        revert MockDenied(attachmentId)
        WRONG_MAGIC, //   return 0xdeadbeef
        MALFORMED, //     return no data
        LONG_REVERT, //   revert with 1,000 bytes
        CALLBACK, //      call `callback` on the engine, bubble its revert, then pass
        CONFIG_REVERT, // revert in configure
        LONG_MAGIC, //    return the magic value followed by a second word
        CONFIG_PROBE //   in configure, read `getAttachment` for its own id and for
        //                `bytes32(callback)` from the engine, and emit what it saw
    }

    mapping(address engine => mapping(address safe => mapping(bytes32 id => Behaviour))) public behaviourOf;
    mapping(address engine => mapping(address safe => mapping(bytes32 id => bytes))) public callbackOf;

    event Configured(address engine, address safe, bytes32 attachmentId, Scope scope, uint8 opMask);
    event Checked(address engine, Context ctx, Call[] calls, Match[] matches);
    event ConfigureSaw(bool selfExists, uint8 selfOpMask, bool otherExists, uint8 otherOpMask);

    error MockDenied(bytes32 attachmentId);
    error MockConfigRejected();

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPolicy).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function configure(
        address safe,
        bytes32 attachmentId,
        Scope calldata scope,
        uint8 opMask,
        bytes calldata settings
    ) external {
        (uint8 behaviour, bytes memory callback) = abi.decode(settings, (uint8, bytes));
        require(behaviour != uint8(Behaviour.CONFIG_REVERT), MockConfigRejected());
        if (behaviour == uint8(Behaviour.CONFIG_PROBE)) {
            (bool selfExists, AttachmentView memory own) = IPolicyGuard(msg.sender).getAttachment(safe, attachmentId);
            (bool otherExists, AttachmentView memory other) = IPolicyGuard(msg.sender).getAttachment(
                safe,
                bytes32(callback)
            );
            emit ConfigureSaw(selfExists, own.opMask, otherExists, other.opMask);
        }
        behaviourOf[msg.sender][safe][attachmentId] = Behaviour(behaviour);
        callbackOf[msg.sender][safe][attachmentId] = callback;
        emit Configured(msg.sender, safe, attachmentId, scope, opMask);
    }

    function check(Context calldata ctx, Call[] calldata calls, Match[] calldata matches) external returns (bytes4) {
        emit Checked(msg.sender, ctx, calls, matches);
        Behaviour behaviour = Behaviour.PASS;
        bytes32 id;
        for (uint256 i = 0; i < matches.length; i++) {
            Behaviour b = behaviourOf[msg.sender][ctx.safe][matches[i].attachmentId];
            if (b != Behaviour.PASS) {
                (behaviour, id) = (b, matches[i].attachmentId);
                break;
            }
        }
        if (behaviour == Behaviour.REVERT) revert MockDenied(id);
        if (behaviour == Behaviour.CALLBACK) {
            (bool ok, bytes memory ret) = msg.sender.call(callbackOf[msg.sender][ctx.safe][id]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        bytes4 magic = IPolicy.check.selector;
        assembly ("memory-safe") {
            switch behaviour
            case 2 {
                mstore(0, shl(224, 0xdeadbeef))
                return(0, 0x20)
            }
            case 3 {
                return(0, 0)
            }
            case 4 {
                revert(0, 1000)
            }
            case 7 {
                mstore(0, magic)
                mstore(0x20, 1)
                return(0, 0x40)
            }
        }
        return magic;
    }
}

/// @title Engine test contract that claims or fails to be a policy (attach-time validation).
contract EngineBadPolicy {
    /// @dev 0: `supportsInterface` returns false; 1: it returns two words; 2: it reverts.
    uint256 public immutable MODE;

    constructor(uint256 mode) {
        MODE = mode;
    }

    function supportsInterface(bytes4) external view returns (bool) {
        uint256 mode = MODE;
        assembly ("memory-safe") {
            if eq(mode, 1) {
                mstore(0, 1)
                mstore(0x20, 1)
                return(0, 0x40)
            }
            if eq(mode, 2) {
                revert(0, 0)
            }
        }
        return false;
    }
}
