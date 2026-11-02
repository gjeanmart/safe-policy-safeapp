// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {PolicyLevel, ScopeData} from "../libraries/Types.sol";

/**
 * @title Pass-only policy for the gas measurements
 * @notice Passes every check (the base's empty `_checkCall` / `_checkTransaction`) and keeps no
 *         state, so a worst-case measurement shows the engine's own cost (lookups, dispatch, ABI
 *         encoding of the context, calls and ids) rather than a policy's.
 */
contract E2ePassPolicy is PolicyBaseV2 {
    PolicyLevel private immutable LEVEL;

    constructor(PolicyLevel level) {
        LEVEL = level;
    }

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public view override returns (PolicyLevel) {
        return LEVEL;
    }

    function _configure(
        address,
        address,
        bytes32,
        ScopeData calldata,
        uint8,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0;
    }
}
