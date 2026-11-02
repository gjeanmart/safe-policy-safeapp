# agent: an AI agent acting as a policy-scoped Safe role

An experiment: an AI agent (Claude Desktop, Cowork, Claude Code, Codex) reads a Safe and acts as
one **role**, an EOA enabled as a module. What the role may do is decided **only by the Safe's
on-chain policies** (SafePolicyGuard).

Everything runs in **one process that you start**, `safe-role signer`. It:

- unlocks the role key in your terminal
- serves the agent's tools over MCP on `127.0.0.1`
- asks you `y/N` there before signing anything (ask mode, the default), or, started with
  `safe-role signer --auto`, signs whatever the Safe's policies allow (auto mode)

| Mode          | Start with                | Before each transaction                                            |
| ------------- | ------------------------- | ------------------------------------------------------------------ |
| ask (default) | `safe-role signer`        | shows the decoded transaction and waits for your `y/N` (2 min max) |
| auto          | `safe-role signer --auto` | nothing: the policies decide                                       |

Auto mode is where the on-chain policies really carry the weight. Use it with narrow policies, and
stop the process (Ctrl+C) to end it.

```
 Claude Code ─────────── MCP over HTTP (127.0.0.1 + token) ──┐
 Claude Desktop / Cowork ─┐                                   ▼
 Codex ───────────────────┴─ safe-role mcp (stdio relay) ─▶ safe-role signer (your terminal)
                                                             tools: guide, status, policies,
                                                             balances, plan, simulate, exec…
                                                             holds the key, asks you y/N
                                                                    │ execTransactionFromModule
                                                                    ▼
                                         Safe ─ SafePolicyGuard (module guard) ─ policies
```

## How an action goes

1. **Plan:** the agent builds a module transaction (`safe_role_plan`). Its id is a hash of the
   chain, Safe, role and transaction.
2. **Simulate:** a dry run as the role against the live Safe (`safe_role_simulate`). The
   policies' verdict and the deciding policy are known before anything is signed.
3. **Exec** (`safe_role_exec`), in the signer:
   - checks the plan wasn't changed and is for this Safe and role (CALL only)
   - decodes the transaction from its bytes; for a CoW swap, checks the order shown is the one
     being pre-signed
   - simulates again
   - in ask mode, asks you `y/N` with the decoded details
   - signs and sends, and records it in `~/.safe-role/audit.jsonl`

The signer adds no rules of its own: no amount caps, no recipient lists. Local rules would be a
false sense of security, because they stop holding as soon as the key leaves the signer. What you
get instead is the on-chain policies, plus seeing and approving exactly what gets signed. The
address book only gives names to addresses; `book add` is terminal-only, so an agent can't label
an address "Owner1".

## Files

```
agent/
  src/          the safe-role CLI: signer, MCP server and relay, plans, CoW swaps (reuses ../src/lib)
  guide/        what the agent is told: overview, actions, policies, errors (served over MCP)
  bin/          safe-role launcher (link it onto your PATH)
  dist/         the build: one bundled file, safe-role.mjs
```

## Setup

```sh
pnpm install
pnpm agent:build
ln -sf "$PWD/agent/bin/safe-role" ~/.local/bin/safe-role    # or any directory on your PATH
```

1. **In the Safe App:** add a role (Roles → Add role → New EOA), enable it as a module, give it
   a little Sepolia ETH for gas, and add policies (Guard & policies).
2. **Run the wizard:** `safe-role setup`. It walks through:
   - the network
   - the Safe (checks the version and the guard)
   - the role key: paste the key revealed in the app, or generate one, then choose a password.
     It checks the role is an enabled module with gas.
   - optional names for addresses
   - connecting Claude Desktop/Cowork and Codex (with a `.bak` of their config), and the command
     for Claude Code
   - starting the signer, in ask or auto mode

   Run it again to change anything; Enter keeps the current values.

3. **Later, start the signer and keep the terminal open:** `safe-role signer` (or `--auto`).

`safe-role reset` deletes the whole setup: config, encrypted key, token, history, plans, and
optionally the client entries. Stop the signer first.

## Connect a client

`safe-role setup` does this for Claude Desktop/Cowork and Codex. For reference, the MCP endpoint
is `http://127.0.0.1:8787/mcp` and the token is in `~/.safe-role/mcp-token`. Clients that only
launch local commands use the relay:

