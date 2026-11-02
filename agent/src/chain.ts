import {
  type Address,
  decodeAbiParameters,
  formatEther,
  formatUnits,
  isAddressEqual,
  zeroAddress,
} from 'viem'
import { erc20Abi, guardAbi, policyViewsAbi } from '../../src/abi'
import { isAllowedRpcUrl, publicClient, rpcUrlStore } from '../../src/config/client'
import { EXPLORER, POLICIES, POLICY_LABELS, type PolicyKey, TOKENS } from '../../src/config/contracts'
import {
  type Configuration,
  PERMISSION_LABELS,
  SELECTOR_LABELS,
  describeConfigurationData,
} from '../../src/lib/configurations'
import { describeError } from '../../src/lib/errors'
import { type ModuleTx, resolvePolicy, simulateModuleTx } from '../../src/lib/moduleTx'
import { activePolicies, scanPolicyEvents } from '../../src/lib/policyEvents'
import { type SafeState, activeGuard, fetchSafeState, isModuleEnabled } from '../../src/lib/safe'
import { type Config, label, nameAddress } from './config'
import { CliError } from './output'
import { planHash } from './plans'
import {
  type V2Simulation,
  detectV2,
  deploymentFor,
  labelContext,
  v2Policies,
  v2Simulate,
  v2Status,
} from './v2'
import { renderPolicies } from './v2render'

/** Points the app's shared client at the configured RPC and checks it serves the right chain. */
export async function connect(config: Config): Promise<void> {
  if (!isAllowedRpcUrl(config.rpcUrl))
    throw new CliError(`RPC URL must be HTTPS (or http://localhost): ${config.rpcUrl}`)
  rpcUrlStore.set(config.rpcUrl)
  let chainId: number
  try {
    chainId = await publicClient.getChainId()
  } catch (error) {
    throw new CliError(
      `Cannot reach the RPC (${config.rpcUrl}): ${describeError(error)}`,
      'Check the network, or the rpcUrl in ~/.safe-role/config.json (safe-role setup).',
    )
  }
  if (chainId !== config.chainId)
    throw new CliError(`RPC is on chain ${chainId}, expected ${config.chainId}. Stopping.`)
}

const policyName = (address: Address): string => {
  const key = (Object.keys(POLICIES) as PolicyKey[]).find((k) => isAddressEqual(POLICIES[k], address))
  return key ? POLICY_LABELS[key] : address
}

export async function status(config: Config) {
  const state = await fetchSafeState(config.safe)
  const v2 = await detectV2(state)
  if (v2) return statusV2(config, state, v2)
  const guard = activeGuard(state)
  const [roleGas, delay, roleAllowed] = await Promise.all([
    publicClient.getBalance({ address: config.role }),
    guard ? publicClient.readContract({ address: guard, abi: guardAbi, functionName: 'DELAY' }) : undefined,
    guard
      ? publicClient.readContract({
          address: POLICIES.allowedModule,
          abi: policyViewsAbi,
          functionName: 'isModuleAllowed',
          args: [guard, config.safe, config.role],
        })
      : undefined,
  ])
  const enabled = isModuleEnabled(state, config.role)
  const scoped = !!guard && isAddressEqual(state.moduleGuard, guard)
  const problems = [
    !enabled && 'The role is NOT an enabled module: every action will fail with GS104.',
    !scoped && 'No SafePolicyGuard on the module path: module calls are NOT scoped by policies.',
    roleGas === 0n && 'The role has no Sepolia ETH for gas.',
  ].filter(Boolean)
  return {
    summary: problems.length
      ? `Attention: ${problems.join(' ')}`
      : `Role is an enabled, policy-scoped module of Safe ${state.version}.`,
    chainId: config.chainId,
    safe: {
      address: state.address,
      version: state.version,
      owners: state.owners,
      threshold: state.threshold,
      modules: state.modules.map((m) => label(nameAddress(config, m))),
    },
    guards: {
      modulePath: state.moduleGuard === zeroAddress ? null : state.moduleGuard,
      multisigPath: state.guard === zeroAddress ? null : state.guard,
      policyGuard: guard ?? null,
      delaySeconds: delay,
    },
    role: {
      address: config.role,
      enabledModule: enabled,
      gasEth: formatEther(roleGas),
      inAllowedModulePolicy: roleAllowed ?? null,
    },
    problems,
  }
}

