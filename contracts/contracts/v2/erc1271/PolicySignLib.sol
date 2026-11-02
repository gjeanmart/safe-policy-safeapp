// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {GPv2Order, IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {SafeMessage} from "./SafeMessage.sol";

/**
 * @title Policy sign library
 * @notice DELEGATECALL target that approves ERC-1271 messages on-chain, in the Safe's storage, from
 *         typed entry points that compute the EIP-712 digest themselves. The engine sees the decoded
 *         fields (token, spender, amount, receiver...) as calldata, so policies price a signature the
 *         way they price the equivalent call (SPEC.md §10).
 * @dev Runs in the Safe's context (`address(this)` is the Safe). Writes slot 7 (`signedMessages`)
 *      exactly as Safe's `SignMessageLib`, so `PolicyFallbackHandler` (and Safe's own handler) read it.
 *      An approval is permanent, as with `SignMessageLib`: the token's own deadline / nonce ends it.
 */
contract PolicySignLib is IPolicySignLib {
    /// @notice A constructor address is zero.
    error ZeroAddress();

    /// @notice Called directly instead of through a Safe's DELEGATECALL.
    error OnlyDelegateCall();

    /// @notice `target` has no usable EIP-712 domain separator (call failed or returned malformed data).
    error DomainSeparatorUnavailable(address target);

    /// @notice The signature's own deadline (`deadline`, `validTo`, `sigDeadline`) is already past.
    error SignatureExpired(uint256 deadline);

    /**
     * @notice `token.DOMAIN_SEPARATOR()` is not an EIP-712 domain with `verifyingContract == token`
     *         and this chain id (rebuilt from ERC-5267 `eip712Domain()` or `name()` / `version()`).
     *         Without this, any contract could return another token's domain and have the Safe sign
     *         that token's permit while policies price it under the contract's address.
     */
    error DomainMismatch(address token);

    /// @dev `SafeStorage.signedMessages` slot in Safe 1.3.0 – 1.5.0.
    uint256 private constant SIGNED_MESSAGES_SLOT = 7;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant DOMAIN_NO_VERSION_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev `GPv2Order.TYPE_HASH`: the marker fields are `string` in EIP-712, hashed into the `bytes32` markers.
    bytes32 public constant COW_ORDER_TYPEHASH =
        keccak256(
            "Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,"
            "uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,"
            "string sellTokenBalance,string buyTokenBalance)"
        );

    bytes32 public constant PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");

    bytes32 public constant PERMIT_SINGLE_TYPEHASH =
        keccak256(
            "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
            "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
        );

    /// @notice CoW Protocol `GPv2Settlement`.
    address public immutable COW_SETTLEMENT;

    /// @notice Uniswap `Permit2`.
    address public immutable PERMIT2;

    address private immutable SELF;

    constructor(address cowSettlement, address permit2) {
        if (cowSettlement == address(0) || permit2 == address(0)) revert ZeroAddress();
        COW_SETTLEMENT = cowSettlement;
        PERMIT2 = permit2;
        SELF = address(this);
    }

    /// @inheritdoc IPolicySignLib
    function signPermit(address token, address spender, uint256 value, uint256 deadline, uint256 nonce) external {
        _notExpired(deadline);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, address(this), spender, value, nonce, deadline));
        _sign(_hashTyped(_tokenDomain(token), structHash));
    }

    /// @inheritdoc IPolicySignLib
    function signCowOrder(GPv2Order calldata order) external {
        _notExpired(order.validTo);
        // Every field is static, so abi.encode(order) is the 12 encoded fields, as in GPv2Order.hash.
        bytes32 structHash = keccak256(abi.encode(COW_ORDER_TYPEHASH, order));
        // The settlement is pinned (immutable): its domain needs no binding check.
        _sign(_hashTyped(_domainSeparator(COW_SETTLEMENT, IGPv2SettlementDomain.domainSeparator.selector), structHash));
    }

    /// @inheritdoc IPolicySignLib
    function signPermit2(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce,
        uint256 sigDeadline
    ) external {
        _notExpired(sigDeadline);
        bytes32 detailsHash = keccak256(abi.encode(PERMIT_DETAILS_TYPEHASH, token, amount, expiration, nonce));
        bytes32 structHash = keccak256(abi.encode(PERMIT_SINGLE_TYPEHASH, detailsHash, spender, sigDeadline));
        // Permit2 is pinned (immutable) and `token` is inside the struct: no binding check needed.
        _sign(_hashTyped(_domainSeparator(PERMIT2, IERC20PermitDomain.DOMAIN_SEPARATOR.selector), structHash));
    }

    /// @inheritdoc IPolicySignLib
    function signMessage(bytes32 digest) external {
        _sign(digest);
    }

    function _notExpired(uint256 deadline) private view {
        if (deadline < block.timestamp) revert SignatureExpired(deadline);
    }

    /// @dev Reads the domain separator at signing time (a static view on every supported target).
    function _domainSeparator(address target, bytes4 domainSelector) private view returns (bytes32) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(domainSelector));
        if (!ok || ret.length != 32) revert DomainSeparatorUnavailable(target);
        return abi.decode(ret, (bytes32));
    }

    /**
     * @dev `token.DOMAIN_SEPARATOR()`, once it is proven to be the domain of `token` itself on this
     *      chain: it must equal a domain rebuilt with `verifyingContract = token` and `block.chainid`,
     *      from ERC-5267 `eip712Domain()` (name, version) or `name()` and `version()` (FiatToken,
     *      OpenZeppelin, with or without a version). Every candidate pins `token` and the chain, so
     *      accepting any of them is safe; the name and version are only the pre-image. A malformed
     *      `eip712Domain()` / `name()` / `version()` return reverts (fails closed).
     */
    function _tokenDomain(address token) private view returns (bytes32 separator) {
        separator = _domainSeparator(token, IERC20PermitDomain.DOMAIN_SEPARATOR.selector);
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(IERC5267.eip712Domain.selector));
        // At least the 7 head words of (bytes1, string, string, uint256, address, bytes32, uint256[]).
        if (ok && ret.length >= 224) {
            (bytes1 fields, string memory name, string memory version) = abi.decode(ret, (bytes1, string, string));
            if (fields == 0x0f && separator == _domain(keccak256(bytes(name)), keccak256(bytes(version)), token)) {
                return separator;
            }
            if (fields == 0x0d && separator == _domainNoVersion(keccak256(bytes(name)), token)) return separator;
        }
        bytes32 nameHash;
        (ok, nameHash) = _stringHash(token, IERC20Metadata.name.selector);
        if (ok) {
            (bool hasVersion, bytes32 versionHash) = _stringHash(token, IERC20Metadata.version.selector);
            // No `version()`: OpenZeppelin's ERC20Permit before ERC-5267 uses "1".
            if (!hasVersion) versionHash = keccak256("1");
            if (separator == _domain(nameHash, versionHash, token) || separator == _domainNoVersion(nameHash, token)) {
                return separator;
            }
        }
        revert DomainMismatch(token);
    }

    /// @dev `keccak256` of the string a view returns, or `ok = false` if it fails or is not an ABI string.
    function _stringHash(address target, bytes4 selector) private view returns (bool ok, bytes32 hash) {
        bytes memory ret;
        (ok, ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 64) return (false, 0);
        (uint256 offset, uint256 length) = abi.decode(ret, (uint256, uint256));
        if (offset != 32 || length > ret.length - 64) return (false, 0);
        assembly ("memory-safe") {
            hash := keccak256(add(ret, 96), length)
        }
    }

    function _domain(bytes32 nameHash, bytes32 versionHash, address token) private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, nameHash, versionHash, block.chainid, token));
    }

    function _domainNoVersion(bytes32 nameHash, address token) private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_NO_VERSION_TYPEHASH, nameHash, block.chainid, token));
    }

    function _hashTyped(bytes32 domainSeparator, bytes32 structHash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator, structHash));
    }

    function _sign(bytes32 digest) private {
        if (address(this) == SELF) revert OnlyDelegateCall();
        bytes32 msgHash = SafeMessage.hash(address(this), abi.encode(digest));
        assembly ("memory-safe") {
            mstore(0x00, msgHash)
            mstore(0x20, SIGNED_MESSAGES_SLOT)
            sstore(keccak256(0x00, 0x40), 1)
        }
        emit SignMsg(msgHash);
    }
}

interface IERC20PermitDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IGPv2SettlementDomain {
    function domainSeparator() external view returns (bytes32);
}

interface IERC5267 {
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}

interface IERC20Metadata {
    function name() external view returns (string memory);

    function version() external view returns (string memory);
}
