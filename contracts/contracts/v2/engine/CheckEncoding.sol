// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Call, Context} from "../libraries/Types.sol";

/**
 * @dev The ABI-encoded calldata `selector(ctx, one, ids)` (`isTx` false: the layout of
 *      `IPolicyV2.checkCall`) or `selector(ctx, calls, signatures, policyData, ids)` (`isTx` true:
 *      the layout of `IPolicyV2.checkTransaction`).
 *      Hand-written: the generic via-IR encoder costs ~2.5k gas per policy run.
 */
function encodeCheck(
    bytes4 selector,
    bool isTx,
    Context memory ctx,
    Call memory one,
    Call[] memory calls,
    bytes calldata signatures,
    bytes memory policyData,
    bytes32[] memory ids
) pure returns (bytes memory data) {
    assembly ("memory-safe") {
        // `len` bytes at `src` as `[len][bytes, zero-padded]` at `dst`; returns the end.
        function writeBytes(dst, src, len) -> end {
            mstore(dst, len)
            let padded := and(add(len, 31), not(31))
            if padded {
                mstore(add(dst, padded), 0)
            }
            mcopy(add(dst, 0x20), src, len)
            end := add(add(dst, 0x20), padded)
        }
        // The tuple `(to, value, data, operation)` of the memory Call `c` at `dst`; returns the end.
        function writeCall(dst, c) -> end {
            let bytesPtr := mload(add(c, 0x40))
            mstore(dst, mload(c))
            mstore(add(dst, 0x20), mload(add(c, 0x20)))
            mstore(add(dst, 0x40), 0x80)
            mstore(add(dst, 0x60), mload(add(c, 0x60)))
            end := writeBytes(add(dst, 0x80), add(bytesPtr, 0x20), mload(bytesPtr))
        }

        data := mload(0x40)
        let start := add(data, 0x20)
        mstore(start, selector)
        // Head: the 5 static Context words, then one offset per dynamic argument.
        let head := add(start, 4)
        mcopy(head, ctx, 0xa0)
        let cur
        switch isTx
        case 0 {
            mstore(add(head, 0xa0), 0xe0)
            cur := writeCall(add(head, 0xe0), one)
            mstore(add(head, 0xc0), sub(cur, head))
        }
        default {
            mstore(add(head, 0xa0), 0x120)
            let n := mload(calls)
            mstore(add(head, 0x120), n)
            let offsets := add(head, 0x140)
            cur := add(offsets, shl(5, n))
            for {
                let i := 0
            } lt(i, n) {
                i := add(i, 1)
            } {
                mstore(add(offsets, shl(5, i)), sub(cur, offsets))
                cur := writeCall(cur, mload(add(calls, shl(5, add(i, 1)))))
            }
            mstore(add(head, 0xc0), sub(cur, head))
            let length := signatures.length
            mstore(cur, length)
            let padded := and(add(length, 31), not(31))
            if padded {
                mstore(add(cur, padded), 0)
            }
            calldatacopy(add(cur, 0x20), signatures.offset, length)
            cur := add(add(cur, 0x20), padded)
            mstore(add(head, 0xe0), sub(cur, head))
            cur := writeBytes(cur, add(policyData, 0x20), mload(policyData))
            mstore(add(head, 0x100), sub(cur, head))
        }
        let idsSize := shl(5, add(mload(ids), 1))
        mcopy(cur, ids, idsSize)
        cur := add(cur, idsSize)
        mstore(data, sub(cur, start))
        mstore(0x40, and(add(cur, 31), not(31)))
    }
}
