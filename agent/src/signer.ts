import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chain, rpcUrl } from '../../src/config/client'
import { Operation } from '../../src/lib/configurations'
import { describeError } from '../../src/lib/errors'
import { fetchSafeState } from '../../src/lib/safe'
import { durationLabel, timelockPolicyAbi } from '../../src/lib/v2'
import { type ModuleTx, sendModuleTx } from '../../src/lib/moduleTx'
import { connect, simulate, txLink } from './chain'
import { AUDIT_PATH, type Config, label, loadConfig } from './config'
import { prompt, readKeystore, requireTty } from './keystore'
import { CliError } from './output'
import { type Plan, describeTx, planHash } from './plans'
import { verifyPresign } from './swap'
import { isoTime, scheduleCheck, v2Context } from './v2'

/**
 * The signer is the only process that holds the role key. The user starts it in a terminal
 * (`safe-role signer`), which also serves MCP on localhost (http.ts).
 *
 * What the role may do is decided on-chain by the Safe's policies. The signer adds no rules of
 * its own; it makes sure the user approves exactly what gets signed:
 * - the plan hash matches its content, for this chain, Safe and role (CALL only)
 * - the transaction is decoded from its bytes (and a CoW order checked against its UID)
 * - it is simulated against the live Safe, so the policies' verdict is known before signing
 * - the user decides: y/N here for each transaction (ask mode, the default), or once when starting
 *   the signer (auto mode, `safe-role signer --auto`)
 */

export type SignerResponse =
  { ok: true; [key: string]: unknown } | { ok: false; error: string; hint?: string }

/** What the agent commands need from a signer: its state, executing a plan, scheduling one (V2). */
export type SignerBackend = {
  describe: () => Promise<Record<string, unknown>>
  exec: (plan: Plan) => Promise<SignerResponse>
  schedule: (plan: Plan) => Promise<SignerResponse>
}

type AuditEntry = {
  at: string
  planHash: Hex
  status: 'sent' | 'scheduled' | 'rejected'
  intent: string
  txHash?: Hex
  reason?: string
}

const CONFIRM_TIMEOUT_MS = 120_000

/** `ask`: y/N per transaction. `auto`: confirmed at startup, then signs what the policies allow. */
export type SignMode = 'ask' | 'auto'

function audit(entry: AuditEntry): void {
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 })
}

export function readAudit(): AuditEntry[] {
  if (!existsSync(AUDIT_PATH)) return []
  return readFileSync(AUDIT_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry)
}

type Reject = (reason: string, intentText?: string, hint?: string) => SignerResponse

/** Rebuilds the transaction from the plan's fields and checks it is for this chain, Safe and role. */
function checkPlan(
  config: Config,
  role: Address,
  plan: Plan,
): { tx: ModuleTx; hash: Hex; reject: Reject; problem?: string } {
  const tx: ModuleTx = {
    to: getAddress(plan.tx.to),
    value: BigInt(plan.tx.value),
    data: plan.tx.data,
    operation: Number(plan.tx.operation) as ModuleTx['operation'],
  }
  const hash = planHash(config.chainId, config.safe, role, tx)
  const reject: Reject = (reason, intentText = '(not decoded)', hint) => {
    audit({ at: new Date().toISOString(), planHash: hash, status: 'rejected', intent: intentText, reason })
    console.log(`\n✗ Rejected ${hash.slice(2, 12)}: ${reason}`)
    return { ok: false, error: `Signer refused: ${reason}`, ...(hint ? { hint } : {}) }
  }
  const problem =
    plan.chainId !== config.chainId ||
    !isAddressEqual(plan.safe, config.safe) ||
    !isAddressEqual(plan.role, role)
      ? 'plan targets another chain, Safe or role'
      : plan.hash !== hash
        ? 'plan hash does not match its content'
        : tx.operation !== Operation.CALL
          ? 'only CALL is supported'
          : undefined
  return { tx, hash, reject, problem }
}

async function confirm(reject: Reject, intentText: string): Promise<SignerResponse | undefined> {
  const answer = await prompt('Sign and send? [y/N] ', { timeoutMs: CONFIRM_TIMEOUT_MS })
  if (!answer) return reject('not approved by the user (no answer within 2 minutes)', intentText)
  if (!/^y(es)?$/i.test(answer))
    return reject('declined by the user', intentText, 'Ask the user why before retrying.')
  return undefined
}

async function handleExec(
  config: Config,
  role: Address,
  privateKey: Hex,
  plan: Plan,
  mode: SignMode,
): Promise<SignerResponse> {
  const { tx, hash, reject, problem } = checkPlan(config, role, plan)
  if (problem) return reject(problem)

  const intent = describeTx(config, tx, plan.cow)
  const mismatch = verifyPresign(config, plan, tx)
  if (mismatch) return reject(mismatch, intent.text, 'Plan the swap again.')

  const sim = await simulate(config, tx)
  if (!sim.ok) return reject(`simulation failed: ${sim.reason}`, intent.text, 'The policies deny it.')

  if (mode === 'ask') {
    console.log('\n──────── Execution request ────────')
    console.log(`Plan     ${hash}`)
    console.log(`Action   ${intent.text}`)
    console.log(`Target   ${tx.to}  value ${formatUnits(tx.value, 18)} ETH`)
    console.log(`Data     ${tx.data.length > 138 ? tx.data.slice(0, 138) + '…' : tx.data}`)
    console.log(`Policy   ${sim.policy ?? 'unknown'} → simulation OK at block ${sim.block}`)
    for (const warning of intent.warnings) console.log(`⚠️  ${warning}`)
    const refused = await confirm(reject, intent.text)
    if (refused) return refused
  }

  try {
    const txHash = await sendModuleTx(config.safe, privateKey, tx)
    audit({ at: new Date().toISOString(), planHash: hash, status: 'sent', intent: intent.text, txHash })
    console.log(`✓ Sent ${txLink(txHash)}`)
    return { ok: true, txHash, intent: intent.text }
  } catch (error) {
    return reject(`sending failed: ${describeError(error)}`, intent.text)
  }
}

