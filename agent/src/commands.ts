import { type Hex, parseAbi, parseEventLogs } from 'viem'
import { publicClient } from '../../src/config/client'
import type { ModuleTx } from '../../src/lib/moduleTx'
import { fetchSafeState } from '../../src/lib/safe'
import { durationLabel, timelockPolicyAbi } from '../../src/lib/v2'
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
import { type SignerBackend, readAudit } from './signer'
import { buildSwap, orderUrl, postOrder } from './swap'
import {
  type QueueEntry,
  blockTime,
  isoTime,
  readQueue,
  requireV2,
  scheduleCheck,
  scheduleState,
  v2Context,
} from './v2'
import { renderQueue, renderSimulation } from './v2render'

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

const QUEUE_NEXT: Record<QueueEntry['status'], (id: string, e: Pick<QueueEntry, 'countdown'>) => string> = {
  waiting: (id, e) => `wait ${e.countdown}, then simulate ${id} and exec ${id}`,
  ready: (id) => `ready: simulate ${id}, then exec ${id}`,
  expired: (id) =>
    `expired: schedule ${id} again (it replaces the expired schedule), wait, then exec in the window`,
  cleared: (id) => `cleared by a freeze: schedule ${id} again once not frozen`,
  untimelocked: (id) => `no Timelock applies any more: simulate ${id}, then exec`,
}

let connectedTo: string | undefined

/** `action` is the plan action; `id` the plan id; other args are the plan flags. */
export async function runAgentCommand(
  config: Config,
  command: AgentCommand,
  args: PlanArgs & { action?: string; id?: string; fromBlock?: string },
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
            engine: 'v2',
            allowed: result.ok,
            reason: result.reason,
            deciding: v2.deciding ?? null,
            gates: v2.gates,
            needs: v2.needs,
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
      const ctx = requireV2(await v2Context(config, await fetchSafeState(config.safe)))
      // Checked here for a quick answer, and again by the signer before it signs.
      const check = await scheduleCheck(config, ctx, tx, plan.id)
      if (!check.ok) throw new CliError(check.reason, check.hint)
      const response = await signer.schedule(plan)
      if (!response.ok) throw new CliError(response.error, response.hint)
      const txHash = response.txHash as Hex
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 })
      const scheduled = parseEventLogs({
        abi: timelockPolicyAbi,
        logs: receipt.logs,
        eventName: 'Scheduled',
      })[0]
      const readyAt = scheduled?.args.readyAt ?? check.readyAt
      const ok = receipt.status === 'success' && !!scheduled
      return {
        summary: ok
          ? `Scheduled: ${intent.text}. Executable from ${isoTime(readyAt)} (delay ${durationLabel(check.delay)}). ` +
            `Check safe-role queue, then simulate and exec ${plan.id}. ${txLink(txHash)}`
          : `Schedule transaction FAILED (${receipt.status}). ${txLink(txHash)}`,
        data: {
          id: plan.id,
          intent: intent.text,
          scheduled: ok,
          callHash: check.callHash,
          readyAt: isoTime(readyAt),
          delay: durationLabel(check.delay),
          cancellers: check.cancellers,
          txHash,
          explorer: txLink(txHash),
        },
      }
    }
    case 'queue': {
      const ctx = requireV2(await v2Context(config, await fetchSafeState(config.safe)))
      const [{ from, to, live }, at] = await Promise.all([
        readQueue(config, ctx, args.fromBlock ? BigInt(args.fromBlock) : undefined),
        blockTime(),
      ])
      const entries = await Promise.all(
        live.map(async ({ call, schedule }): Promise<QueueEntry> => {
          const state = await scheduleState(config, ctx, call, schedule, at)
          const plan = call.operation === 0 ? ensurePlan(config, call) : undefined
          return {
            callHash: schedule.txHash,
            ...(plan ? { planId: plan.id } : {}),
            intent: describeTx(config, call).text,
            to: call.to,
            value: call.value,
            data: call.data,
            operation: call.operation,
            scheduledAt: isoTime(schedule.scheduledAt),
            ...state,
            next: plan
              ? QUEUE_NEXT[state.status](plan.id, state)
              : 'DELEGATECALL schedule: not executable by this CLI',
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
