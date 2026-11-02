// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";

/**
 * @title Policy Engine V2 shared types
 * @dev File-level declarations shared by the engine, the policies and the app (via the ABI). The
 *      numeric value of every enum member is part of the ABI: append, never reorder. See SPEC.md.
 */

/**
 * @notice The call dimension of a scope: which parts of `(to, selector)` the scope names.
 * @dev A wildcard part is stored as zero (`to == address(0)`, `selector == bytes4(0)`); the
 *      `CallMatch` value, not the zero, is what makes it a wildcard, so a scope on a call with
 *      empty calldata (`selector == 0`) never collides with a selector wildcard.
 */
enum CallMatch {
    ANY, //         (*, *)            every call
    TO, //          (to, *)           any function on one contract
    SELECTOR, //    (*, selector)     one function on any contract
    TO_SELECTOR //  (to, selector)    one function on one contract
}

/**
 * @notice What an attachment does.
 * @dev `ALLOW` and `DENY` are engine built-ins (no policy contract); `POLICY` runs a contract that
 *      can only pass or deny.
 */
enum AttachmentKind {
    ALLOW,
    DENY,
    POLICY
}

/**
 * @notice Where a policy runs, declared by the policy and cached in the attachment.
 */
enum PolicyLevel {
    CALL, //        once per call, every sub-call of a batch included
    TRANSACTION //  once per Safe transaction, with the union of the attachments matched by its calls
}

/**
 * @notice Freeze roles, set through the configuration path.
 */
enum FreezeRole {
    GUARDIAN, //    may freeze and lift
    LIFTER //       may lift only (e.g. the recovery key)
}

/**
 * @notice Kind of a configuration change.
 */
enum ChangeType {
    SET, //     attach, or update the op mask and settings of an existing attachment
    DETACH //   remove the attachment; the policy is not called
}

/**
 * @notice A gate's verdict in a preview.
 */
enum Verdict {
    PASS,
    ALLOW,
    DENY
}

/**
 * @notice What produced a gate result in a preview: an attachment, or an engine rule.
 * @dev Values 0..2 equal {AttachmentKind}.
 */
