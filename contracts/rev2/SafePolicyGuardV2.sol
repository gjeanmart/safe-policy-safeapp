// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";
import {SignatureExtension} from "../vendor/policy-engine/libraries/SignatureExtension.sol";
import {IPolicyEngineV2} from "./interfaces/IPolicyEngineV2.sol";
import {Scope} from "./libraries/Scope.sol";
import {Context, FreezeState} from "./libraries/Types.sol";
import {EngineEvaluator} from "./engine/EngineEvaluator.sol";
import {EngineModuleBase, engineParamsHash} from "./engine/EngineModuleBase.sol";
import {EngineStorage} from "./engine/EngineStorage.sol";

/**
 * @title Safe Policy Guard V2
 * @notice The V2 engine and Safe 1.5.0 guard: transaction guard (owner path) and module guard
 *         (module path), one address for Safes, guardians, policies and the app, answering the
 *         whole {IPolicyEngineV2} (its full ABI: {ISafePolicyGuardV2}). Every call of a
 *         transaction is looked up at the 8 scopes of its actor; built-in DENY and ALLOW decide
 *         grants, policies can only pass or deny. Normative behaviour: SPEC.md §6.
 * @dev Research prototype, unaudited. The engine is six contracts because one Sepolia transaction
 *      cannot deploy more than ~10 KB of code (SPEC.md §14, D-6 and D-14). This one holds the
 *      hooks (engine rules, scope lookup, built-in gates, batch decoding) and the views policies
 *      call during a check; it DELEGATECALLs {PolicyEngineV2Runner} to run matched policies, and
 *      {fallback} routes everything else (configuration, freeze, `preview`, the other views) to
 *      its module. Modules run on this storage, at this address.
 */
