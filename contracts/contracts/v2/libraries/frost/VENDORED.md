# Vendored: safe-research/policy-engine FROST libraries

Unmodified copies from [safe-research/policy-engine](https://github.com/safe-research/policy-engine) at commit
`8ee68a8cdac65b4aba5d9a10e9f9018c2efb10b3`, path `contracts/libraries/`, licensed LGPL-3.0-only (see
[`vendor/policy-engine/LICENSE`](../../../vendor/policy-engine/LICENSE)).

| File                    | Source (8ee68a8)                            | SHA-256                                                            |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `ConsensusMessages.sol` | `contracts/libraries/ConsensusMessages.sol` | `6e54a40c9e90e8c78d8280d1cac94b4f8177c2808f45f903deaa11ac4fc4a5d6` |
| `EpochRollover.sol`     | `contracts/libraries/EpochRollover.sol`     | `a5ffece244df82ee99d7a479b67601eafddbc19ff28aad80a8e630bfe2a364bb` |
| `FROST.sol`             | `contracts/libraries/FROST.sol`             | `e955b6cb2b4e842062a92cdc79077c01bc405e1fa84d5b33866cd44dd3925f89` |
| `Secp256k1.sol`         | `contracts/libraries/Secp256k1.sol`         | `cb6ec29f589eae74f36438c48b7f56eb895375cbb725655c91732d33590b637c` |

Used by `SafenetPolicyV2` (SPEC.md §8.7). They live here, not under `vendor/policy-engine` (vendored from the older
commit 71b9cb0, which does not have them), so that vendor tree stays a single-commit copy.

Do not edit these files; re-vendor from a newer commit instead.
