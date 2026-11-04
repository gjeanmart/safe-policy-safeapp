// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {IPolicyGuard} from "../interfaces/IPolicyGuard.sol";
import {ITimelockPolicy} from "../interfaces/policies/ITimelockPolicy.sol";
import {
    SAFE_DISABLE_MODULE,
    SAFE_ENABLE_MODULE,
    SAFE_SET_FALLBACK_HANDLER,
    SAFE_SET_GUARD,
    SAFE_SET_MODULE_GUARD
} from "../libraries/Constants.sol";
import {ScopeLib} from "../libraries/Scope.sol";
import {AttachmentView, CallMatch, Kind, Scope} from "../libraries/Types.sol";
import {TimelockPolicyStorage} from "./TimelockPolicyQueue.sol";

/**
 * @title TimelockPolicy: freeze, lift and the covering rule
 * @notice Not a policy of its own: deployed first, passed to the {TimelockPolicy} constructor and
 *         reached by DELEGATECALL, so it runs on the policy's storage at the policy's address. Split
 *         out to keep each contract under 10,000 bytes. Behaviour: {ITimelockPolicy}.
 * @dev Freezes are bounded per actor and Safe, whoever the guardians and whatever the attachments:
 *      the first freeze of one of an actor's attachments opens that actor's window (`MAX_FREEZE`),
 *      every later freeze of that actor's attachments ends with the window, and once it ends (or a
 *      lift leaves nothing of the actor frozen) none of them can be frozen for `COOLDOWN`. So the
 *      transactions of an actor are frozen at most F per F + C, however many guardians collude
 *      over however many attachments of this deployment (rev 4, review A4). The window lives in
 *      this policy's storage: a second TimelockPolicy deployment attached at the same actor has
 *      its own (the app refuses policies outside its deployment).
 */
