// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {IPolicy} from "../IPolicy.sol";
import {FROST} from "../../libraries/frost/FROST.sol";
import {Secp256k1} from "../../libraries/frost/Secp256k1.sol";

/**
 * @title SafenetPolicy (optional, wave 2): one Safenet FROST attestation per transaction
 * @notice Port of V1 `SafenetPolicy` (8ee68a8) with every attestation pushed on-chain before
 *         execution, on both paths. SPEC.md §5.5.
 * @dev Settings: none (`settings` must be empty, `InvalidSettings`).
 *
 *      Merge rule: one credit of `ctx.txHash` per Safe transaction, however many attachments
 *      matched; the check consumes it (`MissingAttestation` / `AttestationExpired`).
 *
 *      The trusted `(group key, epoch)` set is global to the contract (as V1): seeded at
 *      construction, extended by the permissionless {updateEpoch}.
 */
interface ISafenetPolicy is IPolicy {
    event Attested(address indexed engine, address indexed safe, bytes32 indexed txHash, uint256 deadline);

    error InvalidSettings();
    /// @notice Constructor: zero Consensus address.
    error InvalidAddress();
    error MissingAttestation();
    error MalformedAttestation();
    error UntrustedAttestationKey();
    /// @notice The attestation (by its FROST signature) was already submitted.
    error AttestationAlreadySpent();
    /// @notice Submitted or consumed after its `deadline`.
    error AttestationExpired(uint256 deadline);

    /**
     * @notice Credits one execution of `txHash`. Who: anyone (the signature authorises it).
     * @param deadline 0: owner path, `attestation` is over `txHash` itself (the Safe transaction
     *        hash, nonce-bound), no expiry. Non-zero: module path, `attestation` is over
     *        {attestationDigest}`(engine, safe, txHash, deadline)` and the credit expires after
     *        `deadline` (several credits of one hash share the earliest deadline).
     * @param attestation V1's 256-byte encoding:
     *        `abi.encode(uint64 epoch, address oracle, bytes32 oracleDataHash, Point groupKey, Signature)`.
     */
    function submitAttestation(
        address engine,
        address safe,
        bytes32 txHash,
        uint256 deadline,
        bytes calldata attestation
    ) external;

    /// @notice Whether an unexpired credit exists for `txHash`.
    function isAttested(address engine, address safe, bytes32 txHash) external view returns (bool);

    /**
     * @notice Module-path stand-in for the Safe transaction hash: domain `("SafenetPolicy", "1",
     *         chainid, this)`, `ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 deadline)`.
     */
    function attestationDigest(
        address engine,
        address safe,
        bytes32 txHash,
        uint256 deadline
    ) external view returns (bytes32);

    /// @notice Records a new trusted `(group key, epoch)` from a rollover signed by a trusted
    ///         group (as V1). Who: anyone.
    function updateEpoch(
        Secp256k1.Point calldata parentKey,
        uint64 parentEpoch,
        uint64 proposedEpoch,
        uint64 rolloverBlock,
        Secp256k1.Point calldata newGroupKey,
        FROST.Signature calldata signature
    ) external;

    function isKnownEpoch(Secp256k1.Point calldata groupKey, uint64 epoch) external view returns (bool);

    function getConsensusDomainSeparator() external view returns (bytes32);

    function isAttestationSpent(FROST.Signature calldata signature) external view returns (bool);
}
