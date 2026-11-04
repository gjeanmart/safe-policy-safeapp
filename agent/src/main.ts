import { parseArgs } from 'node:util'
import { getAddress, isAddress } from 'viem'
import { AGENT_COMMANDS, type AgentCommand, runAgentCommand } from './commands'
import { CONFIG_PATH, type Config, KEYSTORE_PATH, PLANS_DIR, loadConfig, saveConfig } from './config'
import { requireTty } from './keystore'
import { guide } from './guide'
import { MCP_TOKEN_PATH, serveMcpHttp } from './http'
import { runMcpRelay } from './mcp'
import { CliError, printError, printResult } from './output'
import { runReset, runSetup } from './setup'
import { type SignMode, printSignerBanner, unlockSigner } from './signer'

const HELP = `safe-role: act on a Safe as a policy-scoped module (role EOA).

Agent commands (read, plan, simulate, execute)
  status                          Safe, guards, role module status and gas (V2: freeze state per Timelock)
  policies [--from-block N]       what the role may do. V2: Allows and their conditions, budgets left and
                                  their reset, Timelock / Co-signer / Safenet / Deny, freeze state, duties
  balances                        Safe token balances and role gas
  book                            address-book names (labels for addresses)
  plan transfer --token ETH|USDC|WETH --to <name|address> --amount <decimal>
  plan approve  --token USDC|WETH --spender <name|address> --amount <decimal>
  plan swap     --sell USDC|WETH --buy WETH|USDC|COW --amount <decimal> [--slippage <bps, default 50>]
                                  CoW order paid to the Safe: 1-2 plans (approve, pre-sign)
  plan wrap     --amount <ETH>    ETH -> WETH (WETH.deposit)
  plan unwrap   --amount <WETH>   WETH -> ETH (WETH.withdraw)
  plan call     --to <address> --data <0x...> [--value <ETH>]
  simulate <plan-id>              dry-run as the role; shows the policy that decides
                                  (V2: every gate per call and scope, the deciding one, what to do next)
  exec <plan-id>                  asks the signer to sign and send a simulated plan
  history                         what the signer sent or refused

Policy Engine V2 (rev 3) commands, signed by the signer (y/N in ask mode)
  schedule <plan-id>              schedule a timelocked plan (TimelockPolicy.scheduleModuleTx)
  queue [--from-block N]          this role's schedules: waiting, ready, expired, void
  cancel <plan-id|callHash>       cancel a schedule this role made, or one it is a canceller of
  approve <txHash> [--valid-for 1h | --valid-until <unix|ISO>]
                                  as a Co-signer approver: approve a transaction hash
  freeze [attachmentId...]        as a Timelock guardian: freeze (default: every attachment it guards)
  lift [attachmentId]             as a guardian or lifter: end a freeze early
  guide [overview|actions|policies|errors]   how to operate the role (the guide served over MCP)

User-only commands (interactive terminal)
  setup                           guided setup: network, Safe, role key, names, AI clients
  signer [--auto]                 unlock the key and serve MCP (and the CLI's exec) on localhost;
                                  asks y/N for each transaction, or with --auto signs whatever the
                                  Safe's policies allow
  book add <name> <address> | book remove <name>
  reset                           delete the whole setup (config, key, token, history, plans)

MCP
  mcp                             stdio relay to the running signer (for Claude Desktop)

Options
  --json                          V2 simulate / policies / queue: print JSON instead of text
  --v2-deployment <file|json>     rev 3 addresses when src/config/contracts.ts has none (the deployment
                                  JSON printed by the deploy script); same as SAFE_ROLE_V2_DEPLOYMENT

Files: ${CONFIG_PATH} (config), ${KEYSTORE_PATH} (encrypted key), plans in ${PLANS_DIR}.
Every command prints JSON with ok, summary, and a hint on errors (V2 views print text unless --json).`

/**
 * `book add` / `book remove`: user-only, because names appear in the y/N prompt: an agent must
 * not be able to label an address "Owner1".
 */
async function editBook(config: Config, sub: string, args: string[]): Promise<void> {
  requireTty(`book ${sub}`)
  const [name, address] = args
  if (!name) throw new CliError('Missing name.')
  if (sub === 'add') {
    if (!address || !isAddress(address, { strict: false }))
      throw new CliError('Usage: safe-role book add <name> <address>')
    if (!/^[\w.-]{1,32}$/.test(name)) throw new CliError('Names: letters, digits, _ . - (max 32).')
    config.addressBook[name] = getAddress(address)
  } else if (sub === 'remove') {
    delete config.addressBook[name]
  } else {
    throw new CliError(`Unknown book command "${sub}".`)
  }
  saveConfig(config)
  printResult(`Address book updated. Restart the signer to apply it.`, { addressBook: config.addressBook })
}

/**
 * `safe-role signer [--auto]`: one process that holds the key (unlocked here) and serves MCP (and
 * the CLI's exec) on localhost. Ask mode (default) asks y/N here for each transaction; auto mode
 * signs whatever the Safe's policies allow.
 */
async function runSigner(mode: SignMode, password?: string): Promise<void> {
  const { config, role, backend } = await unlockSigner(mode, password)
  const endpoint = await serveMcpHttp(backend)
  printSignerBanner(config, role, mode, [
    `  MCP       ${endpoint.url} (token in ${MCP_TOKEN_PATH}; clients: safe-role setup)`,
  ])
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      token: { type: 'string' },
      to: { type: 'string' },
      spender: { type: 'string' },
      amount: { type: 'string' },
      sell: { type: 'string' },
      buy: { type: 'string' },
      slippage: { type: 'string' },
      data: { type: 'string' },
      value: { type: 'string' },
      'from-block': { type: 'string' },
      'v2-deployment': { type: 'string' },
      'valid-for': { type: 'string' },
      'valid-until': { type: 'string' },
      json: { type: 'boolean' },
      auto: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  if (values['v2-deployment']) process.env.SAFE_ROLE_V2_DEPLOYMENT = values['v2-deployment']
  if (!command || values.help || command === 'help') {
    console.log(HELP)
    return
  }
  if (command === 'setup' || command === 'init') return runSetup(runSigner)
  if (command === 'reset') return runReset()
  if (command === 'signer') return runSigner(values.auto ? 'auto' : 'ask')
  if (command === 'mcp') return runMcpRelay()
  if (command === 'guide') {
    console.log(guide(rest[0]))
    return
  }

  const config = loadConfig()
  if (command === 'book' && rest[0]) return editBook(config, rest[0], rest.slice(1))
  if (!(AGENT_COMMANDS as readonly string[]).includes(command)) {
    throw new CliError(`Unknown command "${command}".`, 'Run `safe-role help`.')
  }
  const { token, to, spender, amount, sell, buy, slippage, data: calldata, value } = values
  const { summary, data, text } = await runAgentCommand(config, command as AgentCommand, {
    token,
    to,
    spender,
    amount,
    sell,
    buy,
    slippage,
    data: calldata,
    value,
    ...(command === 'plan' ? { action: rest[0] } : { id: rest[0], ids: rest.join(',') }),
    fromBlock: values['from-block'],
    validFor: values['valid-for'],
    validUntil: values['valid-until'],
  })
  if (text && !values.json) console.log(`${text}\n\n${summary}`)
  else printResult(summary, data)
}

main().catch((error) => {
  printError(error)
  process.exitCode = 1
})
