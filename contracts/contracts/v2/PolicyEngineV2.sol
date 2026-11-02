// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyEngineV2} from "./interfaces/IPolicyEngineV2.sol";
import {IPolicyV2} from "./interfaces/IPolicyV2.sol";
import {MultiSendDecoder} from "./libraries/MultiSendDecoder.sol";
import {Scope} from "./libraries/Scope.sol";
import {
    Attachment,
    AttachmentChange,
    AttachmentKind,
    AttachmentView,
    Call,
    CallMatch,
    ChangeType,
    FreezeRole,
    FreezeState,
    MatchView,
    PolicyLevel,
    RoleChange,
    ScopeData
} from "./libraries/Types.sol";
import {EngineStorage} from "./engine/EngineStorage.sol";

/**
 * @title Policy Engine V2: configuration and freeze logic
 * @notice The state-changing half of the engine: the delayed configuration path (SPEC.md §5) and
 *         the bounded freeze (§7.1). It is not an engine of its own: {SafePolicyGuardV2} deploys it
 *         in its constructor and reaches it by DELEGATECALL, so it runs on the guard's storage, at
 *         the guard's address (Safes, guardians and policies only ever see the guard). Split out
 *         because the engine does not fit the 24 KiB code size limit as one contract.
 * @dev Every entry point is `onlyDelegated` and refuses to run inside a check; `msg.sender` is the
 *      caller of the guard (the Safe, a guardian, a lifter).
 */