| Client                                | How                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Desktop / Cowork               | `claude_desktop_config.json` → `"safe-role": { "command": "/opt/homebrew/bin/node", "args": ["<repo>/agent/dist/safe-role.mjs", "mcp"] }`, then restart Desktop                                                          |
| Codex (ChatGPT desktop app, CLI, IDE) | "Connect to a custom MCP" → STDIO, command `/opt/homebrew/bin/node`, arguments `<repo>/agent/dist/safe-role.mjs` and `mcp`. Then add `tool_timeout_sec = 180` in `~/.codex/config.toml`, because exec waits for your y/N |
| Claude Code                           | `claude mcp add --transport http safe-role http://127.0.0.1:8787/mcp --header "Authorization: Bearer $(cat ~/.safe-role/mcp-token)"`                                                                                     |
| ChatGPT chat                          | not supported: it only accepts public HTTPS servers                                                                                                                                                                      |

In each client, keep `safe_role_exec` on "ask before running".

## Try it

With Safe 0x67BA…5db4 and "Example role" 0xb3Be…f76E:

| Prompt                              | Expected                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------- |
| What can the agent do with my Safe? | reads the guide, status and policies; explains the 4 policies             |
| Send 1 USDC to Owner1               | allowed by ERC20TransferPolicy → y/N in the signer terminal → sent        |
| Approve Owner1 to spend 5 USDC      | `PolicyReverted by ERC20ApprovePolicy → Unauthorized`: explains and stops |
| Send 0.001 ETH to Owner1            | `AccessDenied: no policy` (no NativeTransferPolicy)                       |
| Swap 25 USDC for WETH               | approve + pre-sign, two y/N, CoW order link                               |

Without an agent, the CLI has the same commands:

```sh
safe-role status | policies | balances | book | history | guide [topic]
safe-role plan transfer --token USDC --to Owner1 --amount 1    # → id
safe-role simulate <id>
safe-role exec <id>                                            # y/N in the signer terminal
```

## Policy Engine V2

The CLI detects the engine from the Safe's guard (`supportsInterface` for ITransactionGuard,
IModuleGuard and IPolicyEngineV2). V1 Safes behave as before. On a V2 Safe:

| Command               | What changes                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`              | engine section, and the freeze state of the Safe and of this role: active, frozen until, cooling down until                                      |
| `policies`            | the role's view: grants (Allow that applies to it), protections on it, protections on everyone, each budget with what is left and when it resets |
| `simulate <id>`       | the engine's `preview`: every gate (Allow / pass / Deny), the deciding gate, `needs` and `next`, plus a dry run of the real call                 |
| `schedule <id>` (new) | the role schedules a timelocked call with `TimelockPolicy.scheduleModuleTx` (signed by the signer, y/N in ask mode)                              |
| `queue` (new)         | the role's schedules: waiting (countdown), ready, expired, cleared by a freeze, with the plan id to exec                                         |

`simulate`, `policies` and `queue` print a text view on a V2 Safe; add `--json` for JSON. MCP
tools always return JSON. A timelocked action: `plan` → `simulate` (needs: schedule) → `schedule`
→ `queue` until ready → `simulate` → `exec`.

V2 addresses come from `src/config/contracts.ts` (any exported value shaped like `V2Deployment`).
Until they are there, pass the JSON block printed by `pnpm deploy:v2:sepolia`:

```sh
export SAFE_ROLE_V2_DEPLOYMENT=./v2-deployment.json    # or the JSON itself; or --v2-deployment <file>
safe-role signer                                        # the signer needs it too (simulate, schedule)
```

Policies are shared by both engines, so the CLI also works on an engine that is not listed, as long
as one deployment is known.

## Security notes

- **The on-chain policies are the boundary.** Keep the role's policies narrow. To revoke the
  role, disable the module in the Safe App.
- **The key file** is encrypted (scrypt + AES-256-GCM). The password is only typed in the
  signer terminal, and the key only lives in that process's memory.
- **The MCP endpoint** listens on `127.0.0.1` only and needs the token. It rejects foreign
  `Host` and `Origin` headers, so web pages can't reach it through your browser.
- **Local software** running as your user can read `~/.safe-role`: the encrypted keystore, the
  token and the config. It can't sign without the password, or without your `y/N`.
- **Sepolia only.** The CLI stops if the RPC's chain id doesn't match.
