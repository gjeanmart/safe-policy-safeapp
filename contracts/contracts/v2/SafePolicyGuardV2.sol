// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../vendor/policy-engine/interfaces/IERC165.sol";
import {ISafe} from "../vendor/policy-engine/interfaces/ISafe.sol";
import {ISafeModuleGuard} from "../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";
import {SignatureExtension} from "../vendor/policy-engine/libraries/SignatureExtension.sol";
import {IPolicyEngineV2} from "./interfaces/IPolicyEngineV2.sol";
import {IPolicyV2} from "./interfaces/IPolicyV2.sol";
import {MultiSendDecoder} from "./libraries/MultiSendDecoder.sol";
import {Scope} from "./libraries/Scope.sol";
import {
    AttachmentChange,
    AttachmentKind,
    AttachmentView,
    Call,
    Context,
    FreezeRole,
    FreezeState,
    GateKind,
    GateResult,
    MatchView,
    PolicyContext,
    PolicyLevel,
    RoleChange,
    ScopeData,
    Verdict
} from "./libraries/Types.sol";
import {EngineStorage} from "./engine/EngineStorage.sol";
import {PolicyEngineV2} from "./PolicyEngineV2.sol";

/**
 * @title Safe Policy Guard V2
 * @notice The V2 engine and Safe 1.5.0 guard in one contract: transaction guard (owner path) and
 *         module guard (module path). Every call of a transaction is looked up at the 8 scopes of
 *         its actor; built-in DENY and ALLOW decide grants, policies can only pass or deny.
 *         Normative behaviour: SPEC.md §6.
 * @dev Research prototype, unaudited.
 */
