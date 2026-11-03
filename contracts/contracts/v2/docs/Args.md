# ArgsPolicy: conditions on a call's arguments

Source: `policies/ArgsPolicy.sol`, interface `interfaces/policies/IArgsPolicy.sol`, SPEC §5.2. Research prototype,
unaudited.

## What it does

Granting stays the engine's built-in Allow. ArgsPolicy, attached next to the Allow (usually at the same scope), adds
conditions on the call: who receives, who may spend, how much, which receiver. The app shows the pair as one rule,
"Allow + conditions". It replaces rev 2's RecipientsPolicy.

## Settings

`abi.encode(Settings)` with `Settings { Constraint[] constraints; bool strict }`, at most 16 constraints and 32 values
each.

| Constraint field | Meaning |
| --- | --- |
| `selector` | The function it applies to; `0xffffffff` = every call of the attachment; `0x00000000` = empty calldata |
| `target` | `WORD` (head word `index` of the calldata), `CALL_TO` (the call's `to`), `VALUE` (the call's value) |
| `index` | The head word, for `WORD` only (0 is the first argument) |
| `op` | `EQ`, `NEQ` (1 value), `IN`, `NOT_IN` (1 to 32 values), `LTE`, `GTE` (1 value, unsigned), `EQ_SAFE` (no value: the word must be the Safe) |
| `values` | ABI words (addresses left-padded) |

`strict`: a call to which no constraint applies is denied (`NoConstraint`). An empty list must be strict (it denies
every matched call: a carve-out).

### App presets

| Preset | Constraints |
| --- | --- |
| Recipients | `transfer` word 0 IN list; `transferFrom` word 1 IN list; empty calldata `CALL_TO` IN list |
| Spenders | `approve` word 0 IN list; `approve` word 1 LTE cap |
| Receiver is the Safe | `EQ_SAFE` on the protocol's receiver word (Aave `supply` word 2, Morpho `withdraw` word 8, Uniswap `exactInputSingle` word 3, ENS `register` word 1) |

## Who calls what, and when

Only the engine calls it (`configure` at attach, `check` per transaction). It keeps no state at check time.

A call to the engine itself (`configure`, the only one the engine lets through) is never judged: it moves nothing, and
a strict Args at `(Owners, *)` or `(ANY, *)` would otherwise lock the owners out of their own configuration. Safe admin
calls (`setGuard`, `setModuleGuard`, `addOwner...`) stay judged (a strict Args denies them as `NoConstraint`).

## The check

Every (call, attachment) match is judged alone with that attachment's own constraints and `strict`. Within one
attachment, every constraint whose selector is the call's, or `0xffffffff`, must hold. All matches must pass.

## What it sees and cannot see

| Sees | Cannot see |
| --- | --- |
| The call's `to`, `value`, and the 32-byte head words of its calldata | Dynamic arguments (`bytes`, arrays, strings), so not Uniswap `exactInput` paths, Universal Router `execute`, CoW order contents, ENS's newer struct-based `register`; nested calls; other calls of the batch; any state |

Rev 2 Recipients let `approve(x, 0)` pass for any spender; Args does not (owners can revoke, an ops key may not
revoke an approval it could not make).

Use allowlists (`IN`, `EQ`, `EQ_SAFE`) for addresses, not denylists (`NEQ`, `NOT_IN`). Words are compared in full (32
bytes). An address word with dirty upper bits fails every allowlist (fail closed), but passes a denylist, while a token
compiled without ABI decoding checks (USDT and other pre-0.8 tokens) masks the word to 160 bits and pays the denied
address. The app presets are all allowlists.

## Errors

| Error | When |
| --- | --- |
| `InvalidSettings` | over a cap, wrong value count for the op, `index != 0` with a non-WORD target, empty non-strict list |
| `ConstraintFailed(callIndex, attachmentId, constraintIndex)` | a constraint does not hold |
| `ArgumentMissing(callIndex, attachmentId, constraintIndex)` | the calldata is too short for a WORD constraint |
| `NoConstraint(callIndex, attachmentId)` | strict, and no constraint applies to the call |

## Example: ops pays two vendors

```
allow  (Ops, USDC.transfer)
attach (Ops, USDC.transfer) ArgsPolicy {strict: true, constraints: [
  transfer word 0 IN [vendorA, vendorB], transferFrom word 1 IN [...], empty calldata CALL_TO IN [...] ]}
```

Proven by `test/v2/stories/Erc20Payments.test.ts`, `Erc721.test.ts`, `Aave.test.ts`, `Morpho.test.ts`,
`Uniswap.test.ts`, `Ens.test.ts` and `CowAgent.test.ts`.
