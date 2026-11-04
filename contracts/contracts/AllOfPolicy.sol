// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicy, Operation} from "./vendor/policy-engine/interfaces/IPolicy.sol";
import {AccessSelector} from "./vendor/policy-engine/libraries/AccessSelector.sol";

/**
 * @title All-Of Policy
 * @notice Combines several policies on one access selector: a transaction passes only if every
 *         inner policy accepts it, e.g. ERC20TransferPolicy (who may receive) together with
 *         SpendingLimitPolicy (how much). The engine binds a single policy per access selector;
 *         this is that policy.
 * @dev Inner policies key their state by their caller, which is this contract, not the guard. Two
 *      consequences:
 *      - Inner policies must be configured through {configure} here, never directly.
 *      - To keep the engine's `(policyGuard, safe)` namespacing, an instance serves exactly one
 *        policy guard ({POLICY_GUARD}) and rejects every other caller. Deploy one per guard.
 *
 *      Inner policies run in order, all with the same arguments. If any denies or reverts, the
 *      whole check reverts, so state staged by earlier inner policies (e.g. a spending limit's
 *      spend) is rolled back with it.
 *
 *      Policies that recurse into the engine (MultiSendPolicy calls `checkTransaction` on its
 *      caller) cannot be nested: their call reaches this contract instead and fails closed.
 *
 *      Detaching this policy from an access selector leaves the inner policies' state in place;
 *      revoke it explicitly by reconfiguring through this contract first.
 */
contract AllOfPolicy is IPolicy {
    /**
     * @notice Upper bound on inner policies per access selector, keeping checks gas-bounded.
     */
    uint256 public constant MAX_POLICIES = 5;

    /**
     * @notice The only policy guard allowed to check and configure through this instance.
     */
    address public immutable POLICY_GUARD;

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(address safe => mapping(AccessSelector.T access => address[] policies)) private $policies;

    /**
     * @notice Error indicating the caller is not {POLICY_GUARD}.
     */
    error UnauthorizedCaller();

    /**
     * @notice Error indicating the constructor was given the zero address as guard.
     */
    error InvalidPolicyGuard();

    /**
     * @notice Error indicating an invalid inner policy list (empty, too long, mismatched with its
     *         configurations, zero, duplicate, or this contract itself).
     */
    error InvalidConfiguration();

    /**
     * @notice Error indicating no inner policies are configured for the access selector.
     */
    error NoPoliciesConfigured();

    /**
     * @notice Error indicating an inner policy returned something other than the magic value.
     * @param policy The inner policy.
     */
    error InnerPolicyDenied(address policy);

    /**
     * @notice Error indicating an inner policy reverted.
     * @param policy The inner policy.
     * @param reason The inner policy's revert data.
     */
    error InnerPolicyReverted(address policy, bytes reason);

    /**
     * @notice Error indicating an inner policy rejected its configuration.
     * @param policy The inner policy.
     */
    error InnerPolicyConfigurationFailed(address policy);

    /**
     * @notice Emitted when the inner policies of an access selector are (re)configured.
     * @param safe The Safe address.
     * @param access The access selector.
     * @param policies The inner policies, in check order.
     */
    event PoliciesConfigured(address indexed safe, AccessSelector.T indexed access, address[] policies);

    /**
     * @param policyGuard The policy guard this instance serves.
     */
    constructor(address policyGuard) {
        require(policyGuard != address(0), InvalidPolicyGuard());
        POLICY_GUARD = policyGuard;
    }

    modifier onlyPolicyGuard() {
        require(msg.sender == POLICY_GUARD, UnauthorizedCaller());
        _;
    }

    /**
     * @inheritdoc IPolicy
     * @dev `access` is only used to look up which inner policies are bound, never to authorize;
     *      each inner policy authorizes on the transaction itself.
     */
    function checkTransaction(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module,
        bytes calldata context,
        AccessSelector.T access
    ) external override onlyPolicyGuard returns (bytes4 magicValue) {
        address[] storage policies = $policies[safe][access];
        uint256 count = policies.length;
        require(count != 0, NoPoliciesConfigured());

        for (uint256 i = 0; i < count; i++) {
            address policy = policies[i];
            try
                IPolicy(policy).checkTransaction(safe, to, value, data, operation, module, context, access)
            returns (bytes4 innerMagic) {
                require(innerMagic == IPolicy.checkTransaction.selector, InnerPolicyDenied(policy));
            } catch (bytes memory reason) {
                revert InnerPolicyReverted(policy, reason);
            }
        }
        return IPolicy.checkTransaction.selector;
    }

    /**
     * @inheritdoc IPolicy
     * @param data ABI-encoded `(address[] policies, bytes[] configurations)`: the inner policies in
     *        check order, and the configuration data forwarded to each (`configurations[i]` to
     *        `policies[i].configure`). Replaces any previous list for the access selector.
     */
    function configure(
        address safe,
        AccessSelector.T access,
        bytes memory data
    ) external override onlyPolicyGuard returns (bool) {
        (address[] memory policies, bytes[] memory configurations) = abi.decode(data, (address[], bytes[]));
        uint256 count = policies.length;
        require(count != 0 && count <= MAX_POLICIES && count == configurations.length, InvalidConfiguration());
        for (uint256 i = 0; i < count; i++) {
            address policy = policies[i];
            require(policy != address(0) && policy != address(this), InvalidConfiguration());
            for (uint256 j = 0; j < i; j++) {
                require(policies[j] != policy, InvalidConfiguration());
            }
        }

        $policies[safe][access] = policies;
        emit PoliciesConfigured(safe, access, policies);

        for (uint256 i = 0; i < count; i++) {
            require(
                IPolicy(policies[i]).configure(safe, access, configurations[i]),
                InnerPolicyConfigurationFailed(policies[i])
            );
        }
        return true;
    }

    /**
     * @notice The inner policies bound to an access selector of a Safe, in check order.
     * @param safe The Safe address.
     * @param access The access selector.
     */
    function getPolicies(address safe, AccessSelector.T access) external view returns (address[] memory) {
        return $policies[safe][access];
    }
}
