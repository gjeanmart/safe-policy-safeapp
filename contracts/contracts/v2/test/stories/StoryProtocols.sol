// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicy} from "../../interfaces/IPolicy.sol";
import {Call, Context, Match, Scope} from "../../libraries/Types.sol";

/**
 * @title Protocol stand-ins for the rev 3 story tests (test only)
 * @notice Each mock has the real protocol's function signature, so the calldata layout the
 *         policies read (head words, selectors) is the real one. The bodies only do what a story
 *         needs to observe: pull the input token, record who the output went to.
 */

interface IStoryToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Aave v3 `Pool`: supply, withdraw, borrow, repay (real signatures).
contract StoryAavePool {
    mapping(address => mapping(address => uint256)) public supplied; // asset => onBehalfOf => amount
    mapping(address => mapping(address => uint256)) public debt; // asset => onBehalfOf => amount

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        IStoryToken(asset).transferFrom(msg.sender, address(this), amount);
        supplied[asset][onBehalfOf] += amount;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        supplied[asset][msg.sender] -= amount;
        IStoryToken(asset).transfer(to, amount);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        debt[asset][onBehalfOf] += amount;
        IStoryToken(asset).transfer(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        IStoryToken(asset).transferFrom(msg.sender, address(this), amount);
        debt[asset][onBehalfOf] -= amount;
        return amount;
    }
}

/// @notice Morpho Blue: `supply`, `borrow`, `withdraw`, `setAuthorization` (real signatures).
contract StoryMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    mapping(address => uint256) public supplyAssets; // onBehalf => assets
    mapping(address => mapping(address => bool)) public isAuthorized;

    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256,
        address onBehalf,
        bytes memory
    ) external returns (uint256, uint256) {
        IStoryToken(marketParams.loanToken).transferFrom(msg.sender, address(this), assets);
        supplyAssets[onBehalf] += assets;
        return (assets, assets);
    }

    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256) {
        require(onBehalf == msg.sender || isAuthorized[onBehalf][msg.sender], "unauthorized");
        supplyAssets[onBehalf] -= assets;
        IStoryToken(marketParams.loanToken).transfer(receiver, assets);
        return (assets, assets);
    }

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256) {
        require(onBehalf == msg.sender || isAuthorized[onBehalf][msg.sender], "unauthorized");
        IStoryToken(marketParams.loanToken).transfer(receiver, assets);
        return (assets, assets);
    }

    function setAuthorization(address authorized, bool newIsAuthorized) external {
        isAuthorized[msg.sender][authorized] = newIsAuthorized;
    }
}

/// @notice Uniswap SwapRouter02 `exactInputSingle` (the struct without `deadline`): 1:1 swap.
contract StoryUniswapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
        IStoryToken(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        IStoryToken(params.tokenOut).transfer(params.recipient, params.amountIn);
        return params.amountIn;
    }
}

/// @notice ENS `ETHRegistrarController` (2023): payable `register` and `renew`, 0.01 ETH a year.
contract StoryEnsController {
    uint256 public constant PRICE_PER_YEAR = 0.01 ether;
    mapping(bytes32 => address) public ownerOf;
    mapping(bytes32 => uint256) public expires;

    error InsufficientValue();

    function rentPrice(uint256 duration) public pure returns (uint256) {
        return (PRICE_PER_YEAR * duration) / 365 days;
    }

    function register(
        string calldata name,
        address owner,
        uint256 duration,
        bytes32,
        address,
        bytes[] calldata,
        bool,
        uint16
    ) external payable {
        require(msg.value >= rentPrice(duration), InsufficientValue());
        bytes32 label = keccak256(bytes(name));
        ownerOf[label] = owner;
        expires[label] = block.timestamp + duration;
    }

    function renew(string calldata name, uint256 duration) external payable {
        require(msg.value >= rentPrice(duration), InsufficientValue());
        expires[keccak256(bytes(name))] += duration;
    }
}

/// @notice CoW Protocol `GPv2Settlement.setPreSignature` and the vault relayer that pulls the sell token.
contract StoryCowSettlement {
    address public immutable vaultRelayer;
    mapping(bytes => uint256) public preSignature;

    constructor() {
        vaultRelayer = address(new StoryCowVaultRelayer());
    }

    function setPreSignature(bytes calldata orderUid, bool signed) external {
        // The real contract checks that msg.sender is the order owner (the last 20 bytes of the uid).
        require(orderUid.length == 56 && address(bytes20(orderUid[32:52])) == msg.sender, "owner");
        preSignature[orderUid] = signed ? type(uint256).max : 0;
    }
}

/// @notice Pulls an order's sell amount from its owner, as the real relayer does during settlement.
contract StoryCowVaultRelayer {
    function settle(address token, address owner, address receiver, uint256 amount) external {
        IStoryToken(token).transferFrom(owner, receiver, amount);
    }
}

/// @notice Minimal ERC-721 with the real selectors (same `transferFrom` / `approve` as ERC-20).
contract StoryNft {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from, "owner");
        require(
            msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender],
            "approved"
        );
        ownerOf[id] = to;
        delete getApproved[id];
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata) external {
        transferFrom(from, to, id);
    }

    function approve(address to, uint256 id) external {
        require(ownerOf[id] == msg.sender, "owner");
        getApproved[id] = to;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }
}

/// @notice Accepts any call (gas tests: distinct targets and selectors).
contract StoryTarget {
    fallback() external payable {}
}

/**
 * @notice A pass-only, stateless policy: the gas tests measure the engine's own dispatch cost with
 *         it (real policies add their own work on top).
 */
contract StoryPassPolicy is IPolicy {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IPolicy).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function configure(address, bytes32, Scope calldata, uint8, bytes calldata) external {}

    function check(Context calldata, Call[] calldata, Match[] calldata) external pure returns (bytes4) {
        return IPolicy.check.selector;
    }
}
