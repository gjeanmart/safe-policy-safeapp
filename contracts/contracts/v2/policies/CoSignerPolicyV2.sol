// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {ICoSignerPolicyV2} from "../interfaces/policies/ICoSignerPolicyV2.sol";
import {Scope} from "../libraries/Scope.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

/**
 * @title Co-signer policy V2
 * @notice Every distinct co-signer of the matched attachments must have signed the transaction,
 *         on both paths, once per transaction (a batch needs one co-signature, not one per call).
 *         Port of V1 `CoSignerPolicy` (8ee68a8). SPEC.md §8.6.
 * @dev Owner path: `policyData = abi.encode(CoSignature[])`, each over `ctx.txHash`, the real Safe
 *      transaction hash. It pins the Safe nonce, so a co-signature authorises one execution and
 *      no spent-set is needed (V1 needed one because it ran per sub-call of a batch).
 *
 *      Module path: co-signatures are pushed with {cosign} over {moduleTxDigest} and consumed by
 *      the check. `callHash` has no nonce, so the digest carries a per-`(engine, safe, callHash)`
 *      use counter that the check increments: a consumed co-signature can never be pushed again
 *      (deterministic ECDSA signers would otherwise re-produce the same bytes, and an ERC-1271
 *      approval of a digest is usually permanent), and the same call executed twice needs two.
 *      The digest also carries a `deadline`: a pushed co-signature cannot be consumed after it, so
 *      an approval given months ago does not authorise the call today.
 *
 *      Signatures: a co-signer without code signs the digest directly (65 bytes `r, s, v`, `v` 27
 *      or 28, low `s`); a co-signer with code is checked with ERC-1271 `isValidSignature(bytes32,
 *      bytes)` by STATICCALL. Safe's `eth_sign` / approved-hash encodings are not accepted (as V1).
 */
