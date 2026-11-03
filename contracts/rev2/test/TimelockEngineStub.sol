// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {MultiSendDecoder} from "../libraries/MultiSendDecoder.sol";
import {Scope} from "../libraries/Scope.sol";
import {
    AttachmentKind,
    AttachmentView,
    Call,
    Context,
    FreezeRole,
    FreezeState,
    MatchView,
    PolicyLevel,
    ScopeData
} from "../libraries/Types.sol";

/**
 * @title Timelock engine stub
 * @notice Test double for the V2 engine, written for the Timelock / Freeze unit tests (WP3) while
 *         the real engine (WP2) is built in parallel. It implements only what those policies use,
 *         with the signatures of `IPolicyEngineV2` and the Safe 1.5.0 guard hooks, and calls the
 *         policies the way the engine does (`msg.sender` = engine).
 * @dev Simplifications, all on purpose: attachments are configured instantly (`attach` /
 *      `detach`, no delay, no ALLOW/DENY built-ins, no grant check); the hooks run only
 *      transaction-level policies, with no policy context; freeze roles are set directly.
 *      Matching (8 levels, op mask, one trusted batch decoded) and the freeze state machine follow
 *      SPEC.md §3, §6.2 and §7.1.
 */
contract TimelockEngineStub {
    struct Stored {
        ScopeData scope;
        bytes32 scopeKey;
        bytes32 id;
        address policy;
        uint8 opMask;
        PolicyLevel policyLevel;
    }

    // Same declarations as IPolicyEngineV2.
    error PolicyDenied(uint256 callIndex, address policy, bytes reason);
    error PolicyConfigurationFailed(address policy, bytes reason);
    error NotAttached(bytes32 attachmentId);
    error NotGuardian(address safe);
    error NotGuardianOrLifter(address safe);
    error AlreadyFrozen(address safe, address actor, uint256 until);
    error FreezeCooldown(address safe, address actor, uint256 until);
    error NotFrozen(address safe, address actor);
    error InvalidActor(address actor);
    error ExecutionFailed();
    error ModuleExecutionFailed();

    event Frozen(address indexed safe, address indexed actor, address indexed guardian, uint256 until, uint64 epoch);
    event Unfrozen(address indexed safe, address indexed actor, address indexed by, uint256 cooldownUntil);

    /// @notice Stub only: the delay floor a policy's `configure` returned.
    event Configured(address indexed safe, bytes32 indexed attachmentId, address policy, uint256 delayFloor);

    uint256 public immutable MAX_FREEZE;
    uint256 public immutable FREEZE_COOLDOWN;
    address public immutable TRUSTED_BATCH;

    mapping(address safe => Stored[]) private _attachments;
    mapping(address safe => mapping(address key => FreezeState)) private _freeze;
    mapping(address safe => mapping(FreezeRole role => mapping(address account => bool))) private _roles;

    constructor(uint256 maxFreeze, uint256 freezeCooldown, address trustedBatch) {
        MAX_FREEZE = maxFreeze;
        FREEZE_COOLDOWN = freezeCooldown;
        TRUSTED_BATCH = trustedBatch;
    }

    // =============================================================================================
    // Configuration (stub: instant, no authorization)
    // =============================================================================================

    /// @notice Attaches (or updates) `policy` at `scope` for `safe`, calling `configure` as the engine.
    function attachPolicy(
        address safe,
        ScopeData calldata scope,
        address policy,
        uint8 opMask,
        bytes calldata data
    ) external returns (bytes32 id) {
        bytes32 key = Scope.key(scope);
        id = Scope.attachmentId(key, AttachmentKind.POLICY, policy);
        opMask = Scope.normalizeOpMask(opMask);
        PolicyLevel level = IPolicyV2(policy).policyLevel();
        uint256 delayFloor;
        try IPolicyV2(policy).configure(safe, id, scope, opMask, data) returns (uint256 floor) {
            delayFloor = floor;
        } catch (bytes memory reason) {
            revert PolicyConfigurationFailed(policy, reason);
        }
        Stored[] storage list = _attachments[safe];
        (bool found, uint256 index) = _find(list, id);
        if (found) {
            list[index].opMask = opMask;
        } else {
            list.push(Stored(scope, key, id, policy, opMask, level));
        }
        emit Configured(safe, id, policy, delayFloor);
    }

    function detachPolicy(address safe, bytes32 id) external {
        Stored[] storage list = _attachments[safe];
        (bool found, uint256 index) = _find(list, id);
        require(found, NotAttached(id));
        list[index] = list[list.length - 1];
        list.pop();
    }

    /// @notice Stub only: sets a freeze role directly (the engine does it through configuration).
    function setRole(address safe, FreezeRole role, address account, bool enabled) external {
        _roles[safe][role][account] = enabled;
    }

    // =============================================================================================
    // Freeze (SPEC.md §7.1)
    // =============================================================================================

    function freeze(address[] calldata safes) external {
        for (uint256 i = 0; i < safes.length; i++) {
            require(_roles[safes[i]][FreezeRole.GUARDIAN][msg.sender], NotGuardian(safes[i]));
        }
        for (uint256 i = 0; i < safes.length; i++) {
            FreezeState storage f = _freeze[safes[i]][Scope.ANY];
            if (block.timestamp >= f.cooldownUntil) {
                _start(safes[i], Scope.ANY, f);
            }
        }
    }

    function freezeActor(address safe, address actor) external {
        require(_roles[safe][FreezeRole.GUARDIAN][msg.sender], NotGuardian(safe));
        require(actor != Scope.ANY && actor != Scope.OWNERS, InvalidActor(actor));
        FreezeState storage f = _freeze[safe][actor];
        require(block.timestamp >= f.frozenUntil, AlreadyFrozen(safe, actor, f.frozenUntil));
        require(block.timestamp >= f.cooldownUntil, FreezeCooldown(safe, actor, f.cooldownUntil));
        _start(safe, actor, f);
    }

    function lift(address safe, address actor) external {
        require(
            _roles[safe][FreezeRole.GUARDIAN][msg.sender] || _roles[safe][FreezeRole.LIFTER][msg.sender],
            NotGuardianOrLifter(safe)
        );
        FreezeState storage f = _freeze[safe][actor];
        require(block.timestamp < f.frozenUntil, NotFrozen(safe, actor));
        f.frozenUntil = uint64(block.timestamp);
        f.cooldownUntil = uint64(block.timestamp + FREEZE_COOLDOWN);
        emit Unfrozen(safe, actor, msg.sender, f.cooldownUntil);
    }

    function getFreezeState(address safe, address actor) external view returns (FreezeState memory) {
        return _freeze[safe][actor];
    }

    function freezeStatus(
        address safe,
        address actor
    ) external view returns (bool safeFrozen, bool actorFrozen, uint64 epoch) {
        FreezeState storage safeWide = _freeze[safe][Scope.ANY];
        safeFrozen = block.timestamp < safeWide.frozenUntil;
        epoch = safeWide.epoch;
        if (actor != Scope.ANY) {
            FreezeState storage own = _freeze[safe][actor];
            actorFrozen = block.timestamp < own.frozenUntil;
            epoch += own.epoch;
        }
    }

    function _start(address safe, address key, FreezeState storage f) private {
        f.frozenAt = uint64(block.timestamp);
        f.frozenUntil = uint64(block.timestamp + MAX_FREEZE);
        f.cooldownUntil = uint64(block.timestamp + MAX_FREEZE + FREEZE_COOLDOWN);
        f.epoch++;
        emit Frozen(safe, key, msg.sender, f.frozenUntil, f.epoch);
    }

    // =============================================================================================
    // Matching
    // =============================================================================================

    /// @notice As `IPolicyEngineV2.getMatchingAttachments` (built-ins aside: the stub has none).
    function getMatchingAttachments(
        address safe,
        address actor,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address policy
    ) public view returns (MatchView[] memory matches) {
        Call[] memory calls = _calls(safe, to, value, data, operation);
        Stored[] storage list = _attachments[safe];
        matches = new MatchView[](calls.length * list.length * Scope.LEVEL_COUNT);
        uint256 n;
        for (uint256 i = 0; i < calls.length; i++) {
            (, bytes4 selector) = Scope.selectorOf(calls[i].data);
            uint8 bit = Scope.opBit(calls[i].operation);
            for (uint8 lvl = 0; lvl < Scope.LEVEL_COUNT; lvl++) {
                bytes32 key = Scope.keyAt(lvl, actor, calls[i].to, selector);
                for (uint256 j = 0; j < list.length; j++) {
                    Stored storage a = list[j];
                    if (a.scopeKey != key || a.opMask & bit == 0) continue;
                    if (policy != address(0) && a.policy != policy) continue;
                    matches[n++] = MatchView(
                        uint16(i),
                        lvl,
                        AttachmentView(
                            a.id,
                            a.scopeKey,
                            a.scope,
                            AttachmentKind.POLICY,
                            a.policy,
                            a.opMask,
                            a.policyLevel
                        )
                    );
                }
            }
        }
        assembly ("memory-safe") {
            mstore(matches, n)
        }
    }

    function _calls(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) private view returns (Call[] memory calls) {
        if (operation == Operation.DELEGATECALL && to == TRUSTED_BATCH && to != address(0)) {
            (bool ok, , Call[] memory decoded) = MultiSendDecoder.decode(safe, data);
            return ok ? decoded : new Call[](0);
        }
        calls = new Call[](1);
        calls[0] = Call(to, value, data, operation);
    }

    // =============================================================================================
    // Guard hooks (Safe 1.5.0 signatures)
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
        bytes calldata signatures,
        address msgSender
    ) external {
        uint256 nonce = ISafe(msg.sender).nonce() - 1;
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
            nonce
        );
        _evaluate(Context(msg.sender, Scope.OWNERS, txHash, nonce, msgSender), to, value, data, operation, signatures);
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
        moduleTxHash = Scope.moduleCallHash(msg.sender, module, to, value, data, operation);
        _evaluate(Context(msg.sender, module, moduleTxHash, 0, module), to, value, data, operation, "");
    }

    function checkAfterModuleExecution(bytes32, bool success) external pure {
        require(success, ModuleExecutionFailed());
    }

    /// @notice Stub only: calls `policy.checkTransaction` as the engine with arbitrary inputs and
    ///         bubbles the raw result (for testing the policy's own input checks).
    function callCheckTransaction(
        address policy,
        Context calldata ctx,
        Call[] calldata calls,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4) {
        return IPolicyV2(policy).checkTransaction(ctx, calls, "", "", attachmentIds);
    }

    /// @notice Stub only: calls `policy.checkCall` as the engine (bubbles the raw result).
    function callCheckCall(
        address policy,
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4) {
        return IPolicyV2(policy).checkCall(ctx, call, attachmentIds);
    }

    /// @dev Transaction-level part of SPEC.md §6.2: one run per distinct policy, with its ids
    ///      deduplicated in first-match order; any non-PASS is `PolicyDenied(TX_INDEX, ...)`.
    function _evaluate(
        Context memory ctx,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        bytes memory signatures
    ) private {
        MatchView[] memory matches = getMatchingAttachments(
            ctx.safe,
            ctx.actor,
            to,
            value,
            data,
            operation,
            address(0)
        );
        Call[] memory calls = _calls(ctx.safe, to, value, data, operation);
        for (uint256 i = 0; i < matches.length; i++) {
            AttachmentView memory a = matches[i].attachment;
            if (a.policyLevel != PolicyLevel.TRANSACTION || _seenPolicy(matches, i)) continue;
            bytes32[] memory ids = _idsOf(matches, i);
            (bool ok, bytes memory ret) = a.policy.call(
                abi.encodeCall(IPolicyV2.checkTransaction, (ctx, calls, signatures, "", ids))
            );
            if (!ok) revert PolicyDenied(Scope.TX_INDEX, a.policy, ret);
            if (ret.length != 32 || bytes32(ret) != bytes32(IPolicyV2.checkTransaction.selector)) {
                revert PolicyDenied(Scope.TX_INDEX, a.policy, "");
            }
        }
    }

    function _seenPolicy(MatchView[] memory matches, uint256 i) private pure returns (bool) {
        for (uint256 k = 0; k < i; k++) {
            if (matches[k].attachment.policy == matches[i].attachment.policy) return true;
        }
        return false;
    }

    function _idsOf(MatchView[] memory matches, uint256 first) private pure returns (bytes32[] memory ids) {
        ids = new bytes32[](matches.length);
        uint256 n;
        address policy = matches[first].attachment.policy;
        for (uint256 k = first; k < matches.length; k++) {
            if (matches[k].attachment.policy != policy) continue;
            bytes32 id = matches[k].attachment.attachmentId;
            bool dup;
            for (uint256 m = 0; m < n && !dup; m++) dup = ids[m] == id;
            if (!dup) ids[n++] = id;
        }
        assembly ("memory-safe") {
            mstore(ids, n)
        }
    }

    function _find(Stored[] storage list, bytes32 id) private view returns (bool, uint256) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].id == id) return (true, i);
        }
        return (false, 0);
    }
}

