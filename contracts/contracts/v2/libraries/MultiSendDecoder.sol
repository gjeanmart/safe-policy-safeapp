// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {MULTI_SEND_SELECTOR} from "./Constants.sol";
import {ScopeLib} from "./Scope.sol";
import {Call} from "./Types.sol";

/**
 * @title MultiSend decoder
 * @notice Decodes `multiSend(bytes transactions)` calldata (MultiSend / MultiSendCallOnly 1.4.1+)
 *         into the calls the Safe will execute, so the engine checks exactly what runs.
 * @dev Never reverts: malformed input returns `ok == false` and the engine denies it with
 *      `MalformedBatch`. The accepted encodings are a strict subset of what MultiSend executes, so
 *      a batch that decodes here is executed entry for entry as decoded:
 *      - selector `0x8d80ff0a`, ABI head offset exactly `0x20`, the `bytes` payload in bounds;
 *      - each entry `uint8 op | address to | uint256 value | uint256 dataLength | bytes data`
 *        (packed, 85-byte header), fully inside the payload; `op` 0 or 1;
 *      - `to == address(0)` resolves to the Safe. MultiSend / MultiSendCallOnly 1.5.0 do the same
 *        (`address()` under DELEGATECALL); 1.4.1 does not, it calls `address(0)` (checked against
 *        the v1.4.1 source). Judging such a sub-call as a call to the Safe is the safe side:
 *        module calls to the Safe need a level-5 Allow (F5) and Safe-scoped DENYs and policies
 *        apply. If an Allow on the Safe grants it, a call to `address(0)` runs no code, so the
 *        worst case is its value burnt at `address(0)`, priced by Limit like any value (the
 *        preview labels it "to the Safe"). Never resolve the other way: a Safe call judged as a
 *        call to `address(0)` would dodge F5;
 *      - between 1 and `ScopeLib.MAX_BATCH_CALLS` entries (`tooMany` reports the cap separately).
 *      Adapted from V1 `MultiSendPolicy` (safe-research/policy-engine 8ee68a8).
 */
library MultiSendDecoder {
    uint256 private constant _ENTRY_HEADER = 85;

    /**
     * @param safe The Safe executing the batch; replaces a zero `to`.
     * @param data The full calldata of the DELEGATECALL to the batch contract.
     * @return ok Whether `data` is a well-formed, non-empty batch within the cap.
     * @return tooMany True when well-formed up to the cap but holding more than
     *         `ScopeLib.MAX_BATCH_CALLS` entries (then `ok` is false).
     * @return calls The decoded calls (empty unless `ok`).
     */
    function decode(
        address safe,
        bytes calldata data
    ) internal pure returns (bool ok, bool tooMany, Call[] memory calls) {
        if (data.length < 68 || bytes4(data[:4]) != MULTI_SEND_SELECTOR) {
            return (false, false, calls);
        }
        if (uint256(bytes32(data[4:36])) != 0x20) {
            return (false, false, calls);
        }
        uint256 length = uint256(bytes32(data[36:68]));
        if (length > data.length - 68) {
            return (false, false, calls);
        }
        bytes calldata txs = data[68:68 + length];

        Call[] memory buffer = new Call[](ScopeLib.MAX_BATCH_CALLS);
        uint256 count;
        uint256 i;
        while (i < txs.length) {
            if (txs.length - i < _ENTRY_HEADER) {
                return (false, false, calls);
            }
            uint8 op = uint8(txs[i]);
            if (op > 1) {
                return (false, false, calls);
            }
            uint256 dataLength = uint256(bytes32(txs[i + 53:i + 85]));
            if (dataLength > txs.length - i - _ENTRY_HEADER) {
                return (false, false, calls);
            }
            if (count == ScopeLib.MAX_BATCH_CALLS) {
                return (false, true, calls);
            }
            address to = address(bytes20(txs[i + 1:i + 21]));
            buffer[count] = Call({
                to: to == address(0) ? safe : to,
                value: uint256(bytes32(txs[i + 21:i + 53])),
                data: txs[i + 85:i + 85 + dataLength],
                operation: Operation(op)
            });
            count++;
            i += _ENTRY_HEADER + dataLength;
        }
        if (count == 0) {
            return (false, false, calls);
        }

        calls = buffer;
        // Shrink the buffer in place to the decoded count.
        assembly ("memory-safe") {
            mstore(calls, count)
        }
        return (true, false, calls);
    }
}
