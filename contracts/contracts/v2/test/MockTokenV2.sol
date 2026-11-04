// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

/**
 * @title Mock ERC-20 for V2 policy tests
 * @notice Minimal token: the policies only read `allowance`; `setAllowance` lets a test put any
 *         allowance in place (as if a call had executed, or a spender had pulled tokens).
 */
contract MockTokenV2 {
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    function setAllowance(address owner, address spender, uint256 amount) external {
        allowance[owner][spender] = amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}
