// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {MultiSendDecoder} from "../libraries/MultiSendDecoder.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentKind, Call, Context, GateKind, GateResult, PolicyLevel, Verdict} from "../libraries/Types.sol";
import {EngineStorage} from "./EngineStorage.sol";

/**
 * @title Engine evaluation (SPEC.md §6.2–6.5)
 * @notice The algorithm shared by the hooks of {SafePolicyGuardV2} and the `preview` of
 *         {PolicyEngineV2Preview}: engine rules, scope lookup, built-in DENY / ALLOW, and the
 *         order of the policy runs, which {PolicyEngineV2Runner} performs. Which of the two a
 *         contract is, is a compile-time constant ({_isPreview}), so the guard carries no gate
 *         reporting and the preview no early revert.
 */
abstract contract EngineEvaluator is EngineStorage {
    /// @dev Everything one evaluation carries. `ctx.txHash`/`ctx.nonce` are computed lazily on the
    ///      owner path (by the runner, on the first policy run) unless `ctxReady`. `txIds` /
    ///      `txMetas` queue the transaction-level policy matches of all calls (not deduplicated yet),
    ///      `txMetas[e] = policy | level << 160`; `callIds` / `callMetas` hold the current call's
    ///      call-level matches the same way. Calls with call-level matches wait for the runner in
    ///      a list (`head` to `tail`, `waiting` long) of records `[next, callIndex, count, ids,
    ///      metas]`. `gates` is only used by the preview.
    struct Frame {
        Context ctx;
        bool ctxReady;
        bool isBatch;
        Call[] calls;
        bytes32[] txIds;
        uint256[] txMetas;
        uint256 txCount;
        bytes32[] callIds;
        uint256[] callMetas;
        uint256 callCount;
        uint256 head;
        uint256 tail;
        uint256 waiting;
        bool done;
        bool unvalidatedContext;
        GateResult[] gates;
        uint256 gateCount;
    }

    /// @dev True in the preview module (record every gate, never stop), false in the guard (revert
    ///      at the first deny). A constant per contract, so the optimizer drops the other branch.
    function _isPreview() internal pure virtual returns (bool);

    // =============================================================================================
    // Evaluation (SPEC.md §6.2–6.5)
    // =============================================================================================

    /**
     * @dev Runs every gate of a transaction. Real check: reverts at the first deny, in evaluation
     *      order (per call: engine rules, built-in gates, call-level policies; then the
     *      transaction-level policies). The policy runs are queued and sent to the runner in one
     *      DELEGATECALL at the end, or, before a built-in deny of call `i`, those of the calls
     *      before `i` (so the same deny wins). Preview: records every gate in `f.gates`, never
     *      stops, and sends each call's runs as soon as its built-in gates are recorded.
     */
    function _evaluate(
        Frame memory f,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) internal {
        (bool selOk, bytes4 sel) = _calldataSelector(data);

        // The configuration path: no ALLOW needed; only the owners' policies at its exact scopes
        // run (§5.1, §14 D-19, in {_checkCall}).
        if (to == address(this) && selOk && _isConfigSelector(sel)) {
            if (f.ctx.actor != Scope.OWNERS) {
                _ruleDeny(f, Scope.TX_INDEX, IPolicyEngineV2.ModuleConfigurationDenied.selector, false, 0);
                return;
            }
            if (operation != Operation.CALL || value != 0) {
                _ruleDeny(f, Scope.TX_INDEX, IPolicyEngineV2.GuardTargetDenied.selector, false, 0);
                return;
            }
            uint64 frozenUntil = _freezes[f.ctx.safe][Scope.ANY].frozenUntil;
            if (sel == IPolicyEngineV2.applyConfiguration.selector && block.timestamp < frozenUntil) {
                _ruleDeny(f, Scope.TX_INDEX, IPolicyEngineV2.ConfigFrozen.selector, true, frozenUntil);
                return;
            }
        }

        bool isBatch = operation == Operation.DELEGATECALL &&
            selOk &&
            sel == MultiSendDecoder.MULTI_SEND_SELECTOR &&
            _isTrustedBatch(to);
        Call[] memory calls;
        if (isBatch) {
            if (value != 0) {
                _ruleDeny(f, Scope.TX_INDEX, IPolicyEngineV2.MalformedBatch.selector, false, 0);
                return;
            }
            bool ok;
            bool tooMany;
            (ok, tooMany, calls) = MultiSendDecoder.decode(f.ctx.safe, data);
            if (!ok) {
                _ruleDeny(
                    f,
                    Scope.TX_INDEX,
                    tooMany ? IPolicyEngineV2.BatchTooLarge.selector : IPolicyEngineV2.MalformedBatch.selector,
                    false,
                    0
                );
                return;
            }
        } else {
            calls = new Call[](1);
            calls[0] = Call(to, value, data, operation);
        }

        (f.isBatch, f.calls) = (isBatch, calls);
        for (uint256 i = 0; i < calls.length; i++) {
            bytes memory notGranted = _checkCall(f, i, calls[i], isBatch);
            if (f.callCount != 0) {
                _queueRun(f, i);
            }
            if (_isPreview()) {
                _dispatch(f);
                if (notGranted.length != 0) {
                    _deny(f, i, Scope.NO_LEVEL, GateKind.RULE, bytes32(0), notGranted);
                }
            }
        }
        f.done = true;
        _dispatch(f);
    }

    /// @dev Appends call `callIndex`'s call-level matches to the waiting runs.
    function _queueRun(Frame memory f, uint256 callIndex) private pure {
        (bytes32[] memory ids, uint256[] memory metas, uint256 count, uint256 tail) = (
            f.callIds,
            f.callMetas,
            f.callCount,
            f.tail
        );
        uint256 record;
        assembly ("memory-safe") {
            record := mload(0x40)
            mstore(record, 0)
            mstore(add(record, 0x20), callIndex)
            mstore(add(record, 0x40), count)
            mstore(add(record, 0x60), ids)
            mstore(add(record, 0x80), metas)
            mstore(0x40, add(record, 0xa0))
            if tail {
                mstore(tail, record)
            }
        }
        if (tail == 0) {
            f.head = record;
        }
        f.tail = record;
        f.waiting++;
    }

    /**
     * @dev Sends the waiting call-level runs and, once `f.done` (every call checked), the
     *      transaction-level run to {PolicyEngineV2Runner}, if there is any: one DELEGATECALL (on
     *      this storage, with the guard as the policies' `msg.sender`) with this contract's
     *      calldata (the hook or `preview`) followed by the suffix the runner documents. The
     *      owner-path `txHash` comes back with it. Real check: a deny reverts with the runner's
     *      `PolicyDenied`. Preview: each runner record becomes a POLICY gate.
     */
    function _dispatch(Frame memory f) private {
        bool withTx = f.done;
        uint256 segments = f.waiting + (withTx && f.txCount != 0 ? 1 : 0);
        // An owner-path policy context is checked by the first call, even one with no run.
        if (segments == 0 && !f.unvalidatedContext) {
            return;
        }
        (f.waiting, f.unvalidatedContext) = (0, false);
        // Before the payload is built past the free pointer: nothing below may allocate.
        address runner = _runner(f);
        uint256 flags = (f.ctxReady ? 1 : 0) | (_isPreview() ? 2 : 0) | (f.isBatch ? 4 : 0);
        uint256 suffix;
        uint256 p;
        Call[] memory calls;
        if (f.isBatch) {
            calls = f.calls;
        }
        assembly ("memory-safe") {
            let m := mload(0x40)
            calldatacopy(m, 0, calldatasize())
            suffix := add(m, calldatasize())
            p := add(suffix, 0xa0)
            // A batch's decoded calls `[n, (to, value, operation, data.length, data)…]`, so the
            // runner does not decode it again.
            let n := mload(calls)
            if n {
                mstore(p, n)
                p := add(p, 0x20)
                for {
                    let i := 0
                } lt(i, n) {
                    i := add(i, 1)
                } {
                    let c := mload(add(calls, shl(5, add(i, 1))))
                    let callData := mload(add(c, 0x40))
                    let length := mload(callData)
                    mstore(p, mload(c))
                    mstore(add(p, 0x20), mload(add(c, 0x20)))
                    mstore(add(p, 0x40), mload(add(c, 0x60)))
                    mstore(add(p, 0x60), length)
                    mcopy(add(p, 0x80), add(callData, 0x20), length)
                    p := add(add(p, 0x80), and(add(length, 31), not(31)))
                }
            }
            mstore(add(suffix, 0x80), sub(p, add(suffix, 0xa0)))
        }
        for (uint256 record = f.head; record != 0; ) {
            assembly ("memory-safe") {
                // Inline `_writeSegment` of the record's [callIndex, count, ids, metas].
                let count := mload(add(record, 0x40))
                let size := shl(5, count)
                mstore(p, mload(add(record, 0x20)))
                mstore(add(p, 0x20), count)
                mcopy(add(p, 0x40), add(mload(add(record, 0x60)), 0x20), size)
                mcopy(add(add(p, 0x40), size), add(mload(add(record, 0x80)), 0x20), size)
                p := add(add(p, 0x40), shl(1, size))
                record := mload(record)
            }
        }
        (f.head, f.tail) = (0, 0);
        if (withTx && f.txCount != 0) {
            p = _writeSegment(p, Scope.TX_INDEX, f.txIds, f.txMetas, f.txCount);
        }
        (bytes32 txHash, uint256 nonce) = (f.ctx.txHash, f.ctx.nonce);
        assembly ("memory-safe") {
            mstore(suffix, txHash)
            mstore(add(suffix, 0x20), nonce)
            mstore(add(suffix, 0x40), flags)
            mstore(add(suffix, 0x60), segments)
            mstore(p, sub(p, suffix))
            let m := sub(suffix, calldatasize())
            if iszero(delegatecall(gas(), runner, m, sub(add(p, 0x20), m), 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            returndatacopy(0, 0, 0x40)
            txHash := mload(0)
            nonce := mload(0x20)
        }
        if (segments != 0) {
            (f.ctx.txHash, f.ctx.nonce, f.ctxReady) = (txHash, nonce, true);
        }
        if (_isPreview()) {
            _pushPolicyGates(f);
        }
    }

    /// @dev Writes one run `[callIndex, count, ids[count], metas[count]]` at `p`; returns the end.
    ///      Scratch memory past the free pointer: it only lives until the DELEGATECALL.
    function _writeSegment(
        uint256 p,
        uint256 callIndex,
        bytes32[] memory ids,
        uint256[] memory metas,
        uint256 count
    ) private pure returns (uint256 end) {
        assembly ("memory-safe") {
            mstore(p, callIndex)
            mstore(add(p, 0x20), count)
            let size := shl(5, count)
            mcopy(add(p, 0x40), add(ids, 0x20), size)
            mcopy(add(add(p, 0x40), size), add(metas, 0x20), size)
            end := add(add(p, 0x40), shl(1, size))
        }
    }

    /// @dev Preview: one POLICY gate per runner record `abi.encode(callIndex, level, id, policy,
    ///      verdict, reason)`, after the 64-byte `txHash` and `nonce`.
    function _pushPolicyGates(Frame memory f) private pure {
        uint256 end;
        assembly ("memory-safe") {
            end := returndatasize()
        }
        for (uint256 at = 0x40; at < end; ) {
            uint256 callIndex;
            uint256 level;
            bytes32 id;
            address policy;
            uint256 verdict;
            bytes memory reason;
            assembly ("memory-safe") {
                let m := mload(0x40)
                returndatacopy(m, at, 0xe0)
                callIndex := mload(m)
                level := mload(add(m, 0x20))
                id := mload(add(m, 0x40))
                policy := mload(add(m, 0x60))
                verdict := mload(add(m, 0x80))
                let length := mload(add(m, 0xc0))
                reason := m
                mstore(reason, length)
                returndatacopy(add(reason, 0x20), add(at, 0xe0), length)
                let padded := and(add(length, 31), not(31))
                mstore(0x40, add(add(reason, 0x20), padded))
                at := add(add(at, 0xe0), padded)
            }
            _pushGate(
                f,
                GateResult(uint16(callIndex), uint8(level), GateKind.POLICY, id, policy, Verdict(verdict), reason)
            );
        }
    }

    /// @dev {PolicyEngineV2Runner}, which runs the policies.
    function _runner(Frame memory f) internal view virtual returns (address);

    /**
     * @dev SPEC.md §6.3 for call `i`: the engine rules and the built-in DENY / ALLOW gates. Real
     *      check: reverts at the first deny (`NotGranted` before any policy runs). Leaves the
     *      call-level policy matches in `f.callIds` / `f.callMetas` / `f.callCount` and returns,
     *      in preview, the `NotGranted` reason when no ALLOW counted (its gate follows the call's
     *      policy gates).
     */
    function _checkCall(
        Frame memory f,
        uint256 i,
        Call memory call,
        bool inBatch
    ) private returns (bytes memory notGranted) {
        f.callCount = 0;
        (bool selOk, bytes4 sel) = _selectorOf(call.data);
        if (!selOk) {
            _ruleDeny(f, i, IPolicyEngineV2.InvalidSelector.selector, true, i);
            return notGranted;
        }
        address actor = f.ctx.actor;
        // The top-level configuration path, whose engine rules {_evaluate} already passed.
        bool configPath;
        if (call.to == address(this)) {
            if (_isConfigSelector(sel)) {
                configPath = !inBatch;
                if (inBatch) {
                    _ruleDeny(
                        f,
                        i,
                        actor == Scope.OWNERS
                            ? IPolicyEngineV2.GuardTargetDenied.selector
                            : IPolicyEngineV2.ModuleConfigurationDenied.selector,
                        false,
                        0
                    );
                }
            } else if (
                sel != IPolicyEngineV2.freeze.selector &&
                sel != IPolicyEngineV2.freezeActor.selector &&
                sel != IPolicyEngineV2.lift.selector
            ) {
                _ruleDeny(f, i, IPolicyEngineV2.GuardTargetDenied.selector, false, 0);
            }
        }
        if (inBatch && call.operation == Operation.DELEGATECALL && _isTrustedBatch(call.to)) {
            _ruleDeny(f, i, IPolicyEngineV2.NestedBatch.selector, true, i);
        }

        Operation effOp = _effectiveOperation(call.to, call.operation, sel);
        // F5: on the module path, calls to the Safe itself or to the engine need an exact ALLOW.
        bool exactOnly = actor != Scope.OWNERS && (call.to == f.ctx.safe || call.to == address(this));

        (uint256[] memory matches, bytes32[8] memory keys) = _match(
            f.ctx.safe,
            actor,
            call.to,
            sel,
            _matchMode(call.operation, effOp, configPath)
        );
        // The configuration path needs no ALLOW: a Safe can never lock itself out (§5.1).
        bool granted = configPath;
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
                _deny(f, i, lvl, GateKind.DENY, id, abi.encodeWithSelector(IPolicyEngineV2.Denied.selector, i, id));
            } else if (kind == uint8(AttachmentKind.ALLOW)) {
                bool counts = lvl == Scope.EXACT_LEVEL || (effOp == Operation.CALL && !exactOnly);
                granted = granted || counts;
                if (_isPreview()) {
                    _pushGate(
                        f,
                        GateResult(
                            uint16(i),
                            lvl,
                            GateKind.ALLOW,
                            _attachmentId(keys[lvl], kind, policy),
                            address(0),
                            counts ? Verdict.ALLOW : Verdict.PASS,
                            counts ? new bytes(0) : abi.encodeWithSelector(IPolicyEngineV2.AllowNotExact.selector)
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
        (f.callIds, f.callMetas, f.callCount) = (ids, metas, count);

        if (!granted) {
            notGranted = abi.encodeWithSelector(IPolicyEngineV2.NotGranted.selector, i, call.to, sel, call.operation);
            if (!_isPreview()) {
                _fail(f, notGranted);
            }
        }
    }

    // =============================================================================================
    // Helpers
    // =============================================================================================

    /// @dev Real check: reverts with `reason`. Preview: records the gate.
    function _deny(
        Frame memory f,
        uint256 callIndex,
        uint8 level,
        GateKind kind,
        bytes32 id,
        bytes memory reason
    ) private {
        if (!_isPreview()) {
            _fail(f, reason);
        }
        _pushGate(f, GateResult(uint16(callIndex), level, kind, id, address(0), Verdict.DENY, reason));
    }

    /// @dev Real check, a built-in deny: the call-level runs of the earlier calls come first (one
    ///      of them may deny instead), then `reason`.
    function _fail(Frame memory f, bytes memory reason) private {
        _dispatch(f);
        _revertWith(reason);
    }

    /// @dev `Scope.moduleCallHash` hashed straight from calldata (no copy of `data` to memory first).
    function _moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) internal pure returns (bytes32 hash) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, safe)
            mstore(add(m, 0x20), actor)
            mstore(add(m, 0x40), to)
            mstore(add(m, 0x60), value)
            mstore(add(m, 0x80), 0xc0)
            mstore(add(m, 0xa0), operation)
            mstore(add(m, 0xc0), data.length)
            let padded := and(add(data.length, 31), not(31))
            if padded {
                mstore(add(m, add(0xc0, padded)), 0)
            }
            calldatacopy(add(m, 0xe0), data.offset, data.length)
            hash := keccak256(m, add(0xe0, padded))
        }
    }

    /// @dev An engine-rule deny with reason `selector`, followed by the word `arg` if `hasArg`.
    function _ruleDeny(Frame memory f, uint256 callIndex, bytes4 selector, bool hasArg, uint256 arg) private {
        bytes memory reason;
        assembly ("memory-safe") {
            reason := mload(0x40)
            mstore(reason, add(4, mul(hasArg, 0x20)))
            mstore(add(reason, 0x20), selector)
            mstore(add(reason, 0x24), arg)
            mstore(0x40, add(reason, 0x60))
        }
        _deny(f, callIndex, Scope.NO_LEVEL, GateKind.RULE, bytes32(0), reason);
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

    /// @dev `Scope.selectorOf` for a memory call: the first 4 bytes, or 0 for empty data (§6.3).
    function _selectorOf(bytes memory data) private pure returns (bool ok, bytes4 sel) {
        assembly ("memory-safe") {
            let length := mload(data)
            ok := or(iszero(length), gt(length, 3))
            if gt(length, 3) {
                sel := and(mload(add(data, 0x20)), shl(224, 0xffffffff))
            }
        }
    }

    function _revertWith(bytes memory reason) private pure {
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
