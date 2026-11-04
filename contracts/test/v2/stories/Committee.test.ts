import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import type { Signer } from 'ethers'
import type { MetaTx } from '../fixtures/safe'
import { deploySafe, execAsOwners } from '../fixtures/safe'
import { expectAnyRevert } from '../helpers'
import {
  Kind,
  MONTH,
  OWNERS,
  SEL,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  attachmentId,
  call,
  deployWorld,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  impersonate,
  install,
  limitSettings,
  onFunction,
  recipientsPreset,
  transfer,
  usdc,
} from './world'

/**
 * Story: approval tiers without QuorumPolicy. A 2-of-3 committee Safe (its own owners) is a
 * module actor of the main Safe with a higher budget than the ops key. Committee: Allow
 * `(Committee, USDC.transfer)` + Args Recipients at that scope, Limit 50,000 USDC a month at
 * `(Committee, *)`. Ops: the same with 10,000 a month. The main Safe's owners keep Allow
 * `(Owners, *)`, untouched by either.
 */

const OPS_BUDGET = usdc(10_000)
const COMMITTEE_BUDGET = usdc(50_000)

async function world() {
  const w = await deployWorld()
  const committee = await deploySafe(w.members, 2, { infra: w.infra })
  const committeeAddress = await committee.getAddress()
  const recipients = recipientsPreset([w.vendorA.address, w.vendorB.address])
  const actor = (a: string, budget: bigint) => [
    allow(onFunction(a, w.tokenAddress, SEL.transfer)),
    attach(onFunction(a, w.tokenAddress, SEL.transfer), w.args, argsSettings(recipients)),
    attach(anyCall(a), w.limit, limitSettings([{ token: w.tokenAddress, amount: budget, period: MONTH }])),
  ]
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      ...actor(w.ops.address, OPS_BUDGET),
      ...actor(committeeAddress, COMMITTEE_BUDGET),
    ],
    {
      modules: [w.ops.address, committeeAddress],
    },
  )
  return { ...w, committee, committeeAddress }
}
type W = Awaited<ReturnType<typeof world>>

/** The committee Safe executes `tx` on the main Safe as a module, signed by `signers` of its own owners. */
function committeeExec(w: W, tx: MetaTx, signers: Signer[] = w.members.slice(0, 2)) {
  const data = w.safe.interface.encodeFunctionData('execTransactionFromModule', [
    tx.to,
    tx.value ?? 0n,
    tx.data ?? '0x',
    0,
  ])
  return execAsOwners(w.committee, call(w.safeAddress, data), signers)
}

/** The committee's module call simulated directly, to read the engine's reason (nested, it becomes GS013). */
async function committeeCallStatic(w: W, tx: MetaTx) {
  const asCommittee = await impersonate(w.committeeAddress)
  return w.safe
    .connect(asCommittee)
    .execTransactionFromModule.staticCall(tx.to, tx.value ?? 0n, tx.data ?? '0x', 0)
}

const limitId = (w: W, actor: string) => attachmentId(anyCall(actor), Kind.POLICY, addrOf(w.limit))

describe('Story: a 2-of-3 committee Safe as a module actor with its own higher Limit (replaces QuorumPolicy)', () => {
  it('the committee pays 30,000 with 2 of its 3 signatures', async () => {
    const w = await loadFixture(world)
    await committeeExec(w, transfer(w, w.vendorA.address, usdc(30_000)))
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(30_000))
  })

  it('ops cannot pay what the committee can (LimitExceeded at 10,000)', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.vendorA.address, usdc(30_000))),
      w,
      w.limit,
      'LimitExceeded',
      [0, limitId(w, w.ops.address), w.tokenAddress, usdc(30_000), OPS_BUDGET],
    )
  })

  it('above its own budget the committee is denied (LimitExceeded), summed over the month', async () => {
    const w = await loadFixture(world)
    await committeeExec(w, transfer(w, w.vendorA.address, usdc(40_000)))
    const over = transfer(w, w.vendorB.address, usdc(10_001))
    await expectAnyRevert(committeeExec(w, over))
    await expectPolicyDenied(committeeCallStatic(w, over), w, w.limit, 'LimitExceeded', [
      0,
      limitId(w, w.committeeAddress),
      w.tokenAddress,
      usdc(10_001),
      usdc(10_000),
    ])
    await time.increase(MONTH)
    await committeeExec(w, over)
  })

  it('the committee is held to its recipients (ConstraintFailed)', async () => {
    const w = await loadFixture(world)
    const bad = transfer(w, w.attacker.address, usdc(1))
    await expectAnyRevert(committeeExec(w, bad))
    await expectPolicyDenied(committeeCallStatic(w, bad), w, w.args, 'ConstraintFailed')
  })

  it('one committee signature is not enough (its own threshold is 2)', async () => {
    const w = await loadFixture(world)
    await expectAnyRevert(committeeExec(w, transfer(w, w.vendorA.address, usdc(1)), [w.members[0]]))
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(0n)
  })

  it('the committee can only do what it was granted (NotGranted for approve)', async () => {
    const w = await loadFixture(world)
    const approve = call(
      w.tokenAddress,
      w.token.interface.encodeFunctionData('approve', [w.vendorA.address, 1n]),
    )
    await expectEngineError(committeeCallStatic(w, approve), w, 'NotGranted')
  })

  it("the main Safe's owner path is untouched: the owners pay above both budgets", async () => {
    const w = await loadFixture(world)
    await execOwners(w, transfer(w, w.attacker.address, usdc(60_000)))
    expect(await w.token.balanceOf(w.attacker.address)).to.equal(usdc(60_000))
  })
})
