// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {ISafeModuleGuard} from "../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {SignatureExtension} from "../../vendor/policy-engine/libraries/SignatureExtension.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {Call, Context, PolicyContext, Verdict} from "../libraries/Types.sol";
import {encodeCheck} from "./CheckEncoding.sol";
import {EngineModuleBase} from "./EngineModuleBase.sol";

/**
 * @title Policy Engine V2: policy runner
 * @notice Runs the policies a call (call level) or a transaction (transaction level) matched,
 *         for the hooks of {SafePolicyGuardV2} and for {PolicyEngineV2Preview}: groups the
 *         matches by policy, computes the owner-path `txHash` on first use, decodes the owner-path
 *         policy context (SPEC.md §6.6), encodes and makes each policy call (SPEC.md §6.3–6.5).
 *         Reached only by DELEGATECALL from inside a check, so policies see the guard as
 *         `msg.sender` and the check's lock is held.
 * @dev The caller forwards its own calldata (`checkTransaction`, `checkModuleTransaction` or
 *      `preview`, answered here with the same signatures, so the call and the owner-path fields
 *      are read from it) followed by a suffix of words: `[txHash, nonce, flags, runs,
 *      callsLength]`; for a batch (`FLAG_BATCH`) its decoded calls `[n, (to, value, operation,
 *      data.length, data (padded))…]` (`callsLength` bytes); then per run `[callIndex, count,
 *      ids[count], metas[count]]` (`metas[e] = policy | level << 160`; `callIndex` is `TX_INDEX`
 *      for the transaction level); last the suffix length in bytes. Runs execute in that order.
 *      It returns, raw, `txHash`
 *      and `nonce` (computed here unless `FLAG_CONTEXT_READY`), then, with `FLAG_PREVIEW`, one
 *      record `abi.encode(callIndex, level, id, policy, verdict, reason)` per matched attachment;
 *      without it, the first deny reverts `PolicyDenied`.
 */
