# CoSignerPolicy: M-of-N on-chain approvals

Source: `policies/CoSignerPolicy.sol`, interface `interfaces/policies/ICoSignerPolicy.sol`, SPEC §5.4. Research
prototype, unaudited.

## What it does

A matched transaction needs `required` approvals from the attachment's approvers, pushed on-chain before execution
and keyed by the transaction hash. 1-of-1 is the classic co-signer (a service that reviews every agent transaction);
N-of-M with the owners as approvers gives a same-Safe committee. Works on both paths.

## Settings

`abi.encode(Settings)` with `Settings { address[] approvers; uint8 required }`: 1 to 8 approvers, non-zero, no
duplicate, never the Safe; `required` from 1 to the number of approvers. Approvers are EOAs (ECDSA) or contracts
(ERC-1271).

## Who calls what, and when

| Function                                                          | Who                                                                                      | When                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `approve(engine, safe, txHash, validUntil)`                       | the approver (anyone may call, only listed approvers count)                              | after reviewing the transaction, before it executes  |
| `approveWithSig(engine, safe, txHash, approver, validUntil, sig)` | anyone, relaying the approver's EIP-712 signature (so the co-signer service pays no gas) | same                                                 |
| `revoke(engine, safe, txHash)`                                    | the approver                                                                             | before execution; also voids its unpushed signatures |
| `check`                                                           | the engine                                                                               | consumes every approval of the hash on pass          |

`txHash` is the Safe transaction hash on the owner path and the module call hash
`keccak256(abi.encode(safe, module, to, value, data, op))` on the module path. The signed digest is
`Approval(engine, safe, txHash, approver, useCount, revision, validUntil)` in the domain ("CoSignerPolicy", "1", chain id,
policy), read with `approvalDigest(engine, safe, txHash, approver, validUntil)`. `revision(engine, safe, txHash,
approver)` counts the approver's revokes of that hash, so:

- a revoke removes the approver's recorded approval **and** voids every signature it made but nobody pushed yet
  (`InvalidSignature`): a relayer holding the signature cannot record it after the revoke (review rev 3, A2);
- it touches only that approver: the other approvers' signatures stay valid;
- after a revoke, the approver signs again over the new revision;
- each digest can be pushed once per approver (`SignatureAlreadyUsed`), and a consumption (`useCount`) voids
  everyone's signatures of the previous use.

Signers (the app, the `safe-role` CLI) read `useCount` and `revision` right before signing.

## The check

Every matched attachment must find `required` unexpired approvals among its own approvers; one approval counts for
every attachment that lists the approver. On pass `useCount(txHash)` goes up: every approval of that hash is consumed,
and the next execution of the same module call needs new ones.

## What it sees and cannot see

| Sees              | Cannot see                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.txHash` only | What the approver reviewed beyond the hash: the approver must decode the call itself; the policy stores nothing but (hash, approver, validUntil) |

## Errors

| Error                                            | When                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidSettings`                                | a rule above                                                                                                                           |
| `ApprovalExpired(validUntil)`                    | approving with a `validUntil` in the past                                                                                              |
| `InvalidSignature(approver)`                     | `approveWithSig`: not the approver's ECDSA or ERC-1271 signature of the current digest (a revoke or a consumption since it was signed) |
| `SignatureAlreadyUsed(digest)`                   | the digest was already pushed                                                                                                          |
| `MissingApprovals(attachmentId, required, have)` | the check                                                                                                                              |

## Example: an agent with a co-signer service

```
attach (Agent, *) CoSignerPolicy {approvers: [cosignerService], required: 1}
```

Proven by `test/v2/stories/CowAgent.test.ts` (required, consumed, not listed, signature relayed), `Review.test.ts`
(revoke before the push), `test/v2/policies/CoSigner.test.ts` ("revoke against signatures not pushed yet") and the
module-path row of `test/v2/compare/V1vsV2.test.ts`.
