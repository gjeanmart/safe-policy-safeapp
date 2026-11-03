// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {ISafenetPolicyV2} from "../interfaces/policies/ISafenetPolicyV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";
import {ConsensusMessages} from "../libraries/frost/ConsensusMessages.sol";
import {EpochRollover} from "../libraries/frost/EpochRollover.sol";
import {FROST} from "../libraries/frost/FROST.sol";
import {Secp256k1} from "../libraries/frost/Secp256k1.sol";

/**
 * @title Safenet policy V2
 * @notice A Safe transaction must carry one Safenet FROST attestation, on both paths, once per
 *         transaction (a batch needs one attestation; V1 failed closed on batches). Port of V1
 *         `SafenetPolicy` (8ee68a8): same constructor, epoch forest, message and encoding.
 *         SPEC.md §8.7.
 * @dev Owner path: `policyData` is V1's 256-byte attestation, over `ctx.txHash` (the real Safe
 *      transaction hash, nonce-bound: one attestation authorises one execution).
 *
 *      Module path: {submitAttestation} verifies the attestation over {moduleTxDigest} in place of
 *      the Safe transaction hash and credits one execution of `callHash`; the check consumes one
 *      credit. The digest carries a `deadline` after which the credit cannot be consumed (several
 *      credits of one call share the earliest deadline). Each attestation can be submitted once ({AttestationAlreadySpent}, keyed by its
 *      FROST signature): FROST signing sessions use fresh nonces, so a second attestation of the
 *      same call is a different signature, while a consumed one can never be replayed.
 *
 *      The trusted `(group key, epoch)` forest is global to this contract (as V1), seeded at
 *      construction and extended by the permissionless {updateEpoch}. No per-attachment
 *      settings: several matched attachments still need one attestation.
 */
