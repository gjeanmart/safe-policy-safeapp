// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";

/**
 * @title Policy (rev 3)
 * @notice A restriction or protection attached at scopes of the engine. A policy can only pass or
 *         deny: granting is the engine's built-in ALLOW. SPEC.md §4.
 * @dev Verdict: return exactly `IPolicy.check.selector` (one ABI word) to pass. Anything else is a
 *      deny: a revert (preferred, with a custom error the engine reports as `PolicyDenied`), a
 *      wrong return value, malformed return data or running out of gas.
 *
 *      Rules for implementers (the engine and the app rely on them):
 *      1. `msg.sender` is the engine. Key every piece of state by `(msg.sender, ctx.safe, ...)`.
 *         Anyone may call `configure` and `check`; namespacing by the caller makes that harmless,
 *         and it is what lets the app simulate a check with `eth_call` from the engine address.
 *      2. Settings are keyed `(engine, safe, attachmentId)`. `configure` fully overwrites them.
 *         Detaching does not call the policy: stale settings must be harmless (they are only
 *         read for an id the engine passes in `matches`).
 *      3. One `check` per Safe transaction with every `(call, attachment)` pair this policy
 *         matched. The policy owns the merge rule over several attachments (stated in its
 *         interface) and must handle every match, batches included.
 *      4. External reads by STATICCALL only (view functions); no state-changing call to code the
 *         policy does not trust.
 *      5. Deterministic for a given chain state, so a simulation reports what the real check does.
 */
interface IPolicy is IERC165 {
    /**
     * @notice Validates and stores the settings of one attachment. Called by the engine (who: the
     *         engine, inside `IPolicyGuard.configure`, for every attach or update; never on detach).
     * @param safe The Safe the attachment belongs to.
     * @param attachmentId `ScopeLib.attachmentId(scopeKey, Kind.POLICY, address(this))`.
     * @param scope The scope, validated and normalized by the engine.
     * @param opMask The normalized op mask (never zero).
     * @param settings The policy-specific settings (each interface documents its encoding).
     * @dev Revert to reject: the whole `configure` transaction then reverts with
     *      `PolicyConfigurationFailed(policy, reason)`.
     */
    function configure(
        address safe,
        bytes32 attachmentId,
        Scope calldata scope,
        uint8 opMask,
        bytes calldata settings
    ) external;

    /**
     * @notice Judges one Safe transaction. Called by the engine (who: the engine, from a guard hook,
     *         once per Safe transaction, after every built-in gate passed).
     * @param ctx The transaction context.
     * @param calls Every call the transaction executes: the decoded sub-calls of a trusted batch,
     *        else the single top-level call.
     * @param matches This policy's `(call, attachment)` pairs, never empty, ordered by `callIndex`,
     *        then by level (0..5), then by attachment order within a scope. No duplicates.
     * @return magicValue `IPolicy.check.selector` to pass.
     */
    function check(
        Context calldata ctx,
        Call[] calldata calls,
        Match[] calldata matches
    ) external returns (bytes4 magicValue);
}