/** The active policies, decoded, with live allowlist permissions and what they mean for the role. */
export async function policies(config: Config, fromBlock?: bigint) {
  const state = await fetchSafeState(config.safe)
  const v2 = await detectV2(state)
  if (v2) return policiesV2(config, v2.engine)
  const guard = activeGuard(state)
  if (!guard) return { summary: 'No SafePolicyGuard installed: there are no policies.', policies: [] }
  const head = await publicClient.getBlockNumber()
  const start =
    fromBlock ?? (head > BigInt(config.lookbackBlocks) ? head - BigInt(config.lookbackBlocks) : 0n)
  const active = activePolicies(await scanPolicyEvents(guard, config.safe, start, head))
  const roleAllowed = await publicClient.readContract({
    address: POLICIES.allowedModule,
    abi: policyViewsAbi,
    functionName: 'isModuleAllowed',
    args: [guard, config.safe, config.role],
  })
  const rows = await Promise.all(active.map((c) => describePolicy(config, guard, c, roleAllowed)))
  return {
    summary: `${rows.length} active polic${rows.length === 1 ? 'y' : 'ies'} (scanned blocks ${start}-${head}; older bindings need --from-block). Anything else is denied.`,
    guard,
    scannedFrom: start,
    scannedTo: head,
    policies: rows,
  }
}

async function describePolicy(config: Config, guard: Address, c: Configuration, roleAllowed: boolean) {
  const base = {
    target: label(nameAddress(config, c.target)),
    function: SELECTOR_LABELS[c.selector] ?? c.selector,
    operation: c.operation === 0 ? 'CALL' : 'DELEGATECALL',
    policy: policyName(c.policy),
  }
  const isTransfer = isAddressEqual(c.policy, POLICIES.erc20Transfer)
  if (isTransfer || isAddressEqual(c.policy, POLICIES.erc20Approve)) {
    const [entries] = decodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint8' }] }],
      c.data,
    )
    const allowlist = await Promise.all(
      entries.map(async ([account, configured]) => {
        const live = await publicClient.readContract({
          address: c.policy,
          abi: policyViewsAbi,
          functionName: isTransfer ? 'getRecipientPermission' : 'getSpenderPermission',
          args: [guard, config.safe, c.target, account],
        })
        return {
          account: label(nameAddress(config, account)),
          permission: configured === 1 && live === 0 ? 'once (spent)' : PERMISSION_LABELS[live],
        }
      }),
    )
    return {
      ...base,
      [isTransfer ? 'recipients' : 'spenders']: allowlist,
      meaning: `${isTransfer ? 'transfer' : 'approve'} only to the listed ${isTransfer ? 'recipients' : 'spenders'}; any amount (no on-chain cap)`,
    }
  }
  if (isAddressEqual(c.policy, POLICIES.allowedModule)) {
    return {
      ...base,
      config: describeConfigurationData(c),
      meaning: roleAllowed
        ? 'allowed for this role, with ANY arguments (the policy only checks who calls)'
        : 'only for other modules: this role is not in the AllowedModulePolicy list',
    }
  }
  const meaning: Record<string, string> = {
    [POLICIES.allow.toLowerCase()]: 'allowed for everyone, with any arguments',
    [POLICIES.deny.toLowerCase()]: 'always denied',
    [POLICIES.nativeTransfer.toLowerCase()]: 'plain ETH transfers to this target',
    [POLICIES.coSigner.toLowerCase()]:
      'needs a co-signature, which the module path cannot carry: denied for this role',
    [POLICIES.multiSend.toLowerCase()]: 'batches, each inner call checked against its own policy',
  }
  return {
    ...base,
    config: describeConfigurationData(c),
    meaning: meaning[c.policy.toLowerCase()] ?? 'custom policy',
  }
}

export async function balances(config: Config) {
  const tokens = Object.values(TOKENS)
  const [safeEth, roleEth, ...tokenBalances] = await Promise.all([
    publicClient.getBalance({ address: config.safe }),
    publicClient.getBalance({ address: config.role }),
    ...tokens.map((t) =>
      publicClient.readContract({
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [config.safe],
      }),
    ),
  ])
  const safe: Record<string, string> = { ETH: formatEther(safeEth) }
  tokens.forEach((t, i) => (safe[t.symbol] = formatUnits(tokenBalances[i]!, t.decimals)))
  return {
    summary: `Safe holds ${Object.entries(safe)
      .map(([s, v]) => `${v} ${s}`)
      .join(', ')}; role has ${formatEther(roleEth)} ETH for gas.`,
    safe,
    roleGasEth: formatEther(roleEth),
  }
}

export type Simulation = {
  ok: boolean
  reason?: string
  block: bigint
  /** V1: the policy the guard consults. V2: the deciding gate. */
  policy: string | null
  guard: Address | null
  /** Set on a Policy Engine V2 Safe: every gate, the deciding one, and what to do next. */
  v2?: V2Simulation
}

