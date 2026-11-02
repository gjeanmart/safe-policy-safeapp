// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {ISafePolicyGuardV2} from "../interfaces/ISafePolicyGuardV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {GateResult} from "../libraries/Types.sol";
import {EngineEvaluator} from "./EngineEvaluator.sol";
import {EngineModuleBase} from "./EngineModuleBase.sol";

/**
 * @title Policy Engine V2: preview
 * @notice `preview` (SPEC.md §6.7): the same evaluation as the guard's hooks, compiled to report
 *         every gate instead of stopping at the first deny. Reached by {SafePolicyGuardV2}
 *         through DELEGATECALL.
 */
contract PolicyEngineV2Preview is EngineEvaluator, EngineModuleBase {
    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineModuleBase(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {}

    function _isPreview() internal pure override returns (bool) {
        return true;
    }

    /// @dev The guard's runner: this code runs at the guard's address, so it asks the guard.
    function _runner(Frame memory) internal view override returns (address runner) {
        (, , , , runner) = ISafePolicyGuardV2(address(this)).engineModules();
    }

    // =============================================================================================
    // Preview
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}.
    function preview(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external onlyDelegated {
        require(actor != Scope.ANY, IPolicyEngineV2.InvalidActor(actor));
        _setLock(true);
        Frame memory f;
        f.ctx.safe = safe;
        f.ctx.actor = actor;
        if (actor != Scope.OWNERS) {
            f.ctx.txHash = _moduleCallHash(safe, actor, to, value, data, operation);
            f.ctx.executor = actor;
            f.ctxReady = true;
        }
        f.gates = new GateResult[](8);
        _evaluate(f, to, value, data, operation);
        GateResult[] memory gates = f.gates;
        uint256 count = f.gateCount;
        assembly ("memory-safe") {
            mstore(gates, count)
        }
        // Always reverts, so nothing a policy wrote (or the lock) persists.
        revert IPolicyEngineV2.Preview(gates);
    }
}
