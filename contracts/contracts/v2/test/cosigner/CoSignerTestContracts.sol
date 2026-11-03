// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicy} from "../../interfaces/IPolicy.sol";
import {ERC1271_MAGIC_VALUE} from "../../libraries/Constants.sol";
import {Call, CallMatch, Context, Match, Scope} from "../../libraries/Types.sol";

/**
 * @title CoSigner engine stub (test only)
 * @notice Stands in for the engine: forwards `configure` and `check` so the policy sees this
 *         contract as `msg.sender`, the way it sees the real engine.
 */
contract CoSignerEngineStub {
    error BadVerdict(bytes4 verdict);

    function configure(address policy, address safe, bytes32 attachmentId, bytes calldata settings) external {
        IPolicy(policy).configure(safe, attachmentId, Scope(address(0), address(0), 0, CallMatch.ANY), 3, settings);
    }

    /// @notice Runs a check with one empty call per distinct `callIndex` in `matches`.
    function check(address policy, Context calldata ctx, Match[] calldata matches) external {
        uint256 calls;
        for (uint256 i; i < matches.length; ++i) {
            if (matches[i].callIndex >= calls) calls = matches[i].callIndex + 1;
        }
        bytes4 verdict = IPolicy(policy).check(ctx, new Call[](calls), matches);
        require(verdict == IPolicy.check.selector, BadVerdict(verdict));
    }
}

/**
 * @title CoSigner ERC-1271 approver (test only)
 * @notice A contract approver: approves the digests it was told to, whatever the signature bytes,
 *         and can call the policy itself (direct {approve} / {revoke} from a contract).
 */
contract CoSignerERC1271Approver {
    mapping(bytes32 digest => bool) public approved;

    function setApproved(bytes32 digest, bool value) external {
        approved[digest] = value;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? ERC1271_MAGIC_VALUE : bytes4(0xffffffff);
    }

    function exec(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
