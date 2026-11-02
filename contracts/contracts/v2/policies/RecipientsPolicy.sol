// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {Operation} from "../../vendor/policy-engine/interfaces/Operation.sol";
import {PolicyBaseV2} from "../PolicyBaseV2.sol";
import {IPolicyEngineV2} from "../interfaces/IPolicyEngineV2.sol";
import {IPolicySignLib} from "../interfaces/IPolicySignLib.sol";
import {IRecipientsPolicy} from "../interfaces/policies/IRecipientsPolicy.sol";
import {Call, Context, PolicyLevel, ScopeData} from "../libraries/Types.sol";

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title RecipientsPolicy
 * @notice Call-level allowlist of where value goes (SPEC.md §8.3): native-value targets, ERC-20
 *         `transfer` / `transferFrom` recipients, `approve` / `increaseAllowance` / permit spenders
 *         with a cap on the approved amount, and CoW order receivers. Every matched attachment must
 *         accept the party; the Safe itself is always accepted.
 * @dev Membership lives in a mapping under a versioned key, so a reconfiguration replaces the
 *      lists without iterating the old ones. Checks are O(1) per attachment.
 */
contract RecipientsPolicy is PolicyBaseV2, IRecipientsPolicy {
    uint256 private constant MAX_LIST = 64;

    bytes4 private constant TRANSFER = 0xa9059cbb;
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;
    bytes4 private constant APPROVE = 0x095ea7b3;
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant DECREASE_ALLOWANCE = 0xa457c2d7;

    uint8 private constant RECIPIENT = 1;
    uint8 private constant SPENDER = 2;

    /// @notice Calldata of a known selector does not decode (too short or a dirty address word).
    error MalformedCall(bytes4 selector);

    struct Config {
        uint64 version;
        bool strict;
        uint256 maxApproval;
        address[] recipients;
        address[] spenders;
    }

    /// @dev What a call asks of the lists, besides the native-value target.
    enum Party {
        NONE, //         nothing to check (decreaseAllowance, approve(x, 0), zero-value empty call)
        RECIPIENT, //    `account` must be a recipient
        SPENDER, //      `account` must be a spender and `amount <= maxApproval`
        UNCLASSIFIED //  unknown shape: denied by strict attachments
    }

    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 settingsKey => Config) private $configs;
    // solhint-disable-next-line private-vars-leading-underscore
    mapping(bytes32 versionKey => mapping(address account => uint8 roles)) private $members;

    /// @inheritdoc PolicyBaseV2
    function policyLevel() public pure override returns (PolicyLevel) {
        return PolicyLevel.CALL;
    }

    /// @inheritdoc IRecipientsPolicy
    function isRecipient(
        address engine,
        address safe,
        bytes32 attachmentId,
        address account
    ) external view returns (bool) {
        return _hasRole(_settingsKey(engine, safe, attachmentId), account, RECIPIENT);
    }

    /// @inheritdoc IRecipientsPolicy
    function isSpender(
        address engine,
        address safe,
        bytes32 attachmentId,
        address account
    ) external view returns (bool) {
        return _hasRole(_settingsKey(engine, safe, attachmentId), account, SPENDER);
    }

    /// @inheritdoc IRecipientsPolicy
    function getSettings(address engine, address safe, bytes32 attachmentId) external view returns (Settings memory) {
        Config storage cfg = $configs[_settingsKey(engine, safe, attachmentId)];
        return Settings(cfg.recipients, cfg.spenders, cfg.maxApproval, cfg.strict);
    }

    /// @inheritdoc IRecipientsPolicy
    function encodeSettings(Settings calldata settings) external pure returns (bytes memory) {
        return abi.encode(settings);
    }

    function _configure(
        address engine,
        address safe,
        bytes32 attachmentId,
        ScopeData calldata,
        uint8,
        bytes calldata data
    ) internal override returns (uint256) {
        Settings memory s = abi.decode(data, (Settings));
        require(s.recipients.length <= MAX_LIST && s.spenders.length <= MAX_LIST, InvalidSettings());

        bytes32 key = _settingsKey(engine, safe, attachmentId);
        Config storage cfg = $configs[key];
        uint64 version = cfg.version + 1;
        cfg.version = version;
        cfg.strict = s.strict;
        cfg.maxApproval = s.maxApproval;
        cfg.recipients = s.recipients;
        cfg.spenders = s.spenders;

        mapping(address => uint8) storage members = $members[_versionKey(key, version)];
        _addAll(members, s.recipients, RECIPIENT);
        _addAll(members, s.spenders, SPENDER);
        return 0;
    }

    function _checkCall(
        address engine,
        Context calldata ctx,
        Call calldata call,
        bytes32[] calldata attachmentIds
    ) internal override {
        bytes4 selector = bytes4(call.data);
        (Party party, address account, uint256 amount) = _classify(engine, ctx.safe, call, selector);
        bool nativeTarget = call.value != 0 && call.to != ctx.safe;
        if (account == ctx.safe && party != Party.UNCLASSIFIED) party = Party.NONE;

        for (uint256 i; i < attachmentIds.length; ++i) {
            bytes32 key = _settingsKey(engine, ctx.safe, attachmentIds[i]);
            Config storage cfg = $configs[key];
            mapping(address => uint8) storage members = $members[_versionKey(key, cfg.version)];

            if (nativeTarget) require(members[call.to] & RECIPIENT != 0, RecipientNotAllowed(call.to));
            if (party == Party.RECIPIENT) {
                require(members[account] & RECIPIENT != 0, RecipientNotAllowed(account));
            } else if (party == Party.SPENDER) {
                require(members[account] & SPENDER != 0, SpenderNotAllowed(account));
                uint256 maxApproval = cfg.maxApproval;
                require(amount <= maxApproval, ApprovalTooLarge(amount, maxApproval));
            } else if (party == Party.UNCLASSIFIED) {
                require(!cfg.strict, UnclassifiedCall(selector));
            }
        }
    }

    /**
     * @dev Decodes the party of `call`. ERC-20 shapes count only as CALLs; the typed sign-lib
     *      entries only as DELEGATECALLs to the engine's `SIGN_LIB` (anything else under those
     *      selectors is unclassified). An approval of 0 is a revocation and needs no listing.
     */
    function _classify(
        address engine,
        address safe,
        Call calldata call,
        bytes4 selector
    ) private returns (Party party, address account, uint256 amount) {
        bytes calldata data = call.data;
        if (data.length == 0) return (call.value != 0 ? Party.NONE : Party.UNCLASSIFIED, address(0), 0);

        if (call.operation == Operation.CALL) {
            if (selector == TRANSFER) {
                _wordAt(data, 1, selector);
                return (Party.RECIPIENT, _addressAt(data, 0, selector), 0);
            }
            if (selector == TRANSFER_FROM) {
                _wordAt(data, 2, selector);
                _addressAt(data, 0, selector);
                return (Party.RECIPIENT, _addressAt(data, 1, selector), 0);
            }
            if (selector == APPROVE) {
                account = _addressAt(data, 0, selector);
                amount = _wordAt(data, 1, selector);
                _setExpectedAllowance(engine, safe, call.to, account, amount);
                return (amount == 0 ? Party.NONE : Party.SPENDER, account, amount);
            }
            if (selector == INCREASE_ALLOWANCE) {
                account = _addressAt(data, 0, selector);
                uint256 added = _wordAt(data, 1, selector);
                uint256 current = _allowance(engine, safe, call.to, account);
                amount = added > type(uint256).max - current ? type(uint256).max : current + added;
                _setExpectedAllowance(engine, safe, call.to, account, amount);
                return (Party.SPENDER, account, amount);
            }
            if (selector == DECREASE_ALLOWANCE) {
                account = _addressAt(data, 0, selector);
                _wordAt(data, 1, selector);
                return (Party.NONE, account, 0);
            }
        } else if (_isSignLibCall(engine, call.to, selector)) {
            if (selector == IPolicySignLib.signCowOrder.selector) {
                // GPv2Order.receiver is word 2; address(0) means the Safe.
                _wordAt(data, 11, selector);
                account = _addressAt(data, 2, selector);
                return (Party.RECIPIENT, account == address(0) ? safe : account, 0);
            }
            // signPermit(token, spender, value, ...) and signPermit2(token, spender, amount, ...).
            _wordAt(data, selector == IPolicySignLib.signPermit.selector ? 4 : 5, selector);
            account = _addressAt(data, 1, selector);
            amount = _wordAt(data, 2, selector);
            return (Party.SPENDER, account, amount);
        }
        return (Party.UNCLASSIFIED, address(0), 0);
    }

    function _isSignLibCall(address engine, address to, bytes4 selector) private view returns (bool) {
        return
            (selector == IPolicySignLib.signPermit.selector ||
                selector == IPolicySignLib.signPermit2.selector ||
                selector == IPolicySignLib.signCowOrder.selector) && to == IPolicyEngineV2(engine).SIGN_LIB();
    }

    /**
     * @dev The allowance an `increaseAllowance` builds on. Checks run before any call executes, so
     *      inside a batch an earlier `approve` / `increaseAllowance` of the same pair is not visible
     *      on-chain yet: the larger of the on-chain value and the value expected after the earlier
     *      sub-calls (transient) is used. A stale transient value (another Safe transaction in the
     *      same EVM transaction) can only make the check stricter.
     */
    function _allowance(address engine, address safe, address token, address spender) private view returns (uint256) {
        uint256 onChain = IERC20Allowance(token).allowance(safe, spender);
        uint256 expected = _expectedAllowance(engine, safe, token, spender);
        return expected > onChain ? expected : onChain;
    }

    function _expectedAllowance(
        address engine,
        address safe,
        address token,
        address spender
    ) private view returns (uint256 value) {
        bytes32 slot = _allowanceSlot(engine, safe, token, spender);
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }

    function _setExpectedAllowance(address engine, address safe, address token, address spender, uint256 value) private {
        bytes32 slot = _allowanceSlot(engine, safe, token, spender);
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _allowanceSlot(address engine, address safe, address token, address spender) private pure returns (bytes32) {
        return keccak256(abi.encode("RecipientsPolicy.allowance", engine, safe, token, spender));
    }

    function _hasRole(bytes32 key, address account, uint8 role) private view returns (bool) {
        return $members[_versionKey(key, $configs[key].version)][account] & role != 0;
    }

    function _addAll(mapping(address => uint8) storage members, address[] memory accounts, uint8 role) private {
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            uint8 roles = members[account];
            require(account != address(0) && roles & role == 0, InvalidSettings());
            members[account] = roles | role;
        }
    }

    function _versionKey(bytes32 key, uint64 version) private pure returns (bytes32) {
        return keccak256(abi.encode(key, version));
    }

    /// @dev Static argument word `index` (0-based, after the selector); reverts if the data is short.
    function _wordAt(bytes calldata data, uint256 index, bytes4 selector) private pure returns (uint256 word) {
        uint256 offset = 4 + 32 * index;
        require(data.length >= offset + 32, MalformedCall(selector));
        word = uint256(bytes32(data[offset:offset + 32]));
    }

    function _addressAt(bytes calldata data, uint256 index, bytes4 selector) private pure returns (address) {
        uint256 word = _wordAt(data, index, selector);
        require(word >> 160 == 0, MalformedCall(selector));
        return address(uint160(word));
    }
}
