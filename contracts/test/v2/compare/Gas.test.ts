import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import type { ContractTransactionResponse, Interface } from 'ethers'
import { ethers } from 'hardhat'
import type { E2ePassPolicy } from '../../../typechain-types'
import {
  type MetaTx,
  completeTx,
  execAsModule,
  execAsOwners,
  multiSendTx,
  safeTxHash,
  signSafeTx,
} from '../fixtures/safe'
import {
  ANY,
  CallMatch,
  OWNERS,
  R,
  SEL,
  T,
  addr,
  allow,
  attach,
  attest,
  call,
  coSignatures,
  cosign,
  cosignerSettings,
  cowOrder,
  deployWorld,
  execModule,
  execOwners,
  freezeSettings,
  install,
  limitSettings,
  moduleCallHash,
  orgChanges,
  orgRoles,
  policyContextTail,
  recipientsSettings,
  scheduleModule,
  scheduleOwners,
  scope,
  signCowOrderCall,
  swapOwnerCall,
  timelockSettings,
  tokenTransfer,
  usdc,
  type Change,
  type World,
} from '../e2e/world'
import { deployV1, deployV1Policies, v1Fallback, v1Rule } from './v1'

/**
 * Gas on a real Safe 1.5.0: the whole `execTransaction` / `execTransactionFromModule` (21k base,
 * calldata, signature checks, the call itself, the guard hooks), steady state (each measured
 * transaction follows a warm-up of the same kind, so recipient balances and policy slots are
 * non-zero). Printed as a table at the end; contracts/contracts/v2/GAS.md has the numbers and
 * the method.
 */

type Row = { group: string; label: string; gas: bigint; note?: string }
const rows: Row[] = []

async function gasOf(tx: Promise<ContractTransactionResponse>): Promise<bigint> {
  const receipt = await (await tx).wait()
  return receipt!.gasUsed
}

async function record(
  group: string,
  label: string,
  run: () => Promise<ContractTransactionResponse>,
  note?: string,
) {
  await gasOf(run()) // warm-up of the same kind
  const gas = await gasOf(run())
  rows.push({ group, label, gas, note })
  return gas
}

const pay = (w: World, amount = 1n) => tokenTransfer(w, w.vendorA.address, amount)
const five = async (w: World): Promise<MetaTx> =>
  multiSendTx(
    await w.infra.multiSendCallOnly.getAddress(),
    [w.vendorA, w.vendorB, w.vendorA, w.vendorB, w.vendorA].map((v) => tokenTransfer(w, v.address, 1n)),
  )

async function plainSafe() {
  const w = await deployWorld()
  await execAsOwners(
    w.safe,
    call(w.safeAddress, (w.safe.interface as Interface).encodeFunctionData('enableModule', [w.ops.address])),
    w.quorum2,
  )
  return w
}

