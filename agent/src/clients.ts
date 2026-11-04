import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

/**
 * Adds or removes the safe-role relay in local MCP clients' config files, like the "Connect"
 * buttons of Docker Desktop or JetBrains IDEs. Each write keeps a `.bak` copy of the file. Any
 * entry that launches safe-role.mjs is treated as ours, whatever its name.
 */

const SERVER_NAME = 'safe-role'
const MARKER = 'safe-role.mjs'
/** SAFE_ROLE_CLIENTS_HOME points the client configs elsewhere, for tests. */
const CLIENTS_HOME = process.env.SAFE_ROLE_CLIENTS_HOME ?? homedir()
const DESKTOP_CONFIG = join(CLIENTS_HOME, 'Library/Application Support/Claude/claude_desktop_config.json')
const CODEX_CONFIG = join(CLIENTS_HOME, '.codex/config.toml')

/** Prefers the `node` on PATH over Homebrew's versioned path, which breaks on upgrades. */
function nodePath(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'node'))) return join(dir, 'node')
  }
  return process.execPath
}

const relayCommand = () => ({ command: nodePath(), args: [resolve(process.argv[1] ?? ''), 'mcp'] })

function backupAndWrite(path: string, content: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  writeFileSync(path, content)
}

export type Client = {
  name: string
  /** The client seems installed (its config folder exists). */
  detected: () => boolean
  /** An entry launching safe-role is present. */
  configured: () => boolean
  install: () => void
  remove: () => void
}

type DesktopConfig = { mcpServers?: Record<string, { args?: string[] }> } & Record<string, unknown>

const readDesktop = (): DesktopConfig =>
  existsSync(DESKTOP_CONFIG) ? (JSON.parse(readFileSync(DESKTOP_CONFIG, 'utf8')) as DesktopConfig) : {}

const withoutOurs = (servers: DesktopConfig['mcpServers'] = {}) =>
  Object.fromEntries(Object.entries(servers).filter(([, s]) => !s.args?.some((a) => a.includes(MARKER))))

const claudeDesktop: Client = {
  name: 'Claude Desktop (and Cowork)',
  detected: () => existsSync(dirname(DESKTOP_CONFIG)),
  configured: () =>
    Object.keys(withoutOurs(readDesktop().mcpServers)).length !==
    Object.keys(readDesktop().mcpServers ?? {}).length,
  install: () => {
    const config = readDesktop()
    config.mcpServers = { ...withoutOurs(config.mcpServers), [SERVER_NAME]: relayCommand() }
    backupAndWrite(DESKTOP_CONFIG, JSON.stringify(config, null, 2) + '\n')
  },
  remove: () => {
    const config = readDesktop()
    config.mcpServers = withoutOurs(config.mcpServers)
    backupAndWrite(DESKTOP_CONFIG, JSON.stringify(config, null, 2) + '\n')
  },
}

/**
 * Codex's config.toml, edited line by line: tables are cut at `[header]` lines, and an MCP server
 * is ours when its table launches safe-role.mjs; its sub-tables (`[mcp_servers.x.tools…]`) go too.
 */
function codexWithoutOurs(toml: string): string {
  const blocks: { header?: string; lines: string[] }[] = [{ lines: [] }]
  for (const line of toml.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1]
    if (header) blocks.push({ header, lines: [line] })
    else blocks.at(-1)!.lines.push(line)
  }
  const ours = new Set(
    blocks
      .filter((b) => b.header?.startsWith('mcp_servers.') && b.lines.some((l) => l.includes(MARKER)))
      .map((b) => b.header!),
  )
  return blocks
    .filter((b) => !b.header || ![...ours].some((h) => b.header === h || b.header!.startsWith(`${h}.`)))
    .flatMap((b) => b.lines)
    .join('\n')
    .replace(/\n+$/, '\n')
}

const readCodex = () => (existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '')

const codex: Client = {
  name: 'Codex (ChatGPT desktop app, CLI, IDE)',
  detected: () => existsSync(dirname(CODEX_CONFIG)),
  configured: () => readCodex().includes(MARKER),
  install: () => {
    const { command, args } = relayCommand()
    const block = [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
      '# exec can wait up to 2 minutes for a y/N in the signer terminal',
      'tool_timeout_sec = 180',
    ].join('\n')
    const rest = codexWithoutOurs(readCodex())
    backupAndWrite(CODEX_CONFIG, (rest.trim() ? `${rest.trimEnd()}\n\n` : '') + block + '\n')
  },
  remove: () => backupAndWrite(CODEX_CONFIG, codexWithoutOurs(readCodex())),
}

export const CLIENTS: Client[] = [claudeDesktop, codex]
