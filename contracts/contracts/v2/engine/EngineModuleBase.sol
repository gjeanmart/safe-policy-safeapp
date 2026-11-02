// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {EngineStorage} from "./EngineStorage.sol";

/**
 * @title Engine module
 * @notice Base of the code {SafePolicyGuardV2} reaches by DELEGATECALL (configuration, freeze,
 *         preview and enumeration). A module is not an engine of its own: it runs on the guard's
 *         storage, at the guard's address, so Safes, guardians and policies only ever see the
 *         guard. The engine is split because one contract does not fit the code size a Sepolia
 *         transaction can deploy (SPEC.md §14, D-14).
 * @dev A module is deployed with the guard's own constructor arguments: the guard checks
 *      {engineParams} at construction, so both read the same immutables.
 */
abstract contract EngineModuleBase is EngineStorage {
    address private immutable _SELF = address(this);
    bytes32 private immutable _PARAMS;

    /// @notice Called directly instead of through the guard.
    error NotDelegated();

    /// @dev A direct call would act on this contract's own, unused storage: reject it. State
    ///      changes also refuse to run inside a check (SPEC.md §6.1).
    modifier onlyDelegated() {
        _requireDelegated();
        _requireNotInCheck();
        _;
    }

    /// @dev Directly, a view would read this contract's own, empty storage.
    modifier onlyDelegatedView() {
        _requireDelegated();
        _;
    }

    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineStorage(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {
        _PARAMS = engineParamsHash(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib);
    }

    /// @notice The hash of the constructor arguments this module was deployed with.
    function engineParams() external view returns (bytes32) {
        return _PARAMS;
    }

    function _requireDelegated() internal view {
        require(address(this) != _SELF, NotDelegated());
    }
}

/// @dev The identity of an engine's constructor arguments, shared by the guard and its modules.
function engineParamsHash(
    uint256 delay,
    uint256 expiry,
    uint256 maxFreeze,
    uint256 freezeCooldown,
    address[] memory trustedBatches,
    address signLib
) pure returns (bytes32) {
    return keccak256(abi.encode(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib));
}
