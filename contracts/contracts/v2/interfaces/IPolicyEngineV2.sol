// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {
    AttachmentChange,
    AttachmentKind,
    AttachmentView,
    CallMatch,
    FreezeRole,
    FreezeState,
    GateResult,
    MatchView,
    PolicyLevel,
    RoleChange,
    ScopeData
} from "../libraries/Types.sol";

/**
 * @title Policy Engine V2
 * @notice The engine API: configuration, freeze, identity helpers, enumeration and preview. The
 *         Safe-facing hooks are Safe 1.5.0's `ITransactionGuard` and `IModuleGuard` (vendored as
 *         `ISafeTransactionGuard` / `ISafeModuleGuard`), implemented by the same contract
 *         (`SafePolicyGuardV2`). The app detects a V2 guard with
 *         `supportsInterface(type(IPolicyEngineV2).interfaceId)`. Normative behaviour: SPEC.md.
 */
interface IPolicyEngineV2 {
    // =============================================================================================
    // Events
    // =============================================================================================

    /**
     * @notice An attachment was created or updated (SET). Carries everything the app needs to
     *         rebuild the configuration from logs alone.
     * @param data The settings passed to `IPolicyV2.configure` (empty for built-ins).
     */
    event Attached(
        address indexed safe,
        bytes32 indexed attachmentId,
        bytes32 indexed scopeKey,
        address actor,
        address to,
        bytes4 selector,
        CallMatch callMatch,
        AttachmentKind kind,
        address policy,
        uint8 opMask,
        PolicyLevel policyLevel,
        bytes data
    );

    /// @notice An attachment was removed (DETACH).
    event Detached(address indexed safe, bytes32 indexed attachmentId, bytes32 indexed scopeKey);

    /// @notice A guardian or lifter was added or removed.
    event RoleSet(address indexed safe, FreezeRole indexed role, address indexed account, bool enabled);

    /// @notice A configuration root was requested; it can be applied from `validFrom` until `validFrom + EXPIRY`.
    event ConfigRequested(address indexed safe, bytes32 indexed root, uint256 validFrom);

    /// @notice A pending configuration root was invalidated.
    event ConfigInvalidated(address indexed safe, bytes32 indexed root);

    /// @notice A configuration root was applied; emitted before its `Attached`/`Detached`/`RoleSet` logs.
    event ConfigApplied(address indexed safe, bytes32 indexed root);

    /// @notice Changes applied without delay, before the guard was installed; emitted before their logs.
    event ConfiguredImmediately(address indexed safe, bytes32 indexed root);

    /// @notice A freeze started. `actor == Scope.ANY` for the Safe-wide freeze.
    event Frozen(address indexed safe, address indexed actor, address indexed guardian, uint256 until, uint64 epoch);

    /// @notice A freeze was lifted early; no new freeze of this key before `cooldownUntil`.
    event Unfrozen(address indexed safe, address indexed actor, address indexed by, uint256 cooldownUntil);

    /// @notice `freeze(safes[])` skipped a Safe already frozen (`until` = its end) or cooling down
    ///         (`until` = end of the cooldown).
    event FreezeSkipped(address indexed safe, address indexed guardian, uint256 until);

    // =============================================================================================
    // Errors
    // =============================================================================================

    // --- verdicts (guard hooks; also preview reasons) ---

    /// @notice A built-in DENY matched call `callIndex`.
    error Denied(uint256 callIndex, bytes32 attachmentId);

    /// @notice A policy denied. `callIndex` is `Scope.TX_INDEX` (65535) for transaction-level policies.
    ///         `reason` is the policy's revert data, truncated to `Scope.MAX_REASON_LENGTH`; empty for a
    ///         non-PASS return value.
    error PolicyDenied(uint256 callIndex, address policy, bytes reason);

    /// @notice No ALLOW that counts matched call `callIndex` (deny by default).
    error NotGranted(uint256 callIndex, address to, bytes4 selector, Operation operation);

    /// @notice Preview reason only: an ALLOW matched but does not count for a call to the Safe or
    ///         the engine by a module (SPEC.md §6.4).
    error AllowNotExact();

    // --- transaction shape ---

    /// @notice Calldata of 1 to 3 bytes.
    error InvalidSelector(uint256 callIndex);

    /// @notice A DELEGATECALL to a trusted batch whose calldata does not decode, is empty, or carries value.
    error MalformedBatch();

    /// @notice A batch with more than `Scope.MAX_BATCH_CALLS` calls.
    error BatchTooLarge();