contract SafePolicyGuardV2 is EngineStorage, IPolicyEngineV2, ISafeTransactionGuard, ISafeModuleGuard {
    /// @dev Gas kept back from each policy run in `preview`, so an out-of-gas policy is reported
    ///      instead of aborting the preview (SPEC.md §6.7).
    uint256 private constant _PREVIEW_GAS_RESERVE = 300_000;

    /// @dev {PolicyEngineV2}, deployed by the constructor, DELEGATECALLed for configuration and freeze.
    address private immutable _LOGIC;

    /// @dev A transaction-level policy run being accumulated across calls.
    struct Run {
        address policy;
        uint256 count;
        bytes32[] ids;
        uint8[] levels;
    }

    /// @dev Everything one evaluation carries. `ctx.txHash`/`ctx.nonce` are computed lazily on the
    ///      owner path (only when a policy runs), from the top-level fields kept here.
    struct Frame {
        Context ctx;
        bool preview;
        bool ctxReady;
        address to;
        uint256 value;
        Operation operation;
        uint256 baseGas;
        address gasToken;
        address refundReceiver;
        PolicyContext[] contexts;
        Run[] runs;
        uint256 runCount;
        GateResult[] gates;
        uint256 gateCount;
    }

    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineStorage(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {
        _LOGIC = address(new PolicyEngineV2(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib));
    }

    // =============================================================================================
    // Configuration and freeze: run by {PolicyEngineV2} on this contract's storage
    // =============================================================================================

    /// @inheritdoc IPolicyEngineV2
    function configureImmediately(AttachmentChange[] calldata, RoleChange[] calldata) external override {
        _delegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function requestConfiguration(bytes32) external override {
        _delegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function invalidateRoot(bytes32) external override {
        _delegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function applyConfiguration(AttachmentChange[] calldata, RoleChange[] calldata) external override {
        _delegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function freeze(address[] calldata) external override {
        _delegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function freezeActor(address, address) external override {
        _delegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function lift(address, address) external override {
        _delegateToLogic();
    }

    /// @notice The logic contract this engine DELEGATECALLs for configuration and freeze.
    function engineLogic() external view returns (address) {
        return _LOGIC;
    }

    /// @dev Forwards the current call to {PolicyEngineV2} and returns or reverts with its result.
    function _delegateToLogic() private {
        address logic = _LOGIC;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), logic, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    /// @notice Plumbing for the enumeration views: DELEGATECALLs {PolicyEngineV2} with `data` and
    ///         returns its raw result. Only this contract may call it (from a STATICCALL, so the
    ///         logic runs read-only on this storage).
    function delegateView(bytes calldata data) external {
        require(msg.sender == address(this), GuardTargetDenied());
        address logic = _LOGIC;
        assembly ("memory-safe") {
            calldatacopy(0, data.offset, data.length)
            let ok := delegatecall(gas(), logic, 0, data.length, 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    /// @dev Runs the current (view) call on {PolicyEngineV2} through {delegateView} and returns its
    ///      result: a view cannot DELEGATECALL, but it can STATICCALL itself.
    function _staticDelegateToLogic() private view {
        (bool ok, bytes memory result) = address(this).staticcall(
            abi.encodeCall(this.delegateView, (msg.data))
        );
        assembly ("memory-safe") {
            if iszero(ok) {
                revert(add(result, 0x20), mload(result))
            }
            return(add(result, 0x20), mload(result))
        }
    }

    // =============================================================================================
    // Views
    // =============================================================================================

    /// @inheritdoc IPolicyEngineV2
    function DELAY() external view override returns (uint256) {
        return _DELAY;
    }

    /// @inheritdoc IPolicyEngineV2
    function EXPIRY() external view override returns (uint256) {
        return _EXPIRY;
    }

    /// @inheritdoc IPolicyEngineV2
    function MAX_FREEZE() external view override returns (uint256) {
        return _MAX_FREEZE;
    }

    /// @inheritdoc IPolicyEngineV2
    function FREEZE_COOLDOWN() external view override returns (uint256) {
        return _FREEZE_COOLDOWN;
    }

    /// @inheritdoc IPolicyEngineV2
    function SIGN_LIB() external view override returns (address) {
        return _SIGN_LIB;
    }

    /// @inheritdoc IPolicyEngineV2
    function rootConfigured(address safe, bytes32 root) external view override returns (uint256) {
        return _rootConfigured[safe][root];
    }

    /// @inheritdoc IPolicyEngineV2
    function configurationRoot(
        AttachmentChange[] calldata changes,
        RoleChange[] calldata roles
    ) external pure override returns (bytes32) {
        return keccak256(abi.encode(changes, roles));
    }

    /// @inheritdoc IPolicyEngineV2
    function getFreezeState(address safe, address actor) external view override returns (FreezeState memory) {
        return _freezes[safe][actor];
    }

    /// @inheritdoc IPolicyEngineV2
    function freezeStatus(
        address safe,
        address actor
    ) external view override returns (bool safeFrozen, bool actorFrozen, uint64 epoch) {
        FreezeState storage safeWide = _freezes[safe][Scope.ANY];
        safeFrozen = block.timestamp < safeWide.frozenUntil;
        epoch = safeWide.epoch;
        if (actor != Scope.ANY) {
            FreezeState storage own = _freezes[safe][actor];
            actorFrozen = block.timestamp < own.frozenUntil;
            epoch += own.epoch;
        }
    }

    /// @inheritdoc IPolicyEngineV2
    function isGuardian(address safe, address account) external view override returns (bool) {
        return _hasRole[safe][FreezeRole.GUARDIAN][account];
    }

    /// @inheritdoc IPolicyEngineV2
    function isLifter(address safe, address account) external view override returns (bool) {
        return _hasRole[safe][FreezeRole.LIFTER][account];
    }

    /// @inheritdoc IPolicyEngineV2
    function getRoleMembers(address safe, FreezeRole role) external view override returns (address[] memory) {
        return _roleMembers[safe][role];
    }

    /// @inheritdoc IPolicyEngineV2
    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure override returns (bytes32) {
        return Scope.moduleCallHash(safe, actor, to, value, data, operation);
    }

    /// @inheritdoc IPolicyEngineV2
    function scopeKey(ScopeData calldata scope) external pure override returns (bytes32) {
        return Scope.key(scope);
    }

    /// @inheritdoc IPolicyEngineV2
    function attachmentId(bytes32 key, AttachmentKind kind, address policy) external pure override returns (bytes32) {
        return Scope.attachmentId(key, kind, policy);
    }

    /// @inheritdoc IPolicyEngineV2
    function isTrustedBatch(address target) external view override returns (bool) {
        return _isTrustedBatch(target);
    }

    /// @inheritdoc IPolicyEngineV2
    function getTrustedBatches() external view override returns (address[] memory batches) {
        address[4] memory all = [_BATCH_0, _BATCH_1, _BATCH_2, _BATCH_3];
        batches = new address[](all.length);
        uint256 count;
        for (uint256 i = 0; i < all.length; i++) {
            if (all[i] != address(0)) {
                batches[count++] = all[i];
            }
        }
        assembly ("memory-safe") {
            mstore(batches, count)
        }
    }

    /// @inheritdoc IPolicyEngineV2
    function getScopes(
        address
    ) external view override returns (bytes32[] memory, ScopeData[] memory) {
        _staticDelegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function getAttachments(address) external view override returns (AttachmentView[] memory) {
        _staticDelegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function getScopeAttachments(address, bytes32) external view override returns (AttachmentView[] memory) {
        _staticDelegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function getAttachment(
        address,
        bytes32
    ) external view override returns (bool, AttachmentView memory) {
        _staticDelegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function getMatchingAttachments(
        address,
        address,
        address,
        uint256,
        bytes calldata,
        Operation,
        address
    ) external view override returns (MatchView[] memory) {
        _staticDelegateToLogic();
    }

    /// @inheritdoc IPolicyEngineV2
    function levelsUsed(address safe) external view override returns (uint8) {
        return Scope.bitmap(_levelCounts[safe]);
    }

    // =============================================================================================
    // ERC-165
    // =============================================================================================

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IPolicyEngineV2).interfaceId ||
            interfaceId == type(ISafeTransactionGuard).interfaceId ||
            interfaceId == type(ISafeModuleGuard).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    // =============================================================================================
    // Safe 1.5.0 hooks
    // =============================================================================================

    /// @inheritdoc ISafeTransactionGuard
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures,
        address msgSender
    ) external override {
        require(gasPrice == 0, NonZeroGasPrice());
        require(safeTxGas == 0, NonZeroSafeTxGas());
        _requireNotInCheck();
        _setLock(true);
        Frame memory f;
        f.ctx = Context(msg.sender, Scope.OWNERS, bytes32(0), 0, msgSender);
        f.to = to;
        f.value = value;
        f.operation = operation;
        f.baseGas = baseGas;
        f.gasToken = gasToken;
        f.refundReceiver = refundReceiver;
        f.contexts = _decodeContexts(signatures);
        _evaluate(f, to, value, data, operation, signatures);
        _setLock(false);
    }

    /// @inheritdoc ISafeTransactionGuard
    function checkAfterExecution(bytes32, bool success) external view override {
        _requireNotInCheck();
        require(success, ExecutionFailed());
    }

    /// @inheritdoc ISafeModuleGuard
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module
    ) external override returns (bytes32 moduleTxHash) {
        _requireNotInCheck();
        _setLock(true);
        moduleTxHash = Scope.moduleCallHash(msg.sender, module, to, value, data, operation);
        Frame memory f;
        f.ctx = Context(msg.sender, module, moduleTxHash, 0, module);
        f.ctxReady = true;
        _evaluate(f, to, value, data, operation, msg.data[0:0]);
        _setLock(false);
    }

    /// @inheritdoc ISafeModuleGuard
    function checkAfterModuleExecution(bytes32, bool success) external view override {
        _requireNotInCheck();
        require(success, ModuleExecutionFailed());
    }

    // =============================================================================================
    // Preview
    // =============================================================================================

    /// @inheritdoc IPolicyEngineV2
    function preview(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external override {
        require(actor != Scope.ANY, InvalidActor(actor));
        _requireNotInCheck();
        _setLock(true);
        Frame memory f;
        f.preview = true;
        f.ctx.safe = safe;
        f.ctx.actor = actor;
        f.to = to;
        f.value = value;
        f.operation = operation;
        if (actor != Scope.OWNERS) {
            f.ctx.txHash = Scope.moduleCallHash(safe, actor, to, value, data, operation);
            f.ctx.executor = actor;
            f.ctxReady = true;
        }
        f.gates = new GateResult[](8);
        _evaluate(f, to, value, data, operation, msg.data[0:0]);
        GateResult[] memory gates = f.gates;
        uint256 count = f.gateCount;
        assembly ("memory-safe") {
            mstore(gates, count)
        }
        // Always reverts, so nothing a policy wrote (or the lock) persists.
        revert Preview(gates);
    }

    // =============================================================================================
    // Evaluation (SPEC.md §6.2–6.5)
    // =============================================================================================

    /// @dev Runs every gate of a transaction. Real check: reverts at the first deny. Preview:
    ///      records every gate in `f.gates` and never stops.
    function _evaluate(
        Frame memory f,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        bytes calldata signatures
    ) private {
        (bool selOk, bytes4 sel) = _calldataSelector(data);

        // The configuration path: no lookup, no policy, no ALLOW needed (§5.1).
        if (to == address(this) && selOk && _isConfigSelector(sel)) {
            if (f.ctx.actor != Scope.OWNERS) {
                _ruleDeny(f, Scope.TX_INDEX, abi.encodeWithSelector(ModuleConfigurationDenied.selector));
            } else if (operation != Operation.CALL || value != 0) {
                _ruleDeny(f, Scope.TX_INDEX, abi.encodeWithSelector(GuardTargetDenied.selector));
            } else if (sel == IPolicyEngineV2.applyConfiguration.selector) {
                uint64 frozenUntil = _freezes[f.ctx.safe][Scope.ANY].frozenUntil;
                if (block.timestamp < frozenUntil) {
                    _ruleDeny(f, Scope.TX_INDEX, abi.encodeWithSelector(ConfigFrozen.selector, frozenUntil));
                }
            }
            return;
        }

        bool isBatch = operation == Operation.DELEGATECALL &&
            selOk &&
            sel == MultiSendDecoder.MULTI_SEND_SELECTOR &&
            _isTrustedBatch(to);
        Call[] memory calls;
        if (isBatch) {
            if (value != 0) {
                _ruleDeny(f, Scope.TX_INDEX, abi.encodeWithSelector(MalformedBatch.selector));
                return;
            }
            bool ok;
            bool tooMany;
            (ok, tooMany, calls) = MultiSendDecoder.decode(f.ctx.safe, data);
            if (!ok) {
                _ruleDeny(
                    f,
                    Scope.TX_INDEX,
                    abi.encodeWithSelector(tooMany ? BatchTooLarge.selector : MalformedBatch.selector)
                );
                return;
            }
        } else {
            calls = new Call[](1);
            calls[0] = Call(to, value, data, operation);
        }

        for (uint256 i = 0; i < calls.length; i++) {
            _checkCall(f, i, calls[i], isBatch, data);
        }
        _runTransactionPolicies(f, calls, signatures, data);
    }

    /// @dev SPEC.md §6.3 for call `i`.
    function _checkCall(Frame memory f, uint256 i, Call memory call, bool inBatch, bytes calldata topData) private {
        (bool selOk, bytes4 sel) = Scope.selectorOf(call.data);
        if (!selOk) {
            _ruleDeny(f, i, abi.encodeWithSelector(InvalidSelector.selector, i));
            return;
        }
        address actor = f.ctx.actor;
        if (call.to == address(this)) {
            if (_isConfigSelector(sel)) {
                _ruleDeny(
                    f,
                    i,
                    abi.encodeWithSelector(
                        actor == Scope.OWNERS ? GuardTargetDenied.selector : ModuleConfigurationDenied.selector
                    )
                );
            } else if (
                sel != IPolicyEngineV2.freeze.selector &&
                sel != IPolicyEngineV2.freezeActor.selector &&
                sel != IPolicyEngineV2.lift.selector
            ) {
                _ruleDeny(f, i, abi.encodeWithSelector(GuardTargetDenied.selector));
            }
        }
        if (inBatch && call.operation == Operation.DELEGATECALL && _isTrustedBatch(call.to)) {
            _ruleDeny(f, i, abi.encodeWithSelector(NestedBatch.selector, i));
        }

        Operation effOp = _effectiveOperation(call.to, call.operation, sel);
        // F5: on the module path, calls to the Safe itself or to the engine need an exact ALLOW.
        bool exactOnly = actor != Scope.OWNERS && (call.to == f.ctx.safe || call.to == address(this));

        Match[] memory matches = _match(f.ctx.safe, actor, call.to, sel, effOp);
        bool granted;
        bool hasPolicy;
        for (uint256 k = 0; k < matches.length; k++) {
            Match memory m = matches[k];
            if (m.kind == AttachmentKind.DENY) {
                bytes32 id = Scope.attachmentId(m.scopeKey, m.kind, m.policy);
                _deny(
                    f,
                    GateResult(
                        uint16(i),
                        m.level,
                        GateKind.DENY,
                        id,
                        address(0),
                        Verdict.DENY,
                        abi.encodeWithSelector(Denied.selector, i, id)
                    )
                );
            } else if (m.kind == AttachmentKind.ALLOW) {
                bool counts = m.level == Scope.EXACT_LEVEL || (effOp == Operation.CALL && !exactOnly);
                granted = granted || counts;
                if (f.preview) {
                    _pushGate(
                        f,
                        GateResult(
                            uint16(i),
                            m.level,
                            GateKind.ALLOW,
                            Scope.attachmentId(m.scopeKey, m.kind, m.policy),
                            address(0),
                            counts ? Verdict.ALLOW : Verdict.PASS,
                            counts ? new bytes(0) : abi.encodeWithSelector(AllowNotExact.selector)
                        )
                    );
                }
            } else {
                hasPolicy = true;
            }
        }

        bytes memory notGranted;
        if (!granted) {
            notGranted = abi.encodeWithSelector(NotGranted.selector, i, call.to, sel, call.operation);
            if (!f.preview) {
                _revertWith(notGranted);
            }
        }
        if (hasPolicy) {
            _runCallPolicies(f, i, call, matches, topData);
        }
        if (!granted) {
            _pushGate(
                f,
                GateResult(uint16(i), Scope.NO_LEVEL, GateKind.RULE, bytes32(0), address(0), Verdict.DENY, notGranted)
            );
        }
    }

    /// @dev Runs each distinct call-level policy once with its ids (first-match order) and queues
    ///      the transaction-level matches.
    function _runCallPolicies(
        Frame memory f,
        uint256 i,
        Call memory call,
        Match[] memory matches,
        bytes calldata topData
    ) private {
        for (uint256 k = 0; k < matches.length; k++) {
            Match memory m = matches[k];
            if (m.kind != AttachmentKind.POLICY) {
                continue;
            }
            if (m.policyLevel == PolicyLevel.TRANSACTION) {
                _queueTransactionMatch(f, m.policy, Scope.attachmentId(m.scopeKey, m.kind, m.policy), m.level);
                continue;
            }
            if (_seenCallPolicy(matches, k)) {
                continue;
            }

            uint256 count;
            for (uint256 j = k; j < matches.length; j++) {
                if (_isCallPolicyOf(matches[j], m.policy)) {
                    count++;
                }
            }
            bytes32[] memory ids = new bytes32[](count);
            uint8[] memory levels = new uint8[](count);
            count = 0;
            for (uint256 j = k; j < matches.length; j++) {
                Match memory o = matches[j];
                if (_isCallPolicyOf(o, m.policy)) {
                    ids[count] = Scope.attachmentId(o.scopeKey, o.kind, o.policy);
                    levels[count++] = o.level;
                }
            }

            _ensureContext(f, topData);
            (bool pass, bytes memory reason) = _callPolicy(
                f,
                m.policy,
                abi.encodeCall(IPolicyV2.checkCall, (f.ctx, call, ids)),
                IPolicyV2.checkCall.selector
            );
            if (!pass && !f.preview) {
                revert PolicyDenied(i, m.policy, reason);
            }
            _policyGates(f, uint16(i), m.policy, ids, levels, count, pass, reason);
        }
    }

    function _runTransactionPolicies(
        Frame memory f,
        Call[] memory calls,
        bytes calldata signatures,
        bytes calldata topData
    ) private {
        for (uint256 r = 0; r < f.runCount; r++) {
            Run memory run = f.runs[r];
            bytes32[] memory ids = run.ids;
            uint256 count = run.count;
            assembly ("memory-safe") {
                mstore(ids, count)
            }
            _ensureContext(f, topData);
            (bool pass, bytes memory reason) = _callPolicy(
                f,
                run.policy,
                abi.encodeCall(
                    IPolicyV2.checkTransaction,
                    (f.ctx, calls, signatures, _policyData(f.contexts, run.policy), ids)
                ),
                IPolicyV2.checkTransaction.selector
            );
            if (!pass && !f.preview) {
                revert PolicyDenied(Scope.TX_INDEX, run.policy, reason);
            }
            _policyGates(f, Scope.TX_INDEX, run.policy, ids, run.levels, count, pass, reason);
        }
    }

    /// @dev Preview: one gate per attachment of a policy run, all with the run's verdict.
    function _policyGates(
        Frame memory f,
        uint16 callIndex,
        address policy,
        bytes32[] memory ids,
        uint8[] memory levels,
        uint256 count,
        bool pass,
        bytes memory reason
    ) private pure {
        if (!f.preview) {
            return;
        }
        for (uint256 j = 0; j < count; j++) {
            _pushGate(
                f,
                GateResult(
                    callIndex,
                    levels[j],
                    GateKind.POLICY,
                    ids[j],
                    policy,
                    pass ? Verdict.PASS : Verdict.DENY,
                    reason
                )
            );
        }
    }

    /// @dev Calls a policy with all remaining gas (less a reserve in preview). PASS iff it
    ///      succeeds and returns exactly the 32-byte word `magic`; the reason is its bounded revert data.
    function _callPolicy(
        Frame memory f,
        address policy,
        bytes memory data,
        bytes4 magic
    ) private returns (bool pass, bytes memory reason) {
        uint256 gasLimit = gasleft();
        if (f.preview) {
            gasLimit = gasLimit > 2 * _PREVIEW_GAS_RESERVE ? gasLimit - _PREVIEW_GAS_RESERVE : gasLimit / 2;
        }
        bool ok;
        uint256 size;
        bytes32 word;
        assembly ("memory-safe") {
            ok := call(gasLimit, policy, 0, add(data, 0x20), mload(data), 0, 0)
            size := returndatasize()
            if and(ok, eq(size, 0x20)) {
                returndatacopy(0, 0, 0x20)
                word := mload(0)
            }
        }
        if (ok) {
            return (size == 0x20 && word == bytes32(magic), reason);
        }
        return (false, _boundedReturnData());
    }

    /// @dev The owner-path `txHash` and `nonce`, computed on the first policy run only.
    function _ensureContext(Frame memory f, bytes calldata topData) private view {
        if (f.ctxReady) {
            return;
        }
        f.ctxReady = true;
        ISafe safe = ISafe(f.ctx.safe);
        // The Safe increments its nonce before calling the guard; preview hashes the next one.
        uint256 nonce = f.preview ? safe.nonce() : safe.nonce() - 1;
        f.ctx.nonce = nonce;
        f.ctx.txHash = safe.getTransactionHash(
            f.to,
            f.value,
            topData,
            f.operation,
            0,
            f.baseGas,
            0,
            f.gasToken,
            f.refundReceiver,
            nonce
        );
    }

    // =============================================================================================
    // Helpers
    // =============================================================================================

    /// @dev Real check: reverts with the gate's reason. Preview: records the gate.
    function _deny(Frame memory f, GateResult memory gate) private pure {
        if (!f.preview) {
            _revertWith(gate.reason);
        }
        _pushGate(f, gate);
    }

    function _ruleDeny(Frame memory f, uint256 callIndex, bytes memory reason) private pure {
        _deny(
            f,
            GateResult(uint16(callIndex), Scope.NO_LEVEL, GateKind.RULE, bytes32(0), address(0), Verdict.DENY, reason)
        );
    }

    function _pushGate(Frame memory f, GateResult memory gate) private pure {
        if (f.gateCount == f.gates.length) {
            GateResult[] memory bigger = new GateResult[](f.gates.length * 2 + 1);
            for (uint256 i = 0; i < f.gateCount; i++) {
                bigger[i] = f.gates[i];
            }
            f.gates = bigger;
        }
        f.gates[f.gateCount++] = gate;
    }

    /// @dev Adds `(policy, id)` to the transaction-level runs, deduplicated by id.
    function _queueTransactionMatch(Frame memory f, address policy, bytes32 id, uint8 lvl) private pure {
        Run memory run;
        for (uint256 r = 0; r < f.runCount; r++) {
            if (f.runs[r].policy == policy) {
                run = f.runs[r];
                break;
            }
        }
        if (run.policy == address(0)) {
            if (f.runCount == f.runs.length) {
                Run[] memory bigger = new Run[](f.runs.length * 2 + 2);
                for (uint256 r = 0; r < f.runCount; r++) {
                    bigger[r] = f.runs[r];
                }
                f.runs = bigger;
            }
            run = Run(policy, 0, new bytes32[](4), new uint8[](4));
            f.runs[f.runCount++] = run;
        } else {
            for (uint256 j = 0; j < run.count; j++) {
                if (run.ids[j] == id) {
                    return;
                }
            }
        }
        if (run.count == run.ids.length) {
            bytes32[] memory ids = new bytes32[](run.count * 2);
            uint8[] memory levels = new uint8[](run.count * 2);
            for (uint256 j = 0; j < run.count; j++) {
                ids[j] = run.ids[j];
                levels[j] = run.levels[j];
            }
            run.ids = ids;
            run.levels = levels;
        }
        run.ids[run.count] = id;
        run.levels[run.count] = lvl;
        run.count++;
    }

    function _seenCallPolicy(Match[] memory matches, uint256 k) private pure returns (bool) {
        for (uint256 j = 0; j < k; j++) {
            if (_isCallPolicyOf(matches[j], matches[k].policy)) {
                return true;
            }
        }
        return false;
    }

    function _isCallPolicyOf(Match memory m, address policy) private pure returns (bool) {
        return m.kind == AttachmentKind.POLICY && m.policyLevel == PolicyLevel.CALL && m.policy == policy;
    }

    function _policyData(PolicyContext[] memory contexts, address policy) private pure returns (bytes memory) {
        for (uint256 i = 0; i < contexts.length; i++) {
            if (contexts[i].policy == policy) {
                return contexts[i].data;
            }
        }
        return new bytes(0);
    }

    function _isConfigSelector(bytes4 sel) private pure returns (bool) {
        return
            sel == IPolicyEngineV2.requestConfiguration.selector ||
            sel == IPolicyEngineV2.invalidateRoot.selector ||
            sel == IPolicyEngineV2.applyConfiguration.selector;
    }

    function _revertWith(bytes memory reason) private pure {
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }

    /**
     * @dev The owner-path policy context (SPEC.md §6.6): absent → empty; present → a strictly
     *      decoded `abi.encode(PolicyContext[])` with distinct policies, else `MalformedContext`.
     *      Decoded by hand so every malformation maps to `MalformedContext` instead of a bare revert.
     */
    function _decodeContexts(bytes calldata signatures) private pure returns (PolicyContext[] memory contexts) {
        if (!SignatureExtension.has(signatures, Scope.CONTEXT_TYPE_HASH)) {
            return contexts;
        }
        uint256 length = signatures.length;
        require(length >= 64, MalformedContext());
        uint256 end = length - 64;
        uint256 payloadLength = _word(signatures, end);
        require(payloadLength <= end, MalformedContext());
        bytes calldata payload = signatures[end - payloadLength:end];
        require(payload.length >= 64 && _word(payload, 0) == 0x20, MalformedContext());
        uint256 count = _word(payload, 32);
        bytes calldata body = payload[64:];
        require(count <= body.length / 32, MalformedContext());
        contexts = new PolicyContext[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = _word(body, 32 * i);
            require(offset <= body.length && body.length - offset >= 64, MalformedContext());
            uint256 policyWord = _word(body, offset);
            require(policyWord >> 160 == 0, MalformedContext());
            uint256 dataOffset = _word(body, offset + 32);
            require(dataOffset <= body.length - offset && body.length - offset - dataOffset >= 32, MalformedContext());
            uint256 position = offset + dataOffset;
            uint256 dataLength = _word(body, position);
            require(dataLength <= body.length - position - 32, MalformedContext());
            address policy = address(uint160(policyWord));
            for (uint256 j = 0; j < i; j++) {
                require(contexts[j].policy != policy, MalformedContext());
            }
            contexts[i] = PolicyContext(policy, body[position + 32:position + 32 + dataLength]);
        }
    }

    function _word(bytes calldata data, uint256 at) private pure returns (uint256) {
        return uint256(bytes32(data[at:at + 32]));
    }
}
