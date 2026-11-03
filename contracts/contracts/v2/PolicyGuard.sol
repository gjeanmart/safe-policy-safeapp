// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicy} from "./interfaces/IPolicy.sol";
import {IPolicyGuard} from "./interfaces/IPolicyGuard.sol";
import {ScopeLib} from "./libraries/Scope.sol";
import {Call, Context, Match, MatchView} from "./libraries/Types.sol";
import {EngineEvaluator} from "./engine/EngineEvaluator.sol";

/**
 * @title Policy Guard (rev 3 engine)
 * @notice The engine and Safe 1.5.0 guard: transaction guard (owner path) and module guard
 *         (module path), one address for Safes, policies and the app, answering the whole
 *         {IPolicyGuard}. Every call of a transaction is looked up at the 6 scopes of its actor;
 *         built-in DENY and ALLOW decide grants, then each matched policy is called once and can
 *         only pass or deny. Normative behaviour: SPEC.md §3.
 * @dev Research prototype, unaudited. This contract holds the hooks, the trusted batches, the
 *      policy dispatch and `matches` (which shares the hooks' evaluator); {fallback} DELEGATECALLs
 *      everything else (`configure`, ERC-165, the enumeration and pure views) to
 *      {PolicyGuardConfig}, which runs on this storage at this address. The engine holds no
 *      policy semantics.
 */
