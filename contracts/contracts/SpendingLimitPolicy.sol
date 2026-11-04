// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC20} from "./vendor/policy-engine/interfaces/IERC20.sol";
import {IPolicy, Operation} from "./vendor/policy-engine/interfaces/IPolicy.sol";
import {AccessSelector} from "./vendor/policy-engine/libraries/AccessSelector.sol";

/**
 * @title Spending Limit Policy
 * @notice Caps the amount of an ERC-20 token a Safe can send with `transfer`, either per recurring
 *         period (e.g. 100 USDC per day) or as a one-time budget.
 * @dev Bind it to `(token, transfer(address,uint256), CALL)`; the token is the access selector's
 *      target, so one binding per token. It limits the amount only; combine it with a recipient
 *      allowlist (e.g. ERC20TransferPolicy) through a combinator such as {AllOfPolicy}.
 *
 *      Periods are a fixed grid anchored at configuration time: with a period P configured at T0,
 *      the budget resets at T0 + P, T0 + 2P, … (not a sliding window). A period of 0 is a one-time
 *      budget that never resets. Reconfiguring a token starts a fresh window with nothing spent.
 *
 *      The spend is recorded during the pre-execution check. The guard reverts failed executions
 *      on both paths, so a transfer that does not happen does not consume budget. Amounts are the
 *      requested amounts: fee-on-transfer tokens consume their gross amount, and a non-compliant
 *      token that returns `false` without reverting still consumes budget (fails safe).
 *
 *      State is namespaced by `(msg.sender, safe)` as required by {IPolicy}.
 */
