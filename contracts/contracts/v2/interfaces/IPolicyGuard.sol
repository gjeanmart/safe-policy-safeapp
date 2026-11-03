// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {ISafeModuleGuard} from "../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {AttachmentView, Call, Change, Kind, MatchView, Scope} from "../libraries/Types.sol";

/**
 * @title Policy Guard (rev 3 engine)
 * @notice The full ABI of the engine: Safe 1.5.0 transaction guard (owner path) and module guard
 *         (module path), configuration, views and the `matches` preview. One address for Safes,
 *         policies and the app; the deployment may split the code over two contracts (hooks and a
 *         configuration/views contract reached by fallback), which does not change this ABI.
 *         The app detects the engine with `supportsInterface(type(IPolicyGuard).interfaceId)`.
 *         Normative behaviour: SPEC.md §3.
 * @dev Hooks (inherited): `checkTransaction` (who: the Safe, owner path), `checkAfterExecution`,
 *      `checkModuleTransaction` (who: the Safe, module path; returns the module call hash) and
 *      `checkAfterModuleExecution`. Each check looks every call up at the 6 scopes of its actor,
 *      applies DENY and ALLOW, then calls each matched policy once (SPEC.md §3.4 verdict order).
 */
interface IPolicyGuard is ISafeTransactionGuard, ISafeModuleGuard {
    // =============================================================================================
    // Events
    // =============================================================================================

    /**
     * @notice An attachment was created or updated. Carries everything the app needs to rebuild a
     *         Safe's configuration from logs alone.
     * @param opMask The normalized op mask.
     * @param settings The settings passed to `IPolicy.configure` (empty for ALLOW and DENY).
     */
    event Attached(
        address indexed safe,
        bytes32 indexed attachmentId,
        bytes32 indexed scopeKey,
        Scope scope,
        Kind kind,
        address policy,
        uint8 opMask,
        bytes settings
    );

    /// @notice An attachment was removed. The policy was not called.
    event Detached(address indexed safe, bytes32 indexed attachmentId, bytes32 indexed scopeKey);

    // =============================================================================================
    // Errors: verdicts (guard hooks)
    // =============================================================================================

    /// @notice A built-in DENY matched call `callIndex` (the first in level order).
    error Denied(uint16 callIndex, bytes32 attachmentId);

    /// @notice No ALLOW that counts matched call `callIndex` (deny by default).
    error NotGranted(uint16 callIndex, address to, bytes4 selector, Operation operation);

    /// @notice A policy denied: it reverted (`reason` = its revert data, truncated to
    ///         `ScopeLib.MAX_REASON_LENGTH`), or returned something other than `IPolicy.check.selector`
    ///         (`reason` empty).
    error PolicyDenied(address policy, bytes reason);

    // =============================================================================================
    // Errors: transaction shape and engine rules (guard hooks)
    // =============================================================================================

    /// @notice Call `callIndex` has 1 to 3 bytes of calldata.
    error InvalidSelector(uint16 callIndex);

    /// @notice Call `callIndex` targets the engine and is not an allowed `configure` (a top-level
    ///         CALL with zero value, outside any batch), or targets another engine function.
    error GuardTargetDenied(uint16 callIndex);

    /// @notice A DELEGATECALL to a trusted batch whose calldata does not decode, is empty, or that
    ///         carries value.
    error MalformedBatch();

    /// @notice A trusted batch with more than `ScopeLib.MAX_BATCH_CALLS` calls.
    error BatchTooLarge();

    /// @notice Batch sub-call `callIndex` DELEGATECALLs a trusted batch (no nesting).
    error NestedBatch(uint16 callIndex);

    /// @notice A hook, or `configure`, was entered while a check is running.
    error Reentrancy();

    /// @notice Owner path: `gasPrice != 0` (refunds are not supported).
    error NonZeroGasPrice();

    /// @notice Owner path: `safeTxGas != 0` would let a failed inner call commit policy state.
    error NonZeroSafeTxGas();

    /// @notice Owner path: the guarded transaction failed (`checkAfterExecution`).
    error ExecutionFailed();

    /// @notice Module path: the guarded module transaction failed (`checkAfterModuleExecution`), so
    ///         the state policies wrote during the check is rolled back with it.
    error ModuleExecutionFailed();

    // =============================================================================================
    // Errors: configuration
    // =============================================================================================

    /// @notice A scope that is not normalized (`ScopeLib.isNormalized`).
    error InvalidScope();

    /// @notice An ALLOW at actor `ScopeLib.ANY`: a grant must name an actor (Owners or a module).
    error AllowNotPerActor();

