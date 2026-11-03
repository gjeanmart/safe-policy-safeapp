import { Badge, Card, Notice } from '../ui'
import { COSTS, E2E, STORIES } from './whyV2Data'

/** The V1-vs-V2 comparison (data in `whyV2Data.ts`, from contracts/contracts/v2/COMPARISON.md). */
export function WhyV2() {
  return (
    <>
      <Card title="Why V2: the same scenario on V1 and V2">
        <p>
          V1 maps a call to exactly one policy: the exact rule, else the fallback. V2 attaches rules at scopes
          (who × what: everyone or one actor, any call or one contract or one function) and runs every match:
          any deny wins, one Allow is needed, and policies (Timelock with freeze, Conditions, Budget,
          Co-signer, Safenet) only pass or deny, on both the multisig and the module path. Configuration is an
          ordinary owner transaction.
        </p>
        <p className="muted small">
          Each row runs on two real Safes 1.5.0, one guarded by V1, one by V2 (contracts/test/v2/compare;
          table in contracts/contracts/v2/COMPARISON.md).
        </p>
        <div className="table-scroll">
          <table className="config-table why-table">
            <thead>
              <tr>
                <th>Problem</th>
                <th>Scenario</th>
                <th>V1</th>
                <th>V2</th>
              </tr>
            </thead>
            <tbody>
              {STORIES.map((s) => (
                <tr key={s.scenario}>
                  <td>{s.problem}</td>
                  <td className="small">{s.scenario}</td>
                  <td className="small">
                    {s.v2Wins && <Badge tone="bad">V1</Badge>} {s.v1}
                  </td>
                  <td className="small">
                    {s.v2Wins && <Badge tone="ok">V2</Badge>} {s.v2}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Stories proven end to end on V2 (real Safe 1.5.0)">
        <ul className="plain small">
          {E2E.map((e) => (
            <li key={e.use}>
              <strong>{e.use}</strong>: {e.story}
            </li>
          ))}
        </ul>
        <Notice tone="warn">{COSTS}</Notice>
      </Card>
    </>
  )
}
