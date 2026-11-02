// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {IArgsPolicy} from "../interfaces/policies/IArgsPolicy.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

/**
 * @title ArgsPolicy
 * @notice Call-level constraints on static calldata arguments (SPEC.md §8.5), e.g. "the receiver
 *         of an ERC-4626 `deposit` is the Safe". Every constraint of every matched attachment whose
 *         selector is the call's must hold; a call no constraint applies to passes, unless an
 *         attachment is `strict`.
 * @dev Constraints are stored per attachment under a versioned key, so a reconfiguration replaces
 *      them without deleting the old ones. A check reads at most 16 constraints per attachment.
 */
contract ArgsPolicy is PolicyBaseV2, IArgsPolicy {
    uint256 private constant MAX_CONSTRAINTS = 16;
    uint256 private constant MAX_VALUES = 32;

    struct Config {
        uint64 version;
        bool strict;
    }

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 settingsKey => Config) private $configs;
    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 versionKey => ArgConstraint[]) private $constraints;

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.CALL;
    }

    /// @inheritdoc IArgsPolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory) {
        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config memory cfg = $configs[key];
        return Settings($constraints[_versionKey(key, cfg.version)], cfg.strict);
    }

    /// @inheritdoc IArgsPolicy
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256) {
        Settings memory s = abi.decode(data, (Settings));
        uint256 n = s.constraints.length;
        require(n <= MAX_CONSTRAINTS, InvalidSettings());

        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config storage cfg = $configs[key];
        uint64 version = cfg.version + 1;
        cfg.version = version;
        cfg.strict = s.strict;

        ArgConstraint[] storage stored = $constraints[_versionKey(key, version)];
        for (uint256 i; i < n; ++i) {
            ArgConstraint memory c = s.constraints[i];
            _validate(c);
            ArgConstraint storage dst = stored.push();
            dst.selector = c.selector;
            dst.argIndex = c.argIndex;
            dst.op = c.op;
            dst.values = c.values;
        }
        return 0;
    }

    function _checkCall(
        address engine,
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) internal view override {
        bytes calldata data = call.data;
        bytes4 selector = bytes4(data);
        bool applied;
        bool strict;

        for (uint256 i; i < attachmentIds.length; ++i) {
            bytes32 key = _settingsKey(engine, ctx.safe, attachmentIds[i]);
            Config memory cfg = $configs[key];
            strict = strict || cfg.strict;
            ArgConstraint[] storage constraints = $constraints[_versionKey(key, cfg.version)];
            uint256 n = constraints.length;
            for (uint256 j; j < n; ++j) {
                ArgConstraint storage c = constraints[j];
                if (c.selector != selector) continue;
                applied = true;
                uint16 argIndex = c.argIndex;
                uint256 offset = 4 + 32 * uint256(argIndex);
                require(data.length >= offset + 32, ArgMissing(selector, argIndex));
                bytes32 word = bytes32(data[offset:offset + 32]);
                require(_holds(c, word, ctx.safe), ArgViolation(selector, argIndex));
            }
        }
        require(applied || !strict, NoConstraint(selector));
    }

    function _holds(ArgConstraint storage c, bytes32 word, address safe) private view returns (bool) {
        ArgOp op = c.op;
        if (op == ArgOp.EQ_SAFE) return word == bytes32(uint256(uint160(safe)));
        if (op == ArgOp.EQ) return word == c.values[0];
        if (op == ArgOp.NEQ) return word != c.values[0];
        if (op == ArgOp.LTE) return uint256(word) <= uint256(c.values[0]);
        if (op == ArgOp.GTE) return uint256(word) >= uint256(c.values[0]);
        bytes32[] storage values = c.values;
        uint256 n = values.length;
        bool found;
        for (uint256 i; i < n; ++i) {
            if (values[i] == word) {
                found = true;
                break;
            }
        }
        return op == ArgOp.IN ? found : !found;
    }

    /// @dev EQ_SAFE takes no operand, the comparisons exactly one, IN / NOT_IN 1 to 32.
    function _validate(ArgConstraint memory c) private pure {
        uint256 n = c.values.length;
        if (c.op == ArgOp.EQ_SAFE) require(n == 0, InvalidSettings());
        else if (c.op == ArgOp.IN || c.op == ArgOp.NOT_IN) require(n != 0 && n <= MAX_VALUES, InvalidSettings());
        else require(n == 1, InvalidSettings());
    }

    function _versionKey(bytes32 key, uint64 version) private pure returns (bytes32) {
        return keccak256(abi.encode(key, version));
    }
}
