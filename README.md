# safe-policy-safeapp

[![CI](https://github.com/gjeanmart/safe-policy-safeapp/actions/workflows/ci.yml/badge.svg)](https://github.com/gjeanmart/safe-policy-safeapp/actions/workflows/ci.yml)

A Safe App to experiment with the [Safe Policy Engine](https://github.com/safe-research/policy-engine) on Sepolia:
plug plain EOAs into a Safe as **modules** and scope what they can do with `SafePolicyGuard` policies, while the
multisig keeps working as before.

> Research / PoC code. The policy contracts are unaudited, and role private keys are stored unencrypted in
> localStorage. Sepolia only.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
```

Safe{Wallet} must reach the app over public HTTPS, e.g. with a Cloudflare quick tunnel:

```bash
cloudflared tunnel --url http://localhost:5173   # prints https://<random>.trycloudflare.com
```

Then in [Safe{Wallet}](https://app.safe.global) on Sepolia: **Apps → My custom apps → Add custom Safe App** → the
tunnel URL. `*.trycloudflare.com` is already in Vite's `server.allowedHosts`; add your own hostname there if you use a
named tunnel on a custom domain. Opened directly in a browser, the app runs in standalone mode: you can inspect a Safe and
act as its modules, but not propose multisig transactions.

Optional: set `VITE_RPC_URL` (e.g. in `.env.local`) to use another Sepolia RPC. The default is
`https://ethereum-sepolia-rpc.publicnode.com`.

Requirements: a **Safe v1.5.0** (the module guard doesn't exist in 1.4.1), funded with Sepolia ETH and
[Circle USDC](https://faucet.circle.com/).

## Scripts

| Command                | What it does                        |
| ---------------------- | ----------------------------------- |
| `npm run dev`          | Vite dev server on port 5173        |
| `npm run build`        | Typecheck + production build (dist) |
| `npm run typecheck`    | TypeScript only                     |
| `npm run lint`         | ESLint                              |
| `npm run format:check` | Prettier check (`format` to fix)    |

CI (`.github/workflows/ci.yml`) runs typecheck, build, lint and format check on every push to `main` and on
pull requests.

## Deploy (Cloudflare Pages)

Static site, no backend. In Cloudflare Pages, connect the GitHub repo with:

- Framework preset: **Vite** (or none)
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: taken from `.nvmrc` (22)
- Optional env var: `VITE_RPC_URL`

`public/_headers` adds the CORS headers Safe{Wallet} needs to fetch `manifest.json`. Then add the Pages URL as a
custom Safe App.

## Walkthrough

1. **Roles**: generate an EOA, top it up with gas from the Safe, and optionally enable it as a module.
2. **Guard & policies**:
   - Build a draft from templates (ERC-20 transfer allowlist, native transfer, CoW swap, module-only access, allow,
     deny, remove).
   - Without a guard installed: propose the _bootstrap_ batch, which does
     `configureImmediately(draft)` → `enableModule(role)` → `setModuleGuard(guard)`.
   - With a guard installed: propose `requestConfiguration(root)`, wait for `DELAY`, then apply it from _Pending
     configurations_. With the 0-delay guard, the request and the apply are batched together.
3. **Playground**: act as a role, then _Resolve policy_, _Simulate_, _Execute_ or _Force-send_ (which puts the
   revert on-chain). Every decision goes to the activity log with its decoded revert reason, e.g.
   `PolicyReverted by ERC20TransferPolicy → Unauthorized`.
4. **Notes**: the model and its sharp edges.

## Design choices

- **Module guard only by default.** `SafePolicyGuard` checks owner and module transactions against the same policy
  map, and installing it as a transaction guard makes the multisig default-deny too. Installing it only as a
  **module guard** leaves the owners unchecked and scopes the modules. Modules still can't reconfigure anything:
  `ModuleConfigurationDenied` / `GuardTargetDenied`, and there's no policy for Safe admin calls. The trade-off is
  that the delay then protects against modules only, not against the owners. The "both guards" option is available
  in the Setup tab.
- **No backend, no indexer.** The guard has no getter to enumerate policies. Active bindings are rebuilt from
  `PolicyConfirmed` events, scanned in 50k-block chunks. The guard only stores configuration _roots_, so pending
  configuration lists are kept in localStorage until they're applied.
- **Multisig transactions** go through the Safe Apps SDK (`sdk.txs.send`), so owners sign in the normal
  Safe{Wallet} queue. **Module transactions** are signed locally with viem and call `execTransactionFromModule`
  directly.

## Structure

```
src/
  config/        contract addresses (policies, guards, tokens, CoW) and the viem client
  abi/           human-readable ABIs, including every guard/policy custom error
  lib/
    configurations.ts  Configuration type, policy templates, root computation
    safe.ts            Safe state reader + builders for owner transactions
    moduleTx.ts        simulate / send execTransactionFromModule from a local EOA
    runner.ts          runs module steps and logs the outcomes
    policyEvents.ts    rebuilds active policies from PolicyConfirmed events
    errors.ts          decodes reverts (PolicyReverted is unwrapped recursively, GSxxx codes)
    cow.ts             CoW order-book quote + pre-sign order
  store/         localStorage-backed stores (roles, draft, pending, activity, event cache)
  hooks/         Safe App connection, polling, balances
  components/    Roles, Setup (status, builder, pending, active), Playground, Notes
```

## Known limitations

- **CoW "swap only" is not enforced.** `setPreSignature(orderUid)` is opaque to every deployed policy, so a role can
  pre-sign an order with any receiver. The Playground lets you change the receiver to demonstrate this.
- Policies are per Safe, not per module, and no shipped policy checks both the caller and the parameters. Two roles
  can't have different ERC-20 recipients.
- AllowedModulePolicy has one allowlist per Safe: a role allowed on one selector is allowed on every selector bound
  to that policy.
