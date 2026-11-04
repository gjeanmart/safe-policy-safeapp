/**
 * Data of the "Why V2" tab, from `contracts/contracts/v2/COMPARISON.md` (each row is a test in
 * `contracts/test/v2/compare/V1vsV2.test.ts`, run on two real Safes 1.5.0). That file is being
 * rewritten for rev 3: update these arrays from it, nothing else in the tab needs to change.
 * Rows whose rev 3 outcome differs from the rev 2 file (freeze in TimelockPolicy, configuration as
 * an owner transaction, ERC-1271 dropped) are already worded for rev 3.
 */

export type Story = {
  problem: string
  scenario: string
  v1: string
  v2: string
  /** False when V1 and V2 behave the same (a control row, or a gap V2 does not close). */
  v2Wins: boolean
}

export const STORIES: Story[] = [
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
    v2: 'Executes with an approval pushed on-chain (CoSignerPolicy, consumed by the check)',
    v2Wins: true,
  },
  {
    problem: 'A freeze cannot cover configuration',
    scenario: 'Everything denied by a fallback Deny; a malicious configuration is on its way',
    v1: 'Applied after DELAY (configuration skips every policy), then the Safe is drained',
    v2: "configure is an owner transaction: the guardian's freeze of (Owners, *) blocks it (AttachmentFrozen)",
    v2Wins: true,
  },
  {
    problem: 'Configuration is delayed both ways',
    scenario: 'Stop the Safe now',
    v1: 'A new Deny rule waits DELAY; payments still go out',
    v2: 'The guardian freezes at once; the next owner transaction is AttachmentFrozen',
    v2Wins: true,
  },
  {
    problem: 'The guard conflicts with modules',
    scenario: "Owners' USDC allowlist (vendor A); a spending module pays its own payee (B)",
    v1: "Denied (Unauthorized): the owners' allowlist overrides the module",
    v2: 'Executes: Ops has its own conditions and budget',
    v2Wins: true,
  },
  {
    problem: 'Limits only cover transfers',
    scenario: '5,000 USDC / month transfer limit; approve(attacker, 100,000)',
    v1: 'Executes; the attacker pulls 100,000',
    v2: 'LimitExceeded (an approval counts in full)',
    v2Wins: true,
  },
  {
    problem: 'Limits only cover transfers',
    scenario: 'Same; send 10 ETH',
    v1: 'Executes',
    v2: 'Unpriced / LimitExceeded (native value always counted)',
    v2Wins: true,
  },
  {
    problem: 'Batches',
    scenario: 'Transfer limit + an Allow on MultiSend; a batch of two 50,000 transfers',
    v1: 'Executes: the batch is not looked into; the Safe is drained',
    v2: 'LimitExceeded at call 0 (every sub-call is checked, summed over the batch)',
    v2Wins: true,
  },
  {
    problem: 'ERC-1271 bypasses the guard',
    scenario: 'Owners sign a USDC permit off-chain (off-chain permit attack)',
    v1: 'isValidSignature valid: permit + transferFrom drain, no guard call',
    v2: 'Same engine-side (ERC-1271 handling dropped); the install batch sets TokenCallbackHandler (no ERC-1271) unless the owners opt out',
    v2Wins: false,
  },
]

export const E2E: { use: string; story: string }[] = [
  { use: 'Owners', story: 'Allow + Timelock T with guardians; configure waits T; WA-4014 closed' },
  { use: 'Ops payments', story: 'Allow token.transfer + recipients + budget; batches summed' },
  {
    use: 'Agent (CoW)',
    story: 'Capped approval to the vault relayer, pre-sign, budget, optional co-signer and kill switch',
  },
  { use: 'Recovery', story: 'swapOwner after R, no guardian, may lift; WA-4016 closed' },
  { use: 'Compromise', story: 'Owner keys, guardian, recovery key compromised: T < R < F holds' },
  { use: 'Committee', story: 'A sub-Safe as a module with a higher budget (replaces Quorum)' },
  { use: 'Spark', story: 'Another Safe cancels a queued transaction' },
  { use: 'Preview', story: 'matches + eth_call of each policy equals the real check' },
]

export const COSTS =
  'What V2 costs: gas on every guarded transaction (contracts/contracts/v2/GAS.md), Safe 1.5.0 for the module path, and a new audit. Owner transactions under a Timelock must be scheduled first, and an owner schedule is bound to the Safe nonce (see the Queue). Off-chain owner signatures are not covered.'
