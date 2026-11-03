import { createInterface } from 'node:readline'
import { type AgentCommand, runAgentCommand } from './commands'
import { loadConfig } from './config'
import { mcpEndpoint, postRpc } from './http'
import { GUIDE_TOPICS, MCP_INSTRUCTIONS, guide } from './guide'
import { CliError, toJson } from './output'
import type { SignerBackend } from './signer'

/**
 * The agent commands as MCP tools (JSON-RPC). The signer process serves them over localhost HTTP
 * (http.ts), and `safe-role mcp` relays stdio to it for clients that only launch commands. Written
 * without the MCP SDK to keep the bundle dependency-free; it implements the tools subset only.
 *
 * The guide ships inside the server (see guide.ts): the rules in `instructions`, the full text
 * through `safe_role_guide`. Clients only need to connect; nothing to upload.
 */

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

type Tool = {
  name: string
  command: AgentCommand
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, unknown>
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false }
const planId = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Plan id returned by safe_role_plan' } },
  required: ['id'],
  additionalProperties: false,
}
const read = { readOnlyHint: true, openWorldHint: true }

const TOOLS: Tool[] = [
  {
    name: 'safe_role_status',
    command: 'status',
    description:
      'Safe version, owners, modules, guards (V1 SafePolicyGuard or Policy Engine V2 rev 3), whether the role is an enabled policy-scoped module, its gas, whether the signer is running, and on V2 the freeze state of every Timelock attachment (`appliesToMe`). Report every item in `problems`.',
    inputSchema: noArgs,
    annotations: { ...read, title: 'Safe status' },
  },
  {
    name: 'safe_role_policies',
    command: 'policies',
    description:
      'What this role may do. V1: active policies, decoded, with what each means for the role. V2: `canDo` (its Allows and their conditions), `budgets` (left, total, reset), `protections` (Timelock delay, guardians, co-signers, Safenet, Deny), `freeze` per Timelock attachment, and `duties` (where this key is a guardian, lifter, canceller or approver). Anything not allowed is denied.',
    inputSchema: {
      type: 'object',
      properties: { fromBlock: { type: 'string', description: 'Scan from this block (default ~4 weeks)' } },
      additionalProperties: false,
    },
    annotations: { ...read, title: 'Active policies' },
  },
  {
    name: 'safe_role_balances',
    command: 'balances',
    description: 'Safe ETH/USDC/WETH balances and the role gas balance.',
    inputSchema: noArgs,
    annotations: { ...read, title: 'Balances' },
  },
  {
    name: 'safe_role_book',
    command: 'book',
    description:
      'Address-book names you can use instead of addresses (e.g. as recipient). Labels only: the Safe policies decide what is allowed. Only the user can edit it (in their terminal).',
    inputSchema: noArgs,
    annotations: { ...read, openWorldHint: false, title: 'Address book' },
  },
  {
    name: 'safe_role_history',
    command: 'history',
    description: 'The signer decisions (sent or refused), most recent last.',
    inputSchema: noArgs,
    annotations: { ...read, openWorldHint: false, title: 'Signer history' },
  },
  {
    name: 'safe_role_plan',
    command: 'plan',
    description:
      'Builds a module transaction and returns its plan id. Nothing is signed. Recipients and spenders: an address-book name, safe, or an address. Amounts are decimal token units. swap (CoW, paid to the Safe) returns 1-2 plan ids (approve, then pre-sign) to simulate and execute in order. Next: safe_role_simulate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['transfer', 'approve', 'swap', 'wrap', 'unwrap', 'call'] },
        token: { type: 'string', description: 'ETH, USDC or WETH (transfer, approve)' },
        to: { type: 'string', description: 'Recipient name (transfer) or target address (call)' },
        spender: { type: 'string', description: 'Spender name (approve)' },
        amount: { type: 'string', description: 'Decimal amount, e.g. "1.5" (swap: amount to sell)' },
        sell: { type: 'string', description: 'Token to sell (swap): USDC or WETH' },
        buy: { type: 'string', description: 'Token to buy (swap): WETH, USDC or COW' },
        slippage: { type: 'string', description: 'Swap slippage in basis points (default 50)' },
        data: { type: 'string', description: '0x calldata (call)' },
        value: { type: 'string', description: 'ETH value (call)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      title: 'Plan an action',
    },
  },
  {
    name: 'safe_role_simulate',
    command: 'simulate',
    description:
      'Dry-runs a plan as the role against the live Safe and names the deciding policy. On V2: every gate per (call, scope, policy) with allow / pass / deny and the decoded reason, the deciding one, `needs` (schedule, wait, approval, attestation), `blocked`, and `next`. A denial is an answer: explain it, do not work around it.',
    inputSchema: planId,
    annotations: { ...read, title: 'Simulate a plan' },
  },
  {
    name: 'safe_role_schedule',
    command: 'schedule',
    description:
      'V2 only: schedules a plan with the Timelock when simulate says it needs a schedule. Sends a transaction from the role (gas only, nothing moves); the signer asks y/N in ask mode. After the delay: simulate, then exec. Only after the user confirmed in chat.',
    inputSchema: planId,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Schedule a plan (Timelock)',
    },
  },
  {
    name: 'safe_role_queue',
    command: 'queue',
    description:
      "V2 only: this role's Timelock schedules: status (waiting with a countdown, ready, expired, void after a freeze), the plan id and the next step.",
    inputSchema: {
      type: 'object',
      properties: { fromBlock: { type: 'string', description: 'Scan from this block (default ~4 weeks)' } },
      additionalProperties: false,
    },
    annotations: { ...read, title: 'Timelock queue' },
  },
  {
    name: 'safe_role_cancel',
    command: 'cancel',
    description:
      'V2 only: cancels a Timelock schedule this role made (by plan id or callHash), or one it is a listed canceller of. Sends a transaction from the role; the signer asks y/N in ask mode. Only when the user asks.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Plan id, or the schedule callHash (0x, 32 bytes)' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      title: 'Cancel a schedule',
    },
  },
  {
    name: 'safe_role_approve',
    command: 'approve',
    description:
      'V2 only, for a role listed as a Co-signer approver: approves a transaction hash until validUntil, or validFor from now (default 1h). When a simulate suggested a validUntil (it covers the Timelock delay of the call), pass that one. The hash alone does not say what it approves: only approve a hash the user gave you and reviewed. The signer shows what it can and asks y/N in ask mode.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The transaction hash to approve (0x, 32 bytes)' },
        validFor: { type: 'string', description: 'How long the approval counts: 30m, 1h, 1d (default 1h)' },
        validUntil: {
          type: 'string',
          description: 'Until when the approval counts: unix seconds or an ISO date (overrides validFor)',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      title: 'Approve as co-signer',
    },
  },
  {
    name: 'safe_role_freeze',
    command: 'freeze',
    description:
      "V2 only, for a role listed as a Timelock guardian: freezes attachments (comma-separated ids from safe_role_policies duties; default: every attachment it guards). Every call they match is denied for the policy's max freeze. An emergency action: only on the user's explicit request.",
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'string', description: 'Comma-separated attachment ids (optional)' } },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      title: 'Freeze (guardian)',
    },
  },
  {
    name: 'safe_role_lift',
    command: 'lift',
    description:
      "V2 only, for a Timelock guardian or lifter: ends a freeze early (a cooldown follows). Pass the attachment id when several are frozen. Only on the user's explicit request.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Attachment id (optional when only one is frozen)' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, title: 'Lift a freeze' },
  },
  {
    name: 'safe_role_exec',
    command: 'exec',
    description:
      'Sends a simulated plan to the signer, which re-checks and re-simulates it, then signs: after a y/N from the user in its terminal (ask mode), or directly (auto mode). Only call after showing the user the action, amount, counterparty and policy, and after they confirmed in chat.',
    inputSchema: planId,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Execute a plan',
    },
  },
]