contract PolicyEngineV2 is EngineStorage {
    address private immutable _SELF = address(this);

    /// @dev Safe's `GuardManager.GUARD_STORAGE_SLOT` (`keccak256("guard_manager.guard.address")`).
    bytes32 private constant _GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    /// @dev Safe's `ModuleManager.MODULE_GUARD_STORAGE_SLOT`.
    bytes32 private constant _MODULE_GUARD_STORAGE_SLOT =
        0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    /// @notice Called directly instead of through the guard.
    error NotDelegated();

    /// @dev A direct call would act on this contract's own, unused storage: reject it.
    modifier onlyDelegated() {
        require(address(this) != _SELF, NotDelegated());
        _requireNotInCheck();
        _;
    }

    /// @dev Views are reached by the guard's static self-call; directly they would read empty storage.
    modifier onlyDelegatedView() {
        require(address(this) != _SELF, NotDelegated());
        _;
    }

    constructor(
        uint256 delay,
        uint256 expiry,
        uint256 maxFreeze,
        uint256 freezeCooldown,
        address[] memory trustedBatches,
        address signLib
    ) EngineStorage(delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib) {}

    // =============================================================================================
    // Configuration (msg.sender is the Safe)
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}.
    function configureImmediately(
        AttachmentChange[] calldata changes,
        RoleChange[] calldata roles
    ) external onlyDelegated {
        require(!_isGuardEnabled(msg.sender), IPolicyEngineV2.GuardAlreadyEnabled());
        emit IPolicyEngineV2.ConfiguredImmediately(msg.sender, keccak256(abi.encode(changes, roles)));
        _applyAll(msg.sender, changes, roles);
    }

    /// @notice See {IPolicyEngineV2}.
    function requestConfiguration(bytes32 root) external onlyDelegated {
        uint256 validFrom = _rootConfigured[msg.sender][root];
        require(validFrom == 0 || block.timestamp >= validFrom + _EXPIRY, IPolicyEngineV2.RootAlreadyRequested(root));
        validFrom = block.timestamp + _DELAY;
        _rootConfigured[msg.sender][root] = validFrom;
        emit IPolicyEngineV2.ConfigRequested(msg.sender, root, validFrom);
    }

    /// @notice See {IPolicyEngineV2}.
    function invalidateRoot(bytes32 root) external onlyDelegated {
        require(_rootConfigured[msg.sender][root] != 0, IPolicyEngineV2.RootNotRequested(root));
        delete _rootConfigured[msg.sender][root];
        emit IPolicyEngineV2.ConfigInvalidated(msg.sender, root);
    }

    /// @notice See {IPolicyEngineV2}.
    function applyConfiguration(
        AttachmentChange[] calldata changes,
        RoleChange[] calldata roles
    ) external onlyDelegated {
        bytes32 root = keccak256(abi.encode(changes, roles));
        uint256 validFrom = _rootConfigured[msg.sender][root];
        require(validFrom != 0, IPolicyEngineV2.RootNotRequested(root));
        require(block.timestamp >= validFrom, IPolicyEngineV2.RootPending(root, validFrom));
        require(block.timestamp < validFrom + _EXPIRY, IPolicyEngineV2.RootExpired(root));
        uint64 frozenUntil = _freezes[msg.sender][Scope.ANY].frozenUntil;
        require(block.timestamp >= frozenUntil, IPolicyEngineV2.ConfigFrozen(frozenUntil));
        delete _rootConfigured[msg.sender][root];
        emit IPolicyEngineV2.ConfigApplied(msg.sender, root);
        _applyAll(msg.sender, changes, roles);
    }

    function _applyAll(address safe, AttachmentChange[] calldata changes, RoleChange[] calldata roles) private {
        for (uint256 i = 0; i < changes.length; i++) {
            _applyChange(safe, changes[i]);
        }
        for (uint256 i = 0; i < roles.length; i++) {
            _applyRole(safe, roles[i]);
        }
    }

    /// @dev SPEC.md §5.2.
    function _applyChange(address safe, AttachmentChange calldata change) private {
        ScopeData memory scope = change.scope;
        require(
            Scope.isNormalized(scope) && (!Scope.namesTo(scope.callMatch) || scope.to != address(0)),
            IPolicyEngineV2.InvalidScope()
        );
        bytes32 key = Scope.key(scope);
        uint8 lvl = Scope.level(scope);
        bytes32 id = Scope.attachmentId(key, change.kind, change.policy);

        if (change.changeType == ChangeType.DETACH) {
            _detach(safe, key, lvl, id);
            return;
        }

        uint8 opMask = Scope.normalizeOpMask(change.opMask);
        require(opMask <= Scope.OP_ALL, IPolicyEngineV2.InvalidOpMask(change.opMask));
        PolicyLevel policyLevel_ = PolicyLevel.CALL;
        if (change.kind == AttachmentKind.POLICY) {
            policyLevel_ = _validatePolicy(change.policy);
        } else {
            require(
                change.policy == address(0) && change.data.length == 0,
                IPolicyEngineV2.InvalidPolicy(change.policy)
            );
            require(
                change.kind != AttachmentKind.ALLOW ||
                    opMask & Scope.OP_DELEGATECALL == 0 ||
                    lvl == Scope.EXACT_LEVEL,
                IPolicyEngineV2.DelegateCallNotExact()
            );
        }

        Attachment memory attachment = Attachment(change.policy, change.kind, opMask, policyLevel_);
        AttachmentRef storage ref = _refs[safe][id];
        if (ref.position == 0) {
            Attachment[] storage list = _attachments[safe][key];
            require(list.length < Scope.MAX_ATTACHMENTS_PER_SCOPE, IPolicyEngineV2.TooManyAttachments(key));
            list.push(attachment);
            ref.scopeKey = key;
            ref.position = list.length;
            _levelCounts[safe] += uint256(1) << (32 * uint256(lvl));
            if (list.length == 1) {
                _addScope(safe, key, scope);
            }
        } else {
            _attachments[safe][key][ref.position - 1] = attachment;
        }

        if (change.kind == AttachmentKind.POLICY) {
            uint256 delayFloor = _configurePolicy(safe, id, change);
            require(
                delayFloor <= _DELAY || (scope.actor != Scope.ANY && scope.actor != Scope.OWNERS),
                IPolicyEngineV2.DelayBelowTimelock(_DELAY, delayFloor)
            );
        }

        emit IPolicyEngineV2.Attached(
            safe,
            id,
            key,
            scope.actor,
            scope.to,
            scope.selector,
            scope.callMatch,
            change.kind,
            change.policy,
            opMask,
            policyLevel_,
            change.data
        );
    }

    function _detach(address safe, bytes32 key, uint8 lvl, bytes32 id) private {
        uint256 position = _refs[safe][id].position;
        require(position != 0, IPolicyEngineV2.NotAttached(id));
        Attachment[] storage list = _attachments[safe][key];
        uint256 last = list.length - 1;
        if (position - 1 != last) {
            Attachment memory moved = list[last];
            list[position - 1] = moved;
            _refs[safe][Scope.attachmentId(key, moved.kind, moved.policy)].position = position;
        }
        list.pop();
        delete _refs[safe][id];
        _levelCounts[safe] -= uint256(1) << (32 * uint256(lvl));
        if (last == 0) {
            _removeScope(safe, key);
        }
        emit IPolicyEngineV2.Detached(safe, id, key);
    }

    function _addScope(address safe, bytes32 key, ScopeData memory scope) private {
        bytes32[] storage keys = _scopeKeys[safe];
        keys.push(key);
        _scopes[safe][key] = ScopeRecord(
            scope.actor,
            scope.selector,
            scope.callMatch,
            uint32(keys.length),
            scope.to
        );
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

    /// @dev Code, `supportsInterface(IPolicyV2)` and a `policyLevel()` that decodes, else InvalidPolicy.
    function _validatePolicy(address policy) private view returns (PolicyLevel) {
        require(policy.code.length != 0, IPolicyEngineV2.InvalidPolicy(policy));
        (bool ok, uint256 word) = _staticWord(
            policy,
            abi.encodeWithSelector(0x01ffc9a7, type(IPolicyV2).interfaceId)
        );
        require(ok && word == 1, IPolicyEngineV2.InvalidPolicy(policy));
        (ok, word) = _staticWord(policy, abi.encodeCall(IPolicyV2.policyLevel, ()));
        require(ok && word <= uint256(type(PolicyLevel).max), IPolicyEngineV2.InvalidPolicy(policy));
        return PolicyLevel(word);
    }

    /// @dev A STATICCALL returning one word, without trusting the callee's return size.
    function _staticWord(address target, bytes memory data) private view returns (bool ok, uint256 word) {
        assembly ("memory-safe") {
            ok := staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0x20)
            ok := and(ok, eq(returndatasize(), 0x20))
            word := mload(0)
        }
    }

    function _configurePolicy(
        address safe,
        bytes32 id,
        AttachmentChange calldata change
    ) private returns (uint256 delayFloor) {
        bytes memory data = abi.encodeCall(
            IPolicyV2.configure,
            (safe, id, change.scope, Scope.normalizeOpMask(change.opMask), change.data)
        );
        address policy = change.policy;
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            ok := call(gas(), policy, 0, add(data, 0x20), mload(data), 0, 0x20)
            size := returndatasize()
            delayFloor := mload(0)
        }
        if (!ok || size != 0x20) {
            revert IPolicyEngineV2.PolicyConfigurationFailed(policy, ok ? new bytes(0) : _boundedReturnData());
        }
    }

    function _applyRole(address safe, RoleChange calldata change) private {
        // No dedicated error for a zero account in the frozen interface; InvalidActor names it.
        require(change.account != address(0), IPolicyEngineV2.InvalidActor(address(0)));
        mapping(address => bool) storage has = _hasRole[safe][change.role];
        if (has[change.account] == change.enabled) {
            return;
        }
        address[] storage members = _roleMembers[safe][change.role];
        if (change.enabled) {
            require(members.length < Scope.MAX_ROLE_MEMBERS, IPolicyEngineV2.TooManyRoleMembers(change.role));
            members.push(change.account);
        } else {
            uint256 last = members.length - 1;
            for (uint256 i = 0; i < last; i++) {
                if (members[i] == change.account) {
                    members[i] = members[last];
                    break;
                }
            }
            members.pop();
        }
        has[change.account] = change.enabled;
        emit IPolicyEngineV2.RoleSet(safe, change.role, change.account, change.enabled);
    }

    /// @dev Whether this contract is `safe`'s transaction guard or module guard (V1 slot reads).
    function _isGuardEnabled(address safe) private view returns (bool) {
        return
            _readGuardSlot(safe, _GUARD_STORAGE_SLOT) == address(this) ||
            _readGuardSlot(safe, _MODULE_GUARD_STORAGE_SLOT) == address(this);
    }

    /// @dev `address(0)` when `safe` does not answer `getStorageAt` as a Safe would.
    function _readGuardSlot(address safe, bytes32 slot) private view returns (address guard) {
        (bool success, bytes memory returnData) = safe.staticcall(
            abi.encodeCall(ISafe.getStorageAt, (uint256(slot), 1))
        );
        if (!success || returnData.length < 96) {
            return address(0);
        }
        assembly ("memory-safe") {
            guard := and(mload(add(returnData, 0x60)), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    // =============================================================================================
    // Freeze (SPEC.md §7.1)
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}.
    function freeze(address[] calldata safes) external onlyDelegated {
        for (uint256 i = 0; i < safes.length; i++) {
            address safe = safes[i];
            require(_hasRole[safe][FreezeRole.GUARDIAN][msg.sender], IPolicyEngineV2.NotGuardian(safe));
            FreezeState storage state = _freezes[safe][Scope.ANY];
            if (block.timestamp < state.frozenUntil) {
                emit IPolicyEngineV2.FreezeSkipped(safe, msg.sender, state.frozenUntil);
            } else if (block.timestamp < state.cooldownUntil) {
                emit IPolicyEngineV2.FreezeSkipped(safe, msg.sender, state.cooldownUntil);
            } else {
                _startFreeze(safe, Scope.ANY, state);
            }
        }
    }

    /// @notice See {IPolicyEngineV2}.
    function freezeActor(address safe, address actor) external onlyDelegated {
        require(_hasRole[safe][FreezeRole.GUARDIAN][msg.sender], IPolicyEngineV2.NotGuardian(safe));
        require(actor != Scope.ANY && actor != Scope.OWNERS, IPolicyEngineV2.InvalidActor(actor));
        FreezeState storage state = _freezes[safe][actor];
        require(block.timestamp >= state.frozenUntil, IPolicyEngineV2.AlreadyFrozen(safe, actor, state.frozenUntil));
        require(
            block.timestamp >= state.cooldownUntil,
            IPolicyEngineV2.FreezeCooldown(safe, actor, state.cooldownUntil)
        );
        _startFreeze(safe, actor, state);
    }

    /// @notice See {IPolicyEngineV2}.
    function lift(address safe, address actor) external onlyDelegated {
        require(
            _hasRole[safe][FreezeRole.GUARDIAN][msg.sender] || _hasRole[safe][FreezeRole.LIFTER][msg.sender],
            IPolicyEngineV2.NotGuardianOrLifter(safe)
        );
        FreezeState storage state = _freezes[safe][actor];
        require(block.timestamp < state.frozenUntil, IPolicyEngineV2.NotFrozen(safe, actor));
        uint64 cooldownUntil = uint64(block.timestamp + _FREEZE_COOLDOWN);
        state.frozenUntil = uint64(block.timestamp);
        state.cooldownUntil = cooldownUntil;
        emit IPolicyEngineV2.Unfrozen(safe, actor, msg.sender, cooldownUntil);
    }

    function _startFreeze(address safe, address actor, FreezeState storage state) private {
        uint64 until = uint64(block.timestamp + _MAX_FREEZE);
        uint64 epoch = state.epoch + 1;
        state.frozenAt = uint64(block.timestamp);
        state.frozenUntil = until;
        state.cooldownUntil = uint64(block.timestamp + _MAX_FREEZE + _FREEZE_COOLDOWN);
        state.epoch = epoch;
        emit IPolicyEngineV2.Frozen(safe, actor, msg.sender, until, epoch);
    }

    // =============================================================================================
    // Enumeration views (off the hot path)
    // =============================================================================================

    /// @notice See {IPolicyEngineV2}; reached through the guard by a static self-call.
    function getScopes(
        address safe
    ) external view onlyDelegatedView returns (bytes32[] memory keys, ScopeData[] memory scopes) {
        keys = _scopeKeys[safe];
        scopes = new ScopeData[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            scopes[i] = _scopeData(safe, keys[i]);
        }
    }

    /// @notice See {IPolicyEngineV2}; reached through the guard by a static self-call.
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

    /// @notice See {IPolicyEngineV2}; reached through the guard by a static self-call.
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

    /// @notice See {IPolicyEngineV2}; reached through the guard by a static self-call.
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


    /// @notice See {IPolicyEngineV2}; reached through the guard by a static self-call.
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
            (perCall[i], keys[i]) = _match(safe, actor, calls[i].to, selectors[i], effOp);
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