contract SpendingLimitPolicy is IPolicy {
    using AccessSelector for AccessSelector.T;

    /**
     * @notice Spending limit for one token of one Safe.
     * @custom:member amount Maximum amount per window (0 = no limit configured, transfers denied).
     * @custom:member spent Amount spent in the current window.
     * @custom:member period Window length in seconds, or 0 for a one-time budget.
     * @custom:member windowStart Start of the current window (unix seconds).
     */
    struct Limit {
        uint128 amount;
        uint128 spent;
        uint64 period;
        uint64 windowStart;
    }

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(address policyGuard => mapping(address safe => mapping(address token => Limit))) private $limits;

    /**
     * @notice Error indicating the configured selector is not `transfer(address,uint256)`.
     */
    error InvalidSelector();

    /**
     * @notice Error indicating the configured or checked operation is not `CALL`.
     */
    error InvalidOperation();

    /**
     * @notice Error indicating the checked transaction is not a plain ERC-20 `transfer`.
     */
    error InvalidTransfer();

    /**
     * @notice Error indicating a configured amount or period does not fit its storage type.
     */
    error InvalidConfiguration();

    /**
     * @notice Error indicating no limit is configured for the token (or it was set to 0).
     */
    error NoLimitConfigured();

    /**
     * @notice Error indicating the transfer exceeds what is left of the budget.
     * @param requested The amount of the transfer.
     * @param available The amount still available in the current window.
     */
    error LimitExceeded(uint256 requested, uint256 available);

    /**
     * @notice Emitted when a limit is (re)configured.
     * @param policyGuard The policy guard whose namespace the limit belongs to.
     * @param safe The Safe address.
     * @param token The token address.
     * @param amount Maximum amount per window (0 removes the limit).
     * @param period Window length in seconds, or 0 for a one-time budget.
     */
    event LimitConfigured(
        address indexed policyGuard,
        address indexed safe,
        address indexed token,
        uint256 amount,
        uint256 period
    );

    /**
     * @notice Emitted when a transfer consumes budget.
     * @param policyGuard The policy guard whose namespace the limit belongs to.
     * @param safe The Safe address.
     * @param token The token address.
     * @param amount The amount of the transfer.
     * @param spent The total spent in the current window, including this transfer.
     */
    event Spent(
        address indexed policyGuard,
        address indexed safe,
        address indexed token,
        uint256 amount,
        uint256 spent
    );

    /**
     * @inheritdoc IPolicy
     * @dev Authorizes on `to` and `data`, never on `access` (which is the fallback key when the
     *      policy is reached through a fallback binding).
     */
    function checkTransaction(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address,
        bytes calldata,
        AccessSelector.T
    ) external override returns (bytes4 magicValue) {
        // Defence in depth: the binding is pinned to CALL at configuration, and an ERC-20
        // `transfer` carries no value; refusing both keeps this policy from authorizing anything
        // but a plain token transfer.
        require(operation == Operation.CALL, InvalidOperation());
        require(value == 0, InvalidTransfer());
        uint256 amount = _decodeTransferAmount(data);

        Limit storage limit = $limits[msg.sender][safe][to];
        require(limit.amount != 0, NoLimitConfigured());
        _rollWindow(limit);

        uint256 available = limit.amount - limit.spent;
        require(amount <= available, LimitExceeded(amount, available));
        // Cannot overflow: amount <= available <= limit.amount, which fits in uint128.
        limit.spent += uint128(amount);

        emit Spent(msg.sender, safe, to, amount, limit.spent);
        return IPolicy.checkTransaction.selector;
    }

    /**
     * @inheritdoc IPolicy
     * @param data ABI-encoded `(uint256 amount, uint256 period)`: the budget per window and the
     *        window length in seconds (0 = one-time budget). An amount of 0 removes the limit, so
     *        transfers of the token are denied.
     */
    function configure(address safe, AccessSelector.T access, bytes memory data) external override returns (bool) {
        require(access.getSelector() == IERC20.transfer.selector, InvalidSelector());
        require(access.getOperation() == Operation.CALL, InvalidOperation());

        (uint256 amount, uint256 period) = abi.decode(data, (uint256, uint256));
        require(amount <= type(uint128).max && period <= type(uint64).max, InvalidConfiguration());

        address token = access.getTarget();
        $limits[msg.sender][safe][token] = Limit({
            amount: uint128(amount),
            spent: 0,
            period: uint64(period),
            windowStart: uint64(block.timestamp)
        });

        emit LimitConfigured(msg.sender, safe, token, amount, period);
        return true;
    }

    /**
     * @notice The limit of a Safe for a token, as it applies right now.
     * @param policyGuard The policy guard whose namespace to read.
     * @param safe The Safe address.
     * @param token The token address.
     * @return amount Maximum amount per window (0 = none configured).
     * @return spent Amount spent in the current window (0 if the stored window has elapsed).
     * @return available Amount still available in the current window.
     * @return period Window length in seconds (0 = one-time budget).
     * @return windowStart Start of the current window, after accounting for elapsed periods.
     */
    function getLimit(
        address policyGuard,
        address safe,
        address token
    )
        external
        view
        returns (uint256 amount, uint256 spent, uint256 available, uint256 period, uint256 windowStart)
    {
        Limit memory limit = $limits[policyGuard][safe][token];
        (uint256 start, bool rolled) = _currentWindowStart(limit);
        amount = limit.amount;
        spent = rolled ? 0 : limit.spent;
        available = amount - spent;
        period = limit.period;
        windowStart = start;
    }

    /**
     * @dev Only `transfer(address,uint256)` is accepted: `transferFrom` moves someone else's tokens
     *      and is out of scope for a budget on the Safe's own funds.
     */
    function _decodeTransferAmount(bytes calldata data) private pure returns (uint256 amount) {
        require(data.length >= 4 && bytes4(data) == IERC20.transfer.selector, InvalidTransfer());
        (, amount) = abi.decode(data[4:], (address, uint256));
    }

    /**
     * @dev Starts a new window (with nothing spent) once the current one has elapsed.
     */
    function _rollWindow(Limit storage limit) private {
        (uint256 start, bool rolled) = _currentWindowStart(limit);
        if (rolled) {
            limit.windowStart = uint64(start);
            limit.spent = 0;
        }
    }

    /**
     * @dev Start of the window containing `block.timestamp` on the period grid, and whether it
     *      differs from the stored one. One-time budgets never roll.
     */
    function _currentWindowStart(Limit memory limit) private view returns (uint256 start, bool rolled) {
        start = limit.windowStart;
        if (limit.period == 0 || block.timestamp < start + limit.period) return (start, false);
        uint256 elapsedPeriods = (block.timestamp - start) / limit.period;
        return (start + elapsedPeriods * limit.period, true);
    }
}
