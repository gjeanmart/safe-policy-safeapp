// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {SignEngineStub} from "./SignEngineStub.sol";

/**
 * @title Sign Safe stub
 * @notice A Safe-like account for WP6 unit tests (the real Safe 1.5.0 harness is WP1): Safe 1.5.0's
 *         storage layout up to `approvedHashes` (so `PolicySignLib` writes `signedMessages` at slot 7),
 *         its `domainSeparator`, a single-owner `exec` that runs the engine check then the CALL /
 *         DELEGATECALL, and a `FallbackManager`-style fallback (handler called with the caller appended).
 */
contract SignSafeStub {
    // SafeStorage (Safe 1.3.0 – 1.5.0), slots 0..8.
    address internal singleton;
    mapping(address => address) internal modules;
    mapping(address => address) internal owners;
    uint256 internal ownerCount;
    uint256 internal threshold;
    uint256 public nonce;
    bytes32 internal deprecatedDomainSeparator;
    mapping(bytes32 => uint256) public signedMessages;
    mapping(address => mapping(bytes32 => uint256)) public approvedHashes;

    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");

    address public immutable OWNER;
    SignEngineStub public immutable ENGINE;
    address public fallbackHandler;

    error NotOwner();
    error NotSelf();

    constructor(address owner, SignEngineStub engine, address handler) {
        OWNER = owner;
        ENGINE = engine;
        fallbackHandler = handler;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
    }

    /// @notice Owner-path execution: engine check (if any), then the call; bubbles the revert.
    function exec(address to, uint256 value, bytes calldata data, Operation operation) external returns (bytes memory) {
        if (msg.sender != OWNER) revert NotOwner();
        if (address(ENGINE) != address(0)) ENGINE.checkCall(to, value, data, operation);
        nonce++;
        (bool ok, bytes memory ret) = operation == Operation.DELEGATECALL
            ? to.delegatecall(data)
            : to.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function setFallbackHandler(address handler) external {
        if (msg.sender != address(this)) revert NotSelf();
        fallbackHandler = handler;
    }

    receive() external payable {}

    fallback() external {
        address handler = fallbackHandler;
        assembly ("memory-safe") {
            if iszero(handler) {
                return(0, 0)
            }
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            mstore(add(ptr, calldatasize()), shl(96, caller()))
            let success := call(gas(), handler, 0, ptr, add(calldatasize(), 20), 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(success) {
                revert(ptr, returndatasize())
            }
            return(ptr, returndatasize())
        }
    }
}

/**
 * @notice USDC-style (FiatToken v2.2) EIP-2612 token: `permit` with a `bytes` signature that a
 *         contract owner validates through ERC-1271 (`SignatureChecker`), which is how a Safe permits.
 */
contract PermitTokenStub {
    string public constant name = "USD Coin";
    string public constant version = "2";
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    error InvalidSignature();
    error PermitExpired();
    error InsufficientAllowance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("USD Coin"),
                    keccak256("2"),
                    block.chainid,
                    this
                )
            );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata sig) external {
        if (deadline < block.timestamp) revert PermitExpired();
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), DOMAIN_SEPARATOR(), structHash));
        (bool ok, bytes memory ret) = owner.staticcall(
            abi.encodeWithSignature("isValidSignature(bytes32,bytes)", digest, sig)
        );
        if (!ok || ret.length != 32 || abi.decode(ret, (bytes4)) != 0x1626ba7e) revert InvalidSignature();
        allowance[owner][spender] = value;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice `GPv2Settlement`'s EIP-712 domain only.
contract CowSettlementStub {
    function domainSeparator() external view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Gnosis Protocol"),
                    keccak256("v2"),
                    block.chainid,
                    this
                )
            );
    }
}

/// @notice `Permit2`'s EIP-712 domain only.
contract Permit2Stub {
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                    keccak256("Permit2"),
                    block.chainid,
                    this
                )
            );
    }
}

/**
 * @notice A token whose EIP-712 domain is published through ERC-5267 `eip712Domain()` only: its
 *         ERC-20 `name()` differs from the EIP-712 name (allowed by OpenZeppelin), and the domain
 *         has a version (fields `0x0f`) or not (`0x0d`).
 */
contract Erc5267TokenStub {
    string public constant name = "ERC-20 display name";
    bool public immutable WITH_VERSION;

    constructor(bool withVersion) {
        WITH_VERSION = withVersion;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (!WITH_VERSION) {
            return
                keccak256(
                    abi.encode(
                        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                        keccak256("Permit Token"),
                        block.chainid,
                        this
                    )
                );
        }
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Permit Token"),
                    keccak256("1"),
                    block.chainid,
                    this
                )
            );
    }

    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (
            WITH_VERSION ? bytes1(0x0f) : bytes1(0x0d),
            "Permit Token",
            WITH_VERSION ? "1" : "",
            block.chainid,
            address(this),
            bytes32(0),
            new uint256[](0)
        );
    }
}

/**
 * @notice Review H-1 attacker: returns another token's domain separator, claims that token's name,
 *         version and ERC-5267 domain (its `verifyingContract` included), and an unlimited
 *         allowance, so a policy reading it would price nothing.
 */
contract DomainAliasStub {
    address public immutable VICTIM;
    bytes32 public immutable DOMAIN_SEPARATOR;
    string public name;
    string public version;

    constructor(address victim, bytes32 domainSeparator, string memory name_, string memory version_) {
        VICTIM = victim;
        DOMAIN_SEPARATOR = domainSeparator;
        name = name_;
        version = version_;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (bytes1(0x0f), name, version, block.chainid, VICTIM, bytes32(0), new uint256[](0));
    }
}
