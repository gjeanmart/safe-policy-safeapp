// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

/**
 * @title Engine test MultiSend
 * @notice `multiSend(bytes)` with MultiSend 1.4.1's packed encoding and semantics (DELEGATECALL
 *         only, `to == 0` is the calling Safe, sub-call DELEGATECALL allowed, any failure reverts),
 *         so engine tests execute real batches without the Safe artifacts.
 */
contract EngineMultiSend {
    address private immutable _SELF = address(this);

    error OnlyDelegateCall();
    error SubCallFailed(uint256 index);

    function multiSend(bytes memory transactions) external payable {
        require(address(this) != _SELF, OnlyDelegateCall());
        uint256 i;
        uint256 index;
        while (i < transactions.length) {
            uint8 operation;
            address to;
            uint256 value;
            uint256 dataLength;
            bytes memory data;
            assembly ("memory-safe") {
                let p := add(add(transactions, 0x20), i)
                operation := shr(0xf8, mload(p))
                to := shr(0x60, mload(add(p, 0x01)))
                value := mload(add(p, 0x15))
                dataLength := mload(add(p, 0x35))
            }
            if (to == address(0)) {
                to = address(this);
            }
            data = new bytes(dataLength);
            for (uint256 j = 0; j < dataLength; j++) {
                data[j] = transactions[i + 85 + j];
            }
            bool ok;
            if (operation == 0) {
                (ok, ) = to.call{value: value}(data);
            } else {
                (ok, ) = to.delegatecall(data);
            }
            require(ok, SubCallFailed(index));
            i += 85 + dataLength;
            index++;
        }
    }
}

/**
 * @title Batch recorder
 * @notice Records every call it receives (CALL or DELEGATECALL) for the differential MultiSend
 *         test: `id` is this deployment (an immutable, so a DELEGATECALL into it still reports
 *         it), `self` is `address(this)` (the Safe under DELEGATECALL).
 */
contract BatchRecorder {
    address private immutable _ID = address(this);

    event Recorded(address id, address self, uint256 value, bytes data);

    fallback() external payable {
        emit Recorded(_ID, address(this), msg.value, msg.data);
    }
}
