import { expect } from 'chai'
import { ethers } from 'hardhat'
import {
  ANY,
  CallMatch,
  Level,
  OWNERS,
  Op,
  SEL,
  type Change,
  type ScopeData,
  allow,
  deploySafe,
  execModule,
  execOwner,
  multiSendData,
  policy,
  scope,
  setup,
} from './fixtures'

/**
 * Gas of a guarded transaction on MockSafeV2 (receipt gasUsed, the mock's own cost included) and
 * the guard's overhead over the same transaction on an unguarded mock. Printed as a table; the
 * assertions are loose upper bounds so a regression shows up.
 */
describe('V2 engine: gas', () => {
  const rows: { scenario: string; owner: bigint; module: bigint }[] = []
  let baseline = { owner: 0n, module: 0n }

  after(() => {
    console.log('\n    Guard overhead (gasUsed − unguarded mock), MockSafeV2:')
    console.log('    | scenario | owner path | module path |')
    console.log('    | --- | ---: | ---: |')
    console.log(`    | unguarded baseline (absolute) | ${baseline.owner} | ${baseline.module} |`)
    for (const r of rows) {
      console.log(`    | ${r.scenario} | ${r.owner - baseline.owner} | ${r.module - baseline.module} |`)
    }
  })

  async function used(p: Promise<{ wait: () => Promise<{ gasUsed: bigint } | null> }>) {
    return (await (await p).wait())!.gasUsed
  }

  async function measure(
    scenario: string,
    mk: (module: string) => Change[],
    batchOf?: number,
    mkWithTarget?: (ctx: { targetAddr: string; module: string }) => Change[],
  ) {
    const [, module] = await ethers.getSigners()
    const f = await setup(mkWithTarget ?? mk(module.address))
    const one = { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping }
    const [to, data, op] = batchOf
      ? [f.multiSendAddr, multiSendData(Array(batchOf).fill(one)), Op.DELEGATECALL]
      : [f.targetAddr, SEL.ping, Op.CALL]
    // Warm-up so both rows measure a steady state (nonce slot, first-write costs).
    await execOwner(f.safe, to, data, op)
    await execModule(f.safe, f.module, to, data, op)
    const owner = await used(execOwner(f.safe, to, data, op))
    const mod = await used(execModule(f.safe, f.module, to, data, op))
    rows.push({ scenario, owner, module: mod })
    return { owner, module: mod }
  }

  it('baseline: unguarded mock', async () => {
    const [, module] = await ethers.getSigners()
    const s = await deploySafe()
    const t = await (await ethers.deployContract('EngineTarget')).getAddress()
    await execOwner(s.safe, s.address, s.safe.interface.encodeFunctionData('enableModule', [module.address]))
    await execOwner(s.safe, t, SEL.ping)
    await execModule(s.safe, module, t, SEL.ping)
    baseline = {
      owner: await used(execOwner(s.safe, t, SEL.ping)),
      module: await used(execModule(s.safe, module, t, SEL.ping)),
    }
  })

  it('1 ALLOW', async () => {
    const g = await measure('1 ALLOW (actor, *)', (m) => [allow(scope(OWNERS)), allow(scope(m))])
    expect(Number(g.module - baseline.module)).to.be.lessThan(25_000)
  })

  it('ALLOW + 2 policies (one call-level, one transaction-level)', async () => {
    const cp = await (await ethers.deployContract('MockPolicyV2', [Level.CALL])).getAddress()
    const tp = await (await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])).getAddress()
    const g = await measure('ALLOW + 2 policies', (m) => [
      allow(scope(OWNERS)),
      allow(scope(m)),
      policy(scope(ANY), cp),
      policy(scope(ANY), tp),
    ])
    expect(Number(g.module - baseline.module)).to.be.lessThan(80_000)
  })

  it('worst case at caps: 16-call batch, 8 levels × 8 attachments (1 ALLOW + 7 policies) per call', async () => {
    const policies = [
      ...(await Promise.all(
        [0, 1, 2, 3].map(async () =>
          (await ethers.deployContract('MockPolicyV2', [Level.CALL])).getAddress(),
        ),
      )),
      ...(await Promise.all(
        [0, 1, 2].map(async () =>
          (await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])).getAddress(),
        ),
      )),
    ]
    // Every call of the batch hits all 8 levels; every scope is full (1 ALLOW + 4 call-level + 3
    // transaction-level policies). Per call: 64 matches, 4 call-level runs of 8 ids each; then 3
    // transaction-level runs of 8 deduplicated ids each.
    const scopesFor = (actor: string, t: string): ScopeData[] => [
      scope(actor, CallMatch.ANY),
      scope(actor, CallMatch.TO, t),
      scope(actor, CallMatch.SELECTOR, ethers.ZeroAddress, SEL.ping),
      scope(actor, CallMatch.TO_SELECTOR, t, SEL.ping),
    ]
    const fill = (s: ScopeData): Change[] => [allow(s), ...policies.map((p) => policy(s, p))]
    const g = await measure(
      'worst case at caps: 16 calls × 64 matches',
      () => [],
      16,
      ({ targetAddr, module }) =>
        [ANY, OWNERS, module].flatMap((actor) => scopesFor(actor, targetAddr)).flatMap(fill),
    )
    expect(Number(g.module - baseline.module)).to.be.lessThan(15_000_000)
  })
})
