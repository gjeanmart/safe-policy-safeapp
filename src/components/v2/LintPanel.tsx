import type { LintFinding } from '../../lib/v2'
import { Badge, Notice } from '../ui'

export const findingKey = (f: LintFinding): string => `${f.rule}:${f.attachmentIds.join(',')}:${f.message}`

/**
 * Lint findings over the configuration as it will be once the draft is applied (src/lib/v2/lint.ts).
 * Each `block` finding needs an explicit confirmation before anything can be proposed;
 * `warn` findings are advice.
 */
export function LintPanel({
  findings,
  confirmed,
  onConfirm,
}: {
  findings: readonly LintFinding[]
  confirmed: ReadonlySet<string>
  onConfirm: (key: string, value: boolean) => void
}) {
  if (findings.length === 0) return <p className="muted small">Lint: no finding.</p>
  const blocks = findings.filter((f) => f.severity === 'block')
  const open = blocks.filter((f) => !confirmed.has(findingKey(f))).length
  return (
    <div className="lint">
      <div className="row">
        <h3>Lint</h3>
        {open > 0 ? (
          <Badge tone="bad">{open} to confirm</Badge>
        ) : blocks.length > 0 ? (
          <Badge tone="warn">confirmed</Badge>
        ) : null}
      </div>
      <ul className="plain stack">
        {findings.map((f) => {
          const key = findingKey(f)
          return (
            <li key={key}>
              <Notice tone={f.severity === 'block' ? 'bad' : 'warn'}>
                <div className="stack">
                  <span>
                    <code className="small">{f.rule}</code> {f.message}
                  </span>
                  {f.severity === 'block' && (
                    <label className="row small">
                      <input
                        type="checkbox"
                        checked={confirmed.has(key)}
                        onChange={(e) => onConfirm(key, e.target.checked)}
                      />
                      I understand, propose it anyway
                    </label>
                  )}
                </div>
              </Notice>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
