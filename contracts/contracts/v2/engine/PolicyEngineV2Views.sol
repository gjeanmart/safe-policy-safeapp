// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {ISafeModuleGuard} from "../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {MultiSendDecoder} from "../libraries/MultiSendDecoder.sol";
import {Scope} from "../libraries/Scope.sol";
import {
    Attachment,
    AttachmentKind,
    AttachmentView,
    Call,
    CallMatch,
    MatchView,
    PolicyLevel,
    ScopeData
} from "../libraries/Types.sol";
import {EngineModuleBase} from "./EngineModuleBase.sol";

/**
 * @title Policy Engine V2: enumeration views
 * @notice The configuration of a Safe as the app and policies list it: scopes, attachments and
 *         the attachments a call matches (SPEC.md §6.3). Reached by {SafePolicyGuardV2} through
 *         DELEGATECALL (a STATICCALL to the guard stays static in the module).
 */
contract PolicyEngineV2Views is EngineModuleBase {
    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineModuleBase(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {}

    /**
     * @notice ERC-165 of the guard (SPEC.md §6.1): `IPolicyEngineV2`, both Safe guard interfaces
     *         and `IERC165`. Here rather than in the guard, which has no code size to spare; Safe
     *         reads it only in `setGuard` / `setModuleGuard`.
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IPolicyEngineV2).interfaceId ||
            interfaceId == type(ISafeTransactionGuard).interfaceId ||
            interfaceId == type(ISafeModuleGuard).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    // =============================================================================================
    // Enumeration views
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}; reached through the guard's fallback.
    function getScopes(
        address safe
    ) external view onlyDelegatedView returns (bytes32[] memory keys, ScopeData[] memory scopes) {
        keys = _scopeKeys[safe];
        scopes = new ScopeData[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            scopes[i] = _scopeData(safe, keys[i]);
        }
    }

    /// @notice See {IPolicyEngineV2}; reached through the guard's fallback.
    function getAttachments(address safe) external view onlyDelegatedView returns (AttachmentView[] memory views) {
        bytes32[] storage keys = _scopeKeys[safe];
        uint256 total;
        for (uint256 i = 0; i < keys.length; i++) {
            total += _attachments[safe][keys[i]].length;
        }
        views = new AttachmentView[](total);
        uint256 n;
        for (uint256 i = 0; i < keys.length; i++) {
            AttachmentView[] memory part = getScopeAttachments(safe, keys[i]);
            for (uint256 j = 0; j < part.length; j++) {
                views[n++] = part[j];
            }
        }
    }

    /// @notice See {IPolicyEngineV2}; reached through the guard's fallback.
    function getScopeAttachments(
        address safe,
        bytes32 key
    ) public view onlyDelegatedView returns (AttachmentView[] memory views) {
        Attachment[] storage list = _attachments[safe][key];
        ScopeData memory scope = _scopeData(safe, key);
        views = new AttachmentView[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            views[i] = _view(key, scope, list[i]);
        }
    }

    /// @notice See {IPolicyEngineV2}; reached through the guard's fallback.
    function getAttachment(
        address safe,
        bytes32 id
    ) external view onlyDelegatedView returns (bool exists, AttachmentView memory attachment) {
        AttachmentRef storage ref = _refs[safe][id];
        if (ref.position == 0) {
            return (false, attachment);
        }
        bytes32 key = ref.scopeKey;
        return (true, _view(key, _scopeData(safe, key), _attachments[safe][key][ref.position - 1]));
    }

    /// @notice See {IPolicyEngineV2}; reached through the guard's fallback.
    function getMatchingAttachments(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address policy
    ) external view onlyDelegatedView returns (MatchView[] memory views) {
        (bool selOk, bytes4 sel) = _calldataSelector(data);
        // A top-level configuration call matches as the guard checks it (§5.1, §14 D-19).
        bool configPath = to == address(this) && selOk && _isConfigSelector(sel);
        Call[] memory calls;
        if (
            operation == Operation.DELEGATECALL &&
            selOk &&
            sel == MultiSendDecoder.MULTI_SEND_SELECTOR &&
            _isTrustedBatch(to)
        ) {
            bool ok;
            (ok, , calls) = MultiSendDecoder.decode(safe, data);
            if (!ok || value != 0) {
                return views;
            }
        } else {
            calls = new Call[](1);
            calls[0] = Call(to, value, data, operation);
        }

        uint256[][] memory perCall = new uint256[][](calls.length);
        bytes32[8][] memory keys = new bytes32[8][](calls.length);
        bytes4[] memory selectors = new bytes4[](calls.length);
        uint256 total;
        for (uint256 i = 0; i < calls.length; i++) {
            bool ok;
            (ok, selectors[i]) = Scope.selectorOf(calls[i].data);
            if (!ok) {
                continue;
            }
            Operation effOp = _effectiveOperation(calls[i].to, calls[i].operation, selectors[i]);
            (perCall[i], keys[i]) = _match(
                safe,
                actor,
                calls[i].to,
                selectors[i],
                _matchMode(calls[i].operation, effOp, configPath)
            );
            for (uint256 k = 0; k < perCall[i].length; k++) {
                if (policy == address(0) || address(uint160(perCall[i][k])) == policy) {
                    total++;
                }
            }
        }

        views = new MatchView[](total);
        uint256 n;
        for (uint256 i = 0; i < calls.length; i++) {
            for (uint256 k = 0; k < perCall[i].length; k++) {
                uint256 word = perCall[i][k];
                if (policy != address(0) && address(uint160(word)) != policy) {
                    continue;
                }
                uint8 lvl = uint8(word >> _MATCH_LEVEL_SHIFT);
                views[n++] = MatchView(
                    uint16(i),
                    lvl,
                    _view(
                        keys[i][lvl],
                        _scopeAt(lvl, actor, calls[i].to, selectors[i]),
                        Attachment(
                            address(uint160(word)),
                            AttachmentKind(uint8(word >> 160)),
                            uint8(word >> 168),
                            PolicyLevel(uint8(word >> 176))
                        )
                    )
                );
            }
        }
    }

    /// @dev The scope a call `(actor, to, sel)` is looked up at for level `lvl`.
    function _scopeAt(uint8 lvl, address actor, address to, bytes4 sel) private pure returns (ScopeData memory) {
        CallMatch callMatch = CallMatch(lvl % Scope.ACTOR_LEVEL_OFFSET);
        return
            ScopeData(
                lvl < Scope.ACTOR_LEVEL_OFFSET ? Scope.ANY : actor,
                Scope.namesTo(callMatch) ? to : address(0),
                Scope.namesSelector(callMatch) ? sel : bytes4(0),
                callMatch
            );
    }
}