/**
 * @title Timelock mock Safe
 * @notice Minimal Safe 1.5.0 double for the Timelock / Freeze tests: real transaction hash and
 *         ECDSA / eth_sign / approved-by-executor `checkNSignatures`, nonce, owners, modules, and
 *         the guard and module-guard hooks around a real CALL. DELEGATECALL is checked but not
 *         executed. Admin functions are self-calls, as in Safe.
 */
contract TimelockMockSafe {
    bytes32 private constant _DOMAIN_SEPARATOR_TYPEHASH =
        0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;
    bytes32 private constant _SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;

    error InvalidSignatures();
    error NotSelf();
    error ModuleNotEnabled(address module);
    error CallFailed();

    TimelockEngineStub public guard;
    uint256 public nonce;
    uint256 private _threshold;
    address[] private _owners;
    mapping(address => bool) public isOwner;
    mapping(address => bool) public isModuleEnabled;

    constructor(address[] memory owners, uint256 threshold, TimelockEngineStub guard_, address[] memory modules) {
        for (uint256 i = 0; i < owners.length; i++) {
            isOwner[owners[i]] = true;
        }
        for (uint256 i = 0; i < modules.length; i++) {
            isModuleEnabled[modules[i]] = true;
        }
        _owners = owners;
        _threshold = threshold;
        guard = guard_;
    }

    receive() external payable {}

    modifier onlySelf() {
        require(msg.sender == address(this), NotSelf());
        _;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
    }

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce_
    ) public view returns (bytes32) {
        bytes32 safeTxHash = keccak256(
            abi.encode(
                _SAFE_TX_TYPEHASH,
                to,
                value,
                keccak256(data),
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                nonce_
            )
        );
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeTxHash));
    }

    /// @dev `v == 1`: accepted from the executor only (no approved-hash storage); `v > 30`: eth_sign.
    function checkNSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 requiredSignatures
    ) public view {
        require(requiredSignatures != 0 && signatures.length >= requiredSignatures * 65, InvalidSignatures());
        address last;
        for (uint256 i = 0; i < requiredSignatures; i++) {
            uint8 v;
            bytes32 r;
            bytes32 s;
            assembly ("memory-safe") {
                let pos := add(add(signatures, 0x20), mul(i, 65))
                r := mload(pos)
                s := mload(add(pos, 0x20))
                v := byte(0, mload(add(pos, 0x40)))
            }
            address owner;
            if (v == 1) {
                owner = address(uint160(uint256(r)));
                require(owner == executor, InvalidSignatures());
            } else if (v > 30) {
                owner = ecrecover(
                    keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash)),
                    v - 4,
                    r,
                    s
                );
            } else {
                owner = ecrecover(dataHash, v, r, s);
            }
            require(owner > last && isOwner[owner], InvalidSignatures());
            last = owner;
        }
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        bytes calldata signatures
    ) external returns (bool) {
        bytes32 txHash = getTransactionHash(to, value, data, operation, 0, 0, 0, address(0), address(0), nonce);
        nonce++;
        checkNSignatures(msg.sender, txHash, signatures, _threshold);
        if (address(guard) != address(0)) {
            guard.checkTransaction(
                to,
                value,
                data,
                operation,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                signatures,
                msg.sender
            );
        }
        bool success = _execute(to, value, data, operation);
        if (address(guard) != address(0)) guard.checkAfterExecution(txHash, success);
        require(success, CallFailed());
        return true;
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success) {
        require(isModuleEnabled[msg.sender], ModuleNotEnabled(msg.sender));
        bytes32 hash;
        if (address(guard) != address(0)) hash = guard.checkModuleTransaction(to, value, data, operation, msg.sender);
        success = _execute(to, value, data, operation);
        if (address(guard) != address(0)) guard.checkAfterModuleExecution(hash, success);
    }

    /// @dev Simplified: replaces `oldOwner` in place (`prevOwner` is ignored).
    function swapOwner(address, address oldOwner, address newOwner) external onlySelf {
        require(isOwner[oldOwner] && !isOwner[newOwner] && newOwner != address(0), CallFailed());
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == oldOwner) _owners[i] = newOwner;
        }
        isOwner[oldOwner] = false;
        isOwner[newOwner] = true;
    }

    function enableModule(address module) external onlySelf {
        isModuleEnabled[module] = true;
    }

    function disableModule(address, address module) external onlySelf {
        isModuleEnabled[module] = false;
    }

    function _execute(address to, uint256 value, bytes calldata data, Operation operation) private returns (bool) {
        if (operation == Operation.DELEGATECALL) return true;
        (bool success, ) = to.call{value: value}(data);
        return success;
    }
}
