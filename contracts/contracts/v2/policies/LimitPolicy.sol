// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {ILimitPolicy} from "../interfaces/policies/ILimitPolicy.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title LimitPolicy ("Transfer budget")
 * @notice Call-level per-token budgets on fixed windows (SPEC.md §8.4). Each call is priced once
 *         (native value plus what its calldata gives up), then debited from every matched
 *         attachment; each must have room. Approvals are reservations: an allowance increase
 *         spends, a decrease in the same window gives the unused part back.
 * @dev Budgets live under a versioned key, so a reconfiguration starts fresh budgets (nothing
 *      spent, window anchored at configure time) without iterating the old ones.
 *
 *      Reservations are tracked per `(attachment, token, spender)` and tagged with the window
 *      they were made in; only a reservation of the current window can be given back, and never
 *      more than was reserved, so lowering an allowance granted before the limit (or in an
 *      earlier window) frees nothing.
 */
contract LimitPolicy is PolicyBaseV2, ILimitPolicy {
    uint256 private constant MAX_TOKENS = 16;

    bytes4 private constant TRANSFER = 0xa9059cbb;
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    bytes4 private constant APPROVE = 0x095ea7b3;
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant DECREASE_ALLOWANCE = 0xa457c2d7;

    /// @notice Calldata of a known selector does not decode (too short or a dirty address word).
    error MalformedCall(bytes4 selector);

    struct Config {
        uint64 version;
        bool passUnpriced;
        address[] tokens;
    }

    /// @dev `amount == 0` means the token is not listed by this attachment.
    struct Budget {
        uint128 amount;
        uint128 spent;
        uint64 period;
        uint64 windowStart;
    }

    struct Reservation {
        uint128 amount;
        uint64 windowStart;
    }

    /// @dev What the calldata of a call costs, besides its native value.
    enum Shape {
        NONE, //        free (empty calldata, transferFrom of someone else's tokens, give-back with nothing to give)
        SPEND, //       `amount` of `token`
        RESERVE, //     `amount` of `token`, recorded as reserved for `spender`
        RELEASE, //     give back up to `amount` reserved for `spender`
        UNPRICED //     unknown shape
    }

    struct Price {
        Shape shape;
        address token;
        address spender;
        uint256 amount;
    }

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 settingsKey => Config) private $configs;
    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 budgetKey => Budget) private $budgets;
    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 budgetKey => mapping(address spender => Reservation)) private $reservations;

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.CALL;
    }

    /// @inheritdoc ILimitPolicy
    function remaining(
        address engine,
        address safe,
        bytes32 attachmentId,
        address token
    ) external view returns (Remaining memory r) {
        Budget memory budget = $budgets[_budgetKey(_settingsKey(engine, safe, attachmentId), token)];
        if (budget.amount == 0) return r;
        (uint64 start, bool rolled) = _currentWindowStart(budget);
        r.amount = budget.amount;
        r.spent = rolled ? 0 : budget.spent;
        r.available = r.amount - r.spent;
        r.period = budget.period;
        r.windowStart = start;
    }

    /**
     * @notice What `spender` has reserved of `token`'s budget in the current window (what an
     *         allowance decrease can give back).
     */
    function reserved(
        address engine,
        address safe,
        bytes32 attachmentId,
        address token,
        address spender
    ) external view returns (uint256) {
        bytes32 bk = _budgetKey(_settingsKey(engine, safe, attachmentId), token);
        Budget memory budget = $budgets[bk];
        Reservation memory res = $reservations[bk][spender];
        (uint64 start, ) = _currentWindowStart(budget);
        return budget.amount != 0 && res.windowStart == start ? res.amount : 0;
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
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256) {
        Settings memory s = abi.decode(data, (Settings));
        uint256 n = s.limits.length;
        require(n <= MAX_TOKENS, InvalidSettings());

        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config storage cfg = $configs[key];
        cfg.version += 1;
        cfg.passUnpriced = s.passUnpriced;
        delete cfg.tokens;
        for (uint256 i; i < n; ++i) {
            TokenLimit memory limit = s.limits[i];
            Budget storage budget = $budgets[_budgetKey(key, limit.token)];
            // A non-zero amount in the fresh version means the token appeared earlier in this list.
            require(limit.amount != 0 && budget.amount == 0, InvalidSettings());
            budget.amount = limit.amount;
            budget.period = limit.period;
            budget.windowStart = uint64(block.timestamp);
            cfg.tokens.push(limit.token);
        }
        return 0;
    }

    function _checkCall(
        address engine,
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) internal override {
        bytes4 selector = bytes4(call.data);
        Price memory price = _price(engine, ctx.safe, call, selector);

        for (uint256 i; i < attachmentIds.length; ++i) {
            bytes32 id = attachmentIds[i];
            bytes32 key = _settingsKey(engine, ctx.safe, id);
            bool passUnpriced = $configs[key].passUnpriced;

            if (call.value != 0) _debit(key, id, address(0), call.value, address(0), passUnpriced, selector);
            Shape shape = price.shape;
            if (shape == Shape.SPEND || shape == Shape.RESERVE) {
                _debit(key, id, price.token, price.amount, price.spender, passUnpriced, selector);
            } else if (shape == Shape.RELEASE) {
                _release(_budgetKey(key, price.token), price.spender, price.amount);
            } else if (shape == Shape.UNPRICED) {
                require(passUnpriced, Unpriced(id, address(0), selector));
            }
        }
    }

    /**
     * @dev Debits `amount` of `token` from one attachment, and records it as reserved for
     *      `spender` when non-zero. An unlisted token denies unless `passUnpriced`.
     */
    function _debit(
        bytes32 key,
        bytes32 id,
        address token,
        uint256 amount,
        address spender,
        bool passUnpriced,
        bytes4 selector
    ) private {
        if (amount == 0) return;
        bytes32 bk = _budgetKey(key, token);
        Budget storage budget = $budgets[bk];
        if (budget.amount == 0) {
            require(passUnpriced, Unpriced(id, token, selector));
            return;
        }
        _rollWindow(budget);
        uint256 available = budget.amount - budget.spent;
        require(amount <= available, LimitExceeded(id, token, amount, available));
        // Cannot overflow: amount <= available <= budget.amount, which fits in uint128.
        budget.spent += uint128(amount);

        if (spender != address(0)) {
            Reservation storage res = $reservations[bk][spender];
            uint64 windowStart = budget.windowStart;
            if (res.windowStart != windowStart) {
                res.windowStart = windowStart;
                res.amount = uint128(amount);
            } else {
                // Bounded by `spent`, so it fits in uint128.
                res.amount += uint128(amount);
            }
        }
    }

    /// @dev Gives back up to `amount` reserved for `spender` in the current window.
    function _release(bytes32 bk, address spender, uint256 amount) private {
        Budget storage budget = $budgets[bk];
        if (budget.amount == 0) return;
        _rollWindow(budget);
        Reservation storage res = $reservations[bk][spender];
        if (res.windowStart != budget.windowStart) return;
        uint256 give = amount;
        if (give > res.amount) give = res.amount;
        if (give > budget.spent) give = budget.spent;
        res.amount -= uint128(give);
        budget.spent -= uint128(give);
    }

    /**
     * @dev Prices the calldata of `call` once, for every attachment. ERC-20 shapes count only as
     *      CALLs; the typed sign-lib entries only as DELEGATECALLs to the engine's `SIGN_LIB`.
     */
    function _price(
        address engine,
        address safe,
        Call calldata call,
        bytes4 selector
    ) private returns (Price memory p) {
        bytes calldata data = call.data;
        if (data.length == 0) return p;

        if (call.operation == Operation.CALL) {
            if (selector == TRANSFER) {
                _addressAt(data, 0, selector);
                return Price(Shape.SPEND, call.to, address(0), _wordAt(data, 1, selector));
            }
            if (selector == TRANSFER_FROM) {
                address from = _addressAt(data, 0, selector);
                _addressAt(data, 1, selector);
                uint256 amount = _wordAt(data, 2, selector);
                return from == safe ? Price(Shape.SPEND, call.to, address(0), amount) : p;
            }
            if (selector == APPROVE || selector == INCREASE_ALLOWANCE || selector == DECREASE_ALLOWANCE) {
                return _priceAllowance(engine, safe, call.to, data, selector);
            }
        } else if (_isSignLibCall(engine, call.to, selector)) {
            if (selector == IPolicySignLib.signCowOrder.selector) {
                // GPv2Order: sellToken word 0, sellAmount word 3, feeAmount word 7 (12 words).
                _wordAt(data, 11, selector);
                address sellToken = _addressAt(data, 0, selector);
                return Price(Shape.SPEND, sellToken, address(0), _wordAt(data, 3, selector) + _wordAt(data, 7, selector));
            }
            address token = _addressAt(data, 0, selector);
            address spender = _addressAt(data, 1, selector);
            uint256 value = _wordAt(data, 2, selector);
            if (selector == IPolicySignLib.signPermit2.selector) {
                // A Permit2 allowance is not the ERC-20 allowance, and a signature may never be
                // used: the full amount spends, nothing is given back.
                _wordAt(data, 5, selector);
                return Price(Shape.SPEND, token, address(0), value);
            }
            // signPermit: the allowance only changes when someone submits the permit, so it can
            // reserve an increase but never give back.
            _wordAt(data, 4, selector);
            uint256 current = _allowance(engine, safe, token, spender);
            return value > current ? Price(Shape.RESERVE, token, spender, value - current) : p;
        }
        p.shape = Shape.UNPRICED;
    }

    function _priceAllowance(
        address engine,
        address safe,
        address token,
        bytes calldata data,
        bytes4 selector
    ) private returns (Price memory p) {
        address spender = _addressAt(data, 0, selector);
        uint256 value = _wordAt(data, 1, selector);
        uint256 current = _allowance(engine, safe, token, spender);
        uint256 next;
        if (selector == APPROVE) {
            next = value;
            p = value > current
                ? Price(Shape.RESERVE, token, spender, value - current)
                : Price(Shape.RELEASE, token, spender, current - value);
        } else if (selector == INCREASE_ALLOWANCE) {
            next = value > type(uint256).max - current ? type(uint256).max : current + value;
            p = Price(Shape.RESERVE, token, spender, value);
        } else {
            uint256 decrease = value < current ? value : current;
            next = current - decrease;
            p = Price(Shape.RELEASE, token, spender, decrease);
        }
        _setExpectedAllowance(engine, safe, token, spender, next);
    }

    function _isSignLibCall(address engine, address to, bytes4 selector) private view returns (bool) {
        return
            (selector == IPolicySignLib.signPermit.selector ||
                selector == IPolicySignLib.signPermit2.selector ||
                selector == IPolicySignLib.signCowOrder.selector) && to == IPolicyEngineV2(engine).SIGN_LIB();
    }

    /**
     * @dev The allowance an approval is priced against (read before the call, by STATICCALL).
     *      Checks run before any call executes, so inside a batch an earlier approval of the same
     *      pair is not visible on-chain yet: the smaller of the on-chain value and the value
     *      expected after the earlier sub-calls (transient) is used. Without it, a batch
     *      `[approve(x, 0), approve(x, a)]` would give back and not spend. A stale transient
     *      value (another Safe transaction in the same EVM transaction) can only charge more.
     */
    function _allowance(address engine, address safe, address token, address spender) private view returns (uint256) {
        uint256 onChain = IERC20Allowance(token).allowance(safe, spender);
        bytes32 slot = _allowanceSlot(engine, safe, token, spender);
        uint256 stored;
        assembly ("memory-safe") {
            stored := tload(slot)
        }
        // Stored as value + 1 so that 0 means "nothing earlier in this transaction".
        if (stored != 0 && stored - 1 < onChain) return stored - 1;
        return onChain;
    }

    function _setExpectedAllowance(address engine, address safe, address token, address spender, uint256 value) private {
        bytes32 slot = _allowanceSlot(engine, safe, token, spender);
        uint256 stored = value == type(uint256).max ? value : value + 1;
        assembly ("memory-safe") {
            tstore(slot, stored)
        }
    }

    function _allowanceSlot(address engine, address safe, address token, address spender) private pure returns (bytes32) {
        return keccak256(abi.encode("LimitPolicy.allowance", engine, safe, token, spender));
    }

    function _budgetKey(bytes32 key, address token) private view returns (bytes32) {
        return keccak256(abi.encode(key, $configs[key].version, token));
    }

    /// @dev Starts a new window (nothing spent) once the current one has elapsed.
    function _rollWindow(Budget storage budget) private {
        (uint64 start, bool rolled) = _currentWindowStart(budget);
        if (rolled) {
            budget.windowStart = start;
            budget.spent = 0;
        }
    }

    /// @dev Start of the window containing now on the period grid; one-time budgets never roll.
    function _currentWindowStart(Budget memory budget) private view returns (uint64 start, bool rolled) {
        start = budget.windowStart;
        if (budget.period == 0 || block.timestamp < uint256(start) + budget.period) return (start, false);
        uint256 elapsed = (block.timestamp - start) / budget.period;
        return (uint64(start + elapsed * budget.period), true);
    }

    /// @dev Static argument word `index` (0-based, after the selector); reverts if the data is short.
    function _wordAt(bytes calldata data, uint256 index, bytes4 selector) private pure returns (uint256 word) {
        uint256 offset = 4 + 32 * index;
        require(data.length >= offset + 32, MalformedCall(selector));
        word = uint256(bytes32(data[offset:offset + 32]));
    }

    function _addressAt(bytes calldata data, uint256 index, bytes4 selector) private pure returns (address) {
        uint256 word = _wordAt(data, index, selector);
        require(word >> 160 == 0, MalformedCall(selector));
        return address(uint160(word));
    }
}
