// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {ILimitPolicy} from "../interfaces/policies/ILimitPolicy.sol";
import {
    ERC20_APPROVE,
    ERC20_DECREASE_ALLOWANCE,
    ERC20_INCREASE_ALLOWANCE,
    ERC20_TRANSFER,
    ERC20_TRANSFER_FROM,
    MAX_LIMIT_TOKENS
} from "../libraries/Constants.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title LimitPolicy ("Transfer budget")
 * @notice Per-token budgets on a fixed window grid. One check per Safe transaction prices every
 *         matched call in order and debits each matched attachment, so a batch sums. Approvals
 *         count in full, revocations are free. Calls to the engine (`configure`) are not judged.
 *         SPEC.md §5.3, pricing and merge rule in {ILimitPolicy}.
 * @dev Budgets live under a versioned key: `configure` starts fresh budgets (nothing spent,
 *      windows anchored at configure time) without iterating the old ones. Debits are written as
 *      the check goes; a deny reverts them all, so they persist only when the whole check passes.
 */
contract LimitPolicy is PolicyBase, ILimitPolicy {
    struct Config {
        uint64 version;
        bool passUnpriced;
        address[] tokens;
    }

    /// @dev `amount == 0` means the token is not listed by this attachment. `windowStart` is on
    ///      the grid `anchor + k * period` (the anchor itself for one-time budgets).
    struct Budget {
        uint128 amount;
        uint128 spent;
        uint64 period;
        uint64 windowStart;
    }

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 settingsKey => Config) private $configs;
    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 budgetKey => Budget) private $budgets;

    /// @inheritdoc ILimitPolicy
    function remaining(
        address engine,
        address safe,
        bytes32 attachmentId,
        address token
    ) external view returns (Remaining memory r) {
        Budget memory budget = $budgets[_budgetKey(_settingsKey(engine, safe, attachmentId), token)];
        if (budget.amount == 0) return r;
        (uint64 start, bool rolled) = _currentWindow(budget);
        r.amount = budget.amount;
        r.spent = rolled ? 0 : budget.spent;
        r.available = r.amount - r.spent;
        r.period = budget.period;
        r.windowStart = start;
    }

    /// @inheritdoc ILimitPolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory s) {
        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config storage cfg = $configs[key];
        uint256 n = cfg.tokens.length;
        s.limits = new TokenLimit[](n);
        s.passUnpriced = cfg.passUnpriced;
        for (uint256 i; i < n; ++i) {
            address token = cfg.tokens[i];
            Budget storage budget = $budgets[_budgetKey(key, token)];
            s.limits[i] = TokenLimit(token, budget.amount, budget.period);
        }
    }

    /// @inheritdoc ILimitPolicy
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
        uint256 n = s.limits.length;
        require(n != 0 && n <= MAX_LIMIT_TOKENS, InvalidSettings());

        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config storage cfg = $configs[key];
        cfg.version += 1;
        cfg.passUnpriced = s.passUnpriced;
        delete cfg.tokens;
        for (uint256 i; i < n; ++i) {
            TokenLimit memory limit = s.limits[i];
            Budget storage budget = $budgets[_budgetKey(key, limit.token)];
            // A non-zero amount under the fresh version means the token appeared earlier in this list.
            require(limit.amount != 0 && budget.amount == 0, InvalidSettings());
            budget.amount = limit.amount;
            budget.period = limit.period;
            budget.windowStart = uint64(block.timestamp);
            cfg.tokens.push(limit.token);
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

    /// @dev Prices one matched call and debits the attachment. Matches come in call order, so
    ///      the calls of a batch are debited one after the other and sum.
    function _checkMatch(address engine, Context calldata ctx, Call calldata call, Match calldata m) private {
        // A call that reaches a policy with the engine as target is `configure` (zero value, the
        // engine denies anything else): it moves nothing, and judging it would let a Limit at
        // `(Owners, *)` lock the owners out of their own configuration.
        if (call.to == engine) return;
        bytes32 key = _settingsKey(engine, ctx.safe, m.attachmentId);
        bool passUnpriced = $configs[key].passUnpriced;
        bytes4 selector = bytes4(call.data);

        if (call.value != 0) _debit(key, m, address(0), call.value, selector);
        (bool priced, address token, uint256 amount) = _price(ctx.safe, call, selector);
        if (!priced) {
            // `token != 0`: a spend selector whose calldata does not decode, never let through.
            require(passUnpriced && token == address(0), Unpriced(m.callIndex, m.attachmentId, token, selector));
        } else if (amount != 0) {
            _debit(key, m, token, amount, selector);
        }
    }

    /// @dev Debits `amount` of `token`. An unlisted token always denies, `passUnpriced` or not:
    ///      a known spend must never pass unbounded (list the token to allow it).
    function _debit(bytes32 key, Match calldata m, address token, uint256 amount, bytes4 selector) private {
        Budget storage budget = $budgets[_budgetKey(key, token)];
        require(budget.amount != 0, Unpriced(m.callIndex, m.attachmentId, token, selector));
        (uint64 start, bool rolled) = _currentWindow(budget);
        if (rolled) {
            budget.windowStart = start;
            budget.spent = 0;
        }
        uint256 available = budget.amount - budget.spent;
        require(amount <= available, LimitExceeded(m.callIndex, m.attachmentId, token, amount, available));
        // Cannot overflow: amount <= available <= budget.amount, which fits in uint128.
        budget.spent += uint128(amount);
    }

    /**
     * @dev What the calldata of `call` gives up, besides its native value: `(true, token, amount)`
     *      for a priced shape (amount 0 = free), `(false, 0, 0)` for an unknown one and
     *      `(false, call.to, 0)` for a spend selector with short calldata. Only CALLs are priced:
     *      a DELEGATECALL runs foreign code as the Safe, so it is never a known shape.
     */
    function _price(
        address safe,
        Call calldata call,
        bytes4 selector
    ) private pure returns (bool priced, address token, uint256 amount) {
        bytes calldata data = call.data;
        if (call.operation != Operation.CALL) return (false, address(0), 0);
        if (data.length == 0) return (true, address(0), 0);
        if (selector == ERC20_DECREASE_ALLOWANCE) return (true, address(0), 0);

        // The other shapes are `(word0, word1)` or, for transferFrom, `(from, to, amount)`.
        bool isTransferFrom = selector == ERC20_TRANSFER_FROM;
        if (
            !isTransferFrom &&
            selector != ERC20_TRANSFER &&
            selector != ERC20_APPROVE &&
            selector != ERC20_INCREASE_ALLOWANCE
        ) return (false, address(0), 0);
        uint256 words = isTransferFrom ? 3 : 2;
        if (data.length < 4 + 32 * words) return (false, call.to, 0);
        amount = uint256(bytes32(data[4 + 32 * (words - 1):4 + 32 * words]));
        // Only the low 160 bits are compared, as a token reading the address would: dirty upper
        // bits on the Safe's own address still count.
        if (isTransferFrom && uint160(uint256(bytes32(data[4:36]))) != uint160(safe)) amount = 0;
        // `approve(s, 0)` is a revocation: free.
        return (true, call.to, amount);
    }

    function _budgetKey(bytes32 key, address token) private view returns (bytes32) {
        return keccak256(abi.encode(key, $configs[key].version, token));
    }

    /// @dev Start of the window containing now on the grid; one-time budgets never roll.
    function _currentWindow(Budget memory budget) private view returns (uint64 start, bool rolled) {
        start = budget.windowStart;
        uint256 period = budget.period;
        if (period == 0 || block.timestamp < uint256(start) + period) return (start, false);
        return (uint64(start + ((block.timestamp - start) / period) * period), true);
    }
}