contract SafenetPolicyV2 is PolicyBaseV2, ISafenetPolicyV2 {
    using EpochRollover for EpochRollover.T;

    /// @dev `abi.encode(uint64 epoch, address oracle, bytes32 oracleDataHash, Point groupKey, Signature)`.
    uint256 private constant _ATTESTATION_LENGTH = 256;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("SafenetPolicyV2");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _MODULE_TX_TYPEHASH =
        keccak256("ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 deadline)");

    /// @dev EIP-712 domain separator of the Consensus deployment the attestations are bound to.
    bytes32 private immutable _CONSENSUS_DOMAIN_SEPARATOR;

    EpochRollover.T private _epochs;

    /// @dev Module-path credits of one `callHash`: `count` executions, all usable until `deadline`
    ///      (the earliest deadline of the attestations still credited).
    struct Credit {
        uint192 count;
        uint64 deadline;
    }

    /// @dev Module path: executions of `callHash` credited by attestations and not yet consumed.
    mapping(address engine => mapping(address safe => mapping(bytes32 callHash => Credit))) private _credits;

    /// @dev Module path: FROST signatures already submitted (`keccak256(abi.encode(signature))`).
    mapping(bytes32 signatureHash => bool) private _spent;

    /// @notice The Consensus address is zero.
    error InvalidAddress();

    /**
     * @param consensusChainId The chain id hosting the Consensus contract.
     * @param consensusAddress The Consensus contract; with `consensusChainId` it fixes the domain.
     * @param initialEpoch The genesis epoch.
     * @param initialGroupKey The genesis FROST group key (a non-zero secp256k1 point).
     */
    constructor(
        uint256 consensusChainId,
        address consensusAddress,
        uint64 initialEpoch,
        Secp256k1.Point memory initialGroupKey
    ) {
        require(consensusAddress != address(0), InvalidAddress());
        _CONSENSUS_DOMAIN_SEPARATOR = ConsensusMessages.domain(consensusChainId, consensusAddress);
        _epochs.initialize(initialEpoch, initialGroupKey);
    }

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.TRANSACTION;
    }

    /// @inheritdoc ISafenetPolicyV2
    function submitAttestation(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline,
        bytes calldata attestation
    ) external override {
        FROST.Signature memory signature = _verify(attestation, _moduleTxDigest(engine, safe, callHash, deadline));
        require(deadline >= block.timestamp, AttestationExpired(deadline));
        bytes32 signatureHash = keccak256(abi.encode(signature));
        require(!_spent[signatureHash], AttestationAlreadySpent());
        _spent[signatureHash] = true;

        uint64 end = deadline > type(uint64).max ? type(uint64).max : uint64(deadline);
        Credit storage credit = _credits[engine][safe][callHash];
        if (credit.count == 0 || credit.deadline < block.timestamp) {
            // Nothing credited, or only expired credits: they are dropped.
            credit.count = 1;
            credit.deadline = end;
        } else {
            // One deadline for every credit: the earliest one (stricter, never looser).
            ++credit.count;
            if (end < credit.deadline) credit.deadline = end;
        }
        emit Attested(engine, safe, callHash);
    }

    /// @inheritdoc ISafenetPolicyV2
    function isAttested(address engine, address safe, bytes32 callHash) external view override returns (bool) {
        Credit memory credit = _credits[engine][safe][callHash];
        return credit.count != 0 && block.timestamp <= credit.deadline;
    }

    /// @inheritdoc ISafenetPolicyV2
    function moduleTxDigest(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline
    ) external view override returns (bytes32) {
        return _moduleTxDigest(engine, safe, callHash, deadline);
    }

    /**
     * @notice Records a new trusted `(group key, epoch)` pair from a rollover signed by a trusted
     *         group (as V1). Permissionless: the signature authorises it.
     */
    function updateEpoch(
        Secp256k1.Point calldata parentKey,
        uint64 parentEpoch,
        uint64 proposedEpoch,
        uint64 rolloverBlock,
        Secp256k1.Point calldata newGroupKey,
        FROST.Signature calldata signature
    ) external {
        _epochs.rollover(
            _CONSENSUS_DOMAIN_SEPARATOR,
            parentKey,
            parentEpoch,
            proposedEpoch,
            rolloverBlock,
            newGroupKey,
            signature
        );
    }

    /// @notice Whether a `(group key, epoch)` pair is trusted.
    function isKnownEpoch(Secp256k1.Point calldata groupKey, uint64 epoch) external view returns (bool) {
        return _epochs.isKnown(groupKey, epoch);
    }

    /// @notice The EIP-712 domain separator of the Consensus deployment.
    function getConsensusDomainSeparator() external view returns (bytes32) {
        return _CONSENSUS_DOMAIN_SEPARATOR;
    }

    /// @notice Whether an attestation (by its FROST signature) was already submitted on the module path.
    function isAttestationSpent(FROST.Signature calldata signature) external view returns (bool) {
        return _spent[keccak256(abi.encode(signature))];
    }

    function _configure(
        address,
        address,
        bytes32,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal pure override returns (uint256) {
        require(data.length == 0, InvalidSettings());
        return 0;
    }

    function _checkTransaction(
        address engine,
        Context calldata ctx,
        Call[] calldata,
        bytes calldata,
        bytes calldata policyData,
        bytes32[] calldata
    ) internal override {
        if (ctx.actor == Scope.OWNERS) {
            require(policyData.length != 0, MissingAttestation());
            _verify(policyData, ctx.txHash);
        } else {
            Credit storage credit = _credits[engine][ctx.safe][ctx.txHash];
            uint192 available = credit.count;
            require(available != 0, MissingAttestation());
            require(block.timestamp <= credit.deadline, AttestationExpired(credit.deadline));
            credit.count = available - 1;
        }
    }

    /// @dev Decodes and verifies an attestation over `safeTxHash` (or its module-path stand-in).
    function _verify(bytes calldata attestation, bytes32 safeTxHash) private view returns (FROST.Signature memory) {
        require(attestation.length == _ATTESTATION_LENGTH, MalformedAttestation());
        (uint256 epochWord, uint256 oracleWord) = abi.decode(attestation[:64], (uint256, uint256));
        // Checked by hand: `abi.decode` would revert without data on dirty upper bits.
        require(epochWord <= type(uint64).max && oracleWord <= type(uint160).max, MalformedAttestation());
        (, , bytes32 oracleDataHash, Secp256k1.Point memory groupKey, FROST.Signature memory signature) = abi.decode(
            attestation,
            (uint256, uint256, bytes32, Secp256k1.Point, FROST.Signature)
        );
        uint64 epoch = uint64(epochWord);

        // Cheap membership check first, so an untrusted key short-circuits before the hashing.
        require(_epochs.isKnown(groupKey, epoch), UntrustedAttestationKey());

        // Which oracle is acceptable is a validator-side policy: it is bound by the signature (as V1).
        bytes32 message = ConsensusMessages.transactionProposal(
            _CONSENSUS_DOMAIN_SEPARATOR,
            epoch,
            address(uint160(oracleWord)),
            oracleDataHash,
            safeTxHash
        );
        FROST.verify(groupKey, signature, message);
        return signature;
    }

    function _moduleTxDigest(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline
    ) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(abi.encode(_MODULE_TX_TYPEHASH, engine, safe, callHash, deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}