enum GateKind {
    ALLOW,
    DENY,
    POLICY,
    RULE
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
 * @notice A scope: who `(actor)` doing what `(to, selector)`.
 * @custom:member actor `Scope.ANY` (everyone), `Scope.OWNERS` (the owner path) or a module address.
 * @custom:member to The target, or `address(0)` when `callMatch` leaves it open.
 * @custom:member selector The 4-byte selector, or `bytes4(0)` when `callMatch` leaves it open.
 * @custom:member callMatch Which of `to` / `selector` the scope names.
 */
struct ScopeData {
    address actor;
    address to;
    bytes4 selector;
    CallMatch callMatch;
}

/**
 * @notice An attachment as stored by the engine (one slot).
 * @custom:member policy The policy contract, or `address(0)` for the `ALLOW` / `DENY` built-ins.
 * @custom:member kind ALLOW, DENY or POLICY.
 * @custom:member opMask Bit 0 = CALL, bit 1 = DELEGATECALL. Never zero once stored.
 * @custom:member policyLevel Cached from `IPolicyV2.policyLevel()` at attach time; `CALL` for built-ins.
 */
struct Attachment {
    address policy;
    AttachmentKind kind;
    uint8 opMask;
    PolicyLevel policyLevel;
}

/**
 * @notice An attachment as returned by the engine's views.
 */
struct AttachmentView {
    bytes32 attachmentId;
    bytes32 scopeKey;
    ScopeData scope;
    AttachmentKind kind;
    address policy;
    uint8 opMask;
    PolicyLevel policyLevel;
}

/**
 * @notice An attachment matched by a call, as returned by `getMatchingAttachments`.
 * @custom:member callIndex Index of the call in the decoded transaction (0 when not a batch).
 * @custom:member scopeLevel 0..7, see `Scope.level`.
 */
struct MatchView {
    uint16 callIndex;
    uint8 scopeLevel;
    AttachmentView attachment;
}

/**
 * @notice One configuration change, hashed into the configuration root.
 * @custom:member opMask 0 is read as CALL only (the default); see SPEC.md §5.
 * @custom:member data Settings forwarded to `IPolicyV2.configure`; must be empty for built-ins and
 *                for DETACH.
 */
struct AttachmentChange {
    ChangeType changeType;
    ScopeData scope;
    AttachmentKind kind;
    address policy;
    uint8 opMask;
    bytes data;
}

/**
 * @notice Adds or removes a guardian or a lifter; hashed into the configuration root.
 */
struct RoleChange {
    FreezeRole role;
    address account;
    bool enabled;
}

/**
 * @notice What every policy call receives about the transaction being checked.
 * @custom:member safe The Safe being checked (the guard's `msg.sender`).
 * @custom:member actor `Scope.OWNERS` on the owner path, the module address on the module path.
 * @custom:member txHash Owner path: the Safe transaction hash (nonce − 1, real gas fields).
 *                Module path: `Scope.moduleCallHash(safe, module, to, value, data, operation)`.
 *                Preview: the hash the transaction would have if executed next.
 * @custom:member nonce Owner path: the Safe nonce the transaction consumed. Module path: 0.
 * @custom:member executor Owner path: the `msgSender` the Safe passed to the guard (who called
 *                `execTransaction`); trusted, as it comes from the Safe. Module path: the module.
 */
struct Context {
    address safe;
    address actor;
    bytes32 txHash;
    uint256 nonce;
    address executor;
}

/**
 * @notice One entry of the owner-path policy context carried in the Safe `signatures` tail.
 * @dev The tail payload is `abi.encode(PolicyContext[])`; each tx-level policy receives the `data`
 *      of the entry naming it. Untrusted: any executor can choose it (the Safe transaction hash
 *      does not cover `signatures`), so it may only carry self-authenticating proofs.
 */
struct PolicyContext {
    address policy;
    bytes data;
}

/**
 * @notice Engine freeze state for one `(safe, actor)` key; `actor == Scope.ANY` is the Safe-wide freeze.
 * @custom:member frozenAt Start of the current or last freeze (0 = never frozen).
 * @custom:member frozenUntil End of the current or last freeze: `frozenAt + MAX_FREEZE`, or the lift time.
 * @custom:member cooldownUntil No new freeze of this key before this time: `frozenUntil + FREEZE_COOLDOWN`.
 * @custom:member epoch Number of freezes of this key so far.
 */
struct FreezeState {
    uint64 frozenAt;
    uint64 frozenUntil;
    uint64 cooldownUntil;
    uint64 epoch;
}

/**
 * @notice One gate of a preview.
 * @custom:member callIndex The call the gate ran on, or `Scope.TX_INDEX` for transaction-level
 *                runs and transaction-wide engine rules.
 * @custom:member scopeLevel 0..7, or `Scope.NO_LEVEL` for engine rules.
 * @custom:member kind ALLOW / DENY / POLICY for attachments, RULE for engine rules.
 * @custom:member attachmentId Zero for engine rules.
 * @custom:member policy Zero for built-ins and engine rules.
 * @custom:member verdict PASS, ALLOW or DENY. An ALLOW that does not count (see SPEC.md §6.4)
 *                is reported as PASS with reason `AllowNotExact()`.
 * @custom:member reason The policy's revert data (truncated to `Scope.MAX_REASON_LENGTH`) or the
 *                engine's ABI-encoded custom error; empty for a pass and for a policy that returned
 *                a non-PASS value without reverting.
 */
struct GateResult {
    uint16 callIndex;
    uint8 scopeLevel;
    GateKind kind;
    bytes32 attachmentId;
    address policy;
    Verdict verdict;
    bytes reason;
}
