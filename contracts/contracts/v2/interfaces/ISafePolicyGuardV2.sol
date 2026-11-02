// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {ISafeModuleGuard} from "../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {IPolicyEngineV2} from "./IPolicyEngineV2.sol";

/**
 * @title The full ABI of a deployed SafePolicyGuardV2
 * @notice One address answers the engine API, both Safe guard hooks and the module list. The
 *         contract itself implements only the hooks and what policies read during a check;
 *         its fallback routes the rest to its modules (SPEC.md §14, D-14), so its compiled ABI
 *         is partial: use this one to talk to it.
 */
interface ISafePolicyGuardV2 is IPolicyEngineV2, ISafeTransactionGuard, ISafeModuleGuard {
    /// @notice The modules the engine DELEGATECALLs, in constructor order.
    function engineModules()
        external
        view
        returns (address config, address freeze, address preview, address views, address runner);
}
