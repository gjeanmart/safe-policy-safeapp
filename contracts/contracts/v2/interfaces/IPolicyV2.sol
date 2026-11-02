// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

/**
 * @title Policy V2
 * @notice A restriction or protection attached at scopes of the V2 engine. A policy can only pass
 *         or deny: granting is the engine's built-in ALLOW. See SPEC.md §4.
 * @dev Verdicts:
 *      - PASS: return exactly the selector of the function called (`checkCall.selector` or
 *        `checkTransaction.selector`), ABI-encoded as one 32-byte word.
 *      - DENY: anything else. Prefer reverting with a custom error: the engine reports the revert
 *        data as the reason. A non-PASS return, a revert, running out of gas or malformed return
 *        data are all a deny.
 *
 *      Rules for implementers (the engine relies on them):
 *      1. Key every piece of state by `(msg.sender, ctx.safe, ...)`: `msg.sender` is the engine.
 *         Anyone can call a policy directly; namespacing by the caller makes that harmless.
 *      2. Treat the attachment ids as the only link to settings: `(msg.sender, safe, attachmentId)`.
 *         `configure` fully overwrites the settings of an id (re-attaching resets state).
 *      3. External reads only by STATICCALL (`view` calls); no state-changing call to untrusted code.
 *      4. Exactly one level: implement the matching check function; the other must deny.
 *      5. Deterministic for a given state: `preview` runs the same code and must report what the
 *         real check would do.
 */
interface IPolicyV2 is IERC165 {
    /**
     * @notice Whether the policy runs once per call or once per Safe transaction. Read once by the
     *         engine at attach time and cached in the attachment; it must never change.
     */
    function policyLevel() external view returns (PolicyLevel);

    /**
     * @notice Stores the settings of one attachment. Called by the engine only, on SET (attach or
     *         update) through `applyConfiguration` or `configureImmediately`; never on DETACH.
     * @param safe The Safe the attachment belongs to (the engine's caller; untrusted for anyone else).
     * @param attachmentId `Scope.attachmentId(scopeKey, POLICY, address(this))`.
     * @param scope The scope the attachment sits at (validated and normalized by the engine).
     * @param opMask The attachment's op mask (never zero).
     * @param data The policy-specific settings (SPEC.md §8).
     * @return delayFloor The smallest configuration `DELAY` these settings need: the delay this
     *         attachment imposes on transactions (Timelock), else 0. The engine rejects the change
     *         with `DelayBelowTimelock` when `delayFloor > DELAY` and the scope's actor is ANY or
     *         OWNERS, so the configuration path is never faster than the owners' timelock.
     * @dev Revert to reject invalid settings; the whole configuration change then reverts.
     */
    function configure(
        address safe,
        bytes32 attachmentId,
        ScopeData calldata scope,
        uint8 opMask,
        bytes calldata data
    ) external returns (uint256 delayFloor);

    /**
     * @notice Call-level check: runs once per call (each sub-call of a batch) with every attachment
     *         of this policy that the call matched.
     * @param ctx The transaction context.
     * @param call The call being checked (resolved `to`).
     * @param attachmentIds This policy's matched attachments for this call, in scope-level order,
     *        without duplicates; never empty. The policy owns the merge rule.
     * @return magicValue `IPolicyV2.checkCall.selector` to pass.
     */
    function checkCall(
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4 magicValue);

    /**
     * @notice Transaction-level check: runs once per Safe transaction, after every call-level gate
     *         passed, with the union of this policy's attachments matched by all its calls.
     * @param ctx The transaction context.
     * @param calls The calls the transaction executes: the decoded sub-calls of a trusted batch,
     *        else the single call.
     * @param signatures Owner path: the full `signatures` the Safe received (owner signatures and
     *        the extension tail). Module path and preview: empty.
     * @param policyData Owner path: this policy's entry of the policy context (SPEC.md §6.6), empty
     *        when absent. Module path and preview: empty. Untrusted.
     * @param attachmentIds This policy's matched attachments across all calls, deduplicated, in
     *        first-match order; never empty.
     * @return magicValue `IPolicyV2.checkTransaction.selector` to pass.
     */
    function checkTransaction(
        Context calldata ctx,
        Call[] calldata calls,
        bytes calldata signatures,
        bytes calldata policyData,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4 magicValue);
}
