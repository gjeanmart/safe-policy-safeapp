# Vendored: safe-global/safe-smart-account v1.5.0

Unmodified copies from [safe-global/safe-smart-account](https://github.com/safe-global/safe-smart-account) at tag
`v1.5.0`, commit `dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be` (fetched 2026-11-02 from
`codeload.github.com/safe-global/safe-smart-account/tar.gz/refs/tags/v1.5.0`), licensed LGPL-3.0-only (see
`LICENSE`).

Used by the V2 tests only (`test/v2/fixtures/safe.ts`), to run the engine against a real Safe 1.5.0. Kept: the files
under `contracts/` that these six contracts import, with the upstream paths:

- `Safe.sol` (singleton), `proxies/SafeProxyFactory.sol` (+ `SafeProxy.sol`)
- `handler/CompatibilityFallbackHandler.sol` (+ `TokenCallbackHandler.sol`, `HandlerContext.sol`)
- `libraries/MultiSendCallOnly.sol`, `libraries/MultiSend.sol`, `libraries/SignMessageLib.sol`
- their dependencies in `base/`, `common/`, `external/`, `interfaces/` and `libraries/` (`Enum`, `ErrorMessage`,
  `SafeStorage`)

Not kept: `SafeL2`, the extensible fallback handler, `accessors/`, `examples/`, `test/`, the other libraries.

The pragma is `>=0.7.0 <0.9.0`, so the files compile unchanged with this project's 0.8.30 / cancun / viaIR /
10M-runs settings; `Safe` is 15,895 bytes deployed, under the EIP-170 limit. Do not edit these files; re-vendor
from a newer tag instead.
