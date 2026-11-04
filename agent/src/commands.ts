import { type Abi, type Hex, parseAbi, parseEventLogs } from 'viem'
import { publicClient } from '../../src/config/client'
import type { ModuleTx } from '../../src/lib/moduleTx'
import { fetchSafeState } from '../../src/lib/safe'
import { balances, connect, policies, simulate, status, txLink } from './chain'
import type { Config } from './config'
import { CliError } from './output'
import {
  type Plan,
  type PlanArgs,
  buildTx,
  createPlan,
  describeTx,
  loadPlan,
  planHash,
  planTx,
  savePlan,
} from './plans'
import { httpSigner } from './http'
import { type SignerBackend, type SignerResponse, type V2Request, readAudit } from './signer'
import { buildSwap, orderUrl, postOrder } from './swap'
import { coSignerPolicyAbi, timelockPolicyAbi } from './v2/abi'
import { blockTime, moduleCallHash } from './v2/client'
import { duration, isoTime } from './v2/labels'
import { renderQueue, renderSimulation } from './v2/render'
import {
  type QueueEntry,
  type V2Context,
  readQueue,
  requireV2,
  scheduleCheck,
  scheduleState,
  v2Context,
} from './v2/role'

/**
 * The agent-facing commands, shared by the MCP tools (`safe_role_<command>`, served by the signer)
 * and the CLI (`safe-role <command>`, for trying things by hand). Each returns a one-line summary
 * plus data; V2 views also carry `text`, what the CLI prints without `--json` (MCP returns JSON).
 */
export type CommandResult = { summary: string; data: Record<string, unknown>; text?: string }

export const AGENT_COMMANDS = [
  'status',
  'policies',
  'balances',
  'book',
  'history',
  'plan',
  'simulate',
  'exec',
  'schedule',
  'queue',
  'cancel',
  'approve',
  'freeze',
  'lift',
] as const
export type AgentCommand = (typeof AGENT_COMMANDS)[number]

const moduleEvents = parseAbi([
  'event ExecutionFromModuleSuccess(address indexed module)',
  'event ExecutionFromModuleFailure(address indexed module)',
])

const split = <T extends { summary: string; text?: string }>({
  summary,
  text,
  ...data
}: T): CommandResult => ({
  summary,
  data,
  ...(text ? { text } : {}),
})

/** The plan of a call, reusing the saved one (and its simulation) when it exists. */
function ensurePlan(config: Config, tx: ModuleTx): Plan {
  try {
    return loadPlan(config, planHash(config.chainId, config.safe, config.role, tx).slice(2, 12))
  } catch {
    return createPlan(config, tx)
  }
}

const HASH = /^0x[0-9a-fA-F]{64}$/

/** `90`, `30m`, `2h`, `1d` → seconds. */
function parseDuration(text: string): bigint {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(text.trim())
  if (!m) throw new CliError(`Bad duration "${text}".`, 'Use e.g. 30m, 2h or 1d.')
  return BigInt(m[1]!) * { s: 1n, m: 60n, h: 3600n, d: 86_400n }[(m[2] ?? 's') as 's' | 'm' | 'h' | 'd']
}

/** `--valid-until` (unix seconds or an ISO date) or `--valid-for` (a duration, default 1h). */
async function validUntilOf(args: { validUntil?: string; validFor?: string }): Promise<bigint> {
  if (args.validUntil) {
    const v = args.validUntil.trim()
    const ms = Date.parse(v)
    const seconds = /^\d+$/.test(v) ? BigInt(v) : Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
    if (seconds <= 0n) throw new CliError(`Bad --valid-until "${v}".`, 'Unix seconds or an ISO date.')
    return seconds
  }
  return (await blockTime()) + parseDuration(args.validFor ?? '1h')
}

const attachmentIds = (text: string | undefined): Hex[] =>
  (text ?? '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((id) => {
      if (!HASH.test(id))
        throw new CliError(`"${id}" is not an attachment id (32-byte hex).`, 'Run safe-role policies.')
      return id as Hex
    })

type Sent = { txHash: Hex; ok: boolean; events: { eventName: string; args: unknown }[] }

