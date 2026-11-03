import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { type ContractTransactionResponse, type Interface, type Signer, id } from 'ethers'
import { ethers } from 'hardhat'
import type { Safe } from '../../../typechain-types'
import { type MetaTx, deploySafe, execAsModule, execAsOwners, multiSendTx } from '../fixtures/safe'
import {
  ANY,
  MONTH,
  OWNERS,
  SEL,
  T,
  type Change,
  type World,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  batchTx,
  coApprove,
  configureCall,
  cosignerSettings,
  deployWorld,
  execModule,
  execOwners,
  impersonate,
  install,
  limitSettings,
  moduleCallHash,
  onContract,
  onFunction,
  recipientsPreset,
  scheduleOwners,
  timelockSettings,
  transfer,
  usdc,
} from '../stories/world'
import { deployV1, deployV1Policies, v1Fallback, v1Rule } from './v1'

/**
 * Gas on a real Safe 1.5.0: a plain Safe, the vendored V1 guard (71b9cb0) with an Allow fallback,
 * and the rev 3 engine with its real policies. Whole-transaction `gasUsed`, steady state (each
 * measured transaction follows a warm-up of the same kind), `USDC.transfer(vendor, 1)` unless
 * stated. Prints the table GAS.md reproduces; the assertions are loose bounds against regressions
 * and the 2^24 per-transaction cap.
 */

type Row = { path: string; scenario: string; gas: bigint; rev2?: number }
const rows: Row[] = []
const worst: { scenario: string; gas: bigint }[] = []

/** Rev 2 (GAS.md "Batch B" column, 3c6d740) for the same scenarios. */
const REV2 = {
  ownerPlain: 71_467,
  ownerV1: 91_822,
  ownerAllow: 89_302,
  ownerTimelock: 144_531,
  schedule: 159_993,
  modulePlain: 49_452,
  moduleV1: 86_824,
  moduleAllow: 66_807,
  opsPayment: 136_217,
  cosign: 59_265,
  batchPlain: 99_671,
  batchV1: 118_044,
  batchOwners: 143_601,
  batchOps: 282_629,
}

async function used(p: Promise<ContractTransactionResponse>) {
  return (await (await p).wait())!.gasUsed
}
async function steady(run: () => Promise<ContractTransactionResponse>) {
  await used(run())
  return used(run())
}
function record(path: string, scenario: string, gas: bigint, rev2?: number) {
  rows.push({ path, scenario, gas, rev2 })
  return gas
}

/** A Safe of the world's owners, funded, `modules` enabled, the vendor's balance non-zero. */
async function plainSafe(w: World, modules: string[] = []): Promise<Safe> {
  const safe = await deploySafe(w.owners, 2, { infra: w.infra })
  const self = await safe.getAddress()
  await w.token.mint(self, usdc(1_000_000))
  for (const m of modules) {
    const data = (safe.interface as Interface).encodeFunctionData('enableModule', [m])
    await execAsOwners(safe, { to: self, data }, w.quorum)
  }
  return safe
}

async function fresh() {
  const w = await deployWorld()
  await w.token.mint(w.vendorA.address, 1n)
  await w.token.mint(w.safeAddress, usdc(900_000))
  return w
}

const pay = (w: World) => transfer(w, w.vendorA.address, 1n)
const pay5 = (w: World) => batchTx(w, Array(5).fill(pay(w)))

const fmt = (n: bigint | number) => n.toLocaleString('en-US')

