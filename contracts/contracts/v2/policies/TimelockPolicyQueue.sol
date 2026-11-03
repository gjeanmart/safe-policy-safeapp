// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {ScopeLib} from "../libraries/Scope.sol";
import {Kind, MatchView} from "../libraries/Types.sol";

/**
 * @title TimelockPolicy storage
 * @notice The storage layout and helpers shared by {TimelockPolicy} and {TimelockPolicyQueue}
 *         (reached by DELEGATECALL on the policy's storage). Both inherit exactly this state.
 */
abstract contract TimelockPolicyStorage {
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("TimelockPolicy");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _CANCEL_TYPEHASH =
        keccak256("Cancel(address engine,address safe,bytes32 txHash,uint64 scheduledAt)");

    /// @dev Settings, `configuredAt` and the freeze state share one slot: the check reads one word per id.
    struct Attachment {
        uint32 delay;
        uint32 window;
        uint64 configuredAt;
        uint64 frozenUntil;
        uint64 cooldownUntil;
        address[] guardians;
        address[] lifters;
        address[] cancellers;
    }

    /// @dev The merge over a transaction's ids: max delay, min non-zero window, latest
    ///      configuration, latest freeze end (and its id).
    struct Merged {
        uint256 delay;
        uint256 window;
        uint256 configuredAt;
        uint256 frozenUntil;
        bytes32 frozenId;
    }

    mapping(bytes32 settingsKey => Attachment) internal _attachments;

    mapping(address engine => mapping(address safe => mapping(bytes32 txHash => ITimelockPolicy.Schedule)))
        internal _schedules;

    /// @dev `PolicyBase._settingsKey`.
    function _keyOf(address engine, address safe, bytes32 attachmentId) internal pure returns (bytes32) {
        return keccak256(abi.encode(engine, safe, attachmentId));
    }

    /// @dev Folds one id into `m`; with `denyFrozen`, reverts `AttachmentFrozen` on a frozen id.
    function _merge(Merged memory m, address engine, address safe, bytes32 id, bool denyFrozen) internal view {
        Attachment storage a = _attachments[_keyOf(engine, safe, id)];
        (uint256 delay, uint256 window, uint256 configured, uint64 frozenUntil) = (
            a.delay,
            a.window,
            a.configuredAt,
            a.frozenUntil
        );
        require(!denyFrozen || block.timestamp >= frozenUntil, ITimelockPolicy.AttachmentFrozen(id, frozenUntil));
        if (delay > m.delay) m.delay = delay;
        if (window != 0 && (m.window == 0 || window < m.window)) m.window = window;
        if (configured > m.configuredAt) m.configuredAt = configured;
        if (frozenUntil > m.frozenUntil) (m.frozenUntil, m.frozenId) = (frozenUntil, id);
    }

    function _contains(address[] storage list, address account) internal view returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == account) return true;
        }
        return false;
    }

    /// @dev See {ITimelockPolicy-cancelDigest}; `address(this)` is the policy, also under DELEGATECALL.
    function _cancelDigest(address engine, address safe, bytes32 txHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(
            abi.encode(_CANCEL_TYPEHASH, engine, safe, txHash, _schedules[engine][safe][txHash].scheduledAt)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}

/**
 * @title TimelockPolicy: scheduling and cancelling
 * @notice Not a policy of its own: deployed first, passed to the {TimelockPolicy} constructor and reached by DELEGATECALL, so
 *         it runs on the policy's storage at the policy's address. Split out to keep each contract
 *         under 10,000 bytes. Behaviour: {ITimelockPolicy}.
 */
contract TimelockPolicyQueue is TimelockPolicyStorage {
    address private immutable _SELF = address(this);

    /// @notice Called directly instead of through {TimelockPolicy}.
    error NotDelegated();

    /// @dev A direct call would act on this contract's own, unused storage.
    modifier onlyDelegated() {
        require(address(this) != _SELF, NotDelegated());
        _;
    }

    /// @notice See {ITimelockPolicy-schedule}.
    function schedule(
        address engine,
        address safe,
        ITimelockPolicy.SafeTransaction calldata t,
        bytes calldata signatures
    ) external onlyDelegated returns (bytes32 txHash) {
        require(t.safeTxGas == 0 && t.gasPrice == 0, ITimelockPolicy.GasFieldsNotZero());
        txHash = ISafe(safe).getTransactionHash(
            t.to,
            t.value,
            t.data,
            t.operation,
            0,
            t.baseGas,
            0,
            t.gasToken,
            t.refundReceiver,
            t.nonce
        );
        uint256 current = ISafe(safe).nonce();
        require(t.nonce >= current, ITimelockPolicy.StaleNonce(t.nonce, current));
        ISafe(safe).checkNSignatures(msg.sender, txHash, signatures, ISafe(safe).getThreshold());
        _schedule(engine, safe, ScopeLib.OWNERS, txHash, t.to, t.value, t.data, t.operation, t.nonce);
    }

    /// @notice See {ITimelockPolicy-scheduleModuleTx}.
    function scheduleModuleTx(
        address engine,
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external onlyDelegated returns (bytes32 txHash) {
        txHash = ScopeLib.moduleCallHash(safe, msg.sender, to, value, data, operation);
        _schedule(engine, safe, msg.sender, txHash, to, value, data, operation, 0);
    }

    /// @notice See {ITimelockPolicy-cancel}.
    function cancel(address engine, address safe, bytes32 txHash) external onlyDelegated {
        ITimelockPolicy.Schedule storage s = _schedules[engine][safe][txHash];
        require(s.scheduledAt != 0, ITimelockPolicy.NotScheduled(txHash));
        // The owners' actor (address 1) is never a caller.
        bool allowed = s.actor == msg.sender;
        bytes32[] storage ids = s.attachmentIds;
        for (uint256 i = 0; i < ids.length && !allowed; i++) {
            allowed = _contains(_attachments[_keyOf(engine, safe, ids[i])].cancellers, msg.sender);
        }
        require(allowed, ITimelockPolicy.NotCanceller(msg.sender));
        delete _schedules[engine][safe][txHash];
        emit ITimelockPolicy.Cancelled(engine, safe, txHash, msg.sender);
    }

    /// @notice See {ITimelockPolicy-cancelAsOwners}.
    function cancelAsOwners(
        address engine,
        address safe,
        bytes32 txHash,
        bytes calldata signatures
    ) external onlyDelegated {
        ITimelockPolicy.Schedule storage s = _schedules[engine][safe][txHash];
        require(s.scheduledAt != 0, ITimelockPolicy.NotScheduled(txHash));
        require(s.actor == ScopeLib.OWNERS, ITimelockPolicy.NotOwnersQueue(txHash));
        ISafe(safe).checkNSignatures(
            msg.sender,
            _cancelDigest(engine, safe, txHash),
            signatures,
            ISafe(safe).getThreshold()
        );
        delete _schedules[engine][safe][txHash];
        emit ITimelockPolicy.Cancelled(engine, safe, txHash, safe);
    }

    /**
     * @dev Stores the schedule with this policy's ids the engine matches now (deduplicated). An
     *      existing schedule is replaced only when it could never pass again under the current
     *      settings: expired, or voided by a freeze (a module-path hash has no nonce, so it would
     *      otherwise block the same call forever).
     */
    function _schedule(
        address engine,
        address safe,
        address actor,
        bytes32 txHash,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 nonce
    ) private {
        (, MatchView[] memory found, ) = IPolicyGuard(engine).matches(safe, actor, to, value, data, operation);
        bytes32[] memory ids = new bytes32[](found.length);
        uint256 n;
        Merged memory m;
        for (uint256 i = 0; i < found.length; i++) {
            // `address(this)` is the policy: this code only runs under its DELEGATECALL.
            if (found[i].kind != Kind.POLICY || found[i].policy != address(this)) continue;
            bytes32 id = found[i].attachmentId;
            bool seen;
            for (uint256 j = 0; j < n && !seen; j++) seen = ids[j] == id;
            if (seen) continue;
            ids[n++] = id;
            _merge(m, engine, safe, id, false);
        }
        require(n != 0, ITimelockPolicy.NoTimelock(txHash));
        assembly ("memory-safe") {
            mstore(ids, n)
        }

        ITimelockPolicy.Schedule storage s = _schedules[engine][safe][txHash];
        uint256 scheduledAt = s.scheduledAt;
        if (scheduledAt != 0) {
            uint256 end = (scheduledAt > m.configuredAt ? scheduledAt : m.configuredAt) + m.delay + m.window;
            require(
                (m.window != 0 && block.timestamp > end) || (!s.isConfiguration && scheduledAt < m.frozenUntil),
                ITimelockPolicy.AlreadyScheduled(txHash)
            );
        }
        bool isConfiguration = operation == Operation.CALL &&
            to == engine &&
            data.length >= 4 &&
            bytes4(data[:4]) == IPolicyGuard.configure.selector;
        (s.actor, s.scheduledAt, s.isConfiguration, s.attachmentIds) = (
            actor,
            uint64(block.timestamp),
            isConfiguration,
            ids
        );
        emit ITimelockPolicy.Scheduled(
            engine,
            safe,
            txHash,
            actor,
            to,
            value,
            data,
            operation,
            nonce,
            block.timestamp + m.delay,
            isConfiguration
        );
    }
}