    /// @notice A batch sub-call that DELEGATECALLs a trusted batch (one nesting level only).
    error NestedBatch(uint256 callIndex);

    /// @notice The policy context in the `signatures` tail does not decode, or names a policy twice.
    error MalformedContext();

    /// @notice A call to the engine that is not one of its Safe-callable entry points, or a
    ///         configuration call that is not a top-level `CALL` with zero value.
    error GuardTargetDenied();

    /// @notice A configuration call on the module path.
    error ModuleConfigurationDenied();

    /// @notice Gas refunds are not supported (`gasPrice != 0`).
    error NonZeroGasPrice();

    /// @notice `safeTxGas != 0` would let a failed inner call commit policy state.
    error NonZeroSafeTxGas();

    /// @notice The guarded transaction failed.
    error ExecutionFailed();

    /// @notice The guarded module transaction failed.
    error ModuleExecutionFailed();

    /// @notice A guard hook, `preview` or a state-changing engine function (configuration, freeze)
    ///         was entered while a check is running.
    error Reentrancy();

    /// @notice Always thrown by `preview`, carrying every gate's verdict.
    error Preview(GateResult[] gates);

    // --- configuration ---

    /// @notice `configureImmediately` after the guard (or module guard) was installed on the caller.
    error GuardAlreadyEnabled();

    error RootAlreadyRequested(bytes32 root);
    error RootNotRequested(bytes32 root);
    error RootPending(bytes32 root, uint256 validFrom);
    error RootExpired(bytes32 root);

    /// @notice `applyConfiguration` while the Safe-wide freeze is active.
    error ConfigFrozen(uint256 frozenUntil);

    /// @notice A scope whose open parts are not zero, or a specific actor/target that is invalid.
    error InvalidScope();

    /// @notice An op mask above `Scope.OP_ALL`.
    error InvalidOpMask(uint8 opMask);

    /// @notice An ALLOW covering DELEGATECALL outside the exact scope `(actor, to.selector)`.
    error DelegateCallNotExact();

    /// @notice POLICY with no contract, ALLOW/DENY with a policy or settings, a contract that does
    ///         not implement `IPolicyV2`, or an invalid `policyLevel`.
    error InvalidPolicy(address policy);

    /// @notice `IPolicyV2.configure` reverted.
    error PolicyConfigurationFailed(address policy, bytes reason);

    /// @notice The attachment needs a configuration delay longer than this engine's `DELAY`.
    error DelayBelowTimelock(uint256 delay, uint256 required);

    error TooManyAttachments(bytes32 scopeKey);

    error NotAttached(bytes32 attachmentId);

    error TooManyRoleMembers(FreezeRole role);

    /// @notice Constructor: zero `EXPIRY` or `MAX_FREEZE`, or `EXPIRY < MAX_FREEZE + FREEZE_COOLDOWN + DELAY`.
    error InvalidTiming();

    /// @notice Constructor: zero sign library, zero or duplicate trusted batch, or more than
    ///         `Scope.MAX_TRUSTED_BATCHES`.
    error InvalidDeployment();

    // --- freeze ---

    error NotGuardian(address safe);
    error NotGuardianOrLifter(address safe);
    error AlreadyFrozen(address safe, address actor, uint256 until);
    error FreezeCooldown(address safe, address actor, uint256 until);
    error NotFrozen(address safe, address actor);

    /// @notice `freezeActor` with `Scope.ANY` (use `freeze`) or `Scope.OWNERS` (owners are frozen
    ///         Safe-wide only, see SPEC.md §7.1); `preview` with `Scope.ANY`.
    error InvalidActor(address actor);

    // =============================================================================================
    // Configuration (msg.sender is the Safe)
    // =============================================================================================

    /// @notice Applies changes with no delay. Only while this contract is neither the Safe's guard
    ///         nor its module guard.
    function configureImmediately(AttachmentChange[] calldata changes, RoleChange[] calldata roles) external;

    /// @notice Requests `root = configurationRoot(changes, roles)`; applicable after `DELAY`.
    function requestConfiguration(bytes32 root) external;

    /// @notice Drops a requested root (pending, matured or expired).
    function invalidateRoot(bytes32 root) external;

    /// @notice Applies a matured, unexpired root. Reverts `ConfigFrozen` during a Safe-wide freeze.
    function applyConfiguration(AttachmentChange[] calldata changes, RoleChange[] calldata roles) external;

    /// @notice `keccak256(abi.encode(changes, roles))`.
    function configurationRoot(
        AttachmentChange[] calldata changes,
        RoleChange[] calldata roles
    ) external pure returns (bytes32);