/** Simulates as the role and names the policy the guard consults (exact match or fallback). */
export async function simulate(config: Config, tx: ModuleTx): Promise<Simulation> {
  const state = await fetchSafeState(config.safe)
  const v2 = await detectV2(state)
  if (v2) return simulateV2(config, v2.engine, tx)
  const [result, block] = await Promise.all([
    simulateModuleTx(config.safe, config.role, tx),
    publicClient.getBlockNumber(),
  ])
  const guard = activeGuard(state)
  let policy: string | null = null
  if (guard) {
    try {
      const resolved = await resolvePolicy(guard, config.safe, tx)
      policy =
        resolved.policy === zeroAddress
          ? 'none (default deny)'
          : `${policyName(resolved.policy)}${resolved.isFallback ? ' (fallback for any target)' : ''}`
    } catch {
      policy = null
    }
  }
  return { ...result, block, policy, guard: guard ?? null }
}

export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`

// ---------------------------------------------------------------------------------------------
// Policy Engine V2 (v2.ts holds the reads; V1 above is unchanged)
// ---------------------------------------------------------------------------------------------

const v2Ctx = (config: Config, engine: Address, modulePath = true, ownerPath = true) => {
  const deployment = deploymentFor(engine)
  return { engine, deployment, modulePath, ownerPath, labels: labelContext(config, deployment) }
}

async function statusV2(
  config: Config,
  state: SafeState,
  found: { engine: Address; modulePath: boolean; ownerPath: boolean },
) {
  let details: Awaited<ReturnType<typeof v2Status>> | undefined
  let deploymentProblem: string | undefined
  const roleGas = await publicClient.getBalance({ address: config.role })
  try {
    details = await v2Status(config, v2Ctx(config, found.engine, found.modulePath, found.ownerPath))
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    deploymentProblem = `${error.message} ${error.hint ?? ''}`.trim()
  }
  const enabled = isModuleEnabled(state, config.role)
  const freeze = details?.freeze
  const problems = [
    !enabled && 'The role is NOT an enabled module: every action will fail with GS104.',
    !found.modulePath &&
      'Policy Engine V2 is not the module guard: module calls are NOT scoped by policies (setModuleGuard).',
    freeze?.safe.state === 'frozen' &&
      `The Safe is ${freeze.safe.text}: calls under a Freeze policy are denied.`,
    freeze?.role.state === 'frozen' &&
      `This role is ${freeze.role.text} (kill switch): its calls under a Freeze policy are denied.`,
    roleGas === 0n && 'The role has no Sepolia ETH for gas.',
    deploymentProblem,
  ].filter((p): p is string => typeof p === 'string')
  return {
    summary: problems.length
      ? `Attention: ${problems.join(' ')}`
      : `Role is an enabled module of Safe ${state.version}, scoped by Policy Engine V2. Safe: ${freeze?.safe.text}; role: ${freeze?.role.text}.`,
    chainId: config.chainId,
    safe: {
      address: state.address,
      version: state.version,
      owners: state.owners,
      threshold: state.threshold,
      modules: state.modules.map((m) => label(nameAddress(config, m))),
    },
    guards: {
      modulePath: state.moduleGuard === zeroAddress ? null : state.moduleGuard,
      multisigPath: state.guard === zeroAddress ? null : state.guard,
      policyGuard: found.engine,
    },
    engine: details?.engine ?? { version: 'v2', address: found.engine },
    freeze: freeze ?? null,
    role: { address: config.role, enabledModule: enabled, gasEth: formatEther(roleGas) },
    problems,
  }
}

async function policiesV2(config: Config, engine: Address) {
  const view = await v2Policies(config, v2Ctx(config, engine))
  const budgets = view.budgets.map((b) => `${b.available} of ${b.amount} left at ${b.scope}`)
  return {
    summary:
      `Policy Engine V2: ${view.grants.length} grant(s) for this role, ${view.protectionsOnMe.length} protection(s) on it, ` +
      `${view.protectionsOnEveryone.length} on everyone${budgets.length ? `; budgets: ${budgets.join(', ')}` : ''}. Anything not granted is denied.`,
    guard: engine,
    engine: 'v2',
    ...view,
    text: renderPolicies(engine, view),
  }
}

async function simulateV2(config: Config, engine: Address, tx: ModuleTx): Promise<Simulation> {
  const planId = planHash(config.chainId, config.safe, config.role, tx).slice(2, 12)
  const [sim, block] = await Promise.all([
    v2Simulate(config, v2Ctx(config, engine), tx, planId),
    publicClient.getBlockNumber(),
  ])
  const gate = sim.deciding && `${sim.deciding.gate} at ${sim.deciding.scope}`
  const reason = sim.allowed
    ? undefined
    : !sim.execution.ok && (!sim.deciding || sim.deciding.verdict !== 'deny')
      ? sim.execution.reason
      : `${gate ?? 'denied'}${sim.deciding?.reason ? ` → ${sim.deciding.reason}` : ''}`
  return { ok: sim.allowed, reason, block, policy: gate ?? null, guard: engine, v2: sim }
}