contract SafePolicyGuardV2 is EngineEvaluator {
    /// @dev {PolicyEngineV2Config}: configuration path and roles.
    address private immutable _CONFIG;
    /// @dev {PolicyEngineV2Freeze}: freeze, lift, and every view not routed elsewhere.
    address private immutable _FREEZE;
    /// @dev {PolicyEngineV2Preview}: `preview`.
    address private immutable _PREVIEW;
    /// @dev {PolicyEngineV2Views}: the enumeration views.
    address private immutable _VIEWS;
    /// @dev {PolicyEngineV2Runner}: policy runs of the hooks and of `preview`.
    address private immutable _RUNNER;

    /// @param modules `[config, freeze, preview, views, runner]`, each deployed with the same first
    ///        six arguments (checked through {EngineModuleBase.engineParams}, else `InvalidDeployment`).
    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib,
        address[5] memory modules
    ) EngineStorage(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {
        bytes32 params = engineParamsHash(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib);
        for (uint256 i = 0; i < modules.length; i++) {
            (bool ok, bytes memory result) = modules[i].staticcall(
                abi.encodeCall(EngineModuleBase.engineParams, ())
            );
            require(ok && result.length == 32 && bytes32(result) == params, IPolicyEngineV2.InvalidDeployment());
        }
        _CONFIG = modules[0];
        _FREEZE = modules[1];
        _PREVIEW = modules[2];
        _VIEWS = modules[3];
        _RUNNER = modules[4];
    }

    function _isPreview() internal pure override returns (bool) {
        return false;
    }

    function _runner(Frame memory) internal view override returns (address) {
        return _RUNNER;
    }

    // =============================================================================================
    // Routing to the modules
    // =============================================================================================

    /**
     * @notice Every {IPolicyEngineV2} function not implemented here: DELEGATECALLed to its module,
     *         whose result or revert is returned as is. A STATICCALL stays static in the module.
     *         Unknown selectors end in {PolicyEngineV2Freeze}, which has no fallback and reverts.
     */
    fallback() external {
        (address config, address module, address preview, address views) = (_CONFIG, _FREEZE, _PREVIEW, _VIEWS);
        // IPolicyEngineV2 selectors (Routing.test.ts checks each one reaches its module).
        assembly ("memory-safe") {
            switch shr(224, calldataload(0))
            case 0x7840ce71 /* configureImmediately */ {
                module := config
            }
            case 0xa809eb8e /* requestConfiguration */ {
                module := config
            }
            case 0x3eefdcce /* invalidateRoot */ {
                module := config
            }
            case 0x1d4ed8ec /* applyConfiguration */ {
                module := config
            }
            case 0x87c4cae3 /* preview */ {
                module := preview
            }
            case 0x48a11fa4 /* getScopes */ {
                module := views
            }
            case 0x26793279 /* getAttachments */ {
                module := views
            }
            case 0x64bd52bd /* getScopeAttachments */ {
                module := views
            }
            case 0xe1d5659f /* getAttachment */ {
                module := views
            }
            case 0xdbdbae90 /* getMatchingAttachments */ {
                module := views
            }
            case 0x01ffc9a7 /* supportsInterface (ERC-165) */ {
                module := views
            }
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), module, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    /// @notice The modules this engine DELEGATECALLs, in constructor order.
    function engineModules()
        external
        view
        returns (address config, address freeze, address preview, address views, address runner)
    {
        return (_CONFIG, _FREEZE, _PREVIEW, _VIEWS, _RUNNER);
    }

    // =============================================================================================
    // Views policies call during a check
    // =============================================================================================

    /// @notice See {IPolicyEngineV2-freezeStatus}.
    function freezeStatus(
        address safe,
        address actor
    ) external view returns (bool safeFrozen, bool actorFrozen, uint64 epoch) {
        FreezeState storage safeWide = _freezes[safe][Scope.ANY];
        safeFrozen = block.timestamp < safeWide.frozenUntil;
        epoch = safeWide.epoch;
        if (actor != Scope.ANY) {
            FreezeState storage own = _freezes[safe][actor];
            actorFrozen = block.timestamp < own.frozenUntil;
            epoch += own.epoch;
        }
    }

    /// @notice See {IPolicyEngineV2-SIGN_LIB}.
    function SIGN_LIB() external view returns (address) {
        return _SIGN_LIB;
    }

    // =============================================================================================
    // Safe 1.5.0 hooks
    // =============================================================================================

    /// @notice {ISafeTransactionGuard-checkTransaction}: the owner path (SPEC.md §6.1).
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 /* baseGas: read by the runner */,
        uint256 gasPrice,
        address /* gasToken */,
        address payable /* refundReceiver */,
        bytes calldata signatures,
        address msgSender
    ) external {
        require(gasPrice == 0, IPolicyEngineV2.NonZeroGasPrice());
        require(safeTxGas == 0, IPolicyEngineV2.NonZeroSafeTxGas());
        _requireNotInCheck();
        _setLock(true);
        Frame memory f;
        f.ctx = Context(msg.sender, Scope.OWNERS, bytes32(0), 0, msgSender);
        // A policy context is decoded by the runner, which then always runs before any deny
        // (so a malformed one is rejected first, §6.6).
        f.unvalidatedContext = SignatureExtension.has(signatures, Scope.CONTEXT_TYPE_HASH);
        _evaluate(f, to, value, data, operation);
        _setLock(false);
    }

    /// @notice {ISafeTransactionGuard-checkAfterExecution}.
    function checkAfterExecution(bytes32, bool success) external view {
        _requireNotInCheck();
        require(success, IPolicyEngineV2.ExecutionFailed());
    }

    /// @notice {ISafeModuleGuard-checkModuleTransaction}: the module path (SPEC.md §6.1).
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module
    ) external returns (bytes32 moduleTxHash) {
        _requireNotInCheck();
        _setLock(true);
        moduleTxHash = _moduleCallHash(msg.sender, module, to, value, data, operation);
        Frame memory f;
        f.ctx = Context(msg.sender, module, moduleTxHash, 0, module);
        f.ctxReady = true;
        _evaluate(f, to, value, data, operation);
        _setLock(false);
    }

    /// @notice {ISafeModuleGuard-checkAfterModuleExecution}.
    function checkAfterModuleExecution(bytes32, bool success) external view {
        _requireNotInCheck();
        require(success, IPolicyEngineV2.ModuleExecutionFailed());
    }
}