/** Sends a V2 request to the signer, then waits for the receipt and decodes the policy's events. */
async function sendV2(signer: SignerBackend, request: V2Request, abi: Abi): Promise<Sent> {
  const response: SignerResponse = await signer.v2(request)
  if (!response.ok) throw new CliError(response.error, response.hint)
  const txHash = response.txHash as Hex
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 })
  const events = parseEventLogs({ abi, logs: receipt.logs }) as unknown as Sent['events']
  return { txHash, ok: receipt.status === 'success', events }
}

/** A schedule's call hash, from a plan id or the hash itself. */
function callHashOf(config: Config, idOrHash: string | undefined): Hex {
  if (idOrHash && HASH.test(idOrHash)) return idOrHash as Hex
  return moduleCallHash(config.safe, config.role, planTx(loadPlan(config, idOrHash)))
}

const v2Of = async (config: Config): Promise<V2Context> =>
  requireV2(await v2Context(config, await fetchSafeState(config.safe)))

let connectedTo: string | undefined

/** `action` is the plan action; `id` the plan id; other args are the plan flags. */
export async function runAgentCommand(
  config: Config,
  command: AgentCommand,
  args: PlanArgs & {
    action?: string
    id?: string
    ids?: string
    fromBlock?: string
    validFor?: string
    validUntil?: string
  },
  signer: SignerBackend = httpSigner,
): Promise<CommandResult> {
  if (command === 'book') {
    return {
      summary: `${Object.keys(config.addressBook).length} address-book entries (names for addresses).`,
      data: { addressBook: config.addressBook, safe: config.safe },
    }
  }
  if (command === 'history') {
    const entries = readAudit().slice(-20)
    return { summary: `${entries.length} most recent signer decisions.`, data: { entries } }
  }

  // Check the RPC once per URL, not on every call (the MCP server re-reads the config each call).
  if (connectedTo !== config.rpcUrl) {
    await connect(config)
    connectedTo = config.rpcUrl
  }
  switch (command) {
    case 'status': {
      const { summary, data } = split(await status(config))
      return { summary, data: { ...data, signer: await signer.describe() } }
    }
    case 'policies':
      return split(await policies(config, args.fromBlock ? BigInt(args.fromBlock) : undefined))
    case 'balances':
      return split(await balances(config))
    case 'plan': {
      if (args.action === 'swap') {
        const steps = (await buildSwap(config, args)).map((step) => {
          const plan = createPlan(config, step.tx, step.cow)
          const intent = describeTx(config, step.tx, step.cow)
          return { id: plan.id, step: step.label, intent: intent.text, warnings: intent.warnings }
        })
        const order = steps.map((s) => s.id).join(' then ')
        return {
          summary:
            `Planned a CoW swap in ${steps.length} step${steps.length > 1 ? 's' : ''}: ` +
            `${steps.map((s) => s.intent).join('; then ')}. Simulate and execute ${order}, in that order. ` +
            'The order is valid for 20 minutes.',
          data: { plans: steps },
        }
      }
      const tx = buildTx(config, args.action ?? '', args)
      const plan = createPlan(config, tx)
      const intent = describeTx(config, tx)
      return {
        summary: `Planned ${plan.id}: ${intent.text}. Next: simulate ${plan.id}`,
        data: { id: plan.id, intent: intent.text, warnings: intent.warnings, tx: plan.tx },
      }
    }
    case 'simulate': {
      const plan = loadPlan(config, args.id)
      const intent = describeTx(config, planTx(plan), plan.cow)
      const result = await simulate(config, planTx(plan))
      plan.simulation = {
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
        block: result.block.toString(),
        at: new Date().toISOString(),
      }
      savePlan(plan)
      const v2 = result.v2
      if (v2) {
        return {
          summary: result.ok
            ? `Simulation OK (Policy Engine V2): ${intent.text} is allowed (${result.policy}). Show the user, then exec ${plan.id}`
            : `Simulation DENIED (Policy Engine V2): ${result.reason}. Next: ${v2.next[0] ?? 'explain and stop.'}`,
          data: {
            id: plan.id,
            intent: intent.text,
            engine: 'v2 rev 3',
            allowed: result.ok,
            reason: result.reason,
            deciding: v2.deciding ?? null,
            gates: v2.gates,
            needs: v2.needs,
            blocked: v2.blocked,
            next: v2.next,
            callHash: v2.callHash,
            execution: v2.execution,
            block: result.block,
            warnings: intent.warnings,
          },
          text: renderSimulation(plan.id, intent.text, v2, intent.warnings),
        }
      }
      return {
        summary: result.ok
          ? `Simulation OK: ${intent.text} is allowed by ${result.policy}. Show the user, then exec ${plan.id}`
          : `Simulation FAILED: ${result.reason}`,
        data: {
          id: plan.id,
          intent: intent.text,
          allowed: result.ok,
          reason: result.ok ? undefined : result.reason,
          policy: result.policy,
          block: result.block,
          warnings: intent.warnings,
        },
      }
    }
    case 'schedule': {
      const plan = loadPlan(config, args.id)
      const tx = planTx(plan)
      const intent = describeTx(config, tx, plan.cow)
      const ctx = await v2Of(config)
      // Checked here for a quick answer, and again by the signer before it signs.
      const check = await scheduleCheck(config, ctx, tx, plan.id)
      if (!check.ok) throw new CliError(check.reason, check.hint)
      const r = await sendV2(signer, { type: 'schedule', plan }, timelockPolicyAbi)
      const scheduled = r.events.find((e) => e.eventName === 'Scheduled')?.args as
        { readyAt: bigint } | undefined
      const readyAt = scheduled?.readyAt ?? check.readyAt
      const done = r.ok && !!scheduled
      return {
        summary: done
          ? `Scheduled: ${intent.text}. Executable from ${isoTime(readyAt)} (delay ${duration(check.delay)}). ` +
            `Check safe-role queue, then simulate and exec ${plan.id}. ${txLink(r.txHash)}`
          : `Schedule transaction FAILED. ${txLink(r.txHash)}`,
        data: {
          id: plan.id,
          intent: intent.text,
          scheduled: done,
          callHash: check.callHash,
          readyAt: isoTime(readyAt),
          delay: duration(check.delay),
          ...(check.window ? { window: duration(check.window) } : {}),
          cancellers: check.cancellers,
          warnings: check.warnings,
          txHash: r.txHash,
          explorer: txLink(r.txHash),
        },
      }
    }
    case 'queue': {
      const ctx = await v2Of(config)
      const [{ from, to, live }, now] = await Promise.all([
        readQueue(config, ctx, args.fromBlock ? BigInt(args.fromBlock) : undefined),
        blockTime(),
      ])
      const entries = await Promise.all(
        live.map(async ({ call, schedule, timelock, txHash }): Promise<QueueEntry> => {
          const plan = call.operation === 0 ? ensurePlan(config, call) : undefined
          const state = await scheduleState(config, ctx, timelock, schedule, now, plan?.id)
          return {
            callHash: txHash,
            timelock,
            ...(plan ? { planId: plan.id } : {}),
            intent: describeTx(config, call).text,
            to: call.to,
            value: call.value,
            data: call.data,
            operation: call.operation,
            scheduledAt: isoTime(schedule.scheduledAt),
            ...state,
            ...(plan ? {} : { next: 'DELEGATECALL schedule: not executable by this CLI' }),
          }
        }),
      )
      const scanned = `blocks ${from}-${to}; older schedules need --from-block`
      const ready = entries.filter((e) => e.status === 'ready').length
      return {
        summary: entries.length
          ? `${entries.length} pending schedule(s) for this role, ${ready} ready to execute (${scanned}).`
          : `No pending schedules for this role (${scanned}).`,
        data: { engine: ctx.engine, scannedFrom: from, scannedTo: to, queue: entries },
        text: renderQueue(entries, scanned),
      }
    }
    case 'cancel': {
      await v2Of(config)
      const callHash = callHashOf(config, args.id)
      const r = await sendV2(signer, { type: 'cancel', txHash: callHash }, timelockPolicyAbi)
      const done = r.ok && r.events.some((e) => e.eventName === 'Cancelled')
      return {
        summary: done
          ? `Cancelled schedule ${callHash}. ${txLink(r.txHash)}`
          : `Cancel FAILED. ${txLink(r.txHash)}`,
        data: { cancelled: done, callHash, txHash: r.txHash, explorer: txLink(r.txHash) },
      }
    }
    case 'approve': {
      if (!args.id || !HASH.test(args.id))
        throw new CliError('Usage: safe-role approve <txHash> [--valid-for 1h | --valid-until <time>]')
      await v2Of(config)
      const validUntil = await validUntilOf(args)
      const r = await sendV2(
        signer,
        { type: 'approve', txHash: args.id as Hex, validUntil: validUntil.toString() },
        coSignerPolicyAbi,
      )
      const done = r.ok && r.events.some((e) => e.eventName === 'Approved')
      return {
        summary: done
          ? `Approved ${args.id} until ${isoTime(validUntil)}. ${txLink(r.txHash)}`
          : `Approval FAILED. ${txLink(r.txHash)}`,
        data: {
          approved: done,
          approvedHash: args.id,
          validUntil: isoTime(validUntil),
          txHash: r.txHash,
          explorer: txLink(r.txHash),
        },
      }
    }
    case 'freeze': {
      await v2Of(config)
      const r = await sendV2(
        signer,
        { type: 'freeze', ids: attachmentIds(args.ids ?? args.id) },
        timelockPolicyAbi,
      )
      const results = r.events
        .filter((e) => e.eventName === 'Frozen' || e.eventName === 'FreezeSkipped')
        .map((e) => {
          const a = e.args as { attachmentId: Hex; until: bigint }
          return {
            attachmentId: a.attachmentId,
            result: e.eventName === 'Frozen' ? 'frozen' : 'skipped',
            until: isoTime(a.until),
          }
        })
      return {
        summary: r.ok
          ? `Freeze sent: ${results.map((f) => `${f.attachmentId} ${f.result} until ${f.until}`).join(', ')}. ${txLink(r.txHash)}`
          : `Freeze FAILED. ${txLink(r.txHash)}`,
        data: { sent: r.ok, attachments: results, txHash: r.txHash, explorer: txLink(r.txHash) },
      }
    }
    case 'lift': {
      await v2Of(config)
      const [id] = attachmentIds(args.id)
      const r = await sendV2(signer, { type: 'lift', ...(id ? { id } : {}) }, timelockPolicyAbi)
      const lifted = r.events.find((e) => e.eventName === 'Lifted')?.args as
        { attachmentId: Hex; cooldownUntil: bigint } | undefined
      return {
        summary: lifted
          ? `Lifted ${lifted.attachmentId}; cooling down until ${isoTime(lifted.cooldownUntil)}. ${txLink(r.txHash)}`
          : `Lift FAILED. ${txLink(r.txHash)}`,
        data: {
          lifted: !!lifted,
          ...(lifted
            ? { attachmentId: lifted.attachmentId, cooldownUntil: isoTime(lifted.cooldownUntil) }
            : {}),
          txHash: r.txHash,
          explorer: txLink(r.txHash),
        },
      }
    }
    case 'exec': {
      const plan = loadPlan(config, args.id)
      if (!plan.simulation?.ok) {
        throw new CliError('This plan has no passing simulation.', `Simulate plan ${plan.id} first.`)
      }
      // A pre-sign needs its order in the CoW order book; it is inert there until signed.
      const cowOrder = plan.cow ? await postOrder(config, plan.cow) : undefined
      const response = await signer.exec(plan)
      if (!response.ok) throw new CliError(response.error, response.hint)
      const txHash = response.txHash as Hex
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 })
      const events = parseEventLogs({ abi: moduleEvents, logs: receipt.logs })
      const innerOk =
        receipt.status === 'success' && events.some((e) => e.eventName === 'ExecutionFromModuleSuccess')
      return {
        summary: innerOk
          ? `Executed: ${response.intent}. ${txLink(txHash)}`
          : `Transaction mined but the Safe call FAILED (${receipt.status}). ${txLink(txHash)}`,
        data: {
          txHash,
          explorer: txLink(txHash),
          block: receipt.blockNumber,
          success: innerOk,
          gasUsed: receipt.gasUsed,
          ...(cowOrder ? { cowOrder, cowExplorer: orderUrl(cowOrder) } : {}),
        },
      }
    }
  }
}
