// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {IPolicy, Operation} from "../../vendor/policy-engine/interfaces/IPolicy.sol";
import {AccessSelector} from "../../vendor/policy-engine/libraries/AccessSelector.sol";

/*
 * V1 policies for the V1-vs-V2 comparison suite (test/v2/compare). The vendored V1 package
 * (71b9cb0) ships only ERC20TransferPolicy; these are the other V1 policies the design doc's §1
 * table talks about, written against the V1 `IPolicy` the vendored `SafePolicyGuard` calls:
 *
 *  - E2eV1AllowPolicy: 8ee68a8's AllowPolicy, verbatim behaviour.
 *  - E2eV1CoSignerPolicy: 8ee68a8's CoSignerPolicy with plain ECDSA (no OpenZeppelin here); same
 *    `ModulePathUnsupported` revert on the module path, which is what the comparison exercises
 *    (8ee68a8's SafenetPolicy has the identical `require(module == address(0))`).
 *  - E2eV1TimelockPolicy: a stand-in. Neither 71b9cb0 nor 8ee68a8 has a timelock policy; this is
 *    the smallest one that behaves like the "fallback timelock" of WA-4014 (schedule a Safe
 *    transaction hash, allow it once the delay passed).
 *  - E2eV1DenyPolicy: what a V1 owner binds to stop calls (8ee68a8's DenyPolicy); used as the
 *    V1 stand-in for a freeze.
 */

/// @notice 8ee68a8 AllowPolicy: allows everything it is bound to.
contract E2eV1AllowPolicy is IPolicy {
    /// @inheritdoc IPolicy
    function checkTransaction(
        address,
        address,
        uint256,
        bytes calldata,
        Operation,
        address,
        bytes calldata,
        AccessSelector.T
    ) external pure override returns (bytes4) {
        return IPolicy.checkTransaction.selector;
    }

    /// @inheritdoc IPolicy
    function configure(address, AccessSelector.T, bytes memory) external pure override returns (bool) {
        return true;
    }
}

/// @notice 8ee68a8 DenyPolicy: denies everything it is bound to.
contract E2eV1DenyPolicy is IPolicy {
    error Denied();

    /// @inheritdoc IPolicy
    function checkTransaction(
        address,
        address,
        uint256,
        bytes calldata,
        Operation,
        address,
        bytes calldata,
        AccessSelector.T
    ) external pure override returns (bytes4) {
        revert Denied();
    }

    /// @inheritdoc IPolicy
    function configure(address, AccessSelector.T, bytes memory) external pure override returns (bool) {
        return true;
    }
}

/// @notice 8ee68a8 CoSignerPolicy (owner path only), ECDSA co-signer over the Safe transaction hash.
contract E2eV1CoSignerPolicy is IPolicy {
    mapping(address guard => mapping(address safe => mapping(AccessSelector.T access => address))) private $cosigners;
    mapping(address guard => mapping(address safe => mapping(bytes32 safeTxHash => bool))) private $spent;

    error Unauthorized();
    error NoCosignerConfigured();
    error CoSignatureAlreadySpent();
    error ModulePathUnsupported();

    /// @inheritdoc IPolicy
    function checkTransaction(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module,
        bytes calldata context,
        AccessSelector.T access
    ) external override returns (bytes4) {
        require(module == address(0), ModulePathUnsupported());
        bytes32 safeTxHash = ISafe(safe).getTransactionHash(
            to,
            value,
            data,
            operation,
            0,
            0,
            0,
            address(0),
            address(0),
            ISafe(safe).nonce() - 1
        );
        address cosigner = $cosigners[msg.sender][safe][access];
        require(cosigner != address(0), NoCosignerConfigured());
        require(context.length == 65, Unauthorized());
        (bytes32 r, bytes32 s) = abi.decode(context[:64], (bytes32, bytes32));
        require(ecrecover(safeTxHash, uint8(context[64]), r, s) == cosigner, Unauthorized());
        require(!$spent[msg.sender][safe][safeTxHash], CoSignatureAlreadySpent());
        $spent[msg.sender][safe][safeTxHash] = true;
        return IPolicy.checkTransaction.selector;
    }

    /// @inheritdoc IPolicy
    function configure(address safe, AccessSelector.T access, bytes memory data) external override returns (bool) {
        $cosigners[msg.sender][safe][access] = abi.decode(data, (address));
        return true;
    }
}

/// @notice Stand-in V1 timelock: a Safe transaction hash scheduled with the owners' signatures runs after `delay`.
contract E2eV1TimelockPolicy is IPolicy {
    mapping(address guard => mapping(address safe => mapping(AccessSelector.T access => uint256))) private $delays;
    mapping(address guard => mapping(address safe => mapping(bytes32 safeTxHash => uint256))) public scheduledAt;

    error NotScheduled(bytes32 safeTxHash);
    error NotReady(bytes32 safeTxHash, uint256 readyAt);
    error ModulePathUnsupported();

    /// @notice Schedules `safeTxHash` (zero gas fields), approved by the Safe's owners (`signatures`).
    function schedule(address guard, address safe, bytes32 safeTxHash, bytes calldata signatures) external {
        ISafe(safe).checkNSignatures(address(0), safeTxHash, signatures, ISafe(safe).getThreshold());
        scheduledAt[guard][safe][safeTxHash] = block.timestamp;
    }

    /// @inheritdoc IPolicy
    function checkTransaction(
        address safe,
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module,
        bytes calldata,
        AccessSelector.T access
    ) external override returns (bytes4) {
        require(module == address(0), ModulePathUnsupported());
        bytes32 safeTxHash = ISafe(safe).getTransactionHash(
            to,
            value,
            data,
            operation,
            0,
            0,
            0,
            address(0),
            address(0),
            ISafe(safe).nonce() - 1
        );
        uint256 at = scheduledAt[msg.sender][safe][safeTxHash];
        require(at != 0, NotScheduled(safeTxHash));
        uint256 readyAt = at + $delays[msg.sender][safe][access];
        require(block.timestamp >= readyAt, NotReady(safeTxHash, readyAt));
        delete scheduledAt[msg.sender][safe][safeTxHash];
        return IPolicy.checkTransaction.selector;
    }

    /// @inheritdoc IPolicy
    function configure(address safe, AccessSelector.T access, bytes memory data) external override returns (bool) {
        $delays[msg.sender][safe][access] = abi.decode(data, (uint256));
        return true;
    }
}
