import type { LintFinding, LintRule } from '../../lib/v2'
import { Badge, Notice } from '../ui'

const TITLES: Record<LintRule, string> = {
  'wildcard-allow-module': 'A module may call anything',
  'delegatecall-grant': 'DELEGATECALL granted',
  'safe-target-allow-not-exact': 'Module rule on the Safe itself is too broad',
  'actor-not-module': 'Not a module yet',
  'unknown-policy': 'Unknown policy',
  'no-owners-timelock': 'Owners can change the rules at once',
  'timelock-not-covering-configure': 'Rule changes are not delayed',
  'actor-no-guardian': 'Nobody can stop this actor',
  'no-way-back': 'No way back if a co-signer or Safenet disappears',
  'deny-covers-configure': 'A Deny blocks rule changes',
  'limit-unlisted-spend': 'Budget refuses other tokens',
  'limit-nft-actor': 'Budget cannot price NFTs',
  'strict-covers-safe-admin': 'Strict conditions on Safe admin calls',
  'canceller-covers-owners': 'A canceller can veto every transaction',
  'delay-below-cooldown': 'Delay shorter than the freeze cooldown',
  'self-oversight': 'An actor oversees itself',
  'narrow-delay-other-actor': 'Another actor skips the owners delay',
  'narrow-delay-spend-shape': 'Other spend functions skip the delay',
  'configure-cover-unguarded': 'Guardians cannot stop the removal of a delay',
}

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
  if (findings.length === 0) return <p className="muted small">Checks: nothing to report.</p>
  const blocks = findings.filter((f) => f.severity === 'block')
  const open = blocks.filter((f) => !confirmed.has(findingKey(f))).length
  return (
    <div className="lint">
      <div className="row">
        <h3>Checks</h3>
        {open > 0 ? (
          <Badge tone="bad">{open} to confirm</Badge>
        ) : blocks.length > 0 ? (
          <Badge tone="ok">all confirmed</Badge>
        ) : null}
      </div>
      <ul className="plain stack">
        {findings.map((f) => {
          const key = findingKey(f)
          return (
            <li key={key}>
              <Notice tone={f.severity === 'block' ? 'bad' : 'warn'}>
                <div className="stack">
                  <strong>{TITLES[f.rule] ?? f.rule}</strong>
                  <span>{f.message}</span>
                  {f.severity === 'block' && (
                    <label className="row small">
                      <input
                        type="checkbox"
                        checked={confirmed.has(key)}
                        onChange={(e) => onConfirm(key, e.target.checked)}
                      />
                      I understand, apply it anyway
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