/** Served by the server itself (not a CLI command): the bundled guide. */
const GUIDE_TOOL = {
  name: 'safe_role_guide',
  description:
    'How to operate the Safe through this role: rules, the plan → simulate → confirm → exec workflow, actions, what each built-in policy checks (and does not), and what every error means. Call it once with no arguments before the first action in a conversation; call it with a topic when you need details.',
  inputSchema: {
    type: 'object',
    properties: { topic: { type: 'string', enum: [...GUIDE_TOPICS], description: 'Default: overview' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false, title: 'Guide' },
}

export type JsonRpc = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export type RpcResponse = { jsonrpc: '2.0'; id: number | string | null } & (
  { result: unknown } | { error: { code: number; message: string } }
)

async function callTool(name: string, args: Record<string, unknown>, signer: SignerBackend) {
  if (name === GUIDE_TOOL.name) {
    return { content: [{ type: 'text', text: guide(args?.topic as string | undefined) }] }
  }
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) throw new CliError(`Unknown tool ${name}.`)
  const strings = Object.fromEntries(
    Object.entries(args ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  )
  try {
    // Reads re-load the config (the user may have run `book add`); exec uses the signer's copy.
    const { summary, data } = await runAgentCommand(loadConfig(), tool.command, strings, signer)
    return { content: [{ type: 'text', text: toJson({ ok: true, summary, ...data }) }] }
  } catch (error) {
    const hint = error instanceof CliError ? error.hint : undefined
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: 'text', text: toJson({ ok: false, error: message, ...(hint ? { hint } : {}) }) }],
      isError: true,
    }
  }
}

/** Handles one JSON-RPC message. Notifications (no id) get no response. */
export async function handleRpc(message: JsonRpc, signer: SignerBackend): Promise<RpcResponse | undefined> {
  const { id, method, params = {} } = message
  if (id === undefined || id === null) return undefined
  const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result })
  try {
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '')
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'safe-role', version: '0.1.0' },
          instructions: MCP_INSTRUCTIONS,
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: [
            GUIDE_TOOL,
            ...TOOLS.map(({ name, description, inputSchema, annotations }) => ({
              name,
              description,
              inputSchema,
              annotations,
            })),
          ],
        })
      case 'tools/call':
        return reply(
          await callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>, signer),
        )
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    }
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } }
  }
}

/**
 * `safe-role mcp`: a stdio relay for clients that only launch local commands (Claude Desktop).
 * It forwards each message to the MCP endpoint of the running `safe-role signer` and holds no
 * logic or key of its own.
 */
export async function runMcpRelay(): Promise<void> {
  process.stderr.write(`safe-role MCP relay → ${mcpEndpoint().url}\n`)
  const out = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let message: JsonRpc
    try {
      message = JSON.parse(line) as JsonRpc
    } catch {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    void postRpc(message).then(
      (response) => response && out(response),
      (error: Error) =>
        message.id !== undefined &&
        out({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: `${error.message} Start it in a terminal with \`safe-role signer\`, then retry.`,
          },
        }),
    )
  })
  await new Promise<void>((resolve) => rl.on('close', resolve))
}
