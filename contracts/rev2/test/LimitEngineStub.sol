// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {Call, Context, ScopeData} from "../libraries/Types.sol";

/**
 * @title Engine stub for policy unit tests
 * @notice Stands in for the V2 engine (`msg.sender` of the policies): forwards `configure` and
 *         `checkCall`, bubbles the policy's revert data, and serves the one engine view the
 *         call-level policies read (`SIGN_LIB`).
 */
contract LimitEngineStub {
    address public SIGN_LIB;

    error NotPass(bytes4 returned);

    function setSignLib(address signLib) external {
        SIGN_LIB = signLib;
    }

    function configure(
        IPolicyV2 policy,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata scope,
        uint8 opMask,
        bytes calldata data
    ) external returns (uint256) {
        return policy.configure(safe, attachmentId, scope, opMask, data);
    }

    /// @dev Reverts with the policy's own error on a deny, `NotPass` on a non-PASS return.
    function checkCall(IPolicyV2 policy, Context calldata ctx, Call calldata call, bytes32[] calldata ids) public {
        bytes4 magic = policy.checkCall(ctx, call, ids);
        require(magic == IPolicyV2.checkCall.selector, NotPass(magic));
    }

    /// @notice Checks several calls in order, as the engine does for the sub-calls of a batch.
    function checkBatch(IPolicyV2 policy, Context calldata ctx, Call[] calldata calls, bytes32[] calldata ids) external {
        for (uint256 i; i < calls.length; ++i) checkCall(policy, ctx, calls[i], ids);
    }
}
