import type { QueueEntry, V2Simulation, v2Policies } from './role'

/**
 * Plain-text views of the rev 3 results for the terminal (`--json` prints the JSON instead). The
 * MCP tools always return JSON: agents read the same fields.
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

const none = '  (none)'

export function renderSimulation(
  planId: string,
  intent: string,
  sim: V2Simulation,
  warnings: string[],
): string {
  const d = sim.deciding
  const deciding = d ? `${d.gate}${d.scope ? ` at ${d.scope}` : ''}${d.reason ? ` → ${d.reason}` : ''}` : ''
  const out = [
    `Simulation of ${planId}: ${intent}`,
    `Policy Engine V2 rev 3 ${sim.engine} · module path · callHash ${sim.callHash}`,
    '',
    sim.allowed
      ? `Verdict: ALLOWED${d ? ` (granted by ${deciding})` : ''}`
      : `Verdict: DENIED${d ? ` (deciding: ${deciding})` : ''}`,
  ]
  if (sim.needs.length)
    out.push(`Needs: ${sim.needs.join(', ')}${sim.blocked ? ' (and something else denies it)' : ''}`)
  out.push(
    '',
    sim.gates.length
      ? table(
          ['call', 'scope', 'gate', 'verdict', 'reason'],
          sim.gates.map((g) => [String(g.call), g.scope, g.gate, g.verdict.toUpperCase(), g.reason ?? '']),
        )
      : '  (no attachment matches this call)',
  )
  if (!sim.execution.ok && sim.allowed === false && !sim.gates.some((g) => g.verdict === 'deny'))
    out.push('', `Dry run of execTransactionFromModule: fails (${sim.execution.reason})`)
  for (const w of warnings) out.push(`Warning: ${w}`)
  if (sim.next.length) out.push('', 'Next:', ...sim.next.map((n) => `  - ${n}`))
  return out.join('\n')
}

type PolicyView = Awaited<ReturnType<typeof v2Policies>>

export function renderPolicies(engine: string, view: PolicyView): string {
  const section = (title: string, body: string) => `${title}\n${body}`
  return [
    `Policy Engine V2 rev 3 ${engine}: what this role can do. Anything not allowed is denied.`,
    '',
    section(
      'Can do (Allow for this role, with its conditions)',
      view.canDo.length
        ? view.canDo
            .map((g) =>
              [
                `  ${g.scope}  ${g.operations}${g.note ? `  (${g.note})` : ''}`,
                ...g.conditions.map((c) => `      if ${c}`),
              ].join('\n'),
            )
            .join('\n')
        : none,
    ),
    '',
    section(
      'Limited by (transfer budgets)',
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
    '',
    section(
      'Protected by (Timelock, Co-signer, Safenet, Deny)',
      view.protections.length
        ? table(
            ['scope', 'policy', 'rule', 'freeze'],
            view.protections.map((p) => [p.scope, p.policy, p.rule, p.freeze?.text ?? '']),
          )
        : none,
    ),
    '',
    section(
      'Freeze state per Timelock attachment',
      view.freeze.length
        ? table(
            ['scope', 'applies to me', 'state', 'id'],
            view.freeze.map((f) => [f.scope, f.appliesToMe ? 'yes' : 'no', f.text, f.attachmentId]),
          )
        : none,
    ),
    '',
    section(
      'Duties of this key (guardian, lifter, canceller, approver)',
      view.duties.length
        ? table(
            ['scope', 'policy', 'as', 'command'],
            view.duties.map((d) => [d.scope, d.policy, d.as, d.command]),
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
        e.readyAt,
        e.next,
      ]),
    ),
  ].join('\n')
}
