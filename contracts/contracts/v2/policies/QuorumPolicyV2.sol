// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {IQuorumPolicyV2} from "../interfaces/policies/IQuorumPolicyV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

/**
 * @title Quorum policy V2
 * @notice Matched transactions need more owner signatures than the Safe threshold: per attachment a
 *         base requirement and optional tiers by amount moved; the strictest attachment wins.
 *         Port of V1 `IncreasedThresholdPolicy` (8ee68a8). SPEC.md §8.8.
 * @dev Owner path only: the module path carries no owner signatures ({ModulePathUnsupported}).
 *      The owners' signatures are the Safe's own `signatures` (sorted, at least `required` of
 *      them); the Safe already checked its threshold from the front, this policy checks
 *      `required` with `checkNSignatures(ctx.executor, ctx.txHash, ...)`. `executor` comes from the
 *      Safe (trusted), so the executing owner's `v = 1` signature counts as it does in the Safe.
 *      `ctx.txHash` pins the nonce: no spent-set is needed (V1 ran per sub-call of a batch).
 *
 *      Amounts per token are summed over the calls as LimitPolicy prices them (SPEC.md §8.4),
 *      with approvals counted at their full amount. A call it cannot price adds nothing, so a tier
 *      only means something next to ALLOWs on calls it can price (as LimitPolicy).
 */
