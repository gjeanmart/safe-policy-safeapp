// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {ISafe} from "../../vendor/policy-engine/interfaces/ISafe.sol";
import {ISafeModuleGuard} from "../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {Scope} from "../libraries/Scope.sol";

/**
 * @title No-op guard V2 (test only)
 * @notice Implements Safe 1.5.0's transaction guard and module guard through the same vendored
 *         interfaces the V2 engine uses, allows everything, and emits what each hook received, so
 *         tests on a real Safe can see the exact hook arguments (e.g. the module address).
 * @dev `setBlocked(true)` makes every pre-hook revert `Blocked()`, to show a hook revert reverts
 *      the Safe call. The module hook returns `Scope.moduleCallHash`, as the engine does (SPEC §6.1).
 */
contract NoopGuardV2 is ISafeTransactionGuard, ISafeModuleGuard {
    bool public blocked;

    /// @notice Owner-path pre-hook ran. `txHash` is recomputed with `nonce() - 1` (SPEC §6.1).
    event TransactionChecked(
        address indexed safe,
        address to,
        uint256 value,
        bytes data,
        Operation operation,
        bytes signatures,
        address msgSender,
        uint256 nonce,
        bytes32 txHash
    );

    /// @notice The gas and refund fields the owner-path pre-hook received.
    event TransactionGasFields(
        address indexed safe,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver
    );

    event AfterExecutionChecked(address indexed safe, bytes32 hash, bool success);

    event ModuleTransactionChecked(
        address indexed safe,
        address to,
        uint256 value,
        bytes data,
        Operation operation,
        address module,
        bytes32 moduleTxHash
    );

    event AfterModuleExecutionChecked(address indexed safe, bytes32 hash, bool success);

    error Blocked();

    /// @notice Makes every pre-hook revert (`true`) or pass (`false`).
    function setBlocked(bool blocked_) external {
        blocked = blocked_;
    }

    /// @inheritdoc ISafeTransactionGuard
    function checkTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures,
        address msgSender
    ) external {
        require(!blocked, Blocked());
        // The Safe increments its nonce before calling the guard.
        uint256 nonce = ISafe(msg.sender).nonce() - 1;
        bytes32 txHash = ISafe(msg.sender).getTransactionHash(
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
        emit TransactionChecked(msg.sender, to, value, data, operation, signatures, msgSender, nonce, txHash);
        emit TransactionGasFields(msg.sender, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver);
    }

    /// @inheritdoc ISafeTransactionGuard
    function checkAfterExecution(bytes32 hash, bool success) external {
        emit AfterExecutionChecked(msg.sender, hash, success);
    }

    /// @inheritdoc ISafeModuleGuard
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        address module
    ) external returns (bytes32 moduleTxHash) {
        require(!blocked, Blocked());
        moduleTxHash = Scope.moduleCallHash(msg.sender, module, to, value, data, operation);
        emit ModuleTransactionChecked(msg.sender, to, value, data, operation, module, moduleTxHash);
    }

    /// @inheritdoc ISafeModuleGuard
    function checkAfterModuleExecution(bytes32 txHash, bool success) external {
        emit AfterModuleExecutionChecked(msg.sender, txHash, success);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(ISafeTransactionGuard).interfaceId ||
            interfaceId == type(ISafeModuleGuard).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
