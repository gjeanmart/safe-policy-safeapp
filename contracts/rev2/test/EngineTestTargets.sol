// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IERC165} from "../../vendor/policy-engine/interfaces/IERC165.sol";
import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {IPolicyV2} from "../interfaces/IPolicyV2.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

/// @title Engine test target: records calls (CALL or DELEGATECALL) and accepts value.
contract EngineTarget {
    event Hit(address sender, address self, uint256 value, bytes data);

    fallback() external payable {
        emit Hit(msg.sender, address(this), msg.value, msg.data);
    }

    receive() external payable {
        emit Hit(msg.sender, address(this), msg.value, "");
    }
}

/// @title Engine test module: forwards to `execTransactionFromModule` of any Safe.
contract EngineModule {
    function exec(address safe, address to, uint256 value, bytes calldata data, Operation operation) external {
        (bool ok, bytes memory ret) = safe.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes,uint8)",
                to,
                value,
                data,
                uint8(operation)
            )
        );
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        require(abi.decode(ret, (bool)), "module tx failed");
    }
}

/**
 * @title Engine test policy that calls back into the engine during a check
 * @notice Settings: `abi.encode(bytes callData)`, the call made to the engine on every check; a
 *         revert of that call is bubbled, so the engine reports it as the deny reason.
 */
contract EngineReentrantPolicy is IPolicyV2 {
    PolicyLevel private immutable _LEVEL;
    mapping(address engine => mapping(address safe => bytes)) public callOf;

    constructor(PolicyLevel level) {
        _LEVEL = level;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPolicyV2).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function policyLevel() external view returns (PolicyLevel) {
        return _LEVEL;
    }

    function configure(
        address safe,
        bytes32,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) external returns (uint256) {
        callOf[msg.sender][safe] = abi.decode(data, (bytes));
        return 0;
    }

    function checkCall(Context calldata ctx, Call calldata, bytes32[] calldata) external returns (bytes4) {
        _reenter(ctx.safe);
        return IPolicyV2.checkCall.selector;
    }

    function checkTransaction(
        Context calldata ctx,
        Call[] calldata,
        bytes calldata,
        bytes calldata,
        bytes32[] calldata
    ) external returns (bytes4) {
        _reenter(ctx.safe);
        return IPolicyV2.checkTransaction.selector;
    }

    function _reenter(address safe) private {
        bytes memory callData = callOf[msg.sender][safe];
        if (callData.length == 0) {
            // No callback configured: revert with 1000 bytes (reason truncation test).
            assembly ("memory-safe") {
                revert(0, 1000)
            }
        }
        (bool ok, bytes memory ret) = msg.sender.call(callData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// @title Engine test policy that writes state on every check (to prove `preview` never persists).
contract EngineCountingPolicy is IPolicyV2 {
    PolicyLevel private immutable _LEVEL;
    uint256 public checks;

    constructor(PolicyLevel level) {
        _LEVEL = level;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPolicyV2).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function policyLevel() external view returns (PolicyLevel) {
        return _LEVEL;
    }

    function configure(address, bytes32, ScopeData calldata, uint8, bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function checkCall(Context calldata, Call calldata, bytes32[] calldata) external returns (bytes4) {
        checks++;
        return IPolicyV2.checkCall.selector;
    }

    function checkTransaction(
        Context calldata,
        Call[] calldata,
        bytes calldata,
        bytes calldata,
        bytes32[] calldata
    ) external returns (bytes4) {
        checks++;
        return IPolicyV2.checkTransaction.selector;
    }
}

/// @title Engine test policy-like contracts that fail attach-time validation.
contract EngineBadPolicy {
    /// @dev 0: supportsInterface false; 1: policyLevel out of range; 2: configure returns no data.
    uint256 public immutable MODE;

    constructor(uint256 mode) {
        MODE = mode;
    }

    function supportsInterface(bytes4) external view returns (bool) {
        return MODE != 0;
    }

    function policyLevel() external view returns (uint256) {
        return MODE == 1 ? 7 : 0;
    }

    function configure(address, bytes32, ScopeData calldata, uint8, bytes calldata) external pure {
        assembly ("memory-safe") {
            return(0, 0)
        }
    }
}