describe('Gas on a real Safe 1.5.0: plain, V1, V2', function () {
  this.timeout(600_000)

  after(() => {
    const width = Math.max(...rows.map((r) => r.label.length))
    const lines = rows.map(
      (r) =>
        `  ${r.group.padEnd(8)} ${r.label.padEnd(width)} ${r.gas.toString().padStart(10)}${r.note ? `  ${r.note}` : ''}`,
    )
    console.log(['', '  Gas used (whole Safe transaction, steady state)', ...lines, ''].join('\n'))
  })

  it('owner path, one USDC transfer', async () => {
    const plain = await plainSafe()
    const base = await record('owner', 'plain Safe, no guard', () => execOwners(plain, pay(plain)))

    const v = await deployWorld()
    const v1p = await deployV1Policies()
    const v1 = await deployV1(v, [v1Fallback(addr(v1p.allow))])
    await record('owner', 'V1 guard, fallback AllowPolicy', () => execAsOwners(v1.safe, pay(v), v.quorum2))

    const a = await deployWorld()
    await install(a, [allow(scope(OWNERS))])
    await record('owner', 'V2, Allow (Owners, *)', () => execOwners(a, pay(a)))

    const p = await deployWorld()
    const o = scope(OWNERS)
    await install(p, [
      allow(o),
      attach(
        o,
        addr(p.recipients),
        recipientsSettings({ recipients: [p.vendorA.address, p.vendorB.address] }),
      ),
      attach(
        o,
        addr(p.limit),
        limitSettings([{ token: p.tokenAddress, amount: usdc(1_000_000), period: 30n * 86400n }]),
      ),
      attach(o, addr(p.freeze), freezeSettings(true, false)),
    ])
    await record('owner', 'V2, Allow + Recipients + Limit + Freeze', () => execOwners(p, pay(p)))

    const t = await deployWorld()
    await install(t, [
      allow(o),
      attach(o, addr(t.freeze), freezeSettings(true, false)),
      attach(o, addr(t.timelock), timelockSettings(T, { clearOnFreeze: true })),
    ])
    const scheduled = async () => {
      await scheduleOwners(t, pay(t))
      await time.increase(T)
      return execOwners(t, pay(t))
    }
    await record('owner', 'V2, Allow + Freeze + Timelock (execute)', scheduled)
    const nonce = await t.safe.nonce()
    const full = await completeTx(t.safe, { ...pay(t), nonce })
    const scheduleGas = await gasOf(
      t.timelock.scheduleOwnerTx(
        t.engineAddress,
        t.safeAddress,
        full,
        await signSafeTx(t.safe, full, t.quorum2),
      ),
    )
    rows.push({ group: 'owner', label: '  TimelockPolicy.scheduleOwnerTx (separate tx)', gas: scheduleGas })

    const c = await deployWorld()
    await install(c, [
      allow(o),
      attach(o, addr(c.cosignerPolicy), cosignerSettings(c.cosigner.address)),
      attach(o, addr(c.safenet), '0x'),
    ])
    const proved = async () => {
      const hash = await safeTxHash(c.safe, pay(c))
      const tail = policyContextTail([
        { policy: addr(c.cosignerPolicy), data: coSignatures([[c.cosigner.address, cosign(c, hash)]]) },
        { policy: addr(c.safenet), data: await attest(c, hash) },
      ])
      return execOwners(c, pay(c), c.quorum2, tail)
    }
    await record('owner', 'V2, Allow + Co-signer + Safenet (context)', proved)
    expect(rows.find((r) => r.label === 'V2, Allow (Owners, *)')!.gas > base).to.equal(true)
  })

  it('module path, one call', async () => {
    const plain = await plainSafe()
    await record('module', 'plain Safe, no module guard', () => execModule(plain, plain.ops, pay(plain)))

    const v = await deployWorld()
    const v1p = await deployV1Policies()
    const v1 = await deployV1(v, [v1Fallback(addr(v1p.allow))], [v.ops.address])
    await record('module', 'V1 guard, fallback AllowPolicy', () => execAsModule(v1.safe, v.ops, pay(v)))

    const a = await deployWorld()
    await install(a, [allow(scope(a.ops.address))], [], { modules: [a.ops.address] })
    await record('module', 'V2, Allow (Ops, *)', () => execModule(a, a.ops, pay(a)))

    const org = await deployWorld()
    await install(org, orgChanges(org), orgRoles(org), {
      modules: [org.ops.address, org.agent.address, org.recovery.address],
    })
    await record('module', 'V2 Ops payment: Allow + Recipients + Limit + Freeze', () =>
      execModule(org, org.ops, pay(org)),
    )

    const agentRun = async () => {
      const tx = signCowOrderCall(org, await cowOrder(org, usdc(1)))
      const callHash = await moduleCallHash(org, org.agent.address, tx)
      const digest = await org.cosignerPolicy.moduleTxDigest(org.engineAddress, org.safeAddress, callHash)
      await org.cosignerPolicy.cosign(
        org.engineAddress,
        org.safeAddress,
        callHash,
        org.cosigner.address,
        cosign(org, digest),
      )
      return execModule(org, org.agent, tx)
    }
    await record('module', 'V2 Agent CoW order: Allow + Limit + Co-signer + Freeze', agentRun, 'signCowOrder')
    const tx = signCowOrderCall(org, await cowOrder(org, usdc(1)))
    const callHash = await moduleCallHash(org, org.agent.address, tx)
    const digest = await org.cosignerPolicy.moduleTxDigest(org.engineAddress, org.safeAddress, callHash)
    rows.push({
      group: 'module',
      label: '  CoSignerPolicyV2.cosign (separate tx)',
      gas: await gasOf(
        org.cosignerPolicy.cosign(
          org.engineAddress,
          org.safeAddress,
          callHash,
          org.cosigner.address,
          cosign(org, digest),
        ),
      ),
    })

    const recoveryRun = async () => {
      const owners = await org.safe.getOwners()
      const swap = await swapOwnerCall(org, owners[0], ethers.Wallet.createRandom().address)
      await scheduleModule(org, org.recovery, swap)
      await time.increase(R)
      return execModule(org, org.recovery, swap)
    }
    await record('module', 'V2 Recovery swapOwner: Allow + Timelock (execute)', recoveryRun)
  })

  it('batch of 5 USDC transfers (MultiSendCallOnly)', async () => {
    const plain = await plainSafe()
    await record('batch5', 'plain Safe, owners', async () => execOwners(plain, await five(plain)))

    const v = await deployWorld()
    const v1p = await deployV1Policies()
    const v1 = await deployV1(v, [
      v1Rule(await v.infra.multiSendCallOnly.getAddress(), '0x8d80ff0a', addr(v1p.allow), '0x', 1),
    ])
    await record('batch5', 'V1, Allow on MultiSend (sub-calls unchecked)', async () =>
      execAsOwners(v1.safe, await five(v), v.quorum2),
    )

    const a = await deployWorld()
    await install(a, [allow(scope(OWNERS))])
    await record('batch5', 'V2 owners, Allow', async () => execOwners(a, await five(a)))

    const org = await deployWorld()
    await install(org, orgChanges(org), orgRoles(org), { modules: [org.ops.address] })
    await record('batch5', 'V2 Ops: Allow + Recipients + Limit + Freeze', async () =>
      execModule(org, org.ops, await five(org)),
    )
  })

  /**
   * Worst case at the caps: a batch of `calls` transfers by a module, each matching `perScope`
   * attachments at each of the 8 levels (1 ALLOW + `perScope − 1` distinct pass-only policies per
   * scope, all distinct across scopes). Pass-only policies: this is the engine's cost.
   */
  async function worst(calls: number, perScope: number, level: 0 | 1, gasLimit = 16_000_000) {
    const w = await deployWorld()
    const policies: E2ePassPolicy[] = []
    for (let i = 0; i < 8 * (perScope - 1); i++) {
      policies.push((await ethers.deployContract('E2ePassPolicy', [level])) as unknown as E2ePassPolicy)
    }
    const changes: Change[] = []
    for (let l = 0; l < 8; l++) {
      const actor = l < 4 ? ANY : w.ops.address
      const cm = l % 4
      const s = scope(
        actor,
        cm === CallMatch.TO || cm === CallMatch.TO_SELECTOR ? w.tokenAddress : undefined,
        cm === CallMatch.SELECTOR || cm === CallMatch.TO_SELECTOR ? SEL.transfer : undefined,
      )
      changes.push(allow(s))
      for (let k = 0; k < perScope - 1; k++)
        changes.push(attach(s, addr(policies[l * (perScope - 1) + k]), '0x'))
    }
    const configure = (chunk: Change[]) =>
      execAsOwners(
        w.safe,
        call(w.engineAddress, w.engine.interface.encodeFunctionData('configureImmediately', [chunk, []])),
        w.quorum2,
      )
    for (let i = 0; i < changes.length; i += 16) await configure(changes.slice(i, i + 16))
    await execAsOwners(
      w.safe,
      call(
        w.safeAddress,
        (w.safe.interface as Interface).encodeFunctionData('enableModule', [w.ops.address]),
      ),
      w.quorum2,
    )
    await execAsOwners(
      w.safe,
      call(
        w.safeAddress,
        (w.safe.interface as Interface).encodeFunctionData('setModuleGuard', [w.engineAddress]),
      ),
      w.quorum2,
    )
    const batch = multiSendTx(
      await w.infra.multiSendCallOnly.getAddress(),
      Array.from({ length: calls }, () => tokenTransfer(w, w.vendorA.address, 1n)),
    )
    const label = `${calls} calls × ${8 * perScope} matches (${level === 0 ? 'call' : 'transaction'}-level policies)`
    try {
      await record('worst', label, () =>
        w.safe.connect(w.ops).execTransactionFromModule(batch.to, 0, batch.data!, 1, { gasLimit }),
      )
    } catch (e) {
      // EIP-7825 caps a transaction at 2^24 gas (hardhat enforces it): such a batch cannot execute.
      rows.push({
        group: 'worst',
        label,
        gas: 0n,
        note: `out of gas at ${gasLimit} (${(e as Error).message.slice(0, 40)})`,
      })
    }
  }

  it('worst case: one call at 16 / 32 / 64 matches (the per-call cost is superlinear)', async () => {
    for (const per of [2, 4, 8]) await worst(1, per, 0)
    for (const per of [2, 4, 8]) await worst(1, per, 1)
  })

  it('worst case at the current caps (16 calls × 64 matches) and at tighter caps', async () => {
    await worst(16, 8, 0)
    await worst(16, 8, 1)
    await worst(4, 8, 0)
    await worst(8, 8, 0)
    await worst(16, 4, 0)
    await worst(8, 4, 0)
    await worst(16, 2, 0)
    await worst(8, 2, 0)
    expect(rows.filter((r) => r.group === 'worst').length).to.be.greaterThanOrEqual(8)
  })
})
