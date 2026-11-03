// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

/**
 * @title Magic values of the rev 3 engine and policies
 * @dev File-level constants. Scope sentinels, levels and caps live in `ScopeLib` (Scope.sol).
 *      Mirrored in `src/lib/v2/rev3/types.ts`.
 */

/// @dev `bytes4(keccak256("multiSend(bytes)"))`: the only batch entry point the engine decodes.
bytes4 constant MULTI_SEND_SELECTOR = 0x8d80ff0a;

/// @dev ERC-1271 `isValidSignature(bytes32,bytes)` magic value.
bytes4 constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

/// @dev ArgsPolicy: a constraint whose `selector` is this applies to every call of the attachment.
bytes4 constant ANY_SELECTOR = 0xffffffff;

/// @dev ERC-20 selectors LimitPolicy prices (ERC-721 shares `transferFrom` and `approve`).
bytes4 constant ERC20_TRANSFER = 0xa9059cbb; //            transfer(address,uint256)
bytes4 constant ERC20_TRANSFER_FROM = 0x23b872dd; //       transferFrom(address,address,uint256)
bytes4 constant ERC20_APPROVE = 0x095ea7b3; //             approve(address,uint256)
bytes4 constant ERC20_INCREASE_ALLOWANCE = 0x39509351; //  increaseAllowance(address,uint256)
bytes4 constant ERC20_DECREASE_ALLOWANCE = 0xa457c2d7; //  decreaseAllowance(address,uint256)

/// @dev Caps on policy settings (each list of a TimelockPolicy / CoSignerPolicy attachment, and
///      ArgsPolicy / LimitPolicy sizes).
uint256 constant MAX_ROLE_MEMBERS = 8;
uint256 constant MAX_ARGS_CONSTRAINTS = 16;
uint256 constant MAX_ARGS_VALUES = 32;
uint256 constant MAX_LIMIT_TOKENS = 16;