describe('Gas: plain Safe vs V1 vs V2 rev 4 (real Safe 1.5.0)', () => {
  after(() => {
    console.log('\n    | Path | Scenario | Gas | vs plain | Rev 2 | Δ rev 2 |')
    console.log('    | --- | --- | ---: | ---: | ---: | ---: |')
    const plain: Record<string, bigint> = {}
    for (const r of rows) {
      if (r.scenario.startsWith('plain')) plain[r.path] = r.gas
      const over =
        plain[r.path] !== undefined && !r.scenario.startsWith('plain') ? `+${fmt(r.gas - plain[r.path])}` : ''
      const rev2 = r.rev2 ? fmt(r.rev2) : ''
      const delta = r.rev2 ? fmt(r.gas - BigInt(r.rev2)) : ''
      console.log(`    | ${r.path} | ${r.scenario} | ${fmt(r.gas)} | ${over} | ${rev2} | ${delta} |`)
    }
    console.log('\n    Worst case at the caps (module path, pass-only policies):')
    console.log('    | Shape | Gas |')
    console.log('    | --- | ---: |')
    for (const r of worst) console.log(`    | ${r.scenario} | ${fmt(r.gas)} |`)
  })

  it('owner path, one transfer', async function () {
    this.timeout(120_000)
    const w = await fresh()
    const plain = await plainSafe(w)
    record(
      'owner',
      'plain Safe, no guard',
      await steady(() => execAsOwners(plain, pay(w), w.quorum)),
      REV2.ownerPlain,
    )

    const v1p = await deployV1Policies()
    const v1 = await deployV1(w, [v1Fallback(addrOf(v1p.allow))])
    await w.token.mint(v1.safeAddress, usdc(1_000))
    record(
      'owner',
      'V1 guard, fallback AllowPolicy',
      await steady(() => execAsOwners(v1.safe, pay(w), w.quorum)),
      REV2.ownerV1,
    )

    await install(w, [allow(anyCall(OWNERS))])
    const g = record(
      'owner',
      'V2, Allow `(Owners, *)`',
      await steady(() => execOwners(w, pay(w))),
      REV2.ownerAllow,
    )
    expect(Number(g)).to.be.lessThan(REV2.ownerAllow)
  })

  it('owner path, Timelock 24h: execute and schedule', async function () {
    this.timeout(120_000)
    const w = await fresh()
    await install(w, [
      allow(anyCall(OWNERS)),
      attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T, guardians: [w.guardian.address] })),
    ])
    let scheduleGas = 0n
    const once = async () => {
      const full = { ...pay(w), nonce: await w.safe.nonce() }
      const before = await ethers.provider.getBlockNumber()
      await scheduleOwners(w, full)
      const block = await ethers.provider.getBlock(before + 1, true)
      scheduleGas = (await ethers.provider.getTransactionReceipt(block!.transactions[0]))!.gasUsed
      await time.increase(T)
      return execOwners(w, full)
    }
    const g = await steady(once)
    record('owner', 'V2, Allow + Timelock 24h with a guardian (execute)', g, REV2.ownerTimelock)
    record('owner', '↳ `TimelockPolicy.schedule` (its own transaction)', scheduleGas, REV2.schedule)
    expect(Number(g)).to.be.lessThan(REV2.ownerTimelock)
  })

  it('owner path, configure under the owners Timelock: with and without validate', async function () {
    this.timeout(120_000)
    const w = await fresh()
    const owners = attach(
      anyCall(OWNERS),
      w.timelock,
      timelockSettings({ delay: T, guardians: [w.guardian.address] }),
    )
    await install(w, [allow(anyCall(OWNERS)), owners])
    // Scheduled, then executed after T; only the execution is measured.
    const configure = (changes: Change[]) => async () => {
      const tx = { ...configureCall(w, changes), nonce: await w.safe.nonce() }
      await scheduleOwners(w, tx)
      await time.increase(T)
      return execOwners(w, tx)
    }
    const allowOnly = await steady(configure([allow(onFunction(OWNERS, w.tokenAddress, SEL.transfer))]))
    const withValidate = await steady(configure([owners]))
    record('config', 'configure (execute): one Allow, no policy touched', allowOnly)
    record('config', 'configure (execute): the owners Timelock re-attached, `validate` runs', withValidate)
    expect(Number(withValidate)).to.be.lessThan(250_000)
  })

  it('module path, one transfer: Allow only, ops payment, co-signer', async function () {
    this.timeout(120_000)
    const w = await fresh()
    const ops = w.ops.address
    const agent = w.agent.address
    const plain = await plainSafe(w, [ops])
    record(
      'module',
      'plain Safe, no module guard',
      await steady(() => execAsModule(plain, w.ops, pay(w))),
      REV2.modulePlain,
    )

    const v1p = await deployV1Policies()
    const v1 = await deployV1(w, [v1Fallback(addrOf(v1p.allow))], [ops])
    await w.token.mint(v1.safeAddress, usdc(1_000))
    record(
      'module',
      'V1 guard, fallback AllowPolicy',
      await steady(() => execAsModule(v1.safe, w.ops, pay(w))),
      REV2.moduleV1,
    )

    // Allow only, on a Safe with nothing else attached (as WP A measured it).
    const w2 = await fresh()
    await install(w2, [allow(anyCall(ops))], { modules: [ops] })
    const a = record(
      'module',
      'V2, Allow `(Ops, *)`',
      await steady(() => execModule(w2, w2.ops, pay(w2))),
      REV2.moduleAllow,
    )
    expect(Number(a)).to.be.lessThan(REV2.moduleAllow)

    const opsTransfer = onFunction(ops, w.tokenAddress, SEL.transfer)
    await install(
      w,
      [
        allow(opsTransfer),
        attach(opsTransfer, w.args, argsSettings(recipientsPreset([w.vendorA.address, w.vendorB.address]))),
        attach(
          anyCall(ops),
          w.limit,
          limitSettings([{ token: w.tokenAddress, amount: usdc(10_000), period: MONTH }]),
        ),
        attach(anyCall(ops), w.timelock, timelockSettings({ delay: 0, guardians: [w.guardian.address] })),
        allow(anyCall(agent)),
        attach(anyCall(agent), w.cosigner, cosignerSettings([w.cosignerKey.address], 1)),
      ],
      { modules: [ops, agent] },
    )
    const p = record(
      'module',
      'V2 ops payment: Allow + Args recipients + Limit + Timelock(0, guardian)',
      await steady(() => execModule(w, w.ops, pay(w))),
      REV2.opsPayment,
    )
    expect(Number(p)).to.be.lessThan(REV2.opsPayment)

    let approveGas = 0n
    const cosigned = async () => {
      const before = await ethers.provider.getBlockNumber()
      await coApprove(w, moduleCallHash(w, agent, pay(w)))
      const block = await ethers.provider.getBlock(before + 1, true)
      approveGas = (await ethers.provider.getTransactionReceipt(block!.transactions[0]))!.gasUsed
      return execModule(w, w.agent, pay(w))
    }
    record('module', 'V2 agent: Allow + CoSigner 1-of-1 (approval consumed)', await steady(cosigned))
    record('module', '↳ `CoSignerPolicy.approve` (its own transaction)', approveGas, REV2.cosign)
  })

  it('batch of 5 transfers (MultiSendCallOnly 1.5.0)', async function () {
    this.timeout(120_000)
    const w = await fresh()
    const ops = w.ops.address
    const plain = await plainSafe(w, [ops])
    record(
      'batch5',
      'plain Safe, owners',
      await steady(() => execAsOwners(plain, pay5(w), w.quorum)),
      REV2.batchPlain,
    )
    record('batch5', 'plain Safe, module', await steady(() => execAsModule(plain, w.ops, pay5(w))))

    const v1p = await deployV1Policies()
    const v1 = await deployV1(w, [v1Rule(w.batch, '0x8d80ff0a', addrOf(v1p.allow), '0x', 1)])
    await w.token.mint(v1.safeAddress, usdc(1_000))
    record(
      'batch5',
      'V1, Allow on MultiSend (the sub-calls are not checked)',
      await steady(() => execAsOwners(v1.safe, multiSendTx(w.batch, Array(5).fill(pay(w))), w.quorum)),
      REV2.batchV1,
    )

    const opsTransfer = onFunction(ops, w.tokenAddress, SEL.transfer)
    await install(
      w,
      [
        allow(anyCall(OWNERS)),
        allow(opsTransfer),
        attach(opsTransfer, w.args, argsSettings(recipientsPreset([w.vendorA.address, w.vendorB.address]))),
        attach(
          anyCall(ops),
          w.limit,
          limitSettings([{ token: w.tokenAddress, amount: usdc(10_000), period: MONTH }]),
        ),
        attach(anyCall(ops), w.timelock, timelockSettings({ delay: 0, guardians: [w.guardian.address] })),
      ],
      { modules: [ops] },
    )
    record(
      'batch5',
      'V2 owners, Allow `(Owners, *)`',
      await steady(() => execOwners(w, pay5(w))),
      REV2.batchOwners,
    )
    const b = record(
      'batch5',
      'V2 ops payment: Allow + Args + Limit + Timelock(0, guardian)',
      await steady(() => execModule(w, w.ops, pay5(w))),
      REV2.batchOps,
    )
    expect(Number(b)).to.be.lessThan(REV2.batchOps)
  })

  it('worst case at the caps: 8 calls × 6 levels × 8 attachments, under 16M', async function () {
    this.timeout(600_000)
    const w = await fresh()
    const ops = w.ops.address
    const targets: string[] = []
    const selectors: string[] = []
    for (let i = 0; i < 8; i++) {
      targets.push(await (await ethers.deployContract('StoryTarget')).getAddress())
      selectors.push(id(`f${i}()`).slice(0, 10))
    }
    const factory = await ethers.getContractFactory('StoryPassPolicy')
    const newPolicy = async () => (await (await factory.deploy()).waitForDeployment()).getAddress()
    const changes: Change[] = []
    const fill = async (s: ReturnType<typeof anyCall>, n: number) => {
      for (let k = 0; k < n; k++) changes.push(attach(s, await newPolicy(), '0x'))
    }
    await fill(anyCall(ANY), 8)
    await fill(anyCall(ops), 8)
    for (let i = 0; i < 8; i++) {
      await fill(onContract(ANY, targets[i]), 8)
      await fill(onFunction(ANY, targets[i], selectors[i]), 8)
      await fill(onContract(ops, targets[i]), 8)
      changes.push(allow(onFunction(ops, targets[i], selectors[i])))
      await fill(onFunction(ops, targets[i], selectors[i]), 7)
    }
    // Too many changes for one install transaction: the Safe configures in chunks before the guard.
    const asSafe: Signer = await impersonate(w.safeAddress)
    for (let i = 0; i < changes.length; i += 32) {
      await w.engine.connect(asSafe).configure(changes.slice(i, i + 32))
    }
    await install(w, [], { modules: [ops] })
    const scopes = await w.engine.getScopes(w.safeAddress)
    expect(scopes[0].length).to.equal(2 + 8 * 4)

    const one = (i: number): MetaTx => ({ to: targets[i], data: selectors[i], value: 0n, operation: 0 })
    /** Steady-state gasUsed under the 2^24 cap, or undefined when the transaction cannot fit. */
    const measure = async (scenario: string, tx: MetaTx) => {
      const exec = () =>
        w.safe
          .connect(w.ops)
          .execTransactionFromModule(tx.to, 0n, tx.data ?? '0x', tx.operation ?? 0, { gasLimit: 2 ** 24 })
      try {
        const g = await steady(exec)
        worst.push({ scenario, gas: g })
        return g
      } catch {
        worst.push({ scenario: `${scenario}: does not fit in 2^24 (reverts out of gas)`, gas: 0n })
        return undefined
      }
    }
    const shapes: [string, MetaTx][] = [
      ['1 call, 48 matches (1 ALLOW + 47 policy runs)', one(0)],
      ['2 identical calls, 48 matches each (47 runs, 2 matches each)', batchTx(w, Array(2).fill(one(0)))],
      ['3 identical calls, 48 matches each (47 runs, 3 matches each)', batchTx(w, Array(3).fill(one(0)))],
      ['4 identical calls, 48 matches each (47 runs, 4 matches each)', batchTx(w, Array(4).fill(one(0)))],
      ['8 identical calls, 48 matches each (47 runs, 8 matches each)', batchTx(w, Array(8).fill(one(0)))],
      [
        '8 distinct calls, 48 matches each (264 runs, 384 matches)',
        batchTx(w, [0, 1, 2, 3, 4, 5, 6, 7].map(one)),
      ],
    ]
    const results: (bigint | undefined)[] = []
    for (const [scenario, tx] of shapes) results.push(await measure(scenario, tx))
    // Every shape the caps allow must fit in one transaction (PLAN-rev3: worst case under 16M).
    // Failed on fa5a7ad (8 calls ran out of the 2^24 cap): `PolicyGuard._dispatch` allocated a fresh
    // `Match[](n - s)` and `check` payload per distinct policy, so memory cost grew quadratically.
    // Fixed in WP E1: the payload is encoded once and each run rewrites its `matches` tail in place.
    for (let i = 0; i < shapes.length; i++) {
      // A boolean, not `.not.equal(undefined)`: hardhat-chai-matchers turns `.equal` on a bigint into a
      // BigInt comparison and throws on `undefined`.
      expect(results[i] !== undefined, `${shapes[i][0]} fits in one transaction`).to.equal(true)
      expect(Number(results[i]), shapes[i][0]).to.be.lessThan(16_000_000)
    }
  })
})
