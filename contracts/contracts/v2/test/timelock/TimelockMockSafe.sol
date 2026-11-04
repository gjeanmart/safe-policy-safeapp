// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {ISafeModuleGuard} from "../../../vendor/policy-engine/interfaces/ISafeModuleGuard.sol";
import {ISafeTransactionGuard} from "../../../vendor/policy-engine/interfaces/ISafeTransactionGuard.sol";
import {Operation} from "../../../vendor/policy-engine/interfaces/Operation.sol";

/**
 * @title Timelock mock Safe
 * @notice Minimal Safe 1.5.0 double for the TimelockPolicy tests: EIP-712 transaction hash,
 *         `checkNSignatures` (ECDSA, eth_sign, and `v == 1` from the executor), nonce, owners,
 *         threshold, modules, and the guard hooks around a real CALL (nonce incremented before
 *         `checkTransaction`, as 1.5.0 does). DELEGATECALL is checked but not executed. Admin
 *         functions are self-calls, as in Safe. `execTransaction` takes zero gas fields only.
 */
contract TimelockMockSafe {
    bytes32 private constant _DOMAIN_SEPARATOR_TYPEHASH =
        0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;
    bytes32 private constant _SAFE_TX_TYPEHASH = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;

    error InvalidSignatures();
    error NotSelf();
    error ModuleNotEnabled(address module);
    error CallFailed();

    address public guard;
    uint256 public nonce;
    uint256 private _threshold;
    address[] private _owners;
    mapping(address => bool) public isOwner;
    mapping(address => bool) public isModuleEnabled;

    constructor(address[] memory owners, uint256 threshold, address guard_, address[] memory modules) {
        for (uint256 i = 0; i < owners.length; i++) {
            isOwner[owners[i]] = true;
        }
        for (uint256 i = 0; i < modules.length; i++) {
            isModuleEnabled[modules[i]] = true;
        }
        _owners = owners;
        _threshold = threshold;
        guard = guard_;
    }

    receive() external payable {}

    modifier onlySelf() {
        require(msg.sender == address(this), NotSelf());
        _;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
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
        bytes32 safeTxHash = keccak256(
            abi.encode(
                _SAFE_TX_TYPEHASH,
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
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeTxHash));
    }

    /// @dev `v == 1`: accepted from the executor only (no approved-hash storage); `v > 30`: eth_sign.
    function checkNSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 requiredSignatures
    ) public view {
        require(requiredSignatures != 0 && signatures.length >= requiredSignatures * 65, InvalidSignatures());
        address last;
        for (uint256 i = 0; i < requiredSignatures; i++) {
            uint8 v;
            bytes32 r;
            bytes32 s;
            assembly ("memory-safe") {
                let pos := add(add(signatures, 0x20), mul(i, 65))
                r := mload(pos)
                s := mload(add(pos, 0x20))
                v := byte(0, mload(add(pos, 0x40)))
            }
            address owner;
            if (v == 1) {
                owner = address(uint160(uint256(r)));
                require(owner == executor, InvalidSignatures());
            } else if (v > 30) {
                owner = ecrecover(
                    keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash)),
                    v - 4,
                    r,
                    s
                );
            } else {
                owner = ecrecover(dataHash, v, r, s);
            }
            require(owner > last && isOwner[owner], InvalidSignatures());
            last = owner;
        }
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        bytes calldata signatures
    ) external returns (bool) {
        bytes32 txHash = getTransactionHash(to, value, data, operation, 0, 0, 0, address(0), address(0), nonce);
        nonce++;
        checkNSignatures(msg.sender, txHash, signatures, _threshold);
        if (guard != address(0)) {
            ISafeTransactionGuard(guard).checkTransaction(
                to,
                value,
                data,
                operation,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                signatures,
                msg.sender
            );
        }
        bool success = _execute(to, value, data, operation);
        if (guard != address(0)) ISafeTransactionGuard(guard).checkAfterExecution(txHash, success);
        require(success, CallFailed());
        return true;
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success) {
        require(isModuleEnabled[msg.sender], ModuleNotEnabled(msg.sender));
        bytes32 hash;
        if (guard != address(0)) {
            hash = ISafeModuleGuard(guard).checkModuleTransaction(to, value, data, operation, msg.sender);
        }
        success = _execute(to, value, data, operation);
        if (guard != address(0)) ISafeModuleGuard(guard).checkAfterModuleExecution(hash, success);
    }

    /// @dev Simplified: replaces `oldOwner` in place (`prevOwner` is ignored).
    function swapOwner(address, address oldOwner, address newOwner) external onlySelf {
        require(isOwner[oldOwner] && !isOwner[newOwner] && newOwner != address(0), CallFailed());
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == oldOwner) _owners[i] = newOwner;
        }
        isOwner[oldOwner] = false;
        isOwner[newOwner] = true;
    }

    function enableModule(address module) external onlySelf {
        isModuleEnabled[module] = true;
    }

    function disableModule(address, address module) external onlySelf {
        isModuleEnabled[module] = false;
    }

    function _execute(address to, uint256 value, bytes calldata data, Operation operation) private returns (bool) {
        if (operation == Operation.DELEGATECALL) return true;
        (bool success, ) = to.call{value: value}(data);
        return success;
    }
}
