// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentKind, Call, CallMatch, Context, ScopeData} from "../libraries/Types.sol";

/**
 * @title Sign engine stub
 * @notice The slice of SPEC.md §6.3 that ERC-1271 relies on, for WP6 unit tests while the real engine
 *         (WP2) is built: ALLOW grants by op mask (`(OWNERS, *)` or exact `(to, selector)`), the
 *         `SIGN_LIB` typed-selector rule (DELEGATECALL matched as CALL), and one call-level policy that
 *         receives the original call, as the engine passes it.
 */
contract SignEngineStub {
    address public immutable SIGN_LIB;

    uint8 public anyCallOpMask;
    mapping(address to => mapping(bytes4 selector => uint8 opMask)) public exactOpMask;
    IPolicyV2 public policy;
    bytes32 public policyAttachmentId;

    error NotGranted(address to, bytes4 selector, Operation operation);
    error PolicyDenied(address policy, bytes reason);

    constructor(address signLib) {
        SIGN_LIB = signLib;
    }

    function allowAny(uint8 opMask) external {
        anyCallOpMask = opMask;
    }

    function allowExact(address to, bytes4 selector, uint8 opMask) external {
        exactOpMask[to][selector] = opMask;
    }

    /// @notice Attaches `policy_` (MockPolicyV2 settings) at `(OWNERS, *)` for `safe`.
    function attachPolicy(IPolicyV2 policy_, address safe, bytes memory settings) external {
        ScopeData memory scope = ScopeData(Scope.OWNERS, address(0), bytes4(0), CallMatch.ANY);
        bytes32 id = Scope.attachmentId(Scope.key(scope), AttachmentKind.POLICY, address(policy_));
        policy_.configure(safe, id, scope, 1, settings);
        (policy, policyAttachmentId) = (policy_, id);
    }

    /// @notice Owner-path check of one call, called by {SignSafeStub} before it executes.
    function checkCall(address to, uint256 value, bytes calldata data, Operation operation) external {
        bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        Operation effOp = operation;
        if (operation == Operation.DELEGATECALL && to == SIGN_LIB && _isTyped(sel)) effOp = Operation.CALL;
        uint8 bit = uint8(1) << uint8(effOp);
        if (anyCallOpMask & bit == 0 && exactOpMask[to][sel] & bit == 0) revert NotGranted(to, sel, operation);

        if (address(policy) == address(0)) return;
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = policyAttachmentId;
        Context memory ctx = Context(msg.sender, Scope.OWNERS, bytes32(0), 0, tx.origin);
        try policy.checkCall(ctx, Call(to, value, data, operation), ids) returns (bytes4 answer) {
            if (answer != IPolicyV2.checkCall.selector) revert PolicyDenied(address(policy), "");
        } catch (bytes memory reason) {
            revert PolicyDenied(address(policy), reason);
        }
    }

    function _isTyped(bytes4 sel) private pure returns (bool) {
        return
            sel == IPolicySignLib.signPermit.selector ||
            sel == IPolicySignLib.signCowOrder.selector ||
            sel == IPolicySignLib.signPermit2.selector;
    }
}
