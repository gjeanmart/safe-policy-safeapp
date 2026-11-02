// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title SafenetPolicyV2 (transaction level)
 * @notice One Safenet FROST attestation per transaction (port of V1 `SafenetPolicy`, 8ee68a8).
 *         Owner path: the 256-byte attestation in the policy context, over the Safe transaction
 *         hash (as V1). Module path: pushed with {submitAttestation}, over `moduleTxDigest`,
 *         consumed by the check. No per-attachment settings (`data` must be empty). SPEC.md §8.7.
 * @dev The constructor, `updateEpoch` and the FROST types are those of V1 (vendored by WP5).
 */
interface ISafenetPolicyV2 {
    event Attested(address indexed engine, address indexed safe, bytes32 indexed callHash);

    error InvalidSettings();
    error MissingAttestation();
    error MalformedAttestation();
    error UntrustedAttestationKey();
    error AttestationAlreadySpent();
    /// @notice A module-path attestation submitted or consumed after its `deadline`.
    error AttestationExpired(uint256 deadline);

    /// @notice Pushes a module-path attestation (anyone may relay): V1's 256-byte encoding, signed
    ///         over `transactionProposal(..., moduleTxDigest(engine, safe, callHash, deadline))`.
    ///         The credit can be consumed while `block.timestamp <= deadline`; several credits of one
    ///         call share the earliest deadline.
    function submitAttestation(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline,
        bytes calldata attestation
    ) external;

    /// @notice Whether an unexpired credit exists for `callHash`.
    function isAttested(address engine, address safe, bytes32 callHash) external view returns (bool);

    /**
     * @notice EIP-712 digest standing in for the Safe transaction hash on the module path: domain
     *         `("SafenetPolicyV2", "1", chainid, this)`,
     *         `ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 deadline)`.
     */
    function moduleTxDigest(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline
    ) external view returns (bytes32);
}
