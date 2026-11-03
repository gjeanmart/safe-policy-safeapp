// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity =0.8.30;

import {FROST} from "../../libraries/frost/FROST.sol";
import {Secp256k1} from "../../libraries/frost/Secp256k1.sol";

/**
 * @title Safenet FROST challenge helper (test only)
 * @notice Exposes the FROST challenge so tests can build single-signer (Schnorr) group signatures.
 */
contract SafenetFrostChallenge {
    function challenge(
        Secp256k1.Point memory r,
        Secp256k1.Point memory y,
        bytes32 message
    ) external view returns (uint256) {
        return FROST.challenge(r, y, message);
    }
}
