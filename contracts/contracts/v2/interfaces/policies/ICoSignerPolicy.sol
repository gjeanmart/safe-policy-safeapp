// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {IPolicy} from "../IPolicy.sol";

/**
 * @title CoSignerPolicy: M-of-N on-chain approvals, both paths
 * @notice A matched transaction needs `required` approvals from the attachment's approvers,
 *         pushed on-chain before execution and keyed by `ctx.txHash` (owner path: the Safe
 *         transaction hash; module path: the module call hash). An approver approves directly
 *         ({approve}) or signs, and anyone pushes the signature ({approveWithSig}), so a co-signer
 *         service need not pay gas. 1-of-1 is the classic co-signer. SPEC.md §5.4.
 * @dev Settings: `abi.encode(Settings)`, keyed `(engine, safe, attachmentId)`.
 *
 *      Approvals are stored per `(engine, safe, txHash, useCount, approver)` with a `validUntil`;
 *      they count while `block.timestamp <= validUntil`. Anyone may approve: only the approvers
 *      listed in a matched attachment count.
 *
 *      Merge rule: every matched attachment must find `required` unexpired approvals among its own
 *      approvers (AND); one approval counts for every attachment that lists the approver. On pass,
 *      `useCount(engine, safe, txHash)` increments: every approval of that transaction is consumed
 *      at once, and the next execution of the same module call needs new approvals.
 *
 *      Sees: `ctx.txHash` only. The approver reviews the transaction off-chain; the policy cannot
 *      see what was reviewed beyond the hash.
 */
interface ICoSignerPolicy is IPolicy {
    /**
     * @custom:member approvers 1 to `MAX_ROLE_MEMBERS`, non-zero, no duplicate, never the Safe.
     *                EOAs (ECDSA) or contracts (ERC-1271) for {approveWithSig}.
     * @custom:member required 1 to `approvers.length`.
     */
    struct Settings {
        address[] approvers;
        uint8 required;
    }

    event Approved(
        address indexed engine,
        address indexed safe,
        bytes32 indexed txHash,
        address approver,
        uint64 validUntil
    );

    event Revoked(address indexed engine, address indexed safe, bytes32 indexed txHash, address approver);

    /// @notice A passing check consumed the approvals of `txHash`; `useCount` is the new count.
    event Consumed(address indexed engine, address indexed safe, bytes32 indexed txHash, uint256 useCount);

    error InvalidSettings();
    /// @notice An approval whose `validUntil` is already in the past.
    error ApprovalExpired(uint64 validUntil);
    /// @notice {approveWithSig}: not a valid ECDSA signature by `approver` (EOA) or ERC-1271
    ///         approval (contract) of {approvalDigest}.
    error InvalidSignature(address approver);
    /// @notice {approveWithSig}: this digest was already pushed (so a revoked approval cannot be
    ///         restored by replaying its signature).
    error SignatureAlreadyUsed(bytes32 digest);
    /// @notice Check: `attachmentId` has `have` valid approvals of `required`.
    error MissingApprovals(bytes32 attachmentId, uint8 required, uint8 have);

    /**
     * @notice Records `msg.sender`'s approval of `txHash` until `validUntil`. Who: an approver
     *         (anyone may call; only listed approvers count). Overwrites an earlier approval of the
     *         same use. Reverts `ApprovalExpired` if `validUntil < block.timestamp`.
     */
    function approve(address engine, address safe, bytes32 txHash, uint64 validUntil) external;

    /**
     * @notice Records `approver`'s approval from its signature over
     *         {approvalDigest}`(engine, safe, txHash, validUntil)`. Who: anyone (a relayer).
     *         ECDSA when `approver` has no code, else ERC-1271 `isValidSignature`.
     *         Reverts `ApprovalExpired`, `InvalidSignature`, `SignatureAlreadyUsed`.
     */
    function approveWithSig(
        address engine,
        address safe,
        bytes32 txHash,
        address approver,
        uint64 validUntil,
        bytes calldata signature
    ) external;

    /// @notice Removes `msg.sender`'s approval of the current use of `txHash`. Who: the approver.
    function revoke(address engine, address safe, bytes32 txHash) external;

    /**
     * @notice EIP-712 digest an approver signs: domain `("CoSignerPolicy", "1", chainid, this)`,
     *         `Approval(address engine,address safe,bytes32 txHash,uint256 useCount,uint64 validUntil)`
     *         with the current {useCount}.
     */
    function approvalDigest(
        address engine,
        address safe,
        bytes32 txHash,
        uint64 validUntil
    ) external view returns (bytes32);

    /// @notice How many times approvals of `txHash` were consumed.
    function useCount(address engine, address safe, bytes32 txHash) external view returns (uint256);

    /// @notice `approver`'s approval of the current use of `txHash`: its `validUntil`, 0 if none.
    function approvedUntil(
        address engine,
        address safe,
        bytes32 txHash,
        address approver
    ) external view returns (uint64);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    /// @notice `abi.encode(settings)`; exists so the ABI carries the settings type.
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