contract PolicyGuard is EngineEvaluator {
    /// @dev {PolicyGuardConfig}: configuration, ERC-165 and the enumeration views.
    address private immutable _CONFIG;

    // Up to `ScopeLib.MAX_TRUSTED_BATCHES` trusted batch contracts, as immutables to keep storage
    // off the hot path. Unused entries are zero.
    address private immutable _BATCH_0;
    address private immutable _BATCH_1;
    address private immutable _BATCH_2;
    address private immutable _BATCH_3;

    /**
     * @param batches MultiSendCallOnly 1.4.1+ deployments, 1 to 4, non-zero, distinct.
     * @param config The {PolicyGuardConfig} deployment.
     */
    constructor(address[] memory batches, address config) {
        uint256 count = batches.length;
        require(
            config.code.length != 0 && count != 0 && count <= ScopeLib.MAX_TRUSTED_BATCHES,
            IPolicyGuard.InvalidDeployment()
        );
        for (uint256 i = 0; i < count; i++) {
            require(batches[i] != address(0), IPolicyGuard.InvalidDeployment());
            for (uint256 j = 0; j < i; j++) {
                require(batches[i] != batches[j], IPolicyGuard.InvalidDeployment());
            }
        }
        _CONFIG = config;
        _BATCH_0 = batches[0];
        _BATCH_1 = count > 1 ? batches[1] : address(0);
        _BATCH_2 = count > 2 ? batches[2] : address(0);
        _BATCH_3 = count > 3 ? batches[3] : address(0);
    }

    /**
     * @notice Every {IPolicyGuard} function not implemented here (`configure`, `supportsInterface`,
     *         the enumeration and pure views): DELEGATECALLed to {PolicyGuardConfig}, whose result
     *         or revert is returned as is. A STATICCALL stays static there. Unknown selectors revert.
     */
    fallback() external {
        address config = _CONFIG;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), config, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    /// @notice See {IPolicyGuard-trustedBatches}.
    function trustedBatches() external view returns (address[] memory batches) {
        batches = new address[](ScopeLib.MAX_TRUSTED_BATCHES);
        (batches[0], batches[1], batches[2], batches[3]) = (_BATCH_0, _BATCH_1, _BATCH_2, _BATCH_3);
        uint256 count = 1;
        while (count < batches.length && batches[count] != address(0)) {
            count++;
        }
        assembly ("memory-safe") {
            mstore(batches, count)
        }
    }

    /// @notice See {IPolicyGuard-isTrustedBatch}.
    function isTrustedBatch(address target) external view returns (bool) {
        return _isTrustedBatch(target);
    }

    // =============================================================================================
    // Safe 1.5.0 hooks
    // =============================================================================================

    /// @notice {ISafeTransactionGuard-checkTransaction}: the owner path (SPEC.md §3.1). Who: the Safe.
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
        bytes calldata,
        address
    ) external {
        require(gasPrice == 0, IPolicyGuard.NonZeroGasPrice());
        require(safeTxGas == 0, IPolicyGuard.NonZeroSafeTxGas());
        _requireNotInCheck();
        _setLock(true);
        Frame memory f;
        (f.safe, f.actor) = (msg.sender, ScopeLib.OWNERS);
        _evaluate(f, to, value, data, operation);
        if (f.count != 0) {
            // Safe 1.5.0 increments the nonce before calling the guard.
            ISafe safe = ISafe(msg.sender);
            bytes32 txHash = safe.getTransactionHash(
                to,
                value,
                data,
                operation,
                0,
                baseGas,
                0,
                gasToken,
                refundReceiver,
                safe.nonce() - 1
            );
            _dispatch(f, txHash);
        }
        _setLock(false);
    }

    /// @notice {ISafeTransactionGuard-checkAfterExecution}: a failed execution reverts, so policy
    ///         state written by the check never survives it.
    function checkAfterExecution(bytes32, bool success) external view {
        _requireNotInCheck();
        require(success, IPolicyGuard.ExecutionFailed());
    }

    /// @notice {ISafeModuleGuard-checkModuleTransaction}: the module path (SPEC.md §3.1). Who: the
    ///         Safe. Returns `ScopeLib.moduleCallHash`, the policies' `ctx.txHash`.
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module
    ) external returns (bytes32 moduleTxHash) {
        _requireNotInCheck();
        _setLock(true);
        moduleTxHash = _moduleCallHash(msg.sender, module, to, value, data, operation);
        Frame memory f;
        (f.safe, f.actor) = (msg.sender, module);
        _evaluate(f, to, value, data, operation);
        if (f.count != 0) {
            _dispatch(f, moduleTxHash);
        }
        _setLock(false);
    }

    /// @notice {ISafeModuleGuard-checkAfterModuleExecution}.
    function checkAfterModuleExecution(bytes32, bool success) external view {
        _requireNotInCheck();
        require(success, IPolicyGuard.ModuleExecutionFailed());
    }

    // =============================================================================================
    // Preview
    // =============================================================================================

    /// @notice See {IPolicyGuard-matches}.
    function matches(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external view returns (Call[] memory calls, MatchView[] memory found, bytes memory engineError) {
        Frame memory f;
        (f.safe, f.actor, f.collect) = (safe, actor, true);
        _evaluate(f, to, value, data, operation);
        (calls, found, engineError) = (f.calls, f.found, f.err);
        uint256 n = f.foundCount;
        assembly ("memory-safe") {
            mstore(found, n)
        }
    }

    // =============================================================================================
    // Internals
    // =============================================================================================

    function _isTrustedBatch(address target) internal view override returns (bool trusted) {
        (address b0, address b1, address b2, address b3) = (_BATCH_0, _BATCH_1, _BATCH_2, _BATCH_3);
        assembly ("memory-safe") {
            trusted := and(
                iszero(iszero(target)),
                or(or(eq(target, b0), eq(target, b1)), or(eq(target, b2), eq(target, b3)))
            )
        }
    }

    /**
     * @dev SPEC.md §3.4 step 4: each distinct policy once, in first-match order, with all its
     *      matches (already ordered by call, level, storage). A revert, or anything but one word
     *      holding `IPolicy.check.selector`, is `PolicyDenied`. Bounded: at most 8 calls x 48
     *      matches, scanned once per distinct policy, in memory.
     *
     *      The payload is ABI-encoded once with an empty `matches` (the last argument, so its
     *      encoding is the payload's tail); each run only rewrites that tail in place. Encoding the
     *      calls and allocating a new payload and match array per run made the cost grow with
     *      runs x calls plus quadratic memory expansion: 8 distinct calls at the caps did not fit
     *      the 2^24 transaction gas cap.
     */
    function _dispatch(Frame memory f, bytes32 txHash) private {
        uint256[] memory words = f.words;
        bytes32[] memory ids = f.ids;
        uint256 n = f.count;
        bytes memory payload = abi.encodeCall(
            IPolicy.check,
            (Context(f.safe, f.actor, txHash), f.calls, new Match[](0))
        );
        uint256 baseLength = payload.length;
        uint256 tail; // memory address of the `matches` length word
        assembly ("memory-safe") {
            // Arguments start after the length word and the selector; `matches`' offset is the 5th
            // head word (ctx takes 3, `calls` 1).
            tail := add(add(payload, 0x24), mload(add(payload, 0xa4)))
            // Room for up to n matches (3 words each) after the payload, its last allocation.
            mstore(0x40, add(add(tail, 0x20), mul(n, 0x60)))
        }
        for (uint256 s = 0; s < n; s++) {
            address policy = address(uint160(words[s]));
            if (policy == address(0)) continue;
            uint256 m;
            assembly ("memory-safe") {
                // Collect this policy's matches (s..n-1) into the payload tail, clearing them.
                let w := add(words, 0x20)
                let d := sub(add(ids, 0x20), w)
                let p := add(tail, 0x20)
                for {
                    let at := add(w, shl(5, s))
                    let end := add(w, shl(5, n))
                } lt(at, end) {
                    at := add(at, 0x20)
                } {
                    let word := mload(at)
                    if eq(and(word, 0xffffffffffffffffffffffffffffffffffffffff), policy) {
                        mstore(p, and(shr(168, word), 0xffff))
                        mstore(add(p, 0x20), and(shr(160, word), 0xff))
                        mstore(add(p, 0x40), mload(add(at, d)))
                        p := add(p, 0x60)
                        m := add(m, 1)
                        mstore(at, 0)
                    }
                }
                mstore(tail, m)
                mstore(payload, add(baseLength, mul(m, 0x60)))
            }
            bytes4 pass = IPolicy.check.selector;
            bool ok;
            bool passed;
            assembly ("memory-safe") {
                ok := call(gas(), policy, 0, add(payload, 0x20), mload(payload), 0, 0x20)
                passed := and(ok, and(eq(returndatasize(), 0x20), eq(mload(0), pass)))
            }
            if (!passed) {
                revert IPolicyGuard.PolicyDenied(policy, ok ? new bytes(0) : _boundedReturnData());
            }
        }
    }

    /// @dev `ScopeLib.moduleCallHash` hashed straight from calldata (no copy of `data` to memory first).
    function _moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) private pure returns (bytes32 hash) {
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
}
