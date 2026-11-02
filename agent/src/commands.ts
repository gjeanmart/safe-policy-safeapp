import { type Hex, parseAbi, parseEventLogs } from 'viem'
import { publicClient } from '../../src/config/client'
import { balances, connect, policies, simulate, status, txLink } from './chain'
import type { Config } from './config'
import { CliError } from './output'
import { type PlanArgs, buildTx, createPlan, describeTx, loadPlan, planTx, savePlan } from './plans'
import { httpSigner } from './http'
import { type SignerBackend, readAudit } from './signer'
import { buildSwap, orderUrl, postOrder } from './swap'

/**
 * The agent-facing commands, shared by the MCP tools (`safe_role_<command>`, served by the signer)
 * and the CLI (`safe-role <command>`, for trying things by hand). Each returns a one-line summary
 * plus data.
 */
export type CommandResult = { summary: string; data: Record<string, unknown> }

export const AGENT_COMMANDS = [
  'status',
  'policies',
  'balances',
  'book',
  'history',
  'plan',
  'simulate',
  'exec',
] as const
export type AgentCommand = (typeof AGENT_COMMANDS)[number]

const moduleEvents = parseAbi([
  'event ExecutionFromModuleSuccess(address indexed module)',
  'event ExecutionFromModuleFailure(address indexed module)',
])

const split = <T extends { summary: string }>({ summary, ...data }: T): CommandResult => ({ summary, data })

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
