import { Badge, Card, Notice } from '../ui'

/**
 * The V1-vs-V2 comparison, from `contracts/contracts/v2/COMPARISON.md` (each row is a test in
 * `contracts/test/v2/compare/V1vsV2.test.ts` on two real Safes 1.5.0). Keep in sync with that file.
 */
const STORIES: { problem: string; scenario: string; v1: string; v2: string; v2Wins: boolean }[] = [
  {
    problem: 'A narrow rule hides the fallback (WA-4014)',
    scenario: "Owners' fallback is a 24h timelock; an exact Allow exists for Safe.setGuard",
    v1: 'setGuard(0) executes at once: the guard is gone',
    v2: 'Delayed (NotScheduled): the Timelock at (Owners, *) still runs',
    v2Wins: true,
  },
  {
    problem: 'A narrow rule hides the fallback (WA-4014)',
    scenario: 'Same, with an exact Allow for addOwnerWithThreshold',
    v1: 'The attacker is added as owner at once',
    v2: 'Delayed (NotScheduled)',
    v2Wins: true,
  },
  {
    problem: 'Control',
    scenario: 'A payment with no rule of its own',
    v1: 'Delayed by the fallback timelock',
    v2: 'Delayed (NotScheduled)',
    v2Wins: false,
  },
  {
    problem: 'One rule table for every caller (WA-4016)',
    scenario: 'A USDC payment allowlist; the recovery module calls swapOwner',
    v1: 'Denied (AccessDenied): recovery is blocked by the payment rules',
    v2: "Executes after recovery's 72h timelock",
    v2Wins: true,
  },
  {
    problem: 'One rule table for every caller (WA-4016)',
    scenario: 'Grant swapOwner to the recovery module',
    v1: 'The rule grants every module: Ops replaces an owner with the attacker',
    v2: 'Only Recovery: Ops gets NotGranted',
    v2Wins: true,
  },
  {
    problem: 'Co-signer / Safenet only on the multisig path',
    scenario: "A global Co-signer; the recovery module's swapOwner",
    v1: 'ModulePathUnsupported: every module is bricked, recovery included',
    v2: 'Executes with a pushed co-signature (consumed by the check)',
    v2Wins: true,
  },
  {
    problem: 'A freeze cannot cover configuration',
    scenario: 'Everything denied by a fallback Deny; a malicious configuration was requested',
    v1: 'Applied after DELAY (configuration skips every policy), then the Safe is drained',
    v2: "ConfigFrozen: the guardian's freeze blocks applyConfiguration",
    v2Wins: true,
  },
  {
    problem: 'Configuration is delayed both ways',
    scenario: 'Stop the Safe now',
    v1: 'A new Deny rule waits DELAY; payments still go out',
    v2: 'The guardian freezes at once; the next owner transaction is Frozen',
    v2Wins: true,
  },
  {
    problem: 'The guard conflicts with modules',
    scenario: "Owners' USDC allowlist (vendor A); a spending module pays its own payee (B)",
    v1: "Denied (Unauthorized): the owners' allowlist overrides the module",
    v2: 'Executes: Ops has its own Recipients + Limit',
    v2Wins: true,
  },
  {
    problem: 'Limits only cover transfers',
    scenario: '5,000 USDC / month transfer limit; approve(attacker, 100,000)',
    v1: 'Executes; the attacker pulls 100,000',
    v2: 'LimitExceeded (an approval is priced as a reservation)',
    v2Wins: true,
  },
  {
    problem: 'Limits only cover transfers',
    scenario: 'Same; send 10 ETH',
    v1: 'Executes',
    v2: 'LimitExceeded (native value counted)',
    v2Wins: true,
  },
  {
    problem: 'Batches',
    scenario: 'Transfer limit + an Allow on MultiSend; a batch of two 50,000 transfers',
    v1: 'Executes: the batch is not looked into; the Safe is drained',
    v2: 'LimitExceeded at sub-call 0 (every sub-call is checked)',
    v2Wins: true,
  },
  {
    problem: 'ERC-1271 bypasses the guard',
    scenario: 'Owners sign a USDC permit off-chain (off-chain permit attack)',
    v1: 'isValidSignature valid: permit + transferFrom drain, no guard call',
    v2: 'Invalid (0xffffffff): PolicyFallbackHandler only accepts on-chain approvals',
    v2Wins: true,
  },
]

const E2E: { file: string; story: string }[] = [
  {
    file: 'OrgChart',
    story: 'The design doc organisation: Owners, Ops, Agent, Recovery, Guardian, happy and deny paths',
  },
  {
    file: 'WA4014',
    story: 'Owners cannot skip their timelock (guard, module guard, handler, owners, configuration path)',
  },
  {
    file: 'WA4016',
    story: 'A payment allowlist (everyone / call-wide / one actor, strict) never blocks recovery',
  },
  { file: 'Compromise', story: 'Owner keys, guardian and recovery key compromised: T < R < F holds' },
  { file: 'Spark', story: 'Another Safe cancels a queued transaction; rising owner cancel threshold' },
  {
    file: 'Proofs',
    story: 'Co-signer + Safenet on both paths; one proof per batch; consumed on the module path',
  },
  {
    file: 'LimitBatch',
    story: 'Limit across a MultiSend; approval reservation and give-back; batch refill denied',
  },
  {
    file: 'OffchainPermit',
    story: 'Off-chain permit attack: V1 drained, V2 denied; signing through PolicySignLib is priced',
  },
  { file: 'QuorumTiers', story: 'Approval tiers: 3 of 3 signatures above 10,000 USDC, summed over a batch' },
]

export function WhyV2() {
  return (
    <>
      <Card title="Why V2: the same scenario on V1 and V2">
        <p>
          V1 maps a call to exactly one policy: the exact rule, else the fallback. V2 attaches policies at
          scopes <code>(actor, target, selector)</code> and runs every match: any deny wins, one Allow is
          needed, and protections (Freeze, Timelock, Co-signer, Safenet) only pass or deny, on both the
          multisig and the module path.
        </p>
        <p className="muted small">
          Each row runs on two real Safes 1.5.0 from the same infrastructure, one guarded by V1, one by V2
          (contracts/test/v2/compare/V1vsV2.test.ts; table in contracts/contracts/v2/COMPARISON.md).
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
      <Card title="Also proven end to end on V2 (real Safe 1.5.0)">
        <ul className="plain small">
          {E2E.map((e) => (
            <li key={e.file}>
              <code>{e.file}.test.ts</code>: {e.story}
            </li>
          ))}
        </ul>
        <Notice tone="warn">
          What V2 costs: an ops payment (Allow + Recipients + Limit + Freeze) uses about 96k gas more than a
          plain Safe (the design doc estimated 20–25k; contracts/contracts/v2/GAS.md), Safe 1.5.0 for the
          module path, and a new audit. Owner transactions under a Timelock must be scheduled first, and an
          owner schedule is bound to the Safe nonce (see the Timelock queue).
        </Notice>
      </Card>
    </>
  )
}
