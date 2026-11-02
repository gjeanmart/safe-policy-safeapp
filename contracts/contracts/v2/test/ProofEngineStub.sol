// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {FROST} from "../libraries/frost/FROST.sol";
import {Secp256k1} from "../libraries/frost/Secp256k1.sol";
import {Scope} from "../libraries/Scope.sol";
import {AttachmentKind, Call, Context, ScopeData} from "../libraries/Types.sol";

/**
 * @title Proof engine stub
 * @notice Calls V2 policies the way the engine does (it is their `msg.sender`) with a crafted
 *         {Context}, so the proof policies (co-signer, Safenet, quorum) can be unit-tested before
 *         the engine exists. Policy reverts bubble up unchanged (the engine would wrap them in
 *         `PolicyDenied`).
 */
contract ProofEngineStub {
    /// @notice Stands in for the engine's post-hook failure: everything the check did is rolled back.
    error ExecutionFailed();

    /// @notice `IPolicyV2.configure` with this stub as the engine; `id` as the engine derives it.
    function configure(
        IPolicyV2 policy,
        address safe,
        ScopeData calldata scope,
        uint8 opMask,
        bytes calldata data
    ) external returns (bytes32 id, uint256 delayFloor) {
        id = attachmentIdOf(scope, address(policy));
        delayFloor = policy.configure(safe, id, scope, opMask, data);
    }

    /// @notice A transaction-level check with any context (owner path, module path or preview).
    function checkTransaction(
        IPolicyV2 policy,
        Context calldata ctx,
        Call[] calldata calls,
        bytes calldata signatures,
        bytes calldata policyData,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4) {
        return policy.checkTransaction(ctx, calls, signatures, policyData, attachmentIds);
    }

    /// @notice A call-level check (to assert transaction-level policies reject it).
    function checkCall(
        IPolicyV2 policy,
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) external returns (bytes4) {
        return policy.checkCall(ctx, call, attachmentIds);
    }

    /**
     * @notice The module-path check as the engine's `checkModuleTransaction` builds it (SPEC.md
     *         §6.1): `txHash = moduleCallHash`, `nonce = 0`, `executor = module`, no signatures
     *         and no policy context. `calls` is the decoded batch, or `[top]` for a single call.
     */
    function checkModuleTransaction(
        IPolicyV2 policy,
        address safe,
        address module,
        Call calldata top,
        Call[] calldata calls,
        bytes32[] calldata attachmentIds
    ) public returns (bytes4) {
        Context memory ctx = Context(
            safe,
            module,
            Scope.moduleCallHash(safe, module, top.to, top.value, top.data, top.operation),
            0,
            module
        );
        return policy.checkTransaction(ctx, calls, "", "", attachmentIds);
    }

    /// @notice {checkModuleTransaction}, then a failed execution: must leave no trace.
    function checkModuleTransactionThenFail(
        IPolicyV2 policy,
        address safe,
        address module,
        Call calldata top,
        Call[] calldata calls,
        bytes32[] calldata attachmentIds
    ) external {
        checkModuleTransaction(policy, safe, module, top, calls, attachmentIds);
        revert ExecutionFailed();
    }

    function moduleCallHash(
        address safe,
        address module,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external pure returns (bytes32) {
        return Scope.moduleCallHash(safe, module, to, value, data, operation);
    }

    function attachmentIdOf(ScopeData calldata scope, address policy) public pure returns (bytes32) {
        return Scope.attachmentId(Scope.key(scope), AttachmentKind.POLICY, policy);
    }
}

/**
 * @title Proof Safe stub
 * @notice The Safe 1.5.0 views the proof policies read: owners, threshold and
 *         `checkNSignatures(executor, ...)` with ECDSA (`v` 27/28), `eth_sign` (`v` > 30) and
 *         approved-hash (`v` 1) signatures, sorted by owner, with Safe's revert strings.
 */
contract ProofSafeStub {
    address[] private _owners;
    uint256 private _threshold;
    mapping(address owner => mapping(bytes32 hash => bool)) public approvedHashes;

    constructor(address[] memory owners, uint256 threshold) {
        _owners = owners;
        _threshold = threshold;
    }

    function approveHash(bytes32 hash) external {
        approvedHashes[msg.sender][hash] = true;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function checkNSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 requiredSignatures
    ) external view {
        require(signatures.length >= requiredSignatures * 65, "GS020");
        address last;
        for (uint256 i; i < requiredSignatures; ++i) {
            uint8 v;
            bytes32 r;
            bytes32 s;
            assembly ("memory-safe") {
                let pos := add(signatures, add(0x20, mul(i, 65)))
                r := mload(pos)
                s := mload(add(pos, 0x20))
                v := byte(0, mload(add(pos, 0x40)))
            }
            address owner;
            if (v == 1) {
                owner = address(uint160(uint256(r)));
                require(executor == owner || approvedHashes[owner][dataHash], "GS025");
            } else if (v > 30) {
                owner = ecrecover(
                    keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash)),
                    v - 4,
                    r,
                    s
                );
            } else {
                owner = ecrecover(dataHash, v, r, s);
            }
            require(owner > last && _isOwner(owner), "GS026");
            last = owner;
        }
    }

    function _isOwner(address account) private view returns (bool) {
        for (uint256 i; i < _owners.length; ++i) {
            if (_owners[i] == account) return true;
        }
        return false;
    }
}

/// @title ERC-1271 signer stub: valid for the hashes it approved, whatever the signature bytes.
contract ERC1271SignerStub {
    mapping(bytes32 hash => bool) public approved;

    function approve(bytes32 hash) external {
        approved[hash] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return approved[hash] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/**
 * @title FROST challenge helper
 * @dev Exposes {FROST.challenge} so tests can build a single-signer FROST (Schnorr) signature, as
 *      V1's `TestFROST`. Verification recomputes the challenge, so a wrong scalar still fails.
 */
contract FrostChallenge {
    function challenge(
        Secp256k1.Point memory r,
        Secp256k1.Point memory y,
        bytes32 message
    ) external view returns (uint256) {
        return FROST.challenge(r, y, message);
    }
}
