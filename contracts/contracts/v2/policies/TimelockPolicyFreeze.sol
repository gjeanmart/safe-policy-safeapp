// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {TimelockPolicyStorage} from "./TimelockPolicyQueue.sol";

/**
 * @title TimelockPolicy: freeze and lift
 * @notice Not a policy of its own: deployed first, passed to the {TimelockPolicy} constructor and
 *         reached by DELEGATECALL, so it runs on the policy's storage at the policy's address. Split
 *         out to keep each contract under 10,000 bytes. Behaviour: {ITimelockPolicy}.
 * @dev Freezes are bounded per guardian and Safe, not only per attachment: a guardian's first
 *      freeze opens a window of `MAX_FREEZE`, every later freeze of that guardian ends with the
 *      window, and once the window ends (or a lift leaves it nothing frozen) the guardian cannot
 *      freeze anything in that Safe for `COOLDOWN`. Per attachment, a frozen or cooling id is
 *      skipped. So one guardian freezes any attachment at most F per F + C, however many ids it
 *      guards (staggering two ids that both match the owners' `configure` no longer works).
 */
contract TimelockPolicyFreeze is TimelockPolicyStorage {
    /// @notice F: the longest a guardian's freezes last, from its first freeze in a window.
    uint256 public immutable MAX_FREEZE;
    /// @notice C: after a window ends, no freeze by that guardian (and of that id) for this long.
    uint256 public immutable COOLDOWN;

    address private immutable _SELF = address(this);

    /// @notice Called directly instead of through {TimelockPolicy}.
    error NotDelegated();

    /// @dev A direct call would act on this contract's own, unused storage.
    modifier onlyDelegated() {
        require(address(this) != _SELF, NotDelegated());
        _;
    }

    constructor(uint256 maxFreeze, uint256 cooldown) {
        MAX_FREEZE = maxFreeze;
        COOLDOWN = cooldown;
    }

    /**
     * @notice See {ITimelockPolicy-freeze}.
     * @dev A detached attachment has no guardians: otherwise a guardian removed by a detach could
     *      freeze it, and a later re-attach (same id) would inherit that freeze.
     */
    function freeze(address engine, address safe, bytes32[] calldata attachmentIds) external onlyDelegated {
        GuardianWindow storage w = _windows[engine][safe][msg.sender];
        (uint64 end, uint32 frozen) = (w.end, w.frozen);
        bool cooling = block.timestamp >= end && block.timestamp < end + COOLDOWN;
        if (block.timestamp >= end && !cooling) (end, frozen) = (uint64(block.timestamp + MAX_FREEZE), 0);
        for (uint256 i = 0; i < attachmentIds.length; i++) {
            bytes32 id = attachmentIds[i];
            bytes32 key = _keyOf(engine, safe, id);
            Attachment storage a = _attachments[key];
            (bool attached, ) = IPolicyGuard(engine).getAttachment(safe, id);
            require(attached && _contains(a.guardians, msg.sender), ITimelockPolicy.NotGuardian(id));
            uint64 until = cooling ? uint64(end + COOLDOWN) : block.timestamp < a.frozenUntil
                ? a.frozenUntil
                : a.cooldownUntil;
            if (block.timestamp < until) {
                emit ITimelockPolicy.FreezeSkipped(engine, safe, id, msg.sender, until);
                continue;
            }
            (a.frozenUntil, a.cooldownUntil) = (end, uint64(end + COOLDOWN));
            _frozenBy[key][msg.sender] = end;
            frozen++;
            emit ITimelockPolicy.Frozen(engine, safe, id, msg.sender, end);
        }
        // A window opens with its first actual freeze; an open window always has `frozen > 0`.
        if (frozen != 0) (w.end, w.frozen) = (end, frozen);
    }

    /**
     * @notice See {ITimelockPolicy-lift}.
     * @dev Releases the guardian that froze the id in its current window; a guardian left with
     *      nothing frozen starts its cooldown now, so it cannot re-freeze what was just lifted.
     */
    function lift(address engine, address safe, bytes32 attachmentId) external onlyDelegated {
        bytes32 key = _keyOf(engine, safe, attachmentId);
        Attachment storage a = _attachments[key];
        require(
            _contains(a.guardians, msg.sender) || _contains(a.lifters, msg.sender),
            ITimelockPolicy.NotGuardianOrLifter(attachmentId)
        );
        require(block.timestamp < a.frozenUntil, ITimelockPolicy.NotFrozen(attachmentId));
        uint64 cooldownUntil = uint64(block.timestamp + COOLDOWN);
        (a.frozenUntil, a.cooldownUntil) = (uint64(block.timestamp), cooldownUntil);
        address[] storage guardians = a.guardians;
        for (uint256 i = 0; i < guardians.length; i++) {
            GuardianWindow storage w = _windows[engine][safe][guardians[i]];
            uint64 end = w.end;
            if (end <= block.timestamp || _frozenBy[key][guardians[i]] != end) continue;
            delete _frozenBy[key][guardians[i]];
            if (--w.frozen == 0) w.end = uint64(block.timestamp);
        }
        emit ITimelockPolicy.Lifted(engine, safe, attachmentId, msg.sender, cooldownUntil);
    }
}
