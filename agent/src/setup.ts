import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, type Hex, formatEther, getAddress, isAddress, isAddressEqual, zeroAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { DEFAULT_RPC_URL, isAllowedRpcUrl, publicClient } from '../../src/config/client'
import { GUARDS } from '../../src/config/contracts'
import { type SafeState, activeGuard, fetchSafeState, isModuleEnabled } from '../../src/lib/safe'
import { connect } from './chain'
import { CLIENTS } from './clients'
import {
  AUDIT_PATH,
  CONFIG_PATH,
  type Config,
  HOME,
  KEYSTORE_PATH,
  PLANS_DIR,
  SEPOLIA_CHAIN_ID,
  loadConfig,
  saveConfig,
} from './config'
import { MCP_TOKEN_PATH, ensureToken, httpSigner, mcpEndpoint } from './http'
import { MIN_PASSWORD_LENGTH, keystoreAddress, prompt, requireTty, writeKeystore } from './keystore'
import { CliError, printResult } from './output'
import type { SignMode } from './signer'

/** Where to enable the role and write policies. */
const SAFE_APP_URL = 'https://safe-policy-safeapp.ethdevelopers.com'

const step = (n: number, title: string) => console.log(`\n── ${n}/5 ${title} ──`)
const ok = (text: string) => console.log(`  ✓ ${text}`)
const todo = (text: string) => console.log(`  ✗ ${text}`)

async function ask(question: string, fallback = ''): Promise<string> {
  const answer = await prompt(fallback ? `${question} [${fallback}]: ` : `${question}: `)
  return answer || fallback
}

