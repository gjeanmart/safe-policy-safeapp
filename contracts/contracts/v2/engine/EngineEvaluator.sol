// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {MULTI_SEND_SELECTOR} from "../libraries/Constants.sol";
import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {MultiSendDecoder} from "../libraries/MultiSendDecoder.sol";
import {ScopeLib} from "../libraries/Scope.sol";
import {Call, Kind, MatchView} from "../libraries/Types.sol";
import {EngineStorage} from "./EngineStorage.sol";

/**
 * @title Engine evaluation (SPEC.md §3.3, §3.4)
 * @notice The built-in gates shared by the hooks of {PolicyGuard} and its `matches` preview:
 *         batch decoding, engine rules, scope lookup, DENY and ALLOW. One code path for both, so
 *         the preview reports what the hook does. `Frame.collect` picks the mode: a hook reverts at
 *         the first error; the preview records it and every match, and never stops.
 */
abstract contract EngineEvaluator is EngineStorage {
    /**
     * @dev One evaluation. `words[k]` / `ids[k]` (k < `count`) are the POLICY matches in check
     *      order, `words[k] = policy | level << 160 | callIndex << 168`. Preview only (`collect`):
     *      `found` (`foundCount` long) and `err`, the first engine error.
     */
    struct Frame {
        address safe;
        address actor;
        Call[] calls;
        uint256[] words;
        bytes32[] ids;
        uint256 count;
        MatchView[] found;
        uint256 foundCount;
        bytes err;
        bool collect;
    }


    function _isTrustedBatch(address target) internal view virtual returns (bool);

    /**
     * @dev SPEC.md §3.4 steps 2 and 3 for the top-level call `(to, value, data, operation)` of
     *      `f.actor` on `f.safe`: decodes a trusted batch, then judges each call in order. Leaves
     *      the calls in `f.calls` and the POLICY matches in `f.words` / `f.ids`.
     */
    function _evaluate(
        Frame memory f,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) internal view {
        Call[] memory calls;
        bool isBatch = operation == Operation.DELEGATECALL &&
            data.length >= 4 &&
            bytes4(data[:4]) == MULTI_SEND_SELECTOR &&
            _isTrustedBatch(to);
        if (isBatch) {
            bool ok;
            bool tooMany;
            if (value == 0) {
                (ok, tooMany, calls) = MultiSendDecoder.decode(f.safe, data);
            }
            if (!ok) {
                _fail(
                    f,
                    abi.encodeWithSelector(
                        tooMany ? IPolicyGuard.BatchTooLarge.selector : IPolicyGuard.MalformedBatch.selector
                    )
                );
                return;
            }
        } else {
            calls = new Call[](1);
            calls[0] = Call(to, value, data, operation);
        }
        f.calls = calls;
        for (uint256 i = 0; i < calls.length; i++) {
            _checkCall(f, i, calls[i], isBatch);
        }
    }

    /// @dev SPEC.md §3.4 step 3 for call `i`.
    function _checkCall(Frame memory f, uint256 i, Call memory call, bool inBatch) private view {
        (bool selOk, bytes4 sel) = ScopeLib.selectorOf(call.data);
        if (!selOk) {
            _fail(f, abi.encodeWithSelector(IPolicyGuard.InvalidSelector.selector, i));
            return;
        }
        if (inBatch && call.operation == Operation.DELEGATECALL && _isTrustedBatch(call.to)) {
            _fail(f, abi.encodeWithSelector(IPolicyGuard.NestedBatch.selector, i));
        }
        address actor = f.actor;
        bool granted;
        if (call.to == address(this)) {
            // `configure` as an ordinary transaction (SPEC.md §3.3): granted on the owner path;
            // the module path needs the exact ALLOW, which F5 below enforces.
            if (
                sel == IPolicyGuard.configure.selector &&
                !inBatch &&
                call.operation == Operation.CALL &&
                call.value == 0
            ) {
                granted = actor == ScopeLib.OWNERS;
            } else {
                _fail(f, abi.encodeWithSelector(IPolicyGuard.GuardTargetDenied.selector, i));
            }
        }
        // F5: on the module path, calls to the Safe itself or to the engine need an exact ALLOW.
        bool exactOnly = actor != ScopeLib.OWNERS && (call.to == f.safe || call.to == address(this));
        // F4: a DELEGATECALL needs an exact ALLOW.
        bool anyLevel = call.operation == Operation.CALL && !exactOnly;

        (uint256[] memory matches, bytes32[6] memory keys) = _match(
            f.safe,
            actor,
            call.to,
            sel,
            ScopeLib.opBit(call.operation)
        );
        for (uint256 k = 0; k < matches.length; k++) {
            uint256 word = matches[k];
            uint8 lvl = uint8(word >> _LEVEL_SHIFT);
            uint8 kind = uint8(word >> 160);
            address policy = address(uint160(word));
            bool counts = true;
            if (kind == uint8(Kind.ALLOW)) {
                counts = anyLevel || lvl == ScopeLib.EXACT_LEVEL;
                granted = granted || counts;
                if (!f.collect) continue;
            }
            bytes32 id = _attachmentId(keys[lvl], kind, policy);
            if (kind == uint8(Kind.DENY)) {
                _fail(f, abi.encodeWithSelector(IPolicyGuard.Denied.selector, i, id));
            } else if (kind == uint8(Kind.POLICY)) {
                _pushPolicyMatch(f, uint160(policy) | (uint256(lvl) << 160) | (i << 168), id);
            }
            if (f.collect) {
                _pushFound(f, MatchView(uint16(i), lvl, id, Kind(kind), policy, uint8(word >> 168), counts));
            }
        }
        if (!granted) {
            _fail(f, abi.encodeWithSelector(IPolicyGuard.NotGranted.selector, i, call.to, sel, call.operation));
        }
    }

    /// @dev Hook: reverts with `reason`. Preview: keeps the first one.
    function _fail(Frame memory f, bytes memory reason) private pure {
        if (!f.collect) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
        if (f.err.length == 0) {
            f.err = reason;
        }
    }

    function _pushPolicyMatch(Frame memory f, uint256 word, bytes32 id) private pure {
        uint256 n = f.count;
        if (n == f.words.length) {
            uint256[] memory words = new uint256[](2 * n + 8);
            bytes32[] memory ids = new bytes32[](2 * n + 8);
            for (uint256 j = 0; j < n; j++) {
                words[j] = f.words[j];
                ids[j] = f.ids[j];
            }
            (f.words, f.ids) = (words, ids);
        }
        f.words[n] = word;
        f.ids[n] = id;
        f.count = n + 1;
    }

    function _pushFound(Frame memory f, MatchView memory m) private pure {
        uint256 n = f.foundCount;
        if (n == f.found.length) {
            MatchView[] memory bigger = new MatchView[](2 * n + 8);
            for (uint256 j = 0; j < n; j++) {
                bigger[j] = f.found[j];
            }
            f.found = bigger;
        }
        f.found[n] = m;
        f.foundCount = n + 1;
    }
}
