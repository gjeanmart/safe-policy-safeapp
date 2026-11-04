// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {SafePolicyGuard} from "../vendor/policy-engine/SafePolicyGuard.sol";
import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";

/**
 * @title Mock Safe
 * @notice Test double that drives the real SafePolicyGuard the way a Safe does: it is the
 *         `msg.sender` of the guard calls, so the guard and the policies see it as the Safe.
 * @dev It does not answer `getStorageAt`, so the guard treats it as having no guard installed and
 *      `configureImmediately` is allowed. Nothing is actually executed.
 */
contract MockSafe {
    /**
     * @notice Applies configurations instantly, as a Safe without the guard installed would.
     */
    function configure(SafePolicyGuard guard, SafePolicyGuard.Configuration[] calldata configurations) external {
        guard.configureImmediately(configurations);
    }

    /**
     * @notice Mimics `execTransactionFromModule` with `msg.sender` as the module: the pre-execution
     *         check, then the post-execution hook with the given outcome.
     * @param success Whether the (simulated) execution succeeded; `false` makes the guard revert,
     *        which must roll back any state the policies staged.
     */
    function execFromModule(
        SafePolicyGuard guard,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        bool success
    ) external {
        guard.checkModuleTransaction(to, value, data, operation, msg.sender);
        guard.checkAfterModuleExecution(bytes32(0), success);
    }
}
