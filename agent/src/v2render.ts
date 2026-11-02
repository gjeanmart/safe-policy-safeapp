import type { Budget, GateRow, QueueEntry, V2Simulation } from './v2'

/**
 * Plain-text views of the V2 results for the terminal (`--json` prints the JSON instead). The MCP
 * tools always return JSON: agents read the same fields.
 */

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd()
  return [line(headers), ...rows.map(line)].map((l) => `  ${l}`).join('\n')
}

const VERDICT_TEXT: Record<GateRow['verdict'], string> = { allow: 'ALLOW', pass: 'pass', deny: 'DENY' }

const gateLine = (g: GateRow) => `${g.gate} at ${g.scope}${g.reason ? ` → ${g.reason}` : ''}`

export function renderSimulation(
  planId: string,
  intent: string,
  sim: V2Simulation,
  warnings: string[],
): string {
  const out = [
    `Simulation of ${planId}: ${intent}`,
    `Engine V2 ${sim.engine} · module path · callHash ${sim.callHash}`,
    '',
    sim.allowed
      ? `Verdict: ALLOWED${sim.deciding ? ` (granted by ${gateLine(sim.deciding)})` : ''}`
      : `Verdict: DENIED${sim.deciding ? ` (deciding gate: ${gateLine(sim.deciding)})` : ''}`,
  ]
  if (sim.gates.length) {
    out.push(
      '',
      table(
        ['call', 'scope', 'gate', 'verdict', 'reason'],
        sim.gates.map((g) => [g.call, g.scope, g.gate, VERDICT_TEXT[g.verdict], g.reason ?? '']),
      ),
    )
  }
  // A gate's deny already explains a failing dry run; show it only when it adds something.
  if (!sim.execution.ok && sim.deciding?.verdict !== 'deny')
    out.push('', `Dry run of execTransactionFromModule: fails (${sim.execution.reason})`)
  for (const w of warnings) out.push(`Warning: ${w}`)
  if (sim.next.length) out.push('', 'Next:', ...sim.next.map((n) => `  - ${n}`))
  return out.join('\n')
}

type PolicyView = {
  grants: { scope: string; operations: string; note?: string }[]
  protectionsOnMe: { scope: string; policy: string; rule: string }[]
  protectionsOnEveryone: { scope: string; policy: string; rule: string }[]
  budgets: Budget[]
}

export function renderPolicies(engine: string, view: PolicyView): string {
  const section = (title: string, body: string) => `${title}\n${body}`
  const none = '  (none)'
  return [
    `Policy Engine V2 ${engine}: what this role can do. Anything not granted is denied.`,
    '',
    section(
      'Grants (Allow that applies to me)',
      view.grants.length
        ? table(
            ['scope', 'ops', 'note'],
            view.grants.map((g) => [g.scope, g.operations, g.note ?? '']),
          )
        : none,
    ),
    '',
    section(
      'Protections on me',
      view.protectionsOnMe.length
        ? table(
            ['scope', 'rule'],
            view.protectionsOnMe.map((p) => [p.scope, p.rule]),
          )
        : none,
    ),
    '',
    section(
      'Protections on everyone (apply to me too)',
      view.protectionsOnEveryone.length
        ? table(
            ['scope', 'rule'],
            view.protectionsOnEveryone.map((p) => [p.scope, p.rule]),
          )
        : none,
    ),
    '',
    section(
      'Transfer budgets',
      view.budgets.length
        ? table(
            ['scope', 'token', 'left', 'of', 'period', 'resets'],
            view.budgets.map((b) => [
              b.scope,
              b.token,
              b.available,
              b.amount,
              b.period,
              b.resetsAt ? `${b.resetsAt} (in ${b.resetsIn})` : 'never (one-time)',
            ]),
          )
        : none,
    ),
  ].join('\n')
}

export function renderQueue(entries: QueueEntry[], scanned: string): string {
  if (!entries.length) return `No pending schedules for this role (${scanned}).`
  return [
    `Timelock queue of this role (${scanned})`,
    '',
    table(
      ['plan', 'action', 'status', 'ready at', 'next'],
      entries.map((e) => [
        e.planId ?? '-',
        e.intent ?? `${e.to} ${e.data.slice(0, 10)}`,
        e.countdown ? `waiting, ${e.countdown}` : e.status,
        e.readyAt ?? '-',
        e.next,
      ]),
    ),
  ].join('\n')
}
