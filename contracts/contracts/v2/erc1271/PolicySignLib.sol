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

    /// @dev `SafeStorage.signedMessages` slot in Safe 1.3.0 – 1.5.0.
    uint256 private constant SIGNED_MESSAGES_SLOT = 7;

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
        _sign(_digest(token, IERC20PermitDomain.DOMAIN_SEPARATOR.selector, structHash));
    }

    /// @inheritdoc IPolicySignLib
    function signCowOrder(GPv2Order calldata order) external {
        _notExpired(order.validTo);
        // Every field is static, so abi.encode(order) is the 12 encoded fields, as in GPv2Order.hash.
        bytes32 structHash = keccak256(abi.encode(COW_ORDER_TYPEHASH, order));
        _sign(_digest(COW_SETTLEMENT, IGPv2SettlementDomain.domainSeparator.selector, structHash));
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
        _sign(_digest(PERMIT2, IERC20PermitDomain.DOMAIN_SEPARATOR.selector, structHash));
    }

    /// @inheritdoc IPolicySignLib
    function signMessage(bytes32 digest) external {
        _sign(digest);
    }

    function _notExpired(uint256 deadline) private view {
        if (deadline < block.timestamp) revert SignatureExpired(deadline);
    }

    /// @dev Reads the domain separator at signing time (a static view on every supported target).
    function _digest(address target, bytes4 domainSelector, bytes32 structHash) private view returns (bytes32) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(domainSelector));
        if (!ok || ret.length != 32) revert DomainSeparatorUnavailable(target);
        return keccak256(abi.encodePacked(bytes2(0x1901), abi.decode(ret, (bytes32)), structHash));
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
