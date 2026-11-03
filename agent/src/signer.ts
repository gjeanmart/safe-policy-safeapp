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
import { type ModuleTx, sendModuleTx } from '../../src/lib/moduleTx'
import { connect, simulate, txLink } from './chain'
import { AUDIT_PATH, type Config, label, loadConfig } from './config'
import { prompt, readKeystore, requireTty } from './keystore'
import { CliError } from './output'
import { type Plan, describeTx, planHash } from './plans'
import { verifyPresign } from './swap'
import { type V2Action, describeActionError, prepareAction, v2Context } from './v2/role'
import { client } from './v2/client'

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

/**
 * What a V2 action request carries: a plan to schedule (re-checked like an exec), or a cancel,
 * approve, freeze or lift. The signer derives every contract address itself, from the Safe.
 */
export type V2Request =
  | { type: 'schedule'; plan: Plan }
  | { type: 'cancel'; txHash: Hex }
  | { type: 'approve'; txHash: Hex; validUntil: string }
  | { type: 'freeze'; ids: Hex[] }
  | { type: 'lift'; id?: Hex }

/** What the agent commands need from a signer: its state, executing a plan, a V2 action. */
export type SignerBackend = {
  describe: () => Promise<Record<string, unknown>>
  exec: (plan: Plan) => Promise<SignerResponse>
  v2: (request: V2Request) => Promise<SignerResponse>
}

type AuditEntry = {
  at: string
  planHash?: Hex
  action?: V2Request['type']
  status: 'sent' | 'rejected'
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

const isHash = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

/**
 * Policy Engine V2 rev 3 actions signed by the role key: schedule its own call
 * (`scheduleModuleTx`, `msg.sender` is the actor), cancel a schedule, approve a transaction hash as
 * a co-signer, freeze or lift as a guardian or lifter. Each is re-validated against the chain,
 * simulated, shown (y/N in ask mode), audited, then sent. Nothing moves funds.
 */
async function handleV2(
  config: Config,
  role: Address,
  privateKey: Hex,
  request: V2Request,
  mode: SignMode,
): Promise<SignerResponse> {
  let action: V2Action
  let planHashOf: Hex | undefined
  let intent = ''
  let reject: Reject = (reason, intentText = request.type, hint) => {
    audit({
      at: new Date().toISOString(),
      action: request.type,
      status: 'rejected',
      intent: intentText,
      reason,
    })
    console.log(`\n✗ Rejected ${request.type}: ${reason}`)
    return { ok: false, error: `Signer refused: ${reason}`, ...(hint ? { hint } : {}) }
  }
  if (request.type === 'schedule') {
    const checked = checkPlan(config, role, request.plan)
    if (checked.problem) return checked.reject(checked.problem)
    const mismatch = verifyPresign(config, request.plan, checked.tx)
    if (mismatch) return checked.reject(mismatch, undefined, 'Plan the swap again.')
    reject = checked.reject
    planHashOf = checked.hash
    action = { type: 'schedule', planId: request.plan.id, tx: checked.tx }
    intent = `schedule: ${describeTx(config, checked.tx, request.plan.cow).text}`
  } else if (request.type === 'cancel' || request.type === 'approve') {
    if (!isHash(request.txHash)) return reject('txHash must be 32 bytes of hex')
    action =
      request.type === 'cancel'
        ? { type: 'cancel', txHash: request.txHash }
        : { type: 'approve', txHash: request.txHash, validUntil: String(BigInt(request.validUntil)) }
  } else if (request.type === 'freeze') {
    if (!Array.isArray(request.ids) || !request.ids.every(isHash))
      return reject('attachment ids must be 32-byte hex')
    action = { type: 'freeze', ids: request.ids }
  } else if (request.type === 'lift') {
    if (request.id !== undefined && !isHash(request.id)) return reject('attachment id must be 32-byte hex')
    action = { type: 'lift', ...(request.id ? { id: request.id } : {}) }
  } else return reject('unknown action')

  const ctx = await v2Context(config, await fetchSafeState(config.safe))
  if (!ctx) return reject('this Safe is not guarded by the Policy Engine V2 rev 3')
  const prepared = await prepareAction(config, ctx, action)
  if (!prepared.ok) return reject(prepared.reason, intent || request.type, prepared.hint)
  const intentText = intent || prepared.intent

  const call = {
    account: role,
    address: prepared.call.address,
    abi: prepared.call.abi,
    functionName: prepared.call.functionName,
    args: prepared.call.args,
  } as never
  try {
    await client().simulateContract(call)
  } catch (error) {
    return reject(`simulation failed: ${describeActionError(error, ctx)}`, intentText)
  }

  if (mode === 'ask') {
    console.log(`\n──────── ${prepared.title} ────────`)
    if (planHashOf) console.log(`Plan      ${planHashOf}`)
    console.log(`Action    ${intentText}`)
    console.log(
      `Contract  ${ctx.names(prepared.call.address)} (${prepared.call.address}).${prepared.call.functionName}`,
    )
    for (const line of prepared.lines) console.log(line)
    const refused = await confirm(reject, intentText)
    if (refused) return refused
  }

  try {
    const account = privateKeyToAccount(privateKey)
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) })
    const txHash = await wallet.writeContract({ ...(call as object), account, chain } as never)
    audit({
      at: new Date().toISOString(),
      ...(planHashOf ? { planHash: planHashOf } : {}),
      action: request.type,
      status: 'sent',
      intent: intentText,
      txHash,
    })
    console.log(`✓ Sent ${request.type} ${txLink(txHash)}`)
    return { ok: true, txHash, intent: intentText }
  } catch (error) {
    return reject(`sending failed: ${describeError(error)}`, intentText)
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
    v2: (request) => serialize(() => handleV2(config, role, privateKey, request, mode)),
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
