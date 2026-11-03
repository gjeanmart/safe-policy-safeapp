// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @notice CoW Protocol `GPv2Order.Data`, field for field (all static, so policies can decode it
 *         from calldata). `kind`, `sellTokenBalance` and `buyTokenBalance` are the protocol's
 *         `bytes32` marker hashes.
 */
struct GPv2Order {
    address sellToken;
    address buyToken;
    address receiver;
    uint256 sellAmount;
    uint256 buyAmount;
    uint32 validTo;
    bytes32 appData;
    uint256 feeAmount;
    bytes32 kind;
    bool partiallyFillable;
    bytes32 sellTokenBalance;
    bytes32 buyTokenBalance;
}

/**
 * @title Policy sign library
 * @notice DELEGATECALL target, pinned in the engine (`SIGN_LIB`), that approves an ERC-1271
 *         message on-chain the way Safe's `SignMessageLib` does (`signedMessages[msgHash] = 1` in
 *         the Safe's storage, emits `SignMsg`), but from typed entry points: each computes the
 *         EIP-712 digest itself, so the engine and the policies see decoded fields (SPEC.md §10).
 *         Pair it with `PolicyFallbackHandler`, which accepts only on-chain approved messages.
 * @dev The engine matches a DELEGATECALL to `SIGN_LIB` with a typed selector (`signPermit`,
 *      `signCowOrder`, `signPermit2`) or `signMessage` as if it were a CALL (the library is pinned
 *      and only writes `signedMessages`, SPEC.md §14 D-22); any other selector stays DELEGATECALL
 *      and needs an exact-scope ALLOW covering DELEGATECALL.
 *      `msgHash = getMessageHashForSafe(safe, abi.encode(digest))` as in `CompatibilityFallbackHandler`.
 */
interface IPolicySignLib {
    /// @notice Same event as Safe's `SignMessageLib`, emitted from the Safe.
    event SignMsg(bytes32 indexed msgHash);

    /**
     * @notice Approves an EIP-2612 `Permit(owner = safe, spender, value, nonce, deadline)` digest
     *         under `token`'s `DOMAIN_SEPARATOR()`.
     * @dev Priced by LimitPolicy like `approve(spender, value)` on `token`; RecipientsPolicy checks
     *      `spender` and `maxApproval`.
     */
    function signPermit(address token, address spender, uint256 value, uint256 deadline, uint256 nonce) external;

    /**
     * @notice Approves a CoW Protocol order digest under the settlement's domain separator (the
     *         settlement address is an immutable of the library).
     * @dev Priced by LimitPolicy as a spend of `sellAmount + feeAmount` of `sellToken`;
     *      RecipientsPolicy checks `receiver` (`address(0)` = the Safe).
     */
    function signCowOrder(GPv2Order calldata order) external;

    /**
     * @notice (Stretch) Approves a Permit2 `PermitSingle` digest (allowance transfer) under
     *         Permit2's domain separator (Permit2 address immutable in the library).
     * @dev Priced like `approve(spender, amount)` on `token`.
     */
    function signPermit2(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce,
        uint256 sigDeadline
    ) external;

    /// @notice Raw approval of `digest` (another Safe this one owns, logins, unknown typed data).
    ///         Matched as a CALL like the typed entries (SPEC.md §14 D-22), but no policy can price it.
    function signMessage(bytes32 digest) external;
}
