// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicy} from "../../interfaces/IPolicy.sol";
import {ScopeLib} from "../../libraries/Scope.sol";
import {AttachmentView, Call, Change, Context, Kind, Match, MatchView, Scope} from "../../libraries/Types.sol";

/**
 * @title Timelock engine stub
 * @notice Test double of the rev 3 engine for the TimelockPolicy tests (WP B), built while the
 *         real engine (WP A) is written in parallel. Same ABI for what the policy uses
 *         (`configure`, `matches`, `getAttachment`, the four guard hooks) and calls policies as the
 *         engine does (`msg.sender` = engine, one `check` per policy with all its matches).
 * @dev Simplified on purpose: one call per transaction (no batch decoding); no DENY; the owner
 *      path is granted without an ALLOW, the module path needs any matching ALLOW (no level rule);
 *      `configureFor` configures any Safe without authorization (test setup).
 */
contract TimelockEngineStub {
    struct Stored {
        bytes32 id;
        bytes32 scopeKey;
        Scope scope;
        Kind kind;
        address policy;
        uint8 opMask;
    }

    // Same declarations as IPolicyGuard.
    error NotGranted(uint16 callIndex, address to, bytes4 selector, Operation operation);
    error PolicyDenied(address policy, bytes reason);
    error PolicyConfigurationFailed(address policy, bytes reason);
    error NotAttached(bytes32 attachmentId);
    error ExecutionFailed();
    error ModuleExecutionFailed();

    /// @notice Stub only: gas used by one policy `check`.
    event PolicyChecked(address indexed policy, uint256 gasUsed);

    mapping(address safe => Stored[]) private _attachments;

    // =============================================================================================
    // Configuration
    // =============================================================================================

    /// @notice As `IPolicyGuard.configure`: applies `changes` for `msg.sender`.
    function configure(Change[] calldata changes) external {
        _apply(msg.sender, changes);
    }

    /// @notice Stub only: applies `changes` for `safe` (test setup).
    function configureFor(address safe, Change[] calldata changes) external {
        _apply(safe, changes);
    }

    function _apply(address safe, Change[] calldata changes) private {
        Stored[] storage list = _attachments[safe];
        for (uint256 i = 0; i < changes.length; i++) {
            Change calldata c = changes[i];
            bytes32 key = ScopeLib.key(c.scope);
            bytes32 id = ScopeLib.attachmentId(key, c.kind, c.policy);
            (bool found, uint256 index) = _find(list, id);
            if (c.detach) {
                require(found, NotAttached(id));
                list[index] = list[list.length - 1];
                list.pop();
                continue;
            }
            uint8 opMask = ScopeLib.normalizeOpMask(c.kind, c.opMask);
            if (found) {
                list[index].opMask = opMask;
            } else {
                list.push(Stored(id, key, c.scope, c.kind, c.policy, opMask));
            }
            if (c.kind == Kind.POLICY) {
                try IPolicy(c.policy).configure(safe, id, c.scope, opMask, c.settings) {} catch (bytes memory reason) {
                    revert PolicyConfigurationFailed(c.policy, reason);
                }
            }
        }
    }

    // =============================================================================================
    // Views
    // =============================================================================================

    /// @notice As `IPolicyGuard.matches` for a single call; `engineError` is always empty.
    function matches(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) public view returns (Call[] memory calls, MatchView[] memory found, bytes memory engineError) {
        calls = new Call[](1);
        calls[0] = Call(to, value, data, operation);
        (, bytes4 selector) = ScopeLib.selectorOf(data);
        uint8 bit = ScopeLib.opBit(operation);
        Stored[] storage list = _attachments[safe];
        found = new MatchView[](list.length);
        uint256 n;
        for (uint8 lvl = 0; lvl < ScopeLib.LEVEL_COUNT; lvl++) {
            bytes32 key = ScopeLib.keyAt(lvl, actor, to, selector);
            for (uint256 j = 0; j < list.length; j++) {
                Stored storage a = list[j];
                if (a.scopeKey != key || a.opMask & bit == 0) continue;
                found[n++] = MatchView(0, lvl, a.id, a.kind, a.policy, a.opMask, true);
            }
        }
        assembly ("memory-safe") {
            mstore(found, n)
        }
        engineError = "";
    }

    /// @notice As `IPolicyGuard.getAttachment`.
    function getAttachment(
        address safe,
        bytes32 attachmentId
    ) external view returns (bool exists, AttachmentView memory attachment) {
        Stored[] storage list = _attachments[safe];
        (bool found, uint256 index) = _find(list, attachmentId);
        if (!found) return (false, attachment);
        Stored storage a = list[index];
        return (true, AttachmentView(a.id, a.scopeKey, a.scope, a.kind, a.policy, a.opMask));
    }

    // =============================================================================================
    // Guard hooks (Safe 1.5.0)
    // =============================================================================================

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
        bytes32 txHash = ISafe(msg.sender).getTransactionHash(
            to,
            value,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            ISafe(msg.sender).nonce() - 1
        );
        _evaluate(Context(msg.sender, ScopeLib.OWNERS, txHash), to, value, data, operation);
    }

    function checkAfterExecution(bytes32, bool success) external pure {
        require(success, ExecutionFailed());
    }

    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module
    ) external returns (bytes32 moduleTxHash) {
        moduleTxHash = ScopeLib.moduleCallHash(msg.sender, module, to, value, data, operation);
        _evaluate(Context(msg.sender, module, moduleTxHash), to, value, data, operation);
    }

    function checkAfterModuleExecution(bytes32, bool success) external pure {
        require(success, ModuleExecutionFailed());
    }

    /// @notice Stub only: calls `policy.check` as the engine with arbitrary inputs (raw result).
    function callCheck(
        address policy,
        Context calldata ctx,
        Call[] calldata calls,
        Match[] calldata policyMatches
    ) external returns (bytes4) {
        return IPolicy(policy).check(ctx, calls, policyMatches);
    }

    function _evaluate(Context memory ctx, address to, uint256 value, bytes calldata data, Operation operation) private {
        (Call[] memory calls, MatchView[] memory found, ) = matches(ctx.safe, ctx.actor, to, value, data, operation);
        if (ctx.actor != ScopeLib.OWNERS) {
            bool granted;
            for (uint256 i = 0; i < found.length && !granted; i++) granted = found[i].kind == Kind.ALLOW;
            (, bytes4 selector) = ScopeLib.selectorOf(data);
            require(granted, NotGranted(0, to, selector, operation));
        }
        for (uint256 i = 0; i < found.length; i++) {
            if (found[i].kind != Kind.POLICY || _seen(found, i)) continue;
            address policy = found[i].policy;
            Match[] memory policyMatches = new Match[](found.length);
            uint256 n;
            for (uint256 k = i; k < found.length; k++) {
                if (found[k].kind != Kind.POLICY || found[k].policy != policy) continue;
                policyMatches[n++] = Match(found[k].callIndex, found[k].level, found[k].attachmentId);
            }
            assembly ("memory-safe") {
                mstore(policyMatches, n)
            }
            uint256 before = gasleft();
            try IPolicy(policy).check(ctx, calls, policyMatches) returns (bytes4 result) {
                require(result == IPolicy.check.selector, PolicyDenied(policy, ""));
            } catch (bytes memory reason) {
                revert PolicyDenied(policy, reason);
            }
            emit PolicyChecked(policy, before - gasleft());
        }
    }

    function _seen(MatchView[] memory found, uint256 i) private pure returns (bool) {
        for (uint256 k = 0; k < i; k++) {
            if (found[k].kind == Kind.POLICY && found[k].policy == found[i].policy) return true;
        }
        return false;
    }

    function _find(Stored[] storage list, bytes32 id) private view returns (bool, uint256) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].id == id) return (true, i);
        }
        return (false, 0);
    }
}