async function yes(question: string, fallback: boolean): Promise<boolean> {
  const answer = (await prompt(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `)).toLowerCase()
  return answer ? answer.startsWith('y') : fallback
}

function existingConfig(): Config | undefined {
  try {
    return loadConfig()
  } catch {
    return undefined
  }
}

async function askSafe(config: Pick<Config, 'rpcUrl' | 'chainId'>, fallback?: Address): Promise<SafeState> {
  for (;;) {
    const input = await ask('Safe address', fallback)
    if (!isAddress(input, { strict: false })) {
      console.log('  Not an address.')
      continue
    }
    try {
      return await fetchSafeState(getAddress(input))
    } catch {
      console.log(`  No Safe at ${input} on Sepolia (via ${config.rpcUrl}).`)
    }
  }
}

async function askKey(): Promise<{ role: Address; password: string }> {
  const generate =
    (await ask('Role key: import one from the Safe App (1) or generate a new one (2)', '1')) === '2'
  let privateKey: Hex
  if (generate) {
    privateKey = generatePrivateKey()
    console.log(
      '\n  New role key. Import it in the Safe App (Roles → Add role → Import EOA), then clear this terminal:',
    )
    console.log(`  ${privateKey}\n`)
  } else {
    for (;;) {
      privateKey = (await prompt('  Private key (Safe App → Roles → eye icon; hidden): ', {
        hidden: true,
      })) as Hex
      if (/^0x[0-9a-fA-F]{64}$/.test(privateKey)) break
      console.log('  Expected a 0x-prefixed 32-byte hex key.')
    }
  }
  for (;;) {
    const password = await prompt(`  Keystore password (min ${MIN_PASSWORD_LENGTH} chars, hidden): `, {
      hidden: true,
    })
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.log('  Too short.')
      continue
    }
    if ((await prompt('  Repeat it: ', { hidden: true })) !== password) {
      console.log('  Passwords differ.')
      continue
    }
    return { role: writeKeystore(privateKey, password), password }
  }
}

/**
 * `safe-role setup`: a guided setup (network, Safe, role key, names, clients), with on-chain checks
 * along the way, and optionally starts the signer at the end. Re-running it updates the setup.
 */
export async function runSetup(
  startSigner: (mode: SignMode, password?: string) => Promise<void>,
): Promise<void> {
  requireTty('setup')
  const previous = existingConfig()
  console.log('safe-role setup: an AI agent acting on your Safe as a policy-scoped role.')
  if (previous)
    console.log(`Current setup: Safe ${previous.safe}, role ${previous.role}. Enter keeps a value.`)

  step(1, 'Network')
  let rpcUrl = ''
  for (;;) {
    rpcUrl = await ask('Sepolia RPC URL', previous?.rpcUrl ?? DEFAULT_RPC_URL)
    if (!isAllowedRpcUrl(rpcUrl)) {
      console.log('  Use an https:// URL (or http://localhost).')
      continue
    }
    try {
      await connect({ rpcUrl, chainId: SEPOLIA_CHAIN_ID } as Config)
      ok('Connected to Sepolia')
      break
    } catch (error) {
      console.log(`  ${(error as Error).message}`)
    }
  }

  step(2, 'Safe')
  const safe = await askSafe({ rpcUrl, chainId: SEPOLIA_CHAIN_ID }, previous?.safe)
  const guard = activeGuard(safe)
  const guardLabel = GUARDS.find((g) => guard && isAddressEqual(g.address, guard))?.label
  ok(`Safe ${safe.version}, ${safe.threshold}-of-${safe.owners.length}, ${safe.modules.length} module(s)`)
  if (guard && safe.moduleGuard !== zeroAddress)
    ok(`SafePolicyGuard on the module path (${guardLabel ?? guard})`)
  else todo(`No SafePolicyGuard on the module path: modules are not scoped. Install it in the Safe App.`)

  step(3, 'Role key')
  let role = keystoreAddress()
  let password: string | undefined
  if (role && (await yes(`Keep the current role key (${role})?`, true))) {
    ok(`Role ${role}`)
  } else {
    ;({ role, password } = await askKey())
    ok(`Role ${role} (key encrypted in ${KEYSTORE_PATH})`)
  }
  const gas = await publicClient.getBalance({ address: role! })
  if (isModuleEnabled(safe, role!)) ok('Enabled as a module of the Safe')
  else todo(`Not a module of the Safe yet: enable it in the Safe App (${SAFE_APP_URL}, Roles)`)
  if (gas > 0n) ok(`${formatEther(gas)} ETH for gas`)
  else todo('No Sepolia ETH for gas: top it up (Safe App → Roles → Top up)')

  const config: Config = {
    chainId: SEPOLIA_CHAIN_ID,
    rpcUrl,
    safe: safe.address,
    role: role!,
    addressBook: previous?.addressBook ?? {},
    lookbackBlocks: previous?.lookbackBlocks ?? 200_000,
  }

  step(4, 'Names (optional)')
  console.log('  Names for addresses, shown to you and the agent instead of hex. Labels only.')
  for (const [name, address] of Object.entries(config.addressBook)) console.log(`  ${name}  ${address}`)
  for (;;) {
    const line = await prompt('  Add "name 0xaddress" (Enter to continue): ')
    if (!line) break
    const [name, address] = line.split(/\s+/)
    if (!name || !/^[\w.-]{1,32}$/.test(name) || !address || !isAddress(address, { strict: false })) {
      console.log('  Expected a name (letters, digits, _ . -) and an address.')
      continue
    }
    config.addressBook[name] = getAddress(address)
  }
  saveConfig(config)
  ok(`Saved ${CONFIG_PATH}`)

  step(5, 'Connect your AI clients')
  ensureToken()
  for (const client of CLIENTS.filter((c) => c.detected())) {
    if (await yes(`Connect ${client.name}?`, true)) {
      client.install()
      ok(`${client.name}: added. Restart it to load safe-role.`)
    }
  }
  console.log('  Claude Code:')
  console.log(
    `    claude mcp add --transport http safe-role ${mcpEndpoint().url} --header "Authorization: Bearer $(cat ${MCP_TOKEN_PATH})"`,
  )

  console.log('\nSetup done. The agent works while the signer runs (safe-role signer, or --auto).')
  if (await yes('Start the signer now?', true)) {
    const auto = await yes('Auto mode (sign whatever the policies allow, without asking)?', false)
    await startSigner(auto ? 'auto' : 'ask', password)
  }
}

/** Deletes this file if present; returns whether it existed. */
const remove = (path: string) => existsSync(path) && (rmSync(path), true)

/**
 * `safe-role reset`: deletes the whole local setup (config, keystore, token, history, plans), and
 * optionally the client entries. Only known files are removed, never a whole directory tree.
 */
export async function runReset(): Promise<void> {
  requireTty('reset')
  if ((await httpSigner.describe()).running) {
    throw new CliError('A signer is running.', 'Stop it first (Ctrl+C in its terminal), then reset.')
  }
  const files = [CONFIG_PATH, KEYSTORE_PATH, MCP_TOKEN_PATH, AUDIT_PATH].filter(existsSync)
  const plans = existsSync(PLANS_DIR) ? readdirSync(PLANS_DIR).filter((f) => f.endsWith('.json')) : []
  const clients = CLIENTS.filter((c) => c.detected() && c.configured())
  if (!files.length && !plans.length && !clients.length) {
    printResult('Nothing to reset.')
    return
  }
  console.log('This deletes:')
  for (const file of files) console.log(`  ${file}`)
  if (plans.length) console.log(`  ${plans.length} plan(s) in ${PLANS_DIR}`)
  if (files.includes(KEYSTORE_PATH)) {
    console.log('The role key goes with the keystore: keep a copy if you need it (the Safe App has its own).')
  }
  if (!(await yes('Reset?', false))) {
    printResult('Nothing changed.')
    return
  }
  const removed = files.filter(remove)
  for (const plan of plans) remove(join(PLANS_DIR, plan))
  for (const dir of [PLANS_DIR, HOME]) {
    try {
      rmdirSync(dir) // only if empty
    } catch {
      // Not empty (files we don't own) or already gone: leave it.
    }
  }
  const disconnected: string[] = []
  for (const client of clients) {
    if (await yes(`Also remove safe-role from ${client.name}?`, true)) {
      client.remove()
      disconnected.push(client.name)
    }
  }
  printResult('Reset done. Run `safe-role setup` to start again.', {
    removed,
    plans: plans.length,
    disconnected,
  })
}
