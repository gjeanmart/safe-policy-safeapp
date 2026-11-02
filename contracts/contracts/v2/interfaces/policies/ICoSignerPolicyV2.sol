// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title CoSignerPolicyV2 (transaction level)
 * @notice Every co-signer of the matched attachments must have signed the transaction.
 *         Owner path: signatures over the Safe transaction hash in the policy context (as V1).
 *         Module path: pushed with {cosign} before execution, consumed by the check. SPEC.md §8.6.
 */
interface ICoSignerPolicyV2 {
    /// @notice `abi.encode(Settings)`; `cosigner` non-zero (EOA or ERC-1271 contract).
    struct Settings {
        address cosigner;
    }

    /// @notice Owner-path policy context entry: `abi.encode(CoSignature[])`.
    struct CoSignature {
        address cosigner;
        bytes signature;
    }

    event Cosigned(address indexed engine, address indexed safe, bytes32 indexed callHash, address cosigner);

    error InvalidSettings();
    error MissingCoSignature(address cosigner);
    error InvalidCoSignature(address cosigner);
    error MalformedPolicyData();
    /// @notice A module-path co-signature pushed or consumed after its `deadline`.
    error CoSignatureExpired(address cosigner, uint256 deadline);

    /**
     * @notice Pushes a module-path co-signature (anyone may relay). `signature` is over
     *         `moduleTxDigest(engine, safe, callHash, deadline)`, i.e. bound to the current use
     *         counter and to `deadline` (ECDSA, or ERC-1271 for a contract co-signer). The check
     *         consumes it only while `block.timestamp <= deadline`.
     */
    function cosign(
        address engine,
        address safe,
        bytes32 callHash,
        address cosigner,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Whether `cosigner` has a pushed, unexpired co-signature for the next use of `callHash`.
    function isCosigned(address engine, address safe, bytes32 callHash, address cosigner) external view returns (bool);

    /**
     * @notice EIP-712 digest a co-signer signs for the next module execution of `callHash`: domain
     *         `("CoSignerPolicyV2", "1", chainid, this)`,
     *         `ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 nonce,uint256 deadline)`,
     *         where `nonce` is the policy's use counter for `(engine, safe, callHash)` (`moduleTxNonce`,
     *         not the Safe nonce) and `deadline` the last second the co-signature may be consumed. The
     *         check increments the counter, so a consumed co-signature can never be pushed again and
     *         the same call executed twice needs a fresh co-signature. SPEC.md §7, §8.6.
     */
    function moduleTxDigest(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline
    ) external view returns (bytes32);

    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory);

    function encodeSettings(Settings calldata settings) external pure returns (bytes memory);
}
