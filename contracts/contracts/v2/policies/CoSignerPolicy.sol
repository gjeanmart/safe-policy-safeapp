// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ICoSignerPolicy} from "../interfaces/policies/ICoSignerPolicy.sol";
import {ERC1271_MAGIC_VALUE, MAX_ROLE_MEMBERS} from "../libraries/Constants.sol";
import {Call, Context, Match, Scope} from "../libraries/Types.sol";
import {PolicyBase} from "./PolicyBase.sol";

/**
 * @title CoSignerPolicy: M-of-N on-chain approvals, both paths
 * @notice A matched transaction needs `required` approvals from each matched attachment's
 *         approvers, pushed on-chain before execution and keyed by `ctx.txHash`. SPEC.md §5.4.
 * @dev Approvals are stored under `(engine, safe, txHash, useCount, approver)`. Consuming them is
 *      one write: bumping `useCount` makes every approval of the earlier use unreachable, without
 *      iterating over approvers. The same bump changes {approvalDigest}, so a signature (or a
 *      standing ERC-1271 approval) of a consumed use never counts again.
 */
contract CoSignerPolicy is PolicyBase, ICoSignerPolicy {
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("CoSignerPolicy");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _APPROVAL_TYPEHASH =
        keccak256("Approval(address engine,address safe,bytes32 txHash,uint256 useCount,uint64 validUntil)");

    /// @dev secp256k1 n / 2: higher `s` values are malleable twins and are rejected.
    uint256 private constant _HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// @dev `_settingsKey(engine, safe, attachmentId)` => settings.
    mapping(bytes32 key => Settings) private _settings;

    /// @dev `_useKey(engine, safe, txHash)` => number of consumptions.
    mapping(bytes32 useKey => uint256) private _useCounts;

    /// @dev `_approvalKey(useKey, use, approver)` => `validUntil` (0: none).
    mapping(bytes32 approvalKey => uint64) private _approvals;

    /// @dev `keccak256(digest, approver)` => pushed. Per approver: every approver signs the same digest.
    mapping(bytes32 pushKey => bool) private _pushed;

    /// @inheritdoc ICoSignerPolicy
    function approve(address engine, address safe, bytes32 txHash, uint64 validUntil) external override {
        require(validUntil >= block.timestamp, ApprovalExpired(validUntil));
        _record(engine, safe, txHash, msg.sender, validUntil);
    }

    /// @inheritdoc ICoSignerPolicy
    function approveWithSig(
        address engine,
        address safe,
        bytes32 txHash,
        address approver,
        uint64 validUntil,
        bytes calldata signature
    ) external override {
        require(validUntil >= block.timestamp, ApprovalExpired(validUntil));
        bytes32 useKey = _useKey(engine, safe, txHash);
        bytes32 digest = _digest(engine, safe, txHash, _useCounts[useKey], validUntil);
        require(_isValidSignature(approver, digest, signature), InvalidSignature(approver));
        bytes32 pushKey = keccak256(abi.encode(digest, approver));
        require(!_pushed[pushKey], SignatureAlreadyUsed(digest));
        _pushed[pushKey] = true;
        _record(engine, safe, txHash, approver, validUntil);
    }

    /// @inheritdoc ICoSignerPolicy
    function revoke(address engine, address safe, bytes32 txHash) external override {
        bytes32 useKey = _useKey(engine, safe, txHash);
        delete _approvals[_approvalKey(useKey, _useCounts[useKey], msg.sender)];
        emit Revoked(engine, safe, txHash, msg.sender);
    }

    /// @inheritdoc ICoSignerPolicy
    function approvalDigest(
        address engine,
        address safe,
        bytes32 txHash,
        uint64 validUntil
    ) external view override returns (bytes32) {
        return _digest(engine, safe, txHash, _useCounts[_useKey(engine, safe, txHash)], validUntil);
    }

    /// @inheritdoc ICoSignerPolicy
    function useCount(address engine, address safe, bytes32 txHash) external view override returns (uint256) {
        return _useCounts[_useKey(engine, safe, txHash)];
    }

    /// @inheritdoc ICoSignerPolicy
    function approvedUntil(
        address engine,
        address safe,
        bytes32 txHash,
        address approver
    ) external view override returns (uint64) {
        bytes32 useKey = _useKey(engine, safe, txHash);
        return _approvals[_approvalKey(useKey, _useCounts[useKey], approver)];
    }

    /// @inheritdoc ICoSignerPolicy
    function getSettings(
        address engine,
        address safe,
        bytes32 attachmentId
    ) external view override returns (Settings memory) {
        return _settings[_settingsKey(engine, safe, attachmentId)];
    }

    /// @inheritdoc ICoSignerPolicy
    function encodeSettings(Settings calldata settings) external pure override returns (bytes memory) {
        return abi.encode(settings);
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        Scope calldata,
        uint8,
        bytes calldata data
    ) internal override {
        Settings memory s = abi.decode(data, (Settings));
        uint256 n = s.approvers.length;
        require(n != 0 && n <= MAX_ROLE_MEMBERS && s.required != 0 && s.required <= n, InvalidSettings());
        for (uint256 i; i < n; ++i) {
            address a = s.approvers[i];
            require(a != address(0) && a != safe, InvalidSettings());
            for (uint256 j; j < i; ++j) require(s.approvers[j] != a, InvalidSettings());
        }
        _settings[_settingsKey(engine, safe, attachmentId)] = s;
    }

    /// @dev Each distinct matched attachment needs its own `required` count; then the use is consumed.
    function _check(address engine, Context calldata ctx, Call[] calldata, Match[] calldata matches) internal override {
        bytes32 useKey = _useKey(engine, ctx.safe, ctx.txHash);
        uint256 use = _useCounts[useKey];
        for (uint256 i; i < matches.length; ++i) {
            bytes32 id = matches[i].attachmentId;
            // Matches are ordered by call: an attachment matched by several calls of a batch is
            // checked once.
            bool seen;
            for (uint256 j; j < i && !seen; ++j) seen = matches[j].attachmentId == id;
            if (!seen) _checkAttachment(engine, ctx.safe, id, useKey, use);
        }
        _useCounts[useKey] = use + 1;
        emit Consumed(engine, ctx.safe, ctx.txHash, use + 1);
    }

    function _checkAttachment(address engine, address safe, bytes32 id, bytes32 useKey, uint256 use) private view {
        Settings storage s = _settings[_settingsKey(engine, safe, id)];
        uint256 n = s.approvers.length;
        uint8 required = s.required;
        // Never configured (the engine always configures on attach): fail closed.
        require(n != 0, InvalidSettings());
        uint8 have;
        for (uint256 i; i < n && have < required; ++i) {
            if (_approvals[_approvalKey(useKey, use, s.approvers[i])] >= block.timestamp) ++have;
        }
        require(have >= required, MissingApprovals(id, required, have));
    }

    function _record(address engine, address safe, bytes32 txHash, address approver, uint64 validUntil) private {
        bytes32 useKey = _useKey(engine, safe, txHash);
        _approvals[_approvalKey(useKey, _useCounts[useKey], approver)] = validUntil;
        emit Approved(engine, safe, txHash, approver, validUntil);
    }

    function _digest(
        address engine,
        address safe,
        bytes32 txHash,
        uint256 use,
        uint64 validUntil
    ) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(abi.encode(_APPROVAL_TYPEHASH, engine, safe, txHash, use, validUntil));
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    /// @dev ECDSA (65 bytes `r, s, v`, low `s`) for an account without code, else ERC-1271 by STATICCALL.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length == 0) {
            if (signature.length != 65) return false;
            bytes32 r = bytes32(signature[0:32]);
            bytes32 s = bytes32(signature[32:64]);
            uint8 v = uint8(signature[64]);
            if (uint256(s) > _HALF_N || (v != 27 && v != 28)) return false;
            address recovered = ecrecover(digest, v, r, s);
            return recovered != address(0) && recovered == signer;
        }
        (bool ok, bytes memory ret) = signer.staticcall(
            abi.encodeWithSelector(ERC1271_MAGIC_VALUE, digest, signature)
        );
        return ok && ret.length == 32 && abi.decode(ret, (bytes32)) == bytes32(ERC1271_MAGIC_VALUE);
    }

    function _useKey(address engine, address safe, bytes32 txHash) private pure returns (bytes32) {
        return keccak256(abi.encode(engine, safe, txHash));
    }

    function _approvalKey(bytes32 useKey, uint256 use, address approver) private pure returns (bytes32) {
        return keccak256(abi.encode(useKey, use, approver));
    }
}