contract CoSignerPolicyV2 is PolicyBaseV2, ICoSignerPolicyV2 {
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("CoSignerPolicyV2");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _MODULE_TX_TYPEHASH =
        keccak256("ModuleTransaction(address engine,address safe,bytes32 callHash,uint256 nonce,uint256 deadline)");

    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant _HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// @dev A pushed module-path co-signature: `use` is the use counter + 1 it was signed for (0 =
    ///      nothing pushed), `deadline` the last second it may be consumed.
    struct Push {
        uint192 use;
        uint64 deadline;
    }

    /// @dev Settings key (`_settingsKey`) => co-signer.
    mapping(bytes32 key => address cosigner) private _cosigners;

    /// @dev Pushed module-path co-signatures, valid for the current use counter only.
    mapping(address engine => mapping(address safe => mapping(bytes32 callHash => mapping(address cosigner => Push))))
        private _pushed;

    /// @dev Module-path use counter: number of times the check consumed co-signatures for a call.
    mapping(address engine => mapping(address safe => mapping(bytes32 callHash => uint256 nonce))) private _uses;

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.TRANSACTION;
    }

    /// @inheritdoc ICoSignerPolicyV2
    function cosign(
        address engine,
        address safe,
        bytes32 callHash,
        address cosigner,
        uint256 deadline,
        bytes calldata signature
    ) external override {
        uint256 nonce = _uses[engine][safe][callHash];
        bytes32 digest = _moduleTxDigest(engine, safe, callHash, nonce, deadline);
        require(cosigner != address(0) && _isValidSignature(cosigner, digest, signature), InvalidCoSignature(cosigner));
        require(deadline >= block.timestamp, CoSignatureExpired(cosigner, deadline));
        // `use` is `nonce + 1` so that 0 means "nothing pushed" and an old push never matches. A
        // deadline past 2^64 is stored as 2^64 - 1 (never reached).
        _pushed[engine][safe][callHash][cosigner] = Push(
            uint192(nonce + 1),
            deadline > type(uint64).max ? type(uint64).max : uint64(deadline)
        );
        emit Cosigned(engine, safe, callHash, cosigner);
    }

    /// @inheritdoc ICoSignerPolicyV2
    function isCosigned(
        address engine,
        address safe,
        bytes32 callHash,
        address cosigner
    ) external view override returns (bool) {
        Push memory p = _pushed[engine][safe][callHash][cosigner];
        return p.use == _uses[engine][safe][callHash] + 1 && block.timestamp <= p.deadline;
    }

    /**
     * @inheritdoc ICoSignerPolicyV2
     * @dev The digest of the next use of `callHash`: it includes the current use counter
     *      ({moduleTxNonce}), so it changes every time a module execution consumes co-signatures.
     */
    function moduleTxDigest(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 deadline
    ) external view override returns (bytes32) {
        return _moduleTxDigest(engine, safe, callHash, _uses[engine][safe][callHash], deadline);
    }

    /// @notice How many times the check consumed co-signatures for `(engine, safe, callHash)`.
    function moduleTxNonce(address engine, address safe, bytes32 callHash) external view returns (uint256) {
        return _uses[engine][safe][callHash];
    }

    /// @inheritdoc ICoSignerPolicyV2
    function getSettings(
        address engine,
        address safe,
        bytes32 attachmentId
    ) external view override returns (Settings memory) {
        return Settings(_cosigners[_settingsKey(engine, safe, attachmentId)]);
    }

    /// @inheritdoc ICoSignerPolicyV2
    function encodeSettings(Settings calldata settings) external pure override returns (bytes memory) {
        return abi.encode(settings);
    }

    /**
     * @notice Decodes an owner-path policy context entry. External so the check can catch a
     *         malformed encoding (`abi.decode` reverts without data) and report it.
     */
    function decodePolicyData(bytes calldata policyData) external pure returns (CoSignature[] memory) {
        return abi.decode(policyData, (CoSignature[]));
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256) {
        // Decoded as a word so that dirty upper bits are an InvalidSettings, not a bare revert.
        require(data.length == 32, InvalidSettings());
        uint256 word = abi.decode(data, (uint256));
        require(word != 0 && word <= type(uint160).max, InvalidSettings());
        _cosigners[_settingsKey(engine, safe, attachmentId)] = address(uint160(word));
        return 0;
    }

    function _checkTransaction(
        address engine,
        Context calldata ctx,
        Call[] calldata,
        bytes calldata,
        bytes calldata policyData,
        bytes32[] calldata attachmentIds
    ) internal override {
        address[] memory cosigners = _distinctCosigners(engine, ctx.safe, attachmentIds);
        if (ctx.actor == Scope.OWNERS) {
            _checkOwnerPath(ctx.txHash, policyData, cosigners);
        } else {
            _consumeModulePath(engine, ctx.safe, ctx.txHash, cosigners);
        }
    }

    function _checkOwnerPath(bytes32 txHash, bytes calldata policyData, address[] memory cosigners) private view {
        CoSignature[] memory sigs;
        if (policyData.length != 0) {
            try this.decodePolicyData(policyData) returns (CoSignature[] memory decoded) {
                sigs = decoded;
            } catch {
                revert MalformedPolicyData();
            }
        }
        for (uint256 i; i < cosigners.length; ++i) {
            address cosigner = cosigners[i];
            // The first entry naming the co-signer is the one checked; extra entries are ignored.
            uint256 j;
            while (j < sigs.length && sigs[j].cosigner != cosigner) ++j;
            require(j < sigs.length, MissingCoSignature(cosigner));
            require(_isValidSignature(cosigner, txHash, sigs[j].signature), InvalidCoSignature(cosigner));
        }
    }

    function _consumeModulePath(address engine, address safe, bytes32 callHash, address[] memory cosigners) private {
        uint256 nonce = _uses[engine][safe][callHash];
        mapping(address => Push) storage pushed = _pushed[engine][safe][callHash];
        for (uint256 i; i < cosigners.length; ++i) {
            address cosigner = cosigners[i];
            Push memory p = pushed[cosigner];
            require(p.use == nonce + 1, MissingCoSignature(cosigner));
            require(block.timestamp <= p.deadline, CoSignatureExpired(cosigner, p.deadline));
            delete pushed[cosigner];
        }
        _uses[engine][safe][callHash] = nonce + 1;
    }

    /// @dev The co-signers of the matched attachments, without duplicates (bounded by the engine's caps).
    function _distinctCosigners(
        address engine,
        address safe,
        bytes32[] calldata attachmentIds
    ) private view returns (address[] memory cosigners) {
        cosigners = new address[](attachmentIds.length);
        uint256 count;
        for (uint256 i; i < attachmentIds.length; ++i) {
            address cosigner = _cosigners[_settingsKey(engine, safe, attachmentIds[i])];
            // Never configured (the engine always configures on SET): fail closed.
            require(cosigner != address(0), InvalidSettings());
            uint256 j;
            while (j < count && cosigners[j] != cosigner) ++j;
            if (j == count) cosigners[count++] = cosigner;
        }
        assembly ("memory-safe") {
            mstore(cosigners, count)
        }
    }

    function _moduleTxDigest(
        address engine,
        address safe,
        bytes32 callHash,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(abi.encode(_MODULE_TX_TYPEHASH, engine, safe, callHash, nonce, deadline));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    /// @dev ECDSA (65 bytes, low `s`) for an account without code, else ERC-1271 by STATICCALL.
    function _isValidSignature(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer.code.length == 0) {
            if (signature.length != 65) return false;
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly ("memory-safe") {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            if (uint256(s) > _HALF_N || (v != 27 && v != 28)) return false;
            address recovered = ecrecover(digest, v, r, s);
            return recovered != address(0) && recovered == signer;
        }
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(_ERC1271_MAGIC, digest, signature));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(_ERC1271_MAGIC);
    }
}
