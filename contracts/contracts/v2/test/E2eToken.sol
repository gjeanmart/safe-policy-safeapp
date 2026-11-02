// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

/**
 * @title USDC-style token for the V2 end-to-end tests
 * @notice ERC-20 with `increaseAllowance` / `decreaseAllowance` and FiatToken v2.2's EIP-2612
 *         `permit(owner, spender, value, deadline, bytes signature)`, which validates a contract owner
 *         (a Safe) through ERC-1271 `isValidSignature`: the path Tim's permit attack uses.
 */
contract E2eToken {
    string public constant name = "USD Coin";
    string public constant version = "2";
    uint8 public constant decimals = 6;
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error PermitExpired();
    error InvalidSignature();

    /// @notice Test faucet.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice EIP-712 domain `("USD Coin", "2", chainid, this)`, as FiatToken.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256(bytes(name)),
                    keccak256(bytes(version)),
                    block.chainid,
                    this
                )
            );
    }

    /// @notice ERC-20 transfer.
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    /// @notice ERC-20 transferFrom.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    /// @notice ERC-20 approve.
    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    /// @notice FiatToken `increaseAllowance`.
    function increaseAllowance(address spender, uint256 added) external returns (bool) {
        _approve(msg.sender, spender, allowance[msg.sender][spender] + added);
        return true;
    }

    /// @notice FiatToken `decreaseAllowance` (reverts below zero).
    function decreaseAllowance(address spender, uint256 subtracted) external returns (bool) {
        uint256 current = allowance[msg.sender][spender];
        if (current < subtracted) revert InsufficientAllowance();
        _approve(msg.sender, spender, current - subtracted);
        return true;
    }

    /**
     * @notice FiatToken v2.2 EIP-2612 permit with a `bytes` signature: ECDSA for an EOA owner,
     *         ERC-1271 `isValidSignature(digest, signature)` for a contract owner.
     */
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata sig) external {
        if (deadline < block.timestamp) revert PermitExpired();
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), DOMAIN_SEPARATOR(), structHash));
        if (owner.code.length > 0) {
            (bool ok, bytes memory ret) = owner.staticcall(
                abi.encodeWithSignature("isValidSignature(bytes32,bytes)", digest, sig)
            );
            if (!ok || ret.length != 32 || abi.decode(ret, (bytes4)) != 0x1626ba7e) revert InvalidSignature();
        } else {
            if (sig.length != 65) revert InvalidSignature();
            (bytes32 r, bytes32 s) = abi.decode(sig[:64], (bytes32, bytes32));
            if (ecrecover(digest, uint8(sig[64]), r, s) != owner || owner == address(0)) revert InvalidSignature();
        }
        _approve(owner, spender, value);
    }

    function _move(address from, address to, uint256 amount) private {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _approve(address owner, address spender, uint256 amount) private {
        allowance[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }
}
