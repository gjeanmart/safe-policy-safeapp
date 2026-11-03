// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../vendor/policy-engine/interfaces/IERC165.sol";
import {ISafeModuleGuard} from "../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicy} from "./interfaces/IPolicy.sol";
import {IPolicyGuard} from "./interfaces/IPolicyGuard.sol";
import {ScopeLib} from "./libraries/Scope.sol";
import {AttachmentView, Change, Kind, Scope} from "./libraries/Types.sol";
import {EngineStorage} from "./engine/EngineStorage.sol";

/**
 * @title Policy Guard configuration (rev 3 engine)
 * @notice `configure`, the enumeration views and ERC-165 of {IPolicyGuard}. Reached through
 *         {PolicyGuard}'s fallback by DELEGATECALL: it runs on the guard's storage, at the guard's
 *         address, so `msg.sender` is the guard's caller. SPEC.md §3.2.
 * @dev `matches` lives in the guard, which shares its evaluator with the hooks: one source for the
 *      preview and the check, and the only split under 10,000 bytes per contract. Called directly,
 *      this contract acts on its own unused storage (a direct `configure` only configures a Safe
 *      for an engine no Safe uses).
 */
contract PolicyGuardConfig is EngineStorage {
    // =============================================================================================
    // Configuration (msg.sender is the Safe)
    // =============================================================================================

    /// @notice See {IPolicyGuard-configure}.
    function configure(Change[] calldata changes) external {
        _requireNotInCheck();
        for (uint256 i = 0; i < changes.length; i++) {
            _apply(msg.sender, changes[i]);
        }
    }

    /// @dev SPEC.md §3.2.
    function _apply(address safe, Change calldata change) private {
        Scope memory scope = change.scope;
        require(ScopeLib.isNormalized(scope), IPolicyGuard.InvalidScope());
        bytes32 key = ScopeLib.key(scope);
        uint8 lvl = ScopeLib.level(scope);
        Kind kind = change.kind;
        address policy = change.policy;
        bytes32 id = ScopeLib.attachmentId(key, kind, policy);

        if (change.detach) {
            _detach(safe, key, lvl, id);
            return;
        }

        require(change.opMask <= ScopeLib.OP_ALL, IPolicyGuard.InvalidOpMask(change.opMask));
        uint8 opMask = ScopeLib.normalizeOpMask(kind, change.opMask);
        if (kind == Kind.POLICY) {
            require(_isPolicy(policy), IPolicyGuard.InvalidPolicy(policy));
        } else {
            require(policy == address(0) && change.settings.length == 0, IPolicyGuard.InvalidPolicy(policy));
            if (kind == Kind.ALLOW) {
                require(scope.actor != ScopeLib.ANY, IPolicyGuard.AllowNotPerActor());
                require(
                    opMask & ScopeLib.OP_DELEGATECALL == 0 || lvl == ScopeLib.EXACT_LEVEL,
                    IPolicyGuard.DelegateCallNotExact()
                );
            }
        }

        uint256 word = uint160(policy) | (uint256(kind) << 160) | (uint256(opMask) << 168);
        AttachmentRef storage ref = _refs[safe][id];
        if (ref.position == 0) {
            uint256[] storage list = _attachments[safe][key];
            require(list.length < ScopeLib.MAX_ATTACHMENTS_PER_SCOPE, IPolicyGuard.TooManyAttachments(key));
            list.push(word);
            (ref.scopeKey, ref.position) = (key, list.length);
            _levelCounts[safe] += uint256(1) << (32 * uint256(lvl));
            if (list.length == 1) {
                _addScope(safe, key, scope);
            }
        } else {
            _attachments[safe][key][ref.position - 1] = word;
        }

        if (kind == Kind.POLICY) {
            try IPolicy(policy).configure(safe, id, scope, opMask, change.settings) {} catch {
                revert IPolicyGuard.PolicyConfigurationFailed(policy, _boundedReturnData());
            }
        }
        emit IPolicyGuard.Attached(safe, id, key, scope, kind, policy, opMask, change.settings);
    }

    /// @dev Never calls the policy (liveness): its stale settings are harmless.
    function _detach(address safe, bytes32 key, uint8 lvl, bytes32 id) private {
        uint256 position = _refs[safe][id].position;
        require(position != 0, IPolicyGuard.NotAttached(id));
        uint256[] storage list = _attachments[safe][key];
        uint256 last = list.length - 1;
        if (position - 1 != last) {
            uint256 moved = list[last];
            list[position - 1] = moved;
            _refs[safe][_attachmentId(key, uint8(moved >> 160), address(uint160(moved)))].position = position;
        }
        list.pop();
        delete _refs[safe][id];
        _levelCounts[safe] -= uint256(1) << (32 * uint256(lvl));
        if (last == 0) {
            _removeScope(safe, key);
        }
        emit IPolicyGuard.Detached(safe, id, key);
    }

    function _addScope(address safe, bytes32 key, Scope memory scope) private {
        bytes32[] storage keys = _scopeKeys[safe];
        keys.push(key);
        _scopes[safe][key] = ScopeRecord(scope.actor, scope.selector, scope.callMatch, uint32(keys.length), scope.to);
    }

    function _removeScope(address safe, bytes32 key) private {
        bytes32[] storage keys = _scopeKeys[safe];
        uint256 position = _scopes[safe][key].position;
        uint256 last = keys.length - 1;
        if (position - 1 != last) {
            bytes32 moved = keys[last];
            keys[position - 1] = moved;
            _scopes[safe][moved].position = uint32(position);
        }
        keys.pop();
        delete _scopes[safe][key];
    }

    /// @dev Code and `supportsInterface(IPolicy) == true`, read without trusting the return size.
    function _isPolicy(address policy) private view returns (bool yes) {
        if (policy.code.length == 0) return false;
        bytes memory data = abi.encodeWithSelector(0x01ffc9a7, type(IPolicy).interfaceId);
        assembly ("memory-safe") {
            let ok := staticcall(gas(), policy, add(data, 0x20), mload(data), 0, 0x20)
            yes := and(ok, and(eq(returndatasize(), 0x20), eq(mload(0), 1)))
        }
    }

    // =============================================================================================
    // Views
    // =============================================================================================

    /// @notice {IPolicyGuard}, the Safe 1.5.0 guard interfaces and ERC-165. Here rather than in the
    ///         guard, which has no code size to spare; Safe reads it only in `setGuard` /
    ///         `setModuleGuard`.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IPolicyGuard).interfaceId ||
            interfaceId == type(ISafeTransactionGuard).interfaceId ||
            interfaceId == type(ISafeModuleGuard).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    /// @notice See {IPolicyGuard-getScopes}.
    function getScopes(address safe) external view returns (bytes32[] memory keys, Scope[] memory scopes) {
        keys = _scopeKeys[safe];
        scopes = new Scope[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            ScopeRecord storage record = _scopes[safe][keys[i]];
            scopes[i] = Scope(record.actor, record.to, record.selector, record.callMatch);
        }
    }

    /// @notice See {IPolicyGuard-getAttachments}.
    function getAttachments(address safe) external view returns (AttachmentView[] memory all) {
        bytes32[] storage keys = _scopeKeys[safe];
        uint256 levelCounts = _levelCounts[safe];
        uint256 total;
        for (uint8 lvl = 0; lvl < ScopeLib.LEVEL_COUNT; lvl++) {
            total += ScopeLib.countAt(levelCounts, lvl);
        }
        all = new AttachmentView[](total);
        uint256 n;
        for (uint256 i = 0; i < keys.length; i++) {
            uint256[] storage list = _attachments[safe][keys[i]];
            for (uint256 j = 0; j < list.length; j++) {
                all[n++] = _view(safe, keys[i], list[j]);
            }
        }
    }

    /// @notice See {IPolicyGuard-getScopeAttachments}.
    function getScopeAttachments(address safe, bytes32 key) external view returns (AttachmentView[] memory views) {
        uint256[] storage list = _attachments[safe][key];
        views = new AttachmentView[](list.length);
        for (uint256 j = 0; j < list.length; j++) {
            views[j] = _view(safe, key, list[j]);
        }
    }

    /// @notice See {IPolicyGuard-getAttachment}.
    function getAttachment(
        address safe,
        bytes32 id
    ) external view returns (bool exists, AttachmentView memory attachment) {
        AttachmentRef storage ref = _refs[safe][id];
        exists = ref.position != 0;
        if (exists) {
            attachment = _view(safe, ref.scopeKey, _attachments[safe][ref.scopeKey][ref.position - 1]);
        }
    }

    /// @notice See {IPolicyGuard-levelsUsed}.
    function levelsUsed(address safe) external view returns (uint8) {
        return ScopeLib.bitmap(_levelCounts[safe]);
    }

    /// @notice See {IPolicyGuard-scopeKey}.
    function scopeKey(Scope calldata scope) external pure returns (bytes32) {
        return ScopeLib.key(scope);
    }

    /// @notice See {IPolicyGuard-attachmentId}.
    function attachmentId(bytes32 key, Kind kind, address policy) external pure returns (bytes32) {
        return ScopeLib.attachmentId(key, kind, policy);
    }

    /// @notice See {IPolicyGuard-moduleCallHash}.
    function moduleCallHash(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32) {
        return ScopeLib.moduleCallHash(safe, actor, to, value, data, operation);
    }
}
