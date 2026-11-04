// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicy} from "../../interfaces/IPolicy.sol";
import {Call, Context, Match, Scope} from "../../libraries/Types.sol";

/**
 * @title Engine stub for the Args and Limit unit tests
 * @notice Stands in for the engine (`msg.sender` of the policies): forwards `configure` and
 *         `check` and bubbles the policy's revert data, so tests see the policy's own errors.
 */
contract ArgsLimitEngineStub {
    error NotPass(bytes4 returned);

    function configure(
        IPolicy policy,
        address safe,
        bytes32 attachmentId,
        Scope calldata scope,
        uint8 opMask,
        bytes calldata settings
    ) external {
        policy.configure(safe, attachmentId, scope, opMask, settings);
    }

    /// @dev Reverts with the policy's error on a deny, `NotPass` on a wrong return value.
    function check(IPolicy policy, Context calldata ctx, Call[] calldata calls, Match[] calldata matches) external {
        bytes4 magic = policy.check(ctx, calls, matches);
        require(magic == IPolicy.check.selector, NotPass(magic));
    }
}
