import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { join } from 'node:path'
import { HOME, ensureHome } from './config'
import { type JsonRpc, type RpcResponse, handleRpc } from './mcp'
import { CliError } from './output'
import type { Plan } from './plans'
import type { SignerBackend, SignerResponse } from './signer'

/**
 * The signer's localhost endpoint: MCP over Streamable HTTP (plain JSON responses, no SSE), plus
 * three methods for the CLI, `signer/describe`, `signer/exec` and `signer/schedule`. It listens on 127.0.0.1 only and
 * every request needs the bearer token from `~/.safe-role/mcp-token`; Host and Origin are checked
 * so a web page cannot reach it through the browser (DNS rebinding, cross-origin POSTs).
 */

export const MCP_TOKEN_PATH = join(HOME, 'mcp-token')
const DEFAULT_PORT = 8787
const MAX_BODY_BYTES = 1024 * 1024
/** exec waits up to 2 minutes for the user's y/N, then sends. */
const EXEC_TIMEOUT_MS = 180_000

export type McpEndpoint = { url: string; port: number; token: () => string }

export function mcpEndpoint(): McpEndpoint {
  const port = Number(process.env.SAFE_ROLE_MCP_PORT ?? DEFAULT_PORT)
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    token: () => {
      if (!existsSync(MCP_TOKEN_PATH))
        throw new Error('No MCP token yet: the safe-role signer has never run.')
      return readFileSync(MCP_TOKEN_PATH, 'utf8').trim()
    },
  }
}

/** The token is created once and kept, so client configs keep working across signer restarts. */
export function ensureToken(): string {
  if (existsSync(MCP_TOKEN_PATH)) return readFileSync(MCP_TOKEN_PATH, 'utf8').trim()
  ensureHome()
  const token = randomBytes(32).toString('hex')
  writeFileSync(MCP_TOKEN_PATH, token + '\n', { mode: 0o600 })
  return token
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function denied(req: IncomingMessage, port: number, token: string): number | undefined {
  const host = req.headers.host ?? ''
  if (!LOCAL_HOSTS.has(host.replace(new RegExp(`:${port}$`), ''))) return 403
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname)) return 403
    } catch {
      return 403
    }
  }
  const presented = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  const expected = Buffer.from(token)
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return 401
  return undefined
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/** The signer methods the CLI calls, next to MCP's. */
async function handleSignerRpc(message: JsonRpc, signer: SignerBackend): Promise<RpcResponse | undefined> {
  const id = message.id ?? null
  if (message.method === 'signer/describe') return { jsonrpc: '2.0', id, result: await signer.describe() }
  if (message.method === 'signer/exec') {
    return { jsonrpc: '2.0', id, result: await signer.exec(message.params?.plan as Plan) }
  }
  if (message.method === 'signer/schedule') {
    return { jsonrpc: '2.0', id, result: await signer.schedule(message.params?.plan as Plan) }
  }
  return handleRpc(message, signer)
}

export async function serveMcpHttp(signer: SignerBackend): Promise<McpEndpoint> {
  const endpoint = mcpEndpoint()
  const token = ensureToken()
  const server = createServer((req, res) => {
    void (async () => {
      const status = denied(req, endpoint.port, token)
      if (status) return json(res, status, { error: status === 401 ? 'unauthorized' : 'forbidden' })
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return json(res, 404)
      // No server-initiated stream and no sessions: only POST is served.
      if (req.method !== 'POST') return json(res, 405)
      let parsed: JsonRpc | JsonRpc[]
      try {
        parsed = JSON.parse(await readBody(req)) as JsonRpc | JsonRpc[]
      } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const responses = (await Promise.all(messages.map((m) => handleSignerRpc(m, signer)))).filter(Boolean)
      if (responses.length === 0) return json(res, 202)
      json(res, 200, Array.isArray(parsed) ? responses : responses[0])
    })().catch(() => json(res, 500))
  })
  // Execs can wait up to 2 minutes for y/N: no server-side timeout on requests.
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new CliError(
              `Port ${endpoint.port} is in use (another signer?).`,
              'Set SAFE_ROLE_MCP_PORT to another port.',
            )
          : error,
      ),
    )
    server.listen(endpoint.port, '127.0.0.1', resolve)
  })
  return endpoint
}

/** Posts one JSON-RPC message to the running signer. Undefined for notifications (HTTP 202). */
export async function postRpc(
  message: JsonRpc,
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<RpcResponse | undefined> {
  const endpoint = mcpEndpoint()
  let response: Response
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${endpoint.token()}`,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new CliError(
      'The signer is not running.',
      'Ask the user to run `safe-role signer` in their own terminal and unlock it.',
    )
  }
  if (response.status === 202) return undefined
  if (!response.ok) throw new CliError(`The signer answered HTTP ${response.status}.`)
  return (await response.json()) as RpcResponse
}

/** The CLI's view of the signer: the `safe-role signer` process, over its localhost endpoint. */
export const httpSigner: SignerBackend = {
  describe: () =>
    postRpc({ jsonrpc: '2.0', id: 1, method: 'signer/describe' }, 5_000).then(
      (r) => (r && 'result' in r ? (r.result as Record<string, unknown>) : { running: false }),
      (error: unknown) => ({
        running: false,
        reason: error instanceof Error ? error.message : String(error),
        ...(error instanceof CliError && error.hint ? { hint: error.hint } : {}),
      }),
    ),
  exec: async (plan) => {
    const r = await postRpc({ jsonrpc: '2.0', id: 1, method: 'signer/exec', params: { plan } })
    if (!r || !('result' in r)) throw new CliError('Unexpected answer from the signer.')
    return r.result as SignerResponse
  },
  schedule: async (plan) => {
    const r = await postRpc({ jsonrpc: '2.0', id: 1, method: 'signer/schedule', params: { plan } })
    if (!r || !('result' in r)) throw new CliError('Unexpected answer from the signer.')
    return r.result as SignerResponse
  },
}
