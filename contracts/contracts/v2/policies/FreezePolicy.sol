// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IFreezePolicy} from "../interfaces/policies/IFreezePolicy.sol";
import {Scope} from "../libraries/Scope.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";
import {PolicyBaseV2} from "../PolicyBaseV2.sol";

/**
 * @title Freeze policy (transaction level, stateless reader)
 * @notice Denies while a freeze it reads is active. The freeze state lives in the engine; this
 *         policy only applies it where it is attached (Owners, Ops, Agent, ..., never Recovery), so
 *         recovery passes a freeze because nothing froze it. SPEC.md §7.1, §8.1.
 */
contract FreezePolicy is PolicyBaseV2, IFreezePolicy {
    uint8 private constant _SAFE_WIDE = 1;
    uint8 private constant _ACTOR = 2;

    mapping(bytes32 settingsKey => uint8 flags) private _flags;

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.TRANSACTION;
    }

    /// @inheritdoc PolicyBaseV2
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IFreezePolicy).interfaceId || super.supportsInterface(interfaceId);
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256) {
        Settings memory settings = abi.decode(data, (Settings));
        uint8 flags = (settings.safeWide ? _SAFE_WIDE : 0) | (settings.actor ? _ACTOR : 0);
        require(flags != 0, InvalidSettings());
        _flags[_settingsKey(engine, safe, attachmentId)] = flags;
        return 0;
    }

    /// @dev Merge: deny if any attachment's flags hit. The Safe-wide freeze is reported first.
    function _checkTransaction(
        address engine,
        Context calldata ctx,
        Call[] calldata,
        bytes calldata,
        bytes calldata,
        bytes32[] calldata attachmentIds
    ) internal view override {
        uint8 flags;
        for (uint256 i = 0; i < attachmentIds.length; i++) {
            flags |= _flags[_settingsKey(engine, ctx.safe, attachmentIds[i])];
        }
        (bool safeFrozen, bool actorFrozen, ) = IPolicyEngineV2(engine).freezeStatus(ctx.safe, ctx.actor);
        if (safeFrozen && flags & _SAFE_WIDE != 0) {
            _deny(engine, ctx.safe, Scope.ANY);
        }
        if (actorFrozen && flags & _ACTOR != 0) {
            _deny(engine, ctx.safe, ctx.actor);
        }
    }

    /// @dev `actor` is the frozen key that denied: `Scope.ANY` for the Safe-wide freeze.
    function _deny(address engine, address safe, address actor) private view {
        revert Frozen(safe, actor, IPolicyEngineV2(engine).getFreezeState(safe, actor).frozenUntil);
    }

    /// @inheritdoc IFreezePolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory) {
        uint8 flags = _flags[_settingsKey(engine, safe, attachmentId)];
        return Settings({safeWide: flags & _SAFE_WIDE != 0, actor: flags & _ACTOR != 0});
    }

    /// @inheritdoc IFreezePolicy
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }
}
