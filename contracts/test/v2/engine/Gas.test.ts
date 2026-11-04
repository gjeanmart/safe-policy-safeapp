import { expect } from 'chai'
import type { ContractTransactionResponse, Interface, Signer } from 'ethers'
import { ethers } from 'hardhat'
import type { Safe } from '../../../typechain-types'
import {
  deploySafe as deployRealSafe,
  execAsModule,
  execAsOwners,
  setGuard,
  setModuleGuard,
} from '../fixtures/safe'
import {
  OWNERS,
  Op,
  SEL,
  type Change,
  allow,
  deployEngine,
  deploySafe,
  execModule,
  execOwner,
  multiSendData,
  policy,
  scope,
  setup,
} from './fixtures'

/**
 * Gas of an ALLOW-only transaction (and a few heavier shapes), steady state (each measured
 * transaction follows a warm-up of the same kind):
 * - on MockSafeV2: the engine's overhead over the same transaction on an unguarded mock;
 * - on a real Safe 1.5.0 (2-of-3 owners, `USDC.transfer(vendor, 1)`), comparable with the rev 2
 *   numbers in GAS.md (owner 89,302, module 66,807, ALLOW only).
 * Printed as tables; the assertions are loose upper bounds so a regression shows up.
 */
describe('V2 engine: gas', () => {
  const mockRows: {
    scenario: string
    owner: bigint
    module: bigint
    base?: { owner: bigint; module: bigint }
  }[] = []
  const realRows: { scenario: string; owner: bigint; module: bigint }[] = []
  let baseline = { owner: 0n, module: 0n }

  after(() => {
    console.log('\n    Engine overhead on MockSafeV2 (gasUsed − unguarded mock):')
    console.log('    | scenario | owner path | module path |')
    console.log('    | --- | ---: | ---: |')
    console.log(`    | unguarded baseline (absolute) | ${baseline.owner} | ${baseline.module} |`)
    for (const r of mockRows) {
      const base = r.base ?? baseline
      console.log(`    | ${r.scenario} | ${r.owner - base.owner} | ${r.module - base.module} |`)
    }
    console.log('\n    Real Safe 1.5.0, whole transaction (rev 2: owner 89,302, module 66,807):')
    console.log('    | scenario | owner path | module path |')
    console.log('    | --- | ---: | ---: |')
    for (const r of realRows) console.log(`    | ${r.scenario} | ${r.owner} | ${r.module} |`)
  })

  async function used(p: Promise<ContractTransactionResponse>) {
    return (await (await p).wait())!.gasUsed
  }

  async function steady(run: () => Promise<ContractTransactionResponse>) {
    await used(run())
    return used(run())
  }

  async function onMock(
    scenario: string,
    mk: (module: string, policies: string[]) => Change[],
    batchOf?: number,
  ) {
    const policies = await Promise.all(
      [0, 1].map(async () => (await ethers.deployContract('EngineMockPolicy')).getAddress()),
    )
    const [, module] = await ethers.getSigners()
    const f = await setup(mk(module.address, policies))
    const one = { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping }
    const [to, data, op] = batchOf
      ? [f.multiSendAddr, multiSendData(Array(batchOf).fill(one)), Op.DELEGATECALL]
      : [f.targetAddr, SEL.ping, Op.CALL]
    const owner = await steady(() => execOwner(f.safe, to, data, op))
    const mod = await steady(() => execModule(f.safe, f.module, to, data, op))
    let base = baseline
    if (batchOf) {
      // The same batch on an unguarded mock (MultiSend's own cost is not the engine's).
      const s = await deploySafe()
      await s.safe.connect(s.asSafe).enableModule(module.address)
      base = {
        owner: await steady(() => execOwner(s.safe, to, data, op)),
        module: await steady(() => execModule(s.safe, module, to, data, op)),
      }
    }
    mockRows.push({ scenario, owner, module: mod, base })
    return { owner: owner - base.owner, module: mod - base.module }
  }

  it('baseline: unguarded mock', async () => {
    const [, module] = await ethers.getSigners()
    const s = await deploySafe()
    const t = await (await ethers.deployContract('EngineTarget')).getAddress()
    await s.safe.connect(s.asSafe).enableModule(module.address)
    baseline = {
      owner: await steady(() => execOwner(s.safe, t, SEL.ping)),
      module: await steady(() => execModule(s.safe, module, t, SEL.ping)),
    }
  })

  it('mock: 1 ALLOW (actor, *)', async () => {
    const g = await onMock('1 ALLOW (actor, *)', (m) => [allow(scope(OWNERS)), allow(scope(m))])
    expect(Number(g.owner)).to.be.lessThan(20_000)
    expect(Number(g.module)).to.be.lessThan(20_000)
  })

  it('mock: ALLOW + 2 policies', async () => {
    const g = await onMock('ALLOW + 2 policies (actor, *)', (m, [p1, p2]) => [
      allow(scope(OWNERS)),
      allow(scope(m)),
      policy(scope(OWNERS), p1),
      policy(scope(OWNERS), p2),
      policy(scope(m), p1),
      policy(scope(m), p2),
    ])
    expect(Number(g.module)).to.be.lessThan(60_000)
  })

  it('mock: 5-call batch, ALLOW only', async () => {
    const g = await onMock('5-call batch, 1 ALLOW', (m) => [allow(scope(OWNERS)), allow(scope(m))], 5)
    expect(Number(g.module)).to.be.lessThan(50_000)
  })

  it('real Safe 1.5.0: plain vs ALLOW only, one USDC transfer', async function () {
    this.timeout(120_000)
    const [, a, b, c, ops, vendor] = await ethers.getSigners()
    const owners: Signer[] = [a, b, c]
    const quorum = [a, b]
    const token = await ethers.deployContract('E2eToken')
    const tokenAddr = await token.getAddress()
    const pay = { to: tokenAddr, data: token.interface.encodeFunctionData('transfer', [vendor.address, 1n]) }

    async function freshSafe(): Promise<Safe> {
      const safe = await deployRealSafe(owners, 2)
      await token.mint(await safe.getAddress(), 10n ** 12n)
      await token.mint(vendor.address, 1n) // the recipient balance is non-zero, as in GAS.md
      const enable = (safe.interface as Interface).encodeFunctionData('enableModule', [ops.address])
      await execAsOwners(safe, { to: await safe.getAddress(), data: enable }, quorum)
      return safe
    }

    const plain = await freshSafe()
    realRows.push({
      scenario: 'plain Safe, no guard',
      owner: await steady(() => execAsOwners(plain, pay, quorum)),
      module: await steady(() => execAsModule(plain, ops, pay)),
    })

    const guarded = await freshSafe()
    const { engine } = await deployEngine()
    const engineAddr = await engine.getAddress()
    const configure = engine.interface.encodeFunctionData('configure', [
      [allow(scope(OWNERS)), allow(scope(ops.address))],
    ])
    await execAsOwners(guarded, { to: engineAddr, data: configure }, quorum)
    // Real Safe 1.5.0 checks ERC-165 (answered through the fallback) in both setters.
    await setModuleGuard(guarded, engineAddr, quorum)
    await setGuard(guarded, engineAddr, quorum)
    const owner = await steady(() => execAsOwners(guarded, pay, quorum))
    const mod = await steady(() => execAsModule(guarded, ops, pay))
    realRows.push({ scenario: 'rev 3, ALLOW (actor, *)', owner, module: mod })
    realRows.push({
      scenario: 'rev 3 overhead vs plain',
      owner: owner - realRows[0].owner,
      module: mod - realRows[0].module,
    })
    // Rev 2 on the same transaction: 89,302 (owner) and 66,807 (module), GAS.md.
    expect(Number(owner)).to.be.lessThan(89_302)
    expect(Number(mod)).to.be.lessThan(66_807)
  })
})