contract PolicyEngineV2Runner is EngineModuleBase {
    /// @dev Gas kept back from each policy run in `preview`, so an out-of-gas policy is reported
    ///      instead of aborting the preview (SPEC.md §6.7).
    uint256 private constant _PREVIEW_GAS_RESERVE = 300_000;

    /// @dev Odd multiplier (64-bit golden ratio) spreading keys over the in-memory hash tables.
    uint256 private constant _HASH_MULTIPLIER = 0x9e3779b97f4a7c15;

    /// @dev Suffix flag: `txHash` and `nonce` are set.
    uint256 internal constant FLAG_CONTEXT_READY = 1;
    /// @dev Suffix flag: report every run instead of reverting at the first deny.
    uint256 internal constant FLAG_PREVIEW = 2;
    /// @dev Suffix flag: the top-level call is a trusted batch, its decoded calls are in the suffix.
    uint256 internal constant FLAG_BATCH = 4;

    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineModuleBase(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {}

    // =============================================================================================
    // Entry points: the caller's own calldata, plus the suffix
    // =============================================================================================

    /**
     * @notice The policy runs of {SafePolicyGuardV2.checkTransaction} (owner path),
     *         {SafePolicyGuardV2.checkModuleTransaction} (module path) or
     *         {PolicyEngineV2Preview.preview}: the caller's own calldata, then the suffix.
     * @dev The arguments are read at their fixed ABI positions: the caller's ABI decoder already
     *      validated this calldata (the suffix only extends it).
     */
    fallback() external {
        bytes4 sel = msg.sig;
        if (sel == ISafeTransactionGuard.checkTransaction.selector) {
            // (to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver,
            //  signatures, msgSender)
            _run(
                Context(msg.sender, Scope.OWNERS, bytes32(0), 0, _address(0x144)),
                Top(_address(0x04), _word(0x24), _operation(0x64), _word(0xa4), _address(0xe4), _address(0x104)),
                _bytes(0x44),
                _bytes(0x124)
            );
        } else if (sel == ISafeModuleGuard.checkModuleTransaction.selector) {
            // (to, value, data, operation, module)
            address module = _address(0x84);
            bytes calldata data = _bytes(0x44);
            _run(
                Context(msg.sender, module, bytes32(0), 0, module),
                Top(_address(0x04), _word(0x24), _operation(0x64), 0, address(0), address(0)),
                data,
                data[data.length:]
            );
        } else {
            // preview(safe, actor, to, value, data, operation); anything else reverts in _run's
            // checks or here.
            require(sel == IPolicyEngineV2.preview.selector, NotDelegated());
            address actor = _address(0x24);
            bytes calldata data = _bytes(0x84);
            _run(
                Context(_address(0x04), actor, bytes32(0), 0, actor == Scope.OWNERS ? address(0) : actor),
                Top(_address(0x44), _word(0x64), _operation(0xa4), 0, address(0), address(0)),
                data,
                data[data.length:]
            );
        }
    }

    function _word(uint256 at) private pure returns (uint256 word) {
        assembly ("memory-safe") {
            word := calldataload(at)
        }
    }

    function _address(uint256 at) private pure returns (address) {
        return address(uint160(_word(at)));
    }

    function _operation(uint256 at) private pure returns (Operation) {
        return Operation(uint8(_word(at)));
    }

    /// @dev The `bytes` argument whose offset word is at `at`.
    function _bytes(uint256 at) private pure returns (bytes calldata data) {
        assembly ("memory-safe") {
            let start := add(4, calldataload(at))
            data.offset := add(start, 0x20)
            data.length := calldataload(start)
        }
    }

    // =============================================================================================
    // Runs
    // =============================================================================================

    /// @dev The top-level call, as the Safe hashes it.
    struct Top {
        address to;
        uint256 value;
        Operation operation;
        uint256 baseGas;
        address gasToken;
        address refundReceiver;
    }

    /// @dev What every run of one DELEGATECALL shares. Kept in memory so that few values stay on
    ///      the stack across the runs (else via-IR spills the hot loops' variables to memory).
    struct Shared {
        Context ctx;
        Call[] calls;
        uint256 signaturesOffset;
        uint256 signaturesLength;
        PolicyContext[] contexts;
        bool preview;
    }

    function _run(Context memory ctx, Top memory top, bytes calldata data, bytes calldata signatures) private {
        // Only from inside a check of the guard (its lock is held), never directly.
        _requireDelegated();
        require(_inCheck(), NotDelegated());
        uint256 flags;
        uint256 runs;
        uint256 at;
        assembly ("memory-safe") {
            let suffix := sub(sub(calldatasize(), 0x20), calldataload(sub(calldatasize(), 0x20)))
            mstore(add(ctx, 0x40), calldataload(suffix))
            mstore(add(ctx, 0x60), calldataload(add(suffix, 0x20)))
            flags := calldataload(add(suffix, 0x40))
            runs := calldataload(add(suffix, 0x60))
            at := add(suffix, 0xa0)
        }
        Call[] memory calls;
        if (flags & FLAG_BATCH != 0) {
            calls = _suffixCalls(at);
        } else {
            // `[Call(...)]` without `new Call[](1)`, which would first allocate a zero Call.
            Call memory only = Call(top.to, top.value, data, top.operation);
            assembly ("memory-safe") {
                calls := mload(0x40)
                mstore(calls, 1)
                mstore(add(calls, 0x20), only)
                mstore(0x40, add(calls, 0x40))
            }
        }
        // The owner-path policy context (SPEC.md §6.6), before any policy runs: a malformed one is
        // the first deny (the guard makes this call before any of its own denies).
        Shared memory shared = Shared(
            ctx,
            calls,
            _offsetOf(signatures),
            signatures.length,
            _decodeContexts(signatures),
            flags & FLAG_PREVIEW != 0
        );
        assembly ("memory-safe") {
            // Past the batch's calls (`callsLength` bytes, 0 when not a batch): the runs.
            at := add(at, calldataload(sub(at, 0x20)))
        }
        if (runs != 0 && flags & FLAG_CONTEXT_READY == 0) {
            ISafe safe = ISafe(ctx.safe);
            // The Safe increments its nonce before calling the guard; preview hashes the next one.
            uint256 safeNonce = shared.preview ? safe.nonce() : safe.nonce() - 1;
            ctx.nonce = safeNonce;
            ctx.txHash = safe.getTransactionHash(
                top.to,
                top.value,
                data,
                top.operation,
                0,
                top.baseGas,
                0,
                top.gasToken,
                top.refundReceiver,
                safeNonce
            );
        }
        bytes memory out;
        for (uint256 r = 0; r < runs; r++) {
            uint256 callIndex;
            uint256 count;
            assembly ("memory-safe") {
                callIndex := calldataload(at)
                count := calldataload(add(at, 0x20))
            }
            bytes memory records = _runPolicies(shared, callIndex, at + 0x40, count);
            if (shared.preview) {
                out = bytes.concat(out, records);
            }
            at += 0x40 + 0x40 * count;
        }
        (bytes32 txHash, uint256 nonce) = (ctx.txHash, ctx.nonce);
        assembly ("memory-safe") {
            // `txHash`, `nonce`, then the preview records: written over the two words in front
            // of `out`'s data (they are not read again: this returns).
            let length := mload(out)
            if iszero(length) {
                mstore(0, txHash)
                mstore(0x20, nonce)
                return(0, 0x40)
            }
            let start := sub(out, 0x20)
            mstore(start, txHash)
            mstore(out, nonce)
            return(start, add(0x40, length))
        }
    }

    /// @dev The batch's calls the guard decoded, from the suffix at `at`:
    ///      `[n, (to, value, operation, data.length, data (padded))…]`.
    function _suffixCalls(uint256 at) private pure returns (Call[] memory calls) {
        assembly ("memory-safe") {
            let n := calldataload(at)
            at := add(at, 0x20)
            calls := mload(0x40)
            mstore(calls, n)
            let c := add(calls, shl(5, add(n, 1)))
            for {
                let i := 0
            } lt(i, n) {
                i := add(i, 1)
            } {
                // Call: to, value, data (pointer), operation; then the data bytes.
                let length := calldataload(add(at, 0x60))
                let padded := and(add(length, 31), not(31))
                mstore(add(calls, shl(5, add(i, 1))), c)
                mstore(c, calldataload(at))
                mstore(add(c, 0x20), calldataload(add(at, 0x20)))
                mstore(add(c, 0x40), add(c, 0x80))
                mstore(add(c, 0x60), calldataload(add(at, 0x40)))
                if padded {
                    mstore(add(add(c, 0x80), padded), 0)
                }
                mstore(add(c, 0x80), length)
                calldatacopy(add(c, 0xa0), add(at, 0x80), length)
                c := add(add(c, 0xa0), padded)
                at := add(add(at, 0x80), padded)
            }
            mstore(0x40, c)
        }
    }

    function _offsetOf(bytes calldata data) private pure returns (uint256 offset) {
        assembly ("memory-safe") {
            offset := data.offset
        }
    }

    /**
     * @dev One run: each distinct policy of the `count` matches at calldata `matches` (ids, then
     *      metas) once, in first-match order, with its ids (deduplicated at the transaction
     *      level). Returns the preview records.
     */
    function _runPolicies(
        Shared memory shared,
        uint256 callIndex,
        uint256 matches,
        uint256 count
    ) private returns (bytes memory out) {
        bool isTx = callIndex == Scope.TX_INDEX;
        (address[] memory policies, bytes32[][] memory runIds, uint8[][] memory runLevels) = _group(
            matches,
            count,
            isTx
        );
        bytes calldata signatures;
        {
            (uint256 offset, uint256 length) = (shared.signaturesOffset, shared.signaturesLength);
            assembly ("memory-safe") {
                signatures.offset := offset
                signatures.length := length
            }
        }
        // The policy context goes to transaction-level policies only.
        PolicyContext[] memory contexts;
        if (isTx) {
            contexts = shared.contexts;
        }
        Call memory call = shared.calls[isTx ? 0 : callIndex];
        bytes4 magic = isTx ? IPolicyV2.checkTransaction.selector : IPolicyV2.checkCall.selector;
        for (uint256 r = 0; r < policies.length; r++) {
            address policy = policies[r];
            bytes32[] memory ids = runIds[r];
            (bool pass, bytes memory reason) = _callPolicy(
                policy,
                encodeCheck(magic, isTx, shared.ctx, call, shared.calls, signatures, _policyData(contexts, policy), ids),
                magic,
                shared.preview
            );
            if (!shared.preview) {
                if (!pass) revert IPolicyEngineV2.PolicyDenied(callIndex, policy, reason);
            } else {
                out = bytes.concat(out, _records(callIndex, policy, ids, runLevels[r], pass, reason));
            }
        }
    }

    /// @dev Preview: one record per attachment of a run, all with the run's verdict.
    function _records(
        uint256 callIndex,
        address policy,
        bytes32[] memory ids,
        uint8[] memory levels,
        bool pass,
        bytes memory reason
    ) private pure returns (bytes memory out) {
        Verdict verdict = pass ? Verdict.PASS : Verdict.DENY;
        for (uint256 j = 0; j < ids.length; j++) {
            out = bytes.concat(out, abi.encode(callIndex, levels[j], ids[j], policy, verdict, reason));
        }
    }

    /// @dev Calls a policy with all remaining gas (less a reserve in preview). PASS iff it
    ///      succeeds and returns exactly the 32-byte word `magic`; the reason is its bounded revert data.
    function _callPolicy(
        address policy,
        bytes memory data,
        bytes4 magic,
        bool preview
    ) private returns (bool pass, bytes memory reason) {
        uint256 gasLimit = gasleft();
        if (preview) {
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

    /**
     * @dev Groups `count` policy matches (at calldata `matches`: `count` ids, then `count` metas
     *      `policy | level << 160`) into runs, one per distinct policy in first-match order, each
     *      with its ids and levels in match order; with `dedup`, a repeated id is dropped. Linear
     *      in `count` (SPEC.md §9): policies and ids are looked up in open-addressing hash tables
     *      (power-of-two size, at most half full) in memory. Assembly: the same in Solidity costs
     *      ~100 gas per array access under via-IR.
     */
    function _group(
        uint256 matches,
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

            let ids := matches
            let metas := add(ids, shl(5, count))
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
                let id := calldataload(add(ids, shl(5, e)))
                if dedup {
                    if probe(seen, mask, multiplier, id, not(0), id) {
                        continue
                    }
                }
                let policy := and(calldataload(add(metas, shl(5, e))), addressMask)
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
                    let meta := calldataload(add(metas, shl(5, e)))
                    mstore(add(mload(add(runIds, shl(5, r1))), shl(5, at)), calldataload(add(ids, shl(5, e))))
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
     * @dev The owner-path policy context (SPEC.md §6.6): absent → empty; present → a strictly
     *      decoded `abi.encode(PolicyContext[])` with distinct policies, else `MalformedContext`.
     *      Decoded by hand so every malformation maps to `MalformedContext` instead of a bare revert.
     */
    function _decodeContexts(bytes calldata signatures) private pure returns (PolicyContext[] memory contexts) {
        if (!SignatureExtension.has(signatures, Scope.CONTEXT_TYPE_HASH)) {
            return contexts;
        }
        uint256 length = signatures.length;
        require(length >= 64, IPolicyEngineV2.MalformedContext());
        uint256 end = length - 64;
        uint256 payloadLength = _word(signatures, end);
        require(payloadLength <= end, IPolicyEngineV2.MalformedContext());
        bytes calldata payload = signatures[end - payloadLength:end];
        require(payload.length >= 64 && _word(payload, 0) == 0x20, IPolicyEngineV2.MalformedContext());
        uint256 count = _word(payload, 32);
        bytes calldata body = payload[64:];
        require(count <= body.length / 32, IPolicyEngineV2.MalformedContext());
        contexts = new PolicyContext[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 offset = _word(body, 32 * i);
            require(offset <= body.length && body.length - offset >= 64, IPolicyEngineV2.MalformedContext());
            uint256 policyWord = _word(body, offset);
            require(policyWord >> 160 == 0, IPolicyEngineV2.MalformedContext());
            uint256 dataOffset = _word(body, offset + 32);
            require(dataOffset <= body.length - offset && body.length - offset - dataOffset >= 32, IPolicyEngineV2.MalformedContext());
            uint256 position = offset + dataOffset;
            uint256 dataLength = _word(body, position);
            require(dataLength <= body.length - position - 32, IPolicyEngineV2.MalformedContext());
            address policy = address(uint160(policyWord));
            for (uint256 j = 0; j < i; j++) {
                require(contexts[j].policy != policy, IPolicyEngineV2.MalformedContext());
            }
            contexts[i] = PolicyContext(policy, body[position + 32:position + 32 + dataLength]);
        }
    }

    function _word(bytes calldata data, uint256 at) private pure returns (uint256) {
        return uint256(bytes32(data[at:at + 32]));
    }
}