    /// @notice When `root` becomes applicable for `safe`, or 0 if not requested.
    function rootConfigured(address safe, bytes32 root) external view returns (uint256 validFrom);

    function DELAY() external view returns (uint256);

    function EXPIRY() external view returns (uint256);

    // =============================================================================================
    // Freeze (direct calls by guardians and lifters; a guarded Safe may make them through an
    // exact-scope ALLOW)
    // =============================================================================================

    /// @notice Safe-wide freeze of every listed Safe the caller guards. Reverts `NotGuardian` if
    ///         the caller does not guard one of them; skips (emits `FreezeSkipped`) those already
    ///         frozen or cooling down.
    function freeze(address[] calldata safes) external;

    /// @notice Freezes one module actor of `safe` (agent kill switch).
    function freezeActor(address safe, address actor) external;

    /// @notice Ends the freeze of `(safe, actor)` (`Scope.ANY` = Safe-wide) and starts its cooldown.
    function lift(address safe, address actor) external;

    function MAX_FREEZE() external view returns (uint256);

    function FREEZE_COOLDOWN() external view returns (uint256);

    function getFreezeState(address safe, address actor) external view returns (FreezeState memory);

    /**
     * @notice What FreezePolicy and TimelockPolicy read.
     * @return safeFrozen The Safe-wide freeze is active.
     * @return actorFrozen `actor`'s own freeze is active (always false for `Scope.ANY`).
     * @return epoch Safe-wide epoch + `actor`'s epoch: increases with every freeze that affects `actor`.
     */
    function freezeStatus(
        address safe,
        address actor
    ) external view returns (bool safeFrozen, bool actorFrozen, uint64 epoch);

    function isGuardian(address safe, address account) external view returns (bool);

    function isLifter(address safe, address account) external view returns (bool);

    function getRoleMembers(address safe, FreezeRole role) external view returns (address[] memory);

    // =============================================================================================
    // Identity and keys
    // =============================================================================================

    /// @notice `Scope.moduleCallHash`: the module-path `txHash` and `moduleTxHash`.
    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32);

    /// @notice `Scope.key(scope)`.
    function scopeKey(ScopeData calldata scope) external pure returns (bytes32);

    /// @notice `Scope.attachmentId(scopeKey, kind, policy)`.
    function attachmentId(bytes32 scopeKey, AttachmentKind kind, address policy) external pure returns (bytes32);

    // =============================================================================================
    // Enumeration (for the app; not used on the hot path)
    // =============================================================================================

    /// @notice Every scope of `safe` holding at least one attachment, in insertion order (a removed
    ///         scope's slot is filled by the last one).
    function getScopes(address safe) external view returns (bytes32[] memory keys, ScopeData[] memory scopes);

    /// @notice Every attachment of `safe`, grouped by scope in `getScopes` order.
    function getAttachments(address safe) external view returns (AttachmentView[] memory);

    function getScopeAttachments(address safe, bytes32 key) external view returns (AttachmentView[] memory);

    function getAttachment(
        address safe,
        bytes32 attachmentId_
    ) external view returns (bool exists, AttachmentView memory attachment);

    /// @notice Bit i set iff scope level i has at least one attachment on `safe`.
    function levelsUsed(address safe) external view returns (uint8);

    /**
     * @notice The attachments a transaction would match, without running any policy: per call (each
     *         sub-call of a trusted batch), in scope-level order, after the op-mask filter.
     * @param policy Only attachments of this policy; `address(0)` for all (built-ins included).
     * @dev Returns an empty list for a malformed batch. Used by TimelockPolicy to resolve the
     *      cancellers of a scheduled transaction, and by the app.
     */
    function getMatchingAttachments(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address policy
    ) external view returns (MatchView[] memory);

    function isTrustedBatch(address target) external view returns (bool);

    function getTrustedBatches() external view returns (address[] memory);

    /// @notice The pinned PolicySignLib whose typed entry points are matched as CALL (SPEC.md §6.3).
    function SIGN_LIB() external view returns (address);

    // =============================================================================================
    // Preview
    // =============================================================================================

    /**
     * @notice Runs every gate a transaction would meet, without stopping at the first deny, and
     *         always reverts with `Preview(gates)` so nothing persists. Call it with `eth_call`.
     * @param actor `Scope.OWNERS` for the owner path, else the module.
     * @dev The transaction is allowed iff no gate has verdict DENY. Owner path: `txHash` is the hash
     *      at the Safe's current nonce; no signatures or policy context are available, so policies
     *      needing them report their deny reason.
     */
    function preview(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external;
}
