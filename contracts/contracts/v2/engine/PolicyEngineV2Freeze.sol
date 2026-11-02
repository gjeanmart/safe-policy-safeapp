// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentChange, AttachmentKind, FreezeRole, FreezeState, RoleChange, ScopeData} from "../libraries/Types.sol";
import {EngineModuleBase} from "./EngineModuleBase.sol";

/**
 * @title Policy Engine V2: freeze and settings views
 * @notice The bounded freeze (SPEC.md §7.1) and the engine's small views (immutables, roles,
 *         freeze state, identity helpers). Reached by {SafePolicyGuardV2} through DELEGATECALL.
 *         The views policies call during a check (`freezeStatus`, `SIGN_LIB`) stay in the guard.
 */
contract PolicyEngineV2Freeze is EngineModuleBase {
    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineModuleBase(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {}

    // =============================================================================================
    // Freeze (SPEC.md §7.1), msg.sender is a guardian or a lifter
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}.
    function freeze(address[] calldata safes) external onlyDelegated {
        for (uint256 i = 0; i < safes.length; i++) {
            address safe = safes[i];
            require(_hasRole[safe][FreezeRole.GUARDIAN][msg.sender], IPolicyEngineV2.NotGuardian(safe));
            FreezeState storage state = _freezes[safe][Scope.ANY];
            if (block.timestamp < state.frozenUntil) {
                emit IPolicyEngineV2.FreezeSkipped(safe, msg.sender, state.frozenUntil);
            } else if (block.timestamp < state.cooldownUntil) {
                emit IPolicyEngineV2.FreezeSkipped(safe, msg.sender, state.cooldownUntil);
            } else {
                _startFreeze(safe, Scope.ANY, state);
            }
        }
    }

    /// @notice See {IPolicyEngineV2}.
    function freezeActor(address safe, address actor) external onlyDelegated {
        require(_hasRole[safe][FreezeRole.GUARDIAN][msg.sender], IPolicyEngineV2.NotGuardian(safe));
        require(actor != Scope.ANY && actor != Scope.OWNERS, IPolicyEngineV2.InvalidActor(actor));
        FreezeState storage state = _freezes[safe][actor];
        require(block.timestamp >= state.frozenUntil, IPolicyEngineV2.AlreadyFrozen(safe, actor, state.frozenUntil));
        require(
            block.timestamp >= state.cooldownUntil,
            IPolicyEngineV2.FreezeCooldown(safe, actor, state.cooldownUntil)
        );
        _startFreeze(safe, actor, state);
    }

    /// @notice See {IPolicyEngineV2}.
    function lift(address safe, address actor) external onlyDelegated {
        require(
            _hasRole[safe][FreezeRole.GUARDIAN][msg.sender] || _hasRole[safe][FreezeRole.LIFTER][msg.sender],
            IPolicyEngineV2.NotGuardianOrLifter(safe)
        );
        FreezeState storage state = _freezes[safe][actor];
        require(block.timestamp < state.frozenUntil, IPolicyEngineV2.NotFrozen(safe, actor));
        uint64 cooldownUntil = uint64(block.timestamp + _FREEZE_COOLDOWN);
        state.frozenUntil = uint64(block.timestamp);
        state.cooldownUntil = cooldownUntil;
        emit IPolicyEngineV2.Unfrozen(safe, actor, msg.sender, cooldownUntil);
    }

    function _startFreeze(address safe, address actor, FreezeState storage state) private {
        uint64 until = uint64(block.timestamp + _MAX_FREEZE);
        uint64 epoch = state.epoch + 1;
        state.frozenAt = uint64(block.timestamp);
        state.frozenUntil = until;
        state.cooldownUntil = uint64(block.timestamp + _MAX_FREEZE + _FREEZE_COOLDOWN);
        state.epoch = epoch;
        emit IPolicyEngineV2.Frozen(safe, actor, msg.sender, until, epoch);
    }

    // =============================================================================================
    // Views (reached through the guard's fallback; storage reads are `onlyDelegatedView`)
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}.
    function DELAY() external view returns (uint256) {
        return _DELAY;
    }

    /// @notice See {IPolicyEngineV2}.
    function EXPIRY() external view returns (uint256) {
        return _EXPIRY;
    }

    /// @notice See {IPolicyEngineV2}.
    function MAX_FREEZE() external view returns (uint256) {
        return _MAX_FREEZE;
    }

    /// @notice See {IPolicyEngineV2}.
    function FREEZE_COOLDOWN() external view returns (uint256) {
        return _FREEZE_COOLDOWN;
    }

    /// @notice See {IPolicyEngineV2}.
    function rootConfigured(address safe, bytes32 root) external view onlyDelegatedView returns (uint256) {
        return _rootConfigured[safe][root];
    }

    /// @notice See {IPolicyEngineV2}.
    function configurationRoot(
        AttachmentChange[] calldata changes,
        RoleChange[] calldata roles
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(changes, roles));
    }

    /// @notice See {IPolicyEngineV2}.
    function getFreezeState(
        address safe,
        address actor
    ) external view onlyDelegatedView returns (FreezeState memory) {
        return _freezes[safe][actor];
    }

    /// @notice See {IPolicyEngineV2}.
    function isGuardian(address safe, address account) external view onlyDelegatedView returns (bool) {
        return _hasRole[safe][FreezeRole.GUARDIAN][account];
    }

    /// @notice See {IPolicyEngineV2}.
    function isLifter(address safe, address account) external view onlyDelegatedView returns (bool) {
        return _hasRole[safe][FreezeRole.LIFTER][account];
    }

    /// @notice See {IPolicyEngineV2}.
    function getRoleMembers(
        address safe,
        FreezeRole role
    ) external view onlyDelegatedView returns (address[] memory) {
        return _roleMembers[safe][role];
    }

    /// @notice See {IPolicyEngineV2}.
    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32) {
        return Scope.moduleCallHash(safe, actor, to, value, data, operation);
    }

    /// @notice See {IPolicyEngineV2}.
    function scopeKey(ScopeData calldata scope) external pure returns (bytes32) {
        return Scope.key(scope);
    }

    /// @notice See {IPolicyEngineV2}.
    function attachmentId(bytes32 key, AttachmentKind kind, address policy) external pure returns (bytes32) {
        return Scope.attachmentId(key, kind, policy);
    }

    /// @notice See {IPolicyEngineV2}.
    function isTrustedBatch(address target) external view returns (bool) {
        return _isTrustedBatch(target);
    }

    /// @notice See {IPolicyEngineV2}.
    function getTrustedBatches() external view returns (address[] memory batches) {
        address[4] memory all = [_BATCH_0, _BATCH_1, _BATCH_2, _BATCH_3];
        batches = new address[](all.length);
        uint256 count;
        for (uint256 i = 0; i < all.length; i++) {
            if (all[i] != address(0)) {
                batches[count++] = all[i];
            }
        }
        assembly ("memory-safe") {
            mstore(batches, count)
        }
    }

    /// @notice See {IPolicyEngineV2}.
    function levelsUsed(address safe) external view onlyDelegatedView returns (uint8) {
        return Scope.bitmap(_levelCounts[safe]);
    }
}