/**
 * Policy Engine V2: the role schedules its own call with the Timelock (`scheduleModuleTx`, sent from
 * the role key: `msg.sender` is the actor). Nothing moves now; the schedule is keyed by the call's
 * `callHash` and consumed when the same call executes after the delay.
 */
async function handleSchedule(
  config: Config,
  role: Address,
  privateKey: Hex,
  plan: Plan,
  mode: SignMode,
): Promise<SignerResponse> {
  const { tx, hash, reject, problem } = checkPlan(config, role, plan)
  if (problem) return reject(problem)
  const intent = describeTx(config, tx, plan.cow)
  const mismatch = verifyPresign(config, plan, tx)
  if (mismatch) return reject(mismatch, intent.text, 'Plan the swap again.')

  const ctx = await v2Context(config, await fetchSafeState(config.safe))
  if (!ctx) return reject('this Safe is not guarded by the Policy Engine V2', intent.text)
  const check = await scheduleCheck(config, ctx, tx, plan.id)
  if (!check.ok) return reject(check.reason, intent.text, check.hint)

  if (mode === 'ask') {
    console.log('\n──────── Schedule request (Timelock) ────────')
    console.log(`Plan      ${hash}`)
    console.log(`Action    ${intent.text}`)
    console.log(`Target    ${tx.to}  value ${formatUnits(tx.value, 18)} ETH`)
    console.log(`Schedule  delay ${durationLabel(check.delay)}, executable from ~${isoTime(check.readyAt)}`)
    console.log(`CallHash  ${check.callHash}`)
    console.log('Nothing moves now: this only starts the delay. Owners and cancellers can see and cancel it.')
    for (const warning of intent.warnings) console.log(`⚠️  ${warning}`)
    const refused = await confirm(reject, `schedule: ${intent.text}`)
    if (refused) return refused
  }

  try {
    const account = privateKeyToAccount(privateKey)
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })
    const txHash = await wallet.writeContract({
      account,
      address: ctx.deployment.policies.timelock,
      abi: timelockPolicyAbi,
      functionName: 'scheduleModuleTx',
      args: [ctx.engine, config.safe, tx.to, tx.value, tx.data, tx.operation],
    })
    audit({ at: new Date().toISOString(), planHash: hash, status: 'scheduled', intent: intent.text, txHash })
    console.log(`✓ Scheduled ${txLink(txHash)}`)
    return { ok: true, txHash, intent: intent.text, callHash: check.callHash }
  } catch (error) {
    return reject(`sending failed: ${describeError(error)}`, intent.text)
  }
}

/**
 * Unlocks the key in this terminal and returns the in-process signer. Requests are served one at
 * a time, so y/N prompts never interleave.
 */
export async function unlockSigner(
  mode: SignMode,
  password?: string,
): Promise<{ config: Config; role: Address; backend: SignerBackend }> {
  requireTty('signer')
  const config = loadConfig()
  await connect(config)
  const privateKey = readKeystore(password ?? (await prompt('Keystore password: ', { hidden: true })))
  const role = privateKeyToAccount(privateKey).address
  if (!isAddressEqual(role, config.role))
    throw new CliError(`Keystore is for ${role}, config expects ${config.role}.`)

  let queue: Promise<unknown> = Promise.resolve()
  const serialize = (task: () => Promise<SignerResponse>): Promise<SignerResponse> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run.catch((error: unknown) => ({ ok: false as const, error: describeError(error) }))
  }
  const backend: SignerBackend = {
    describe: async () => ({ running: true, mode }),
    exec: (plan) => serialize(() => handleExec(config, role, privateKey, plan, mode)),
    schedule: (plan) => serialize(() => handleSchedule(config, role, privateKey, plan, mode)),
  }
  return { config, role, backend }
}

/** Prints what the signer loaded, so the user can check it before approving anything. */
export function printSignerBanner(config: Config, role: Address, mode: SignMode, extra: string[]): void {
  console.log('\nSigner unlocked. The config is loaded now; restart the signer after editing it.')
  console.log(`  Safe      ${config.safe}`)
  console.log(`  Role      ${role}`)
  console.log(
    `  Mode      ${mode === 'ask' ? 'ask: y/N here for each transaction' : 'auto: signs whatever the policies allow, without asking'}`,
  )
  console.log(
    '  Names     ' +
      (Object.entries(config.addressBook)
        .map(([n, a]) => label({ address: a, name: n, source: 'book' }))
        .join('\n            ') || '(none)'),
  )
  for (const line of extra) console.log(line)
  console.log('Waiting for requests (Ctrl+C to stop)…')
}
