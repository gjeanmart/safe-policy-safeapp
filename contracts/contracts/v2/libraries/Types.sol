// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";

/**
 * @title Policy Engine V2 (rev 3) shared types
 * @dev File-level declarations shared by the engine, the policies and the app (through the ABI).
 *      The numeric value of every enum member and the field order of every struct are part of the
 *      ABI: append, never reorder. Normative text: SPEC.md. Mirrored in `src/lib/v2/rev3/types.ts`.
 */

/**
 * @notice The call dimension of a scope: which parts of `(to, selector)` the scope names.
 * @dev A part the scope leaves open is stored as zero. The `CallMatch` value, not the zero, makes
 *      it a wildcard, so a FUNCTION scope on empty calldata (`selector == 0`) never collides with
 *      a CONTRACT scope. "Any contract, this selector" does not exist (SPEC.md §2).
 */
enum CallMatch {
    ANY, //       (*)               every call
    CONTRACT, //  (to.*)            any function of one contract
    FUNCTION //   (to.selector)     one function of one contract
}

/**
 * @notice What an attachment does.
 * @dev ALLOW and DENY are engine built-ins (no contract, `policy == address(0)`). POLICY calls a
 *      contract that can only pass or deny; it can never grant.
 */
enum Kind {
    ALLOW,
    DENY,
    POLICY
}

/**
 * @notice A scope: who (`actor`) doing what (`to`, `selector`).
 * @custom:member actor `ScopeLib.ANY` (everyone, owners included), `ScopeLib.OWNERS` (the owner
 *                path) or a module address.
 * @custom:member to The target; `address(0)` when `callMatch == ANY`, non-zero otherwise.
 * @custom:member selector The 4-byte selector when `callMatch == FUNCTION` (`bytes4(0)` names empty
 *                calldata), else `bytes4(0)`.
 * @custom:member callMatch Which of `to` / `selector` the scope names.
 */
struct Scope {
    address actor;
    address to;
    bytes4 selector;
    CallMatch callMatch;
}

/**
 * @notice One call as the Safe executes it.
 * @dev In a batch, `to` is already resolved (`address(0)` becomes the Safe, as MultiSend does).
 */
struct Call {
    address to;
    uint256 value;
    bytes data;
    Operation operation;
}

/**
 * @notice What a policy learns about the Safe transaction being checked.
 * @custom:member safe The Safe (the guard hook's `msg.sender`).
 * @custom:member actor `ScopeLib.OWNERS` on the owner path, the module on the module path.
 * @custom:member txHash Owner path: the Safe transaction hash at `nonce - 1` (Safe 1.5.0 increments
 *                the nonce before calling the guard), with the real gas fields. Module path:
 *                `ScopeLib.moduleCallHash(safe, actor, to, value, data, operation)` of the
 *                top-level call (no nonce). Proofs (schedules, approvals, attestations) are keyed
 *                by it.
 */
struct Context {
    address safe;
    address actor;
    bytes32 txHash;
}

/**
 * @notice One (call, attachment) pair a policy matched.
 * @custom:member callIndex Index into the `calls` passed with it.
 * @custom:member level The scope level of the attachment, 0..5 (`ScopeLib.level`).
 * @custom:member attachmentId The attachment; settings are keyed `(engine, safe, attachmentId)`.
 */
struct Match {
    uint16 callIndex;
    uint8 level;
    bytes32 attachmentId;
}

/**
 * @notice One configuration change, applied by `IPolicyGuard.configure`.
 * @custom:member detach Remove the attachment `(scope, kind, policy)`; `opMask` and `settings` are
 *                ignored and the policy is not called. Otherwise attach, or update the op mask and
 *                settings of the existing attachment.
 * @custom:member opMask Bit 0 CALL, bit 1 DELEGATECALL. 0 means the default: CALL for ALLOW,
 *                CALL | DELEGATECALL for DENY and POLICY (`ScopeLib.normalizeOpMask`).
 * @custom:member settings Forwarded to `IPolicy.configure`; must be empty for ALLOW and DENY.
 */
struct Change {
    bool detach;
    Scope scope;
    Kind kind;
    address policy;
    uint8 opMask;
    bytes settings;
}

/**
 * @notice An attachment as returned by the engine views.
 * @custom:member opMask As stored (normalized, never zero).
 */
struct AttachmentView {
    bytes32 attachmentId;
    bytes32 scopeKey;
    Scope scope;
    Kind kind;
    address policy;
    uint8 opMask;
}

/**
 * @notice One attachment a call matched, as returned by `IPolicyGuard.matches`.
 * @custom:member counts ALLOW only: whether this Allow grants the call (DELEGATECALL and calls to
 *                the Safe or the engine on the module path need level 5, SPEC.md §3). Always true
 *                for DENY and POLICY.
 */
struct MatchView {
    uint16 callIndex;
    uint8 level;
    bytes32 attachmentId;
    Kind kind;
    address policy;
    uint8 opMask;
    bool counts;
}