contract TimelockPolicyFreeze is TimelockPolicyStorage {
    /// @notice F: the longest an actor's attachments stay frozen, from the first freeze of a window.
    uint256 public immutable MAX_FREEZE;
    /// @notice C: after a window ends, no freeze of that actor's attachments for this long.
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
        for (uint256 i = 0; i < attachmentIds.length; i++) {
            bytes32 id = attachmentIds[i];
            Attachment storage a = _attachments[_keyOf(engine, safe, id)];
            (bool attached, ) = IPolicyGuard(engine).getAttachment(safe, id);
            require(attached && _contains(a.guardians, msg.sender), ITimelockPolicy.NotGuardian(id));
            ActorWindow storage w = _actorWindows[engine][safe][a.actor];
            uint64 end = w.end;
            bool cooling = end != 0 && block.timestamp >= end && block.timestamp < end + COOLDOWN;
            uint64 until = cooling ? uint64(end + COOLDOWN) : block.timestamp < a.frozenUntil
                ? a.frozenUntil
                : a.cooldownUntil;
            if (block.timestamp < until) {
                emit ITimelockPolicy.FreezeSkipped(engine, safe, id, msg.sender, until);
                continue;
            }
            if (block.timestamp >= end) {
                // Past the actor's window and its cooldown: this freeze opens a new window.
                end = uint64(block.timestamp + MAX_FREEZE);
                (w.end, w.frozen) = (end, 1);
            } else {
                w.frozen++; // joins the open window, never extends it
            }
            (a.frozenUntil, a.cooldownUntil) = (end, uint64(end + COOLDOWN));
            emit ITimelockPolicy.Frozen(engine, safe, id, msg.sender, end);
        }
    }

    /**
     * @notice See {ITimelockPolicy-lift}.
     * @dev Every freeze of a window ends with it, so a frozen id always belongs to its actor's open
     *      window; a lift that leaves the actor nothing frozen closes the window, which starts the
     *      actor's cooldown: what was just lifted cannot be re-frozen for C.
     */
    function lift(address engine, address safe, bytes32 attachmentId) external onlyDelegated {
        Attachment storage a = _attachments[_keyOf(engine, safe, attachmentId)];
        // As in `freeze`: a detached attachment's stale roles count for nothing.
        (bool attached, ) = IPolicyGuard(engine).getAttachment(safe, attachmentId);
        require(
            attached && (_contains(a.guardians, msg.sender) || _contains(a.lifters, msg.sender)),
            ITimelockPolicy.NotGuardianOrLifter(attachmentId)
        );
        require(block.timestamp < a.frozenUntil, ITimelockPolicy.NotFrozen(attachmentId));
        uint64 cooldownUntil = uint64(block.timestamp + COOLDOWN);
        (a.frozenUntil, a.cooldownUntil) = (uint64(block.timestamp), cooldownUntil);
        ActorWindow storage w = _actorWindows[engine][safe][a.actor];
        if (w.frozen != 0 && --w.frozen == 0) w.end = uint64(block.timestamp);
        emit ITimelockPolicy.Lifted(engine, safe, attachmentId, msg.sender, cooldownUntil);
    }

    /// @dev One of this policy's attachments that reaches the owner path, with its delay.
    struct Cover {
        Scope scope;
        uint8 opMask;
        uint32 delay;
    }

    /**
     * @dev The covering rule (SPEC.md §5.1, rev 4): let D be the longest delay of this policy's
     *      attachments at actor OWNERS or ANY. Each owner-path route out of a policy must then be
     *      delayed at least D by an attachment of this policy matching it (at any of its 6 lookup
     *      scopes, with the route's op in its mask): `engine.configure`, `Safe.setGuard`,
     *      `Safe.setModuleGuard`, `Safe.enableModule`, `Safe.disableModule`,
     *      `Safe.setFallbackHandler` (CALL), and any DELEGATECALL (only `(OWNERS, *)` or
     *      `(ANY, *)` with DELEGATECALL in its mask covers that one). Runs on the final
     *      configuration of every `configure` touching this policy (IPolicy.validate).
     */
    function validate(address safe) external view onlyDelegated {
        address engine = msg.sender;
        AttachmentView[] memory all = IPolicyGuard(engine).getAttachments(safe);
        Cover[] memory covers = new Cover[](all.length);
        uint256 n;
        uint32 need;
        for (uint256 i = 0; i < all.length; i++) {
            AttachmentView memory v = all[i];
            if (v.kind != Kind.POLICY || v.policy != address(this)) continue;
            if (v.scope.actor != ScopeLib.OWNERS && v.scope.actor != ScopeLib.ANY) continue;
            uint32 delay = _attachments[_keyOf(engine, safe, v.attachmentId)].delay;
            covers[n++] = Cover(v.scope, v.opMask, delay);
            if (delay > need) need = delay;
        }
        if (need == 0) return;
        // Trim the array to the `n` covers kept.
        assembly ("memory-safe") {
            mstore(covers, n)
        }
        _requireRoute(covers, need, address(0), bytes4(0), ScopeLib.OP_DELEGATECALL);
        _requireRoute(covers, need, engine, IPolicyGuard.configure.selector, ScopeLib.OP_CALL);
        _requireRoute(covers, need, safe, SAFE_SET_GUARD, ScopeLib.OP_CALL);
        _requireRoute(covers, need, safe, SAFE_SET_MODULE_GUARD, ScopeLib.OP_CALL);
        _requireRoute(covers, need, safe, SAFE_ENABLE_MODULE, ScopeLib.OP_CALL);
        _requireRoute(covers, need, safe, SAFE_DISABLE_MODULE, ScopeLib.OP_CALL);
        _requireRoute(covers, need, safe, SAFE_SET_FALLBACK_HANDLER, ScopeLib.OP_CALL);
    }

    /// @dev `TimelockNotCoveringConfiguration` unless a cover matching `(to, selector)` with `op`
    ///      in its mask delays at least `need`. `to == 0` is "any DELEGATECALL": only `(*, *)` covers.
    function _requireRoute(Cover[] memory covers, uint32 need, address to, bytes4 selector, uint8 op) private pure {
        for (uint256 i = 0; i < covers.length; i++) {
            Cover memory c = covers[i];
            if (c.opMask & op == 0 || c.delay < need) continue;
            CallMatch m = c.scope.callMatch;
            if (m == CallMatch.ANY) return;
            if (c.scope.to != to) continue;
            if (m == CallMatch.CONTRACT || c.scope.selector == selector) return;
        }
        revert ITimelockPolicy.TimelockNotCoveringConfiguration(to, selector, op, need);
    }
}