contract QuorumPolicyV2 is PolicyBaseV2, IQuorumPolicyV2 {
    uint256 private constant _MAX_TIERS = 8;

    bytes4 private constant _TRANSFER = 0xa9059cbb; //            transfer(address,uint256)
    bytes4 private constant _TRANSFER_FROM = 0x23b872dd; //       transferFrom(address,address,uint256)
    bytes4 private constant _APPROVE = 0x095ea7b3; //             approve(address,uint256)
    bytes4 private constant _INCREASE_ALLOWANCE = 0x39509351; //  increaseAllowance(address,uint256)
    bytes4 private constant _SIGN_PERMIT = 0x51bdfa61; //         PolicySignLib.signPermit
    bytes4 private constant _SIGN_PERMIT2 = 0xda3c0cb0; //        PolicySignLib.signPermit2
    bytes4 private constant _SIGN_COW_ORDER = 0x3d296e04; //      PolicySignLib.signCowOrder

    mapping(bytes32 key => Settings) private _settings;

    /// @dev One priced spend of a call: `amount` of `token` (`address(0)` = native).
    struct Spend {
        address token;
        uint256 amount;
    }

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.TRANSACTION;
    }

    /// @inheritdoc IQuorumPolicyV2
    function getSettings(
        address engine,
        address safe,
        bytes32 attachmentId
    ) external view override returns (Settings memory) {
        return _settings[_settingsKey(engine, safe, attachmentId)];
    }

    /// @inheritdoc IQuorumPolicyV2
    function encodeSettings(Settings calldata settings) external pure override returns (bytes memory) {
        return abi.encode(settings);
    }

    /**
     * @notice The number of owner signatures the matched attachments require for `calls` of
     *         `safe`, clamped to the owner count (for the app; the check uses the same rule).
     */
    function requiredSignatures(
        address engine,
        address safe,
        Call[] calldata calls,
        bytes32[] calldata attachmentIds
    ) external view returns (uint256) {
        return _requiredSignatures(engine, safe, calls, attachmentIds);
    }

    /// @notice Decodes settings; external so that {_configure} can catch a malformed encoding.
    function decodeSettings(bytes calldata data) external pure returns (Settings memory) {
        return abi.decode(data, (Settings));
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256) {
        Settings memory settings;
        try this.decodeSettings(data) returns (Settings memory decoded) {
            settings = decoded;
        } catch {
            revert InvalidSettings();
        }
        require(settings.required != 0 && settings.tiers.length <= _MAX_TIERS, InvalidSettings());

        Settings storage stored = _settings[_settingsKey(engine, safe, attachmentId)];
        stored.required = settings.required;
        delete stored.tiers;
        for (uint256 i; i < settings.tiers.length; ++i) {
            require(settings.tiers[i].required != 0, InvalidSettings());
            stored.tiers.push(settings.tiers[i]);
        }
        return 0;
    }

    function _checkTransaction(
        address engine,
        Context calldata ctx,
        Call[] calldata calls,
        bytes calldata signatures,
        bytes calldata,
        bytes32[] calldata attachmentIds
    ) internal view override {
        require(ctx.actor == Scope.OWNERS, ModulePathUnsupported());
        uint256 required = _requiredSignatures(engine, ctx.safe, calls, attachmentIds);
        try ISafe(ctx.safe).checkNSignatures(ctx.executor, ctx.txHash, signatures, required) {} catch (
            bytes memory reason
        ) {
            revert QuorumNotMet(required, reason);
        }
    }

    function _requiredSignatures(
        address engine,
        address safe,
        Call[] calldata calls,
        bytes32[] calldata attachmentIds
    ) private view returns (uint256 required) {
        Spend[] memory spends;
        bool priced;
        for (uint256 i; i < attachmentIds.length; ++i) {
            Settings storage settings = _settings[_settingsKey(engine, safe, attachmentIds[i])];
            // Never configured (the engine always configures on SET): fail closed on an unmeetable 0.
            require(settings.required != 0, InvalidSettings());
            if (settings.required > required) required = settings.required;
            uint256 tierCount = settings.tiers.length;
            for (uint256 t; t < tierCount; ++t) {
                Tier storage tier = settings.tiers[t];
                if (tier.required <= required) continue;
                if (!priced) {
                    spends = _price(safe, calls);
                    priced = true;
                }
                if (_total(spends, tier.token) > tier.above) required = tier.required;
            }
        }
        uint256 owners = ISafe(safe).getOwners().length;
        if (required > owners) required = owners;
    }

    /// @dev Saturating: an overflowing total is "more than any tier", not a panic.
    function _total(Spend[] memory spends, address token) private pure returns (uint256 total) {
        for (uint256 i; i < spends.length; ++i) {
            if (spends[i].token != token) continue;
            bool ok;
            (ok, total) = _tryAdd(total, spends[i].amount);
            if (!ok) return type(uint256).max;
        }
    }

    /// @dev Up to two spends per call: its native value and what its calldata moves.
    function _price(address safe, Call[] calldata calls) private pure returns (Spend[] memory spends) {
        spends = new Spend[](calls.length * 2);
        uint256 count;
        for (uint256 i; i < calls.length; ++i) {
            Call calldata call = calls[i];
            if (call.value != 0) spends[count++] = Spend(address(0), call.value);
            (address token, uint256 amount) = _priceData(safe, call);
            if (amount != 0) spends[count++] = Spend(token, amount);
        }
        assembly ("memory-safe") {
            mstore(spends, count)
        }
    }

    /// @dev What a call's calldata moves; malformed or unknown calldata moves nothing.
    function _priceData(address safe, Call calldata call) private pure returns (address token, uint256 amount) {
        bytes calldata data = call.data;
        if (data.length < 4) return (address(0), 0);
        bytes4 selector = bytes4(data[:4]);
        if (call.operation == Operation.CALL) {
            if (selector == _TRANSFER || selector == _APPROVE || selector == _INCREASE_ALLOWANCE) {
                if (data.length >= 68) return (call.to, _word(data, 1));
            } else if (selector == _TRANSFER_FROM) {
                if (data.length >= 100 && _word(data, 0) == uint256(uint160(safe))) return (call.to, _word(data, 2));
            }
        } else if (selector == _SIGN_PERMIT || selector == _SIGN_PERMIT2) {
            // (token, spender, amount, ...): the token is an argument, the target is the sign library.
            if (data.length >= 100) return (address(uint160(_word(data, 0))), _word(data, 2));
        } else if (selector == _SIGN_COW_ORDER) {
            // GPv2Order (all static): sellToken word 0, sellAmount word 3, feeAmount word 7.
            if (data.length >= 260) {
                (bool ok, uint256 sum) = _tryAdd(_word(data, 3), _word(data, 7));
                return (address(uint160(_word(data, 0))), ok ? sum : type(uint256).max);
            }
        }
        return (address(0), 0);
    }

    function _word(bytes calldata data, uint256 index) private pure returns (uint256) {
        return uint256(bytes32(data[4 + 32 * index:36 + 32 * index]));
    }

    function _tryAdd(uint256 a, uint256 b) private pure returns (bool, uint256) {
        unchecked {
            uint256 c = a + b;
            return (c >= a, c);
        }
    }
}
