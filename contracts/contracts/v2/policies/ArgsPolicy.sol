// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IArgsPolicy} from "../interfaces/policies/IArgsPolicy.sol";
import {ANY_SELECTOR, MAX_ARGS_CONSTRAINTS, MAX_ARGS_VALUES} from "../libraries/Constants.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title ArgsPolicy
 * @notice Conditions on a call's static arguments, target and value ("Allow + conditions"); the
 *         app's Recipients, Spenders and Receiver-is-the-Safe presets are settings of this
 *         policy. Calls to the engine (`configure`) are not judged. SPEC.md §5.2, merge rule in
 *         {IArgsPolicy}.
 * @dev Constraints live under a versioned key, so `configure` replaces them without deleting the
 *      old ones (no unbounded loop over stale storage).
 */
contract ArgsPolicy is PolicyBase, IArgsPolicy {
    struct Config {
        uint64 version;
        bool strict;
    }

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 settingsKey => Config) private $configs;
    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 versionKey => Constraint[]) private $constraints;

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
        Scope calldata,
        uint8,
        bytes calldata data
    ) internal override {
        Settings memory s = abi.decode(data, (Settings));
        uint256 n = s.constraints.length;
        require(n <= MAX_ARGS_CONSTRAINTS && (n != 0 || s.strict), InvalidSettings());

        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config storage cfg = $configs[key];
        uint64 version = cfg.version + 1;
        cfg.version = version;
        cfg.strict = s.strict;

        Constraint[] storage stored = $constraints[_versionKey(key, version)];
        for (uint256 i; i < n; ++i) {
            Constraint memory c = s.constraints[i];
            _validateConstraint(c);
            stored.push(c);
        }
    }

    function _check(
        address engine,
        Context calldata ctx,
        Call[] calldata calls,
        Match[] calldata matches
    ) internal override {
        _forEachMatch(engine, ctx, calls, matches, _checkMatch);
    }

    /// @dev One `(call, attachment)` pair, judged alone with the attachment's own constraints.
    function _checkMatch(address engine, Context calldata ctx, Call calldata call, Match calldata m) private view {
        // A call that reaches a policy with the engine as target is `configure` (zero value, the
        // engine denies anything else): it moves nothing, and judging it would let a strict Args
        // at `(Owners, *)` lock the owners out of their own configuration.
        if (call.to == engine) return;
        (address safe, uint16 callIndex, bytes32 attachmentId) = (ctx.safe, m.callIndex, m.attachmentId);
        bytes calldata data = call.data;
        // Empty calldata reads as selector 0 (the engine rejects 1 to 3 bytes before any policy).
        bytes4 selector = bytes4(data);
        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config memory cfg = $configs[key];
        Constraint[] storage constraints = $constraints[_versionKey(key, cfg.version)];

        bool applied;
        uint256 n = constraints.length;
        for (uint256 j; j < n; ++j) {
            Constraint storage c = constraints[j];
            bytes4 cSelector = c.selector;
            if (cSelector != selector && cSelector != ANY_SELECTOR) continue;
            Target target = c.target;
            // VALUE_TO judges the destination only when value moves.
            if (target == Target.VALUE_TO && call.value == 0) continue;
            applied = true;

            bytes32 word;
            if (target == Target.WORD) {
                uint256 offset = 4 + 32 * uint256(c.index);
                require(data.length >= offset + 32, ArgumentMissing(callIndex, attachmentId, uint16(j)));
                word = bytes32(data[offset:offset + 32]);
            } else if (target == Target.VALUE) {
                word = bytes32(call.value);
            } else {
                // CALL_TO or VALUE_TO
                word = bytes32(uint256(uint160(call.to)));
            }
            require(_holds(c, word, safe), ConstraintFailed(callIndex, attachmentId, uint16(j)));
        }
        require(applied || !cfg.strict, NoConstraint(callIndex, attachmentId));
    }

    function _holds(Constraint storage c, bytes32 word, address safe) private view returns (bool) {
        Op op = c.op;
        if (op == Op.EQ_SAFE) return word == bytes32(uint256(uint160(safe)));
        if (op == Op.EQ) return word == c.values[0];
        if (op == Op.NEQ) return word != c.values[0];
        if (op == Op.LTE) return uint256(word) <= uint256(c.values[0]);
        if (op == Op.GTE) return uint256(word) >= uint256(c.values[0]);
        bytes32[] storage values = c.values;
        uint256 n = values.length;
        bool found;
        for (uint256 i; i < n; ++i) {
            if (values[i] == word) {
                found = true;
                break;
            }
        }
        return op == Op.IN ? found : !found;
    }

    /// @dev EQ_SAFE takes no operand, IN / NOT_IN 1 to 32, the others exactly one; `index` is
    ///      WORD-only.
    function _validateConstraint(Constraint memory c) private pure {
        require(c.target == Target.WORD || c.index == 0, InvalidSettings());
        uint256 n = c.values.length;
        if (c.op == Op.EQ_SAFE) require(n == 0, InvalidSettings());
        else if (c.op == Op.IN || c.op == Op.NOT_IN) require(n != 0 && n <= MAX_ARGS_VALUES, InvalidSettings());
        else require(n == 1, InvalidSettings());
    }

    function _versionKey(bytes32 key, uint64 version) private pure returns (bytes32) {
        return keccak256(abi.encode(key, version));
    }
}