    /// @notice An ALLOW whose op mask covers DELEGATECALL at a level other than 5.
    error DelegateCallNotExact();

    /// @notice An op mask above `ScopeLib.OP_ALL`.
    error InvalidOpMask(uint8 opMask);

    /// @notice POLICY with a zero address or a contract that does not report `IPolicy` through
    ///         ERC-165; ALLOW or DENY with a non-zero policy or non-empty settings.
    error InvalidPolicy(address policy);

    /// @notice `IPolicy.configure` or `IPolicy.validate` reverted; `reason` is its revert data.
    error PolicyConfigurationFailed(address policy, bytes reason);

    /// @notice Attaching would put more than `ScopeLib.MAX_ATTACHMENTS_PER_SCOPE` at `scopeKey`.
    error TooManyAttachments(bytes32 scopeKey);

    /// @notice Detaching an attachment that does not exist.
    error NotAttached(bytes32 attachmentId);

    /// @notice Constructor: a zero or duplicate trusted batch, more than
    ///         `ScopeLib.MAX_TRUSTED_BATCHES`, or a zero configuration contract.
    error InvalidDeployment();

    // =============================================================================================
    // Configuration
    // =============================================================================================

    /**
     * @notice Applies `changes` in order, at once, for `msg.sender` (who: the Safe; any caller
     *         only ever configures its own address). Not delayed by the engine: on a guarded Safe it
     *         is an ordinary Safe transaction, judged like any other call (SPEC.md §3.3), so the
     *         owners' Timelock delays it and their freeze blocks it. Before the guard is set,
     *         the install batch calls it unguarded.
     * @dev Attach / update calls `IPolicy.configure` for POLICY; emits `Attached`. Detach does not
     *      call the policy; emits `Detached`. After the whole batch, `IPolicy.validate(safe)` is
     *      STATICCALLed once per policy the batch attached, updated or detached, unless none of its
     *      attachments is left: the policy checks its invariants over the final configuration.
     *      Reverts `Reentrancy` during a check.
     */
    function configure(Change[] calldata changes) external;

    // =============================================================================================
    // Preview and lookup
    // =============================================================================================

    /**
     * @notice Everything the guard hook would match for a transaction, without running any
     *         policy: the app's preview (then `eth_call` of each policy's `check` from this
     *         address) and the Timelock's schedule-time lookup.
     * @param actor `ScopeLib.OWNERS` for the owner path, else the module.
     * @return calls The calls the hook would check (decoded sub-calls of a trusted batch, else
     *         the top-level call); empty when the batch does not decode.
     * @return found Every matched attachment, per call in level order, after the op-mask filter.
     * @return engineError The ABI-encoded error the hook would revert with before running any
     *         policy (shape, engine target, `Denied`, `NotGranted`), or empty if the built-in
     *         gates pass. Owner-path gas checks (`NonZeroGasPrice`, `NonZeroSafeTxGas`) are not
     *         evaluated.
     */
    function matches(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external view returns (Call[] memory calls, MatchView[] memory found, bytes memory engineError);

    // =============================================================================================
    // Views
    // =============================================================================================

    /// @notice Every scope of `safe` holding at least one attachment.
    function getScopes(address safe) external view returns (bytes32[] memory keys, Scope[] memory scopes);

    /// @notice Every attachment of `safe`, grouped by scope in `getScopes` order.
    function getAttachments(address safe) external view returns (AttachmentView[] memory);

    /// @notice The attachments at one scope, in lookup order.
    function getScopeAttachments(address safe, bytes32 scopeKey) external view returns (AttachmentView[] memory);

    /// @notice One attachment by id; `exists` is false once detached.
    function getAttachment(
        address safe,
        bytes32 attachmentId
    ) external view returns (bool exists, AttachmentView memory attachment);

    /// @notice Bit i set iff scope level i (0..5) holds at least one attachment of `safe`.
    function levelsUsed(address safe) external view returns (uint8);

    /// @notice The trusted batch contracts (MultiSendCallOnly 1.4.1+), fixed at deployment.
    function trustedBatches() external view returns (address[] memory);

    function isTrustedBatch(address target) external view returns (bool);

    /// @notice `ScopeLib.key(scope)`.
    function scopeKey(Scope calldata scope) external pure returns (bytes32);

    /// @notice `ScopeLib.attachmentId(scopeKey, kind, policy)`.
    function attachmentId(bytes32 scopeKey, Kind kind, address policy) external pure returns (bytes32);

    /// @notice `ScopeLib.moduleCallHash`: the module-path `Context.txHash`.
    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32);
}
