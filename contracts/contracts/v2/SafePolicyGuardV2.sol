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

    /// @dev Odd multiplier (64-bit golden ratio) spreading keys over the in-memory hash tables.
    uint256 private constant _HASH_MULTIPLIER = 0x9e3779b97f4a7c15;

    /// @dev {PolicyEngineV2}, deployed by the constructor, DELEGATECALLed for configuration and freeze.
    address private immutable _LOGIC;

    /// @dev Everything one evaluation carries. `ctx.txHash`/`ctx.nonce` are computed lazily on the
    ///      owner path (only when a policy runs), from the top-level fields kept here. `txIds` /
    ///      `txMetas` queue the transaction-level policy matches of all calls (not deduplicated yet),
    ///      `txMetas[e] = policy | level << 160`.
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
        bytes32[] txIds;
        uint256[] txMetas;
        uint256 txCount;
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

        (uint256[] memory matches, bytes32[8] memory keys) = _match(f.ctx.safe, actor, call.to, sel, effOp);
        bool granted;
        // This call's call-level policy matches, run once the built-in gates are known.
        bytes32[] memory ids;
        uint256[] memory metas;
        uint256 count;
        for (uint256 k = 0; k < matches.length; k++) {
            uint256 word = matches[k];
            uint8 lvl = uint8(word >> _MATCH_LEVEL_SHIFT);
            uint256 kind = uint8(word >> 160);
            address policy = address(uint160(word));
            if (kind == uint8(AttachmentKind.DENY)) {
                bytes32 id = _attachmentId(keys[lvl], kind, policy);
                _deny(
                    f,
                    GateResult(
                        uint16(i),
                        lvl,
                        GateKind.DENY,
                        id,
                        address(0),
                        Verdict.DENY,
                        abi.encodeWithSelector(Denied.selector, i, id)
                    )
                );
            } else if (kind == uint8(AttachmentKind.ALLOW)) {
                bool counts = lvl == Scope.EXACT_LEVEL || (effOp == Operation.CALL && !exactOnly);
                granted = granted || counts;
                if (f.preview) {
                    _pushGate(
                        f,
                        GateResult(
                            uint16(i),
                            lvl,
                            GateKind.ALLOW,
                            _attachmentId(keys[lvl], kind, policy),
                            address(0),
                            counts ? Verdict.ALLOW : Verdict.PASS,
                            counts ? new bytes(0) : abi.encodeWithSelector(AllowNotExact.selector)
                        )
                    );
                }
            } else {
                bytes32 id = _attachmentId(keys[lvl], kind, policy);
                uint256 meta = uint160(policy) | (uint256(lvl) << 160);
                if (uint8(word >> 176) == uint8(PolicyLevel.CALL)) {
                    if (count == 0) {
                        ids = new bytes32[](matches.length - k);
                        metas = new uint256[](matches.length - k);
                    }
                    ids[count] = id;
                    metas[count++] = meta;
                } else {
                    _queueTransactionMatch(f, id, meta);
                }
            }
        }

        bytes memory notGranted;
        if (!granted) {
            notGranted = abi.encodeWithSelector(NotGranted.selector, i, call.to, sel, call.operation);
            if (!f.preview) {
                _revertWith(notGranted);
            }
        }
        if (count != 0) {
            _runPolicies(f, i, call, new Call[](0), msg.data[0:0], topData, ids, metas, count);
        }
        if (!granted) {
            _pushGate(
                f,
                GateResult(uint16(i), Scope.NO_LEVEL, GateKind.RULE, bytes32(0), address(0), Verdict.DENY, notGranted)
            );
        }
    }

    function _runTransactionPolicies(
        Frame memory f,
        Call[] memory calls,
        bytes calldata signatures,
        bytes calldata topData
    ) private {
        if (f.txCount != 0) {
            _runPolicies(f, Scope.TX_INDEX, calls[0], calls, signatures, topData, f.txIds, f.txMetas, f.txCount);
        }
    }

    /**
     * @dev Runs each distinct policy of `count` matches `(ids[e], metas[e])` once, in first-match
     *      order, with its ids: `checkCall(ctx, call, ids)` for call `callIndex`, or
     *      `checkTransaction(ctx, calls, signatures, policyData, ids)` for `TX_INDEX` (ids
     *      deduplicated across calls).
     */
    function _runPolicies(
        Frame memory f,
        uint256 callIndex,
        Call memory call,
        Call[] memory calls,
        bytes calldata signatures,
        bytes calldata topData,
        bytes32[] memory ids,
        uint256[] memory metas,
        uint256 count
    ) private {
        bool isTx = callIndex == Scope.TX_INDEX;
        (address[] memory policies, bytes32[][] memory runIds, uint8[][] memory runLevels) = _group(
            ids,
            metas,
            count,
            isTx
        );
        uint256 runs = policies.length;
        _ensureContext(f, topData);
        bytes4 magic = isTx ? IPolicyV2.checkTransaction.selector : IPolicyV2.checkCall.selector;
        for (uint256 r = 0; r < runs; r++) {
            address policy = policies[r];
            bytes32[] memory runIdList = runIds[r];
            (bool pass, bytes memory reason) = _callPolicy(
                f,
                policy,
                _encodeCheck(magic, f.ctx, call, calls, signatures, _policyData(f.contexts, policy), runIdList),
                magic
            );
            if (!pass && !f.preview) {
                revert PolicyDenied(callIndex, policy, reason);
            }
            _policyGates(f, uint16(callIndex), policy, runIdList, runLevels[r], pass, reason);
        }
    }

    /// @dev Preview: one gate per attachment of a policy run, all with the run's verdict.
    function _policyGates(
        Frame memory f,
        uint16 callIndex,
        address policy,
        bytes32[] memory ids,
        uint8[] memory levels,
        bool pass,
        bytes memory reason
    ) private pure {
        if (!f.preview) {
            return;
        }
        for (uint256 j = 0; j < ids.length; j++) {
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

    /// @dev Queues a transaction-level match; repeated ids are dropped when the runs are formed.
    function _queueTransactionMatch(Frame memory f, bytes32 id, uint256 meta) private pure {
        uint256 n = f.txCount;
        if (n == f.txIds.length) {
            bytes32[] memory ids = new bytes32[](2 * n + 4);
            uint256[] memory metas = new uint256[](2 * n + 4);
            for (uint256 j = 0; j < n; j++) {
                ids[j] = f.txIds[j];
                metas[j] = f.txMetas[j];
            }
            f.txIds = ids;
            f.txMetas = metas;
        }
        f.txIds[n] = id;
        f.txMetas[n] = meta;
        f.txCount = n + 1;
    }

    /**
     * @dev Groups `count` policy matches `(ids[e], metas[e] = policy | level << 160)` into runs, one
     *      per distinct policy in first-match order, each with its ids and levels in match order;
     *      with `dedup`, a repeated id is dropped. Linear in `count` (SPEC.md §9): policies and ids
     *      are looked up in open-addressing hash tables (power-of-two size, at most half full) in
     *      memory. Assembly: the same in Solidity costs ~100 gas per array access under via-IR.
     */
    function _group(
        bytes32[] memory ids,
        uint256[] memory metas,
        uint256 count,
        bool dedup
    ) private pure returns (address[] memory policies, bytes32[][] memory runIds, uint8[][] memory runLevels) {
        uint256 multiplier = _HASH_MULTIPLIER;
        assembly ("memory-safe") {
            // Returns the word of `key` in the table at `table` (`mask + 1` words), else stores
            // `word` in its free slot and returns 0.
            function probe(table, mask, multiplier_, key, keyMask, word) -> found {
                let slot := and(shr(32, mul(key, multiplier_)), mask)
                for {} 1 {} {
                    let at := add(table, shl(5, slot))
                    found := mload(at)
                    if iszero(found) {
                        mstore(at, word)
                        break
                    }
                    if eq(and(found, keyMask), key) {
                        break
                    }
                    slot := and(add(slot, 1), mask)
                }
            }

            let size := 8
            for {} lt(size, shl(1, count)) {} {
                size := shl(1, size)
            }
            let mask := sub(size, 1)
            // Scratch: the policy table, the id table (used with `dedup`), then runOf[count]
            // (run + 1, 0 = dropped) and sizes[count]; then the results.
            let byPolicy := mload(0x40)
            let seen := add(byPolicy, shl(5, size))
            let runOf := add(seen, shl(5, size))
            let sizes := add(runOf, shl(5, count))
            policies := add(sizes, shl(5, count))
            calldatacopy(byPolicy, calldatasize(), sub(add(policies, 0x20), byPolicy))
            let addressMask := 0xffffffffffffffffffffffffffffffffffffffff
            let runs := 0
            for {
                let e := 0
            } lt(e, count) {
                e := add(e, 1)
            } {
                let id := mload(add(ids, shl(5, add(e, 1))))
                if dedup {
                    if probe(seen, mask, multiplier, id, not(0), id) {
                        continue
                    }
                }
                let policy := and(mload(add(metas, shl(5, add(e, 1)))), addressMask)
                let r := runs
                let found := probe(byPolicy, mask, multiplier, policy, addressMask, or(policy, shl(160, add(runs, 1))))
                switch found
                case 0 {
                    runs := add(runs, 1)
                    mstore(add(policies, shl(5, runs)), policy)
                }
                default {
                    r := sub(shr(160, found), 1)
                }
                mstore(add(runOf, shl(5, e)), add(r, 1))
                let sizeAt := add(sizes, shl(5, r))
                mstore(sizeAt, add(mload(sizeAt), 1))
            }
            mstore(policies, runs)

            // runIds[runs], runLevels[runs], then each run's two arrays.
            runIds := add(policies, shl(5, add(runs, 1)))
            runLevels := add(runIds, shl(5, add(runs, 1)))
            mstore(runIds, runs)
            mstore(runLevels, runs)
            let cursor := add(runLevels, shl(5, add(runs, 1)))
            for {
                let r := 0
            } lt(r, runs) {
                r := add(r, 1)
            } {
                let sizeAt := add(sizes, shl(5, r))
                let n := mload(sizeAt)
                mstore(sizeAt, 0)
                mstore(add(runIds, shl(5, add(r, 1))), cursor)
                mstore(cursor, n)
                cursor := add(cursor, shl(5, add(n, 1)))
                mstore(add(runLevels, shl(5, add(r, 1))), cursor)
                mstore(cursor, n)
                cursor := add(cursor, shl(5, add(n, 1)))
            }
            for {
                let e := 0
            } lt(e, count) {
                e := add(e, 1)
            } {
                let r1 := mload(add(runOf, shl(5, e)))
                if r1 {
                    let sizeAt := add(sizes, shl(5, sub(r1, 1)))
                    let at := add(mload(sizeAt), 1)
                    mstore(sizeAt, at)
                    let meta := mload(add(metas, shl(5, add(e, 1))))
                    mstore(add(mload(add(runIds, shl(5, r1))), shl(5, at)), mload(add(ids, shl(5, add(e, 1)))))
                    mstore(add(mload(add(runLevels, shl(5, r1))), shl(5, at)), and(shr(160, meta), 0xff))
                }
            }
            mstore(0x40, cursor)
        }
    }

    function _policyData(PolicyContext[] memory contexts, address policy) private pure returns (bytes memory) {
        for (uint256 i = 0; i < contexts.length; i++) {
            if (contexts[i].policy == policy) {
                return contexts[i].data;
            }
        }
        bytes memory empty;
        return empty;
    }

    /**
     * @dev The ABI-encoded calldata of `checkCall(ctx, one, ids)` (`selector` = its selector) or of
     *      `checkTransaction(ctx, calls, signatures, policyData, ids)`. Hand-written: the generic
     *      via-IR encoder costs ~2.5k gas per policy run.
     */
    function _encodeCheck(
        bytes4 selector,
        Context memory ctx,
        Call memory one,
        Call[] memory calls,
        bytes calldata signatures,
        bytes memory policyData,
        bytes32[] memory ids
    ) private pure returns (bytes memory data) {
        bool isTx = selector == IPolicyV2.checkTransaction.selector;
        assembly ("memory-safe") {
            // `len` bytes at `src` as `[len][bytes, zero-padded]` at `dst`; returns the end.
            function writeBytes(dst, src, len) -> end {
                mstore(dst, len)
                let padded := and(add(len, 31), not(31))
                if padded {
                    mstore(add(dst, padded), 0)
                }
                mcopy(add(dst, 0x20), src, len)
                end := add(add(dst, 0x20), padded)
            }
            // The tuple `(to, value, data, operation)` of the memory Call `c` at `dst`; returns the end.
            function writeCall(dst, c) -> end {
                let bytesPtr := mload(add(c, 0x40))
                mstore(dst, mload(c))
                mstore(add(dst, 0x20), mload(add(c, 0x20)))
                mstore(add(dst, 0x40), 0x80)
                mstore(add(dst, 0x60), mload(add(c, 0x60)))
                end := writeBytes(add(dst, 0x80), add(bytesPtr, 0x20), mload(bytesPtr))
            }

            data := mload(0x40)
            let start := add(data, 0x20)
            mstore(start, selector)
            // Head: the 5 static Context words, then one offset per dynamic argument.
            let head := add(start, 4)
            mcopy(head, ctx, 0xa0)
            let cur
            switch isTx
            case 0 {
                mstore(add(head, 0xa0), 0xe0)
                cur := writeCall(add(head, 0xe0), one)
                mstore(add(head, 0xc0), sub(cur, head))
            }
            default {
                mstore(add(head, 0xa0), 0x120)
                let n := mload(calls)
                mstore(add(head, 0x120), n)
                let offsets := add(head, 0x140)
                cur := add(offsets, shl(5, n))
                for {
                    let i := 0
                } lt(i, n) {
                    i := add(i, 1)
                } {
                    mstore(add(offsets, shl(5, i)), sub(cur, offsets))
                    cur := writeCall(cur, mload(add(calls, shl(5, add(i, 1)))))
                }
                mstore(add(head, 0xc0), sub(cur, head))
                let length := signatures.length
                mstore(cur, length)
                let padded := and(add(length, 31), not(31))
                if padded {
                    mstore(add(cur, padded), 0)
                }
                calldatacopy(add(cur, 0x20), signatures.offset, length)
                cur := add(add(cur, 0x20), padded)
                mstore(add(head, 0xe0), sub(cur, head))
                cur := writeBytes(cur, add(policyData, 0x20), mload(policyData))
                mstore(add(head, 0x100), sub(cur, head))
            }
            let idsSize := shl(5, add(mload(ids), 1))
            mcopy(cur, ids, idsSize)
            cur := add(cur, idsSize)
            mstore(data, sub(cur, start))
            mstore(0x40, and(add(cur, 31), not(31)))
        }
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
