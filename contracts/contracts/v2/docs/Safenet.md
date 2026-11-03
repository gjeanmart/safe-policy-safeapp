# SafenetPolicy: one Safenet attestation per transaction (optional)

Source: `policies/SafenetPolicy.sol`, interface `interfaces/policies/ISafenetPolicy.sol`, SPEC §5.5. Port of V1's
SafenetPolicy (8ee68a8). Research prototype, unaudited; deployed only when the Safenet Consensus parameters are given.

## What it does

A matched transaction needs a Safenet FROST attestation of its hash, pushed on-chain before execution. Unlike V1, it
works on the module path too.

## Settings

None: `settings` must be empty (`InvalidSettings`). The trusted (group key, epoch) set is global to the contract:
seeded at construction `(consensusChainId, consensusAddress, initialEpoch, initialGroupKey)` and extended by anyone
with `updateEpoch` and a rollover signed by a trusted group, as in V1.

## Who calls what, and when

| Function | Who | When |
| --- | --- | --- |
| `submitAttestation(engine, safe, txHash, deadline, attestation)` | anyone (the FROST signature authorises it) | before execution |
| `updateEpoch(...)` | anyone | when Safenet rolls its group key over |
| `check` | the engine | consumes one credit |

`deadline = 0`: owner path, the attestation is over the Safe transaction hash itself (nonce-bound), no expiry.
`deadline > 0`: module path, the attestation is over `attestationDigest(engine, safe, txHash, deadline)` and the credit
expires after the deadline. `attestation` is V1's 256-byte encoding
`abi.encode(uint64 epoch, address oracle, bytes32 oracleDataHash, Point groupKey, Signature)`. Each FROST signature
can be submitted once.

## The check

One credit of `ctx.txHash` per Safe transaction, however many attachments matched; the check consumes it.

## What it sees and cannot see

| Sees | Cannot see |
| --- | --- |
| `ctx.txHash` | What Safenet checked: the policy trusts the attestation of the hash |

## Errors

| Error | When |
| --- | --- |
| `InvalidSettings` | non-empty settings |
| `InvalidAddress` | constructor: zero Consensus address |
| `MalformedAttestation`, `UntrustedAttestationKey`, `AttestationAlreadySpent` | `submitAttestation` |
| `AttestationExpired(deadline)` | submitted or consumed after the deadline |
| `MissingAttestation` | the check finds no credit |

## Example: every transaction attested

```
attach (ANY, *) SafenetPolicy {}
```

Proven by the unit tests `test/v2/policies/Safenet.test.ts` (real FROST signatures, both paths). No story uses it:
the story world deploys only the policies every template needs.
