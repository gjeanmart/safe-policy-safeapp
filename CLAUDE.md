# Repository guide

Three packages, each with its own toolchain root. Never commit secrets, keys, keystores or `.env*` files.

| Path         | What                                                                                                   | Toolchain                         |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `/` (root)   | Safe App "Safe Policy Sandbox" (React + Vite + viem), deployed to Cloudflare Workers                   | pnpm (root `pnpm-workspace.yaml`) |
| `agent/`     | `safe-role` CLI: an AI agent acting as a policy-scoped Safe module (TS, bundled by Vite from the root) | root pnpm                         |
| `contracts/` | Experimental policies for the Safe Policy Engine (Hardhat, Solidity 0.8.30)                            | own pnpm root                     |

## Conventions

- TypeScript: Prettier (no semicolons, single quotes, width 110), ESLint (`typescript-eslint` recommended,
  react-hooks), strict `tsconfig`, viem for all Ethereum code (no ethers), small components, comments only where
  the "why" is not obvious.
- Dependencies: lockfiles committed; pnpm `minimumReleaseAge: 1440`; GitHub Actions pinned to SHAs.
- Git: feature branches + PRs into `main`; commit messages explain the why; the CI must be green before merge.
- Safe Bunkr, the desktop wallet that grew in this tree, moved to its own repository on 2026-10-14
  (`../safe-bunkr`, github.com/gjeanmart/safe-bunkr); nothing of it remains here.

## Environment quirks

- The Bash sandbox blocks reading paths matching `*private*key*` (hits `viem/_esm/accounts/generatePrivateKey.js`),
  so `vite build`/node scripts importing viem accounts must run outside the sandbox.
- Global git config rewrites `https://github.com/` to SSH, which the sandbox blocks; fetch tarballs from
  `codeload.github.com` instead.
- Node's `fetch` needs `NODE_USE_ENV_PROXY=1` inside the sandbox.
