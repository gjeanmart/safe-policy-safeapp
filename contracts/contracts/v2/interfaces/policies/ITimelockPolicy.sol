// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../../vendor/policy-engine/interfaces/Operation.sol";

/**
 * @title TimelockPolicy (transaction level)
 * @notice A transaction matched by a Timelock attachment runs only if it was scheduled at least
 *         `delay` before (longest delay of the matched attachments). Schedules are proofs pushed
 *         by direct calls, keyed `(engine, safe, txHash)`, consumed by the check. SPEC.md §8.2.
 */
interface ITimelockPolicy {
    /**
     * @notice Settings of one attachment: `abi.encode(Settings)`.
     * @custom:member delay Seconds between schedule and execution (> 0). Returned as `delayFloor`.
     * @custom:member window Seconds the matured schedule stays executable; 0 = no expiry.
     * @custom:member clearOnFreeze Schedules made before or during a freeze affecting the actor are void.
     * @custom:member cancellers Addresses that may cancel a schedule this attachment matched (e.g.
     *                another Safe), in addition to the owners on the owners' queue. ≤ 8.
     */
    struct Settings {
        uint32 delay;
        uint32 window;
        bool clearOnFreeze;
        address[] cancellers;
    }

    /**
     * @notice A queued transaction.
     * @custom:member readyAt Informational: `scheduledAt` + the longest delay matched at schedule
     *                time. The check recomputes the delay from the attachments matched at execution.
     * @custom:member epoch `IPolicyEngineV2.freezeStatus(safe, actor).epoch` at schedule time.
     * @custom:member frozenAtSchedule A freeze affecting the actor was active at schedule time.
     */
    struct Schedule {
        address actor;
        uint64 scheduledAt;
        uint64 readyAt;
        uint64 epoch;
        bool frozenAtSchedule;
    }

    /// @notice A Safe transaction as hashed by `ISafe.getTransactionHash`.
    struct SafeTransaction {
        address to;
        uint256 value;
        bytes data;
        Operation operation;
        uint256 safeTxGas;
        uint256 baseGas;
        uint256 gasPrice;
        address gasToken;
        address refundReceiver;
        uint256 nonce;
    }

    /// @notice Carries the full call so off-chain alerts and the app queue need nothing else.
    event Scheduled(
        address indexed engine,
        address indexed safe,
        bytes32 indexed txHash,
        address actor,
        address to,
        uint256 value,
        bytes data,
        Operation operation,
        uint256 nonce,
        uint256 readyAt
    );

    /// @notice `cancelCount` is the owners' consecutive-cancel count after this cancel (0 for a canceller).
    event Cancelled(
        address indexed engine,
        address indexed safe,
        bytes32 indexed txHash,
        address by,
        uint256 cancelCount
    );

    /// @notice The schedule was consumed by a passing check.
    event Executed(address indexed engine, address indexed safe, bytes32 indexed txHash);

    error InvalidSettings();
    /// @notice A schedule for a transaction that no Timelock attachment of this policy matches.
    error NoTimelock(bytes32 txHash);
    error AlreadyScheduled(bytes32 txHash);
    error NotScheduled(bytes32 txHash);
    error NotReady(bytes32 txHash, uint256 readyAt);
    error ScheduleExpired(bytes32 txHash, uint256 expiredAt);
    error ClearedByFreeze(bytes32 txHash);
    error NotCanceller(address account);
    error NotOwnersQueue(bytes32 txHash);
    /// @notice The owner-path schedule names a nonce already used.
    error StaleNonce(uint256 nonce, uint256 current);

    /**
     * @notice Owners schedule a Safe transaction with the same signatures they will execute it with:
     *         `ISafe.checkNSignatures(address(0), txHash, signatures, threshold)`.
     *         Not a Safe transaction (it would wait for its own timelock). Anyone may relay.
     *         `safeTxGas` and `gasPrice` must be 0, as the engine requires at execution
     *         (`IPolicyEngineV2.NonZeroSafeTxGas` / `NonZeroGasPrice`).
     * @dev Both schedule functions revert `NoTimelock` unless a Timelock attachment of this policy
     *      matches the transaction, and `AlreadyScheduled` if one exists that is neither expired
     *      (window passed under the current settings) nor voided by a freeze; those are replaced.
     * @return txHash The Safe transaction hash (binds the nonce: the schedule dies when the nonce moves).
     */
    function scheduleOwnerTx(
        address engine,
        address safe,
        SafeTransaction calldata safeTx,
        bytes calldata signatures
    ) external returns (bytes32 txHash);

    /**
     * @notice A module (`msg.sender` is the actor) schedules its own call.
     * @return txHash `Scope.moduleCallHash(safe, msg.sender, to, value, data, operation)`.
     */
    function scheduleModuleTx(
        address engine,
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bytes32 txHash);

    /**
     * @notice Owners cancel an owners'-queue schedule with a rising threshold:
     *         `min(cancelCount + 1, threshold)` signatures over `cancelDigest(engine, safe, txHash)`,
     *         checked with `ISafe.checkNSignatures(address(0), ...)`. Each cancel increments
     *         `cancelCount`; a consumed owners' schedule resets it to 0.
     */
    function cancelAsOwners(address engine, address safe, bytes32 txHash, bytes calldata signatures) external;

    /// @notice A canceller listed (at schedule time) by an attachment the transaction matched, or the
    ///         module that scheduled it, cancels it.
    function cancel(address engine, address safe, bytes32 txHash) external;

    function getSchedule(address engine, address safe, bytes32 txHash) external view returns (Schedule memory);

    function getCancellers(address engine, address safe, bytes32 txHash) external view returns (address[] memory);

    function cancelCount(address engine, address safe) external view returns (uint256);

    function requiredCancelSignatures(address engine, address safe) external view returns (uint256);

    /**
     * @notice EIP-712 digest owners sign to cancel: domain `("TimelockPolicy", "1", chainid, this)`,
     *         `Cancel(address engine,address safe,bytes32 txHash,uint256 cancelCount)`.
     */
    function cancelDigest(address engine, address safe, bytes32 txHash) external view returns (bytes32);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    /**
     * @notice When the attachment's settings were last configured. A transaction it matches is
     *         ready `delay` after the later of its schedule and the latest `configuredAt` of the
     *         Timelock attachments it matches (SPEC.md §8.2).
     */
    function configuredAt(address engine, address safe, bytes32 attachmentId) external view returns (uint256);

    /// @notice `abi.encode(settings)`; exists so the ABI carries the settings type.
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
