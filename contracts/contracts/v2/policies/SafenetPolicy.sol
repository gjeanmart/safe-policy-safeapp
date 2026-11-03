// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafenetPolicy} from "../interfaces/policies/ISafenetPolicy.sol";
import {ConsensusMessages} from "../libraries/frost/ConsensusMessages.sol";
import {EpochRollover} from "../libraries/frost/EpochRollover.sol";
import {FROST} from "../libraries/frost/FROST.sol";
import {Secp256k1} from "../libraries/frost/Secp256k1.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title SafenetPolicy: one Safenet FROST attestation per transaction, pushed on-chain
 * @notice Port of V1 `SafenetPolicy` (8ee68a8) and rev 2 `SafenetPolicyV2`: same constructor,
 *         epoch forest, message and attestation encoding. Every attestation is submitted with
 *         {submitAttestation} before execution, on both paths. SPEC.md §5.5.
 * @dev Each attestation can be submitted once (`AttestationAlreadySpent`, keyed by its FROST
 *      signature): FROST sessions use fresh nonces, so a second attestation of the same hash is a
 *      different signature, while a submitted one can never be replayed for another credit.
 */
contract SafenetPolicy is PolicyBase, ISafenetPolicy {
    using EpochRollover for EpochRollover.T;

    /// @dev `abi.encode(uint64 epoch, address oracle, bytes32 oracleDataHash, Point groupKey, Signature)`.
    uint256 private constant _ATTESTATION_LENGTH = 256;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("SafenetPolicy");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _MODULE_TX_TYPEHASH =
        keccak256("ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 deadline)");

    /// @dev EIP-712 domain separator of the Consensus deployment the attestations are bound to.
    bytes32 private immutable _CONSENSUS_DOMAIN_SEPARATOR;

    EpochRollover.T private _epochs;

    /// @dev Credits of one `txHash`: `count` executions, all usable until `deadline` (the earliest
    ///      deadline of the attestations still credited; `type(uint64).max` on the owner path).
    struct Credit {
        uint192 count;
        uint64 deadline;
    }

    mapping(address engine => mapping(address safe => mapping(bytes32 txHash => Credit))) private _credits;

    /// @dev FROST signatures already submitted (`keccak256(abi.encode(signature))`).
    mapping(bytes32 signatureHash => bool) private _spent;

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

    /// @inheritdoc ISafenetPolicy
    function submitAttestation(
        address engine,
        address safe,
        bytes32 txHash,
        uint256 deadline,
        bytes calldata attestation
    ) external override {
        // Owner path: the Safe transaction hash itself (nonce-bound) is what Safenet attests.
        bytes32 signed = deadline == 0 ? txHash : _attestationDigest(engine, safe, txHash, deadline);
        FROST.Signature memory signature = _verify(attestation, signed);
        require(deadline == 0 || deadline >= block.timestamp, AttestationExpired(deadline));
        bytes32 signatureHash = keccak256(abi.encode(signature));
        require(!_spent[signatureHash], AttestationAlreadySpent());
        _spent[signatureHash] = true;

        uint64 end = deadline == 0 || deadline > type(uint64).max ? type(uint64).max : uint64(deadline);
        Credit storage credit = _credits[engine][safe][txHash];
        if (credit.count == 0 || credit.deadline < block.timestamp) {
            // Nothing credited, or only expired credits: they are dropped.
            credit.count = 1;
            credit.deadline = end;
        } else {
            // One deadline for every credit: the earliest one (stricter, never looser).
            ++credit.count;
            if (end < credit.deadline) credit.deadline = end;
        }
        emit Attested(engine, safe, txHash, deadline);
    }

    /// @inheritdoc ISafenetPolicy
    function isAttested(address engine, address safe, bytes32 txHash) external view override returns (bool) {
        Credit memory credit = _credits[engine][safe][txHash];
        return credit.count != 0 && block.timestamp <= credit.deadline;
    }

    /// @inheritdoc ISafenetPolicy
    function attestationDigest(
        address engine,
        address safe,
        bytes32 txHash,
        uint256 deadline
    ) external view override returns (bytes32) {
        return _attestationDigest(engine, safe, txHash, deadline);
    }

    /// @inheritdoc ISafenetPolicy
    function updateEpoch(
        Secp256k1.Point calldata parentKey,
        uint64 parentEpoch,
        uint64 proposedEpoch,
        uint64 rolloverBlock,
        Secp256k1.Point calldata newGroupKey,
        FROST.Signature calldata signature
    ) external override {
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

    /// @inheritdoc ISafenetPolicy
    function isKnownEpoch(Secp256k1.Point calldata groupKey, uint64 epoch) external view override returns (bool) {
        return _epochs.isKnown(groupKey, epoch);
    }

    /// @inheritdoc ISafenetPolicy
    function getConsensusDomainSeparator() external view override returns (bytes32) {
        return _CONSENSUS_DOMAIN_SEPARATOR;
    }

    /// @inheritdoc ISafenetPolicy
    function isAttestationSpent(FROST.Signature calldata signature) external view override returns (bool) {
        return _spent[keccak256(abi.encode(signature))];
    }

    function _configure(
        address,
        address,
        bytes32,
        Scope calldata,
        uint8,
        bytes calldata data
    ) internal pure override {
        require(data.length == 0, InvalidSettings());
    }

    /// @dev One credit per transaction, however many attachments and calls matched.
    function _check(address engine, Context calldata ctx, Call[] calldata, Match[] calldata) internal override {
        Credit storage credit = _credits[engine][ctx.safe][ctx.txHash];
        uint192 available = credit.count;
        require(available != 0, MissingAttestation());
        require(block.timestamp <= credit.deadline, AttestationExpired(credit.deadline));
        credit.count = available - 1;
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

    function _attestationDigest(
        address engine,
        address safe,
        bytes32 txHash,
        uint256 deadline
    ) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(abi.encode(_MODULE_TX_TYPEHASH, engine, safe, txHash, deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}
