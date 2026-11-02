// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafeModuleGuard} from "../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";

/**
 * @title Mock Safe V2
 * @notice A minimal Safe for engine unit tests. It really executes calls (CALL and DELEGATECALL)
 *         and calls the guard hooks in Safe 1.5.0's order:
 *         - `execTransaction`: nonce++, `checkTransaction(..., signatures, msg.sender)`, execute,
 *           GS013 if a zero-gas transaction failed, `checkAfterExecution(txHash, success)`;
 *         - `execTransactionFromModule`: enabled-module check, `checkModuleTransaction(..., module)`
 *           returning the guard hash, execute, `checkAfterModuleExecution(guardHash, success)`.
 * @dev No owner signatures: anyone can call `execTransaction` (tests only). The guard and module
 *      guard live at Safe's real storage slots so `getStorageAt` answers as a Safe does. The
 *      transaction hash binds chain id, Safe and every field like Safe's, but is not EIP-712.
 */
contract MockSafeV2 {
    bytes32 private constant _GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    bytes32 private constant _MODULE_GUARD_STORAGE_SLOT =
        0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    uint256 public nonce;
    mapping(address module => bool) public isModuleEnabled;

    event ExecutionSuccess(bytes32 txHash);
    event ExecutionFailure(bytes32 txHash);
    event ModuleExecution(address module, bool success);
    event Received(address from, uint256 value);

    error GS013();
    error NotModule();
    error NotSelf();

    modifier onlySelf() {
        require(msg.sender == address(this), NotSelf());
        _;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    function setGuard(address guard) external onlySelf {
        bytes32 slot = _GUARD_STORAGE_SLOT;
        assembly ("memory-safe") {
            sstore(slot, guard)
        }
    }

    function setModuleGuard(address guard) external onlySelf {
        bytes32 slot = _MODULE_GUARD_STORAGE_SLOT;
        assembly ("memory-safe") {
            sstore(slot, guard)
        }
    }

    function enableModule(address module) external onlySelf {
        isModuleEnabled[module] = true;
    }

    function disableModule(address module) external onlySelf {
        isModuleEnabled[module] = false;
    }

    function getGuard() public view returns (address guard) {
        bytes32 slot = _GUARD_STORAGE_SLOT;
        assembly ("memory-safe") {
            guard := sload(slot)
        }
    }

    function getModuleGuard() public view returns (address guard) {
        bytes32 slot = _MODULE_GUARD_STORAGE_SLOT;
        assembly ("memory-safe") {
            guard := sload(slot)
        }
    }

    /// @notice As Safe's `StorageAccessible.getStorageAt`.
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory result) {
        result = new bytes(length * 32);
        for (uint256 i = 0; i < length; i++) {
            assembly ("memory-safe") {
                mstore(add(add(result, 0x20), mul(i, 0x20)), sload(add(offset, i)))
            }
        }
    }

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce_
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    to,
                    value,
                    keccak256(data),
                    operation,
                    safeTxGas,
                    baseGas,
                    gasPrice,
                    gasToken,
                    refundReceiver,
                    nonce_
                )
            );
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success) {
        bytes32 txHash = getTransactionHash(
            to,
            value,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            nonce
        );
        nonce++;
        address guard = getGuard();
        if (guard != address(0)) {
            ISafeTransactionGuard(guard).checkTransaction(
                to,
                value,
                data,
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                signatures,
                msg.sender
            );
        }
        success = _execute(to, value, data, operation);
        require(success || safeTxGas != 0 || gasPrice != 0, GS013());
        if (success) {
            emit ExecutionSuccess(txHash);
        } else {
            emit ExecutionFailure(txHash);
        }
        if (guard != address(0)) {
            ISafeTransactionGuard(guard).checkAfterExecution(txHash, success);
        }
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) public returns (bool success) {
        require(isModuleEnabled[msg.sender], NotModule());
        address guard = getModuleGuard();
        bytes32 guardHash;
        if (guard != address(0)) {
            guardHash = ISafeModuleGuard(guard).checkModuleTransaction(to, value, data, operation, msg.sender);
        }
        success = _execute(to, value, data, operation);
        emit ModuleExecution(msg.sender, success);
        if (guard != address(0)) {
            ISafeModuleGuard(guard).checkAfterModuleExecution(guardHash, success);
        }
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success, bytes memory returnData) {
        success = execTransactionFromModule(to, value, data, operation);
        returnData = "";
    }

    function _execute(address to, uint256 value, bytes memory data, Operation operation) private returns (bool ok) {
        if (operation == Operation.DELEGATECALL) {
            assembly ("memory-safe") {
                ok := delegatecall(gas(), to, add(data, 0x20), mload(data), 0, 0)
            }
        } else {
            assembly ("memory-safe") {
                ok := call(gas(), to, value, add(data, 0x20), mload(data), 0, 0)
            }
        }
    }
}
