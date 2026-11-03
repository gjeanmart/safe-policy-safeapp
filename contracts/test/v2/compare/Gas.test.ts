import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import type { ContractTransactionResponse, Interface } from 'ethers'
import { ethers } from 'hardhat'
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
  type ScopeData,
  signCowOrderCall,
  swapOwnerCall,
  timelockSettings,
  tokenTransfer,
  usdc,
  type Change,
  type World,
} from '../e2e/world'
import { deployV1, deployV1Policies, v1Fallback, v1Rule } from './v1'

/** `Scope.MAX_ATTACHMENTS_PER_SCOPE` (SPEC §9, §14 D-26). */
const MAX_PER_SCOPE = 6

/** Module-path co-signature deadline far past any time the test advances to. */
const PROOF_DEADLINE = 2n ** 40n

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
      const digest = await org.cosignerPolicy.moduleTxDigest(
        org.engineAddress,
        org.safeAddress,
        callHash,
        PROOF_DEADLINE,
      )
      await org.cosignerPolicy.cosign(
        org.engineAddress,
        org.safeAddress,
        callHash,
        org.cosigner.address,
        PROOF_DEADLINE,
        cosign(org, digest),
      )
      return execModule(org, org.agent, tx)
    }
    await record('module', 'V2 Agent CoW order: Allow + Limit + Co-signer + Freeze', agentRun, 'signCowOrder')
    const tx = signCowOrderCall(org, await cowOrder(org, usdc(1)))
    const callHash = await moduleCallHash(org, org.agent.address, tx)
    const digest = await org.cosignerPolicy.moduleTxDigest(
      org.engineAddress,
      org.safeAddress,
      callHash,
      PROOF_DEADLINE,
    )
    rows.push({
      group: 'module',
      label: '  CoSignerPolicyV2.cosign (separate tx)',
      gas: await gasOf(
        org.cosignerPolicy.cosign(
          org.engineAddress,
          org.safeAddress,
          callHash,
          org.cosigner.address,
          PROOF_DEADLINE,
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
   * Worst case: a module batch of `calls` calls, each matching `perScope` attachments at each of
   * the 8 levels (1 ALLOW + `perScope − 1` pass-only policies per scope, all distinct). Pass-only
   * policies keep no state, so this is the engine's own cost; real policies add theirs.
   * - identical calls (`USDC.transfer`): every call matches the same 8 scopes, so a
   *   transaction-level policy runs once for the whole batch.
   * - distinct calls (`distinct`): call j goes to its own target with its own selector, so only
   *   the `(ANY, *)` and `(Ops, *)` scopes are shared and every call brings 6 scopes of its own:
   *   the most policy runs (and the least transaction-level deduplication) the caps allow.
   */
  async function worst(calls: number, perScope: number, level: 0 | 1, distinct = false) {
    const w = await deployWorld()
    const targets = Array.from({ length: calls }, (_, j) =>
      distinct
        ? { to: ethers.Wallet.createRandom().address, selector: `0x${(0x10000000 + j).toString(16)}` }
        : { to: w.tokenAddress, selector: SEL.transfer },
    )
    const scopes: ScopeData[] = []
    const seen = new Set<string>()
    for (const t of targets) {
      for (let l = 0; l < 8; l++) {
        const cm = l % 4
        const s = scope(
          l < 4 ? ANY : w.ops.address,
          cm === CallMatch.TO || cm === CallMatch.TO_SELECTOR ? t.to : undefined,
          cm === CallMatch.SELECTOR || cm === CallMatch.TO_SELECTOR ? t.selector : undefined,
        )
        const key = JSON.stringify(s)
        if (!seen.has(key)) {
          seen.add(key)
          scopes.push(s)
        }
      }
    }
    const changes: Change[] = []
    for (const s of scopes) {
      changes.push(allow(s))
      for (let k = 0; k < perScope - 1; k++) {
        const policy = await ethers.deployContract('E2ePassPolicy', [level])
        changes.push(attach(s, addr(policy), '0x'))
      }
    }
    const engineTx = (fn: string, args: unknown[]) =>
      execAsOwners(
        w.safe,
        call(w.engineAddress, (w.engine.interface as Interface).encodeFunctionData(fn, args)),
        w.quorum2,
      )
    // Only the first chunk can be immediate (an empty configuration, SPEC §14 D-25); the others go
    // through the delay, requested together and applied once it passed.
    const chunks: Change[][] = []
    for (let i = 0; i < changes.length; i += 16) chunks.push(changes.slice(i, i + 16))
    await engineTx('configureImmediately', [chunks[0], []])
    for (const chunk of chunks.slice(1))
      await engineTx('requestConfiguration', [await w.engine.configurationRoot(chunk, [])])
    await time.increase(T)
    for (const chunk of chunks.slice(1)) await engineTx('applyConfiguration', [chunk, []])
    for (const [fn, arg] of [
      ['enableModule', w.ops.address],
      ['setModuleGuard', w.engineAddress],
    ])
      await execAsOwners(
        w.safe,
        call(w.safeAddress, (w.safe.interface as Interface).encodeFunctionData(fn, [arg])),
        w.quorum2,
      )
    const batch = multiSendTx(
      await w.infra.multiSendCallOnly.getAddress(),
      targets.map((t) =>
        distinct ? call(t.to, t.selector + '00'.repeat(64)) : tokenTransfer(w, w.vendorA.address, 1n),
      ),
    )
    const label =
      `${calls} ${distinct ? 'distinct' : 'identical'} call${calls > 1 ? 's' : ''} × ${8 * perScope} matches, ` +
      `${level === 0 ? 'call' : 'transaction'}-level`
    return record('worst', label, () =>
      w.safe.connect(w.ops).execTransactionFromModule(batch.to, 0, batch.data!, 1, { gasLimit: 16_000_000 }),
    )
  }

  it('worst case: one call at 8 / 16 / 32 / 48 matches (linear in the policy runs)', async () => {
    for (const level of [0, 1] as const) {
      const [g8, g16, g32, g48] = [
        await worst(1, 1, level),
        await worst(1, 2, level),
        await worst(1, 4, level),
        await worst(1, 6, level),
      ]
      // 8 → 16 matches adds 8 policy runs, 16 → 32 adds 16, 32 → 48 another 16: the cost per run
      // must not grow.
      const perRun16 = Number(g16 - g8) / 8
      const perRun32 = Number(g32 - g16) / 16
      const perRun48 = Number(g48 - g32) / 16
      expect(perRun32).to.be.lessThan(perRun16 * 1.15)
      expect(perRun48).to.be.lessThan(perRun16 * 1.15)
    }
  })

  it('worst case at the caps (8 calls × 48 matches) stays below 6M gas, well under the 2^24 cap', async () => {
    // Also at 4 per scope (the cap before D-26), for the table in GAS.md.
    for (const perScope of [4, 6])
      for (const distinct of [false, true])
        for (const level of [0, 1] as const) {
          const gas = await worst(8, perScope, level, distinct)
          // EIP-7825: 2^24 = 16,777,216 per transaction. The engine's worst case must leave room
          // for the policies' own work (each run here is a pass-only policy).
          if (perScope === MAX_PER_SCOPE) expect(Number(gas)).to.be.lessThan(6_000_000)
        }
  })
})
