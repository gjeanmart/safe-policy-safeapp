import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  ArgsOp,
  F,
  Kind,
  MAX_UINT,
  MONTH,
  OWNERS,
  SEL,
  type World,
  addrOf,
  allow,
  anyCall,
  approve,
  argsSettings,
  attach,
  attachmentId,
  batchTx,
  configureCall,
  deployWorld,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  install,
  limitSettings,
  onFunction,
  onWord,
  recipientsPreset,
  spendersPreset,
  timelockSettings,
  transfer,
  usdc,
} from './world'

/**
 * Story: an ops actor (a module key) pays vendors within a monthly budget (COOKBOOK "ERC-20
 * payments"). Ops: Allow `USDC.transfer` + Args Recipients at that scope; Allow `USDC.approve` +
 * Args Spenders (the payroll processor, capped); Limit 10,000 USDC a month and Timelock(0,
 * guardian G) at `(Ops, *)`.
 */

const BUDGET = usdc(10_000)

async function world() {
  const w = await deployWorld()
  const processor = w.members[0].address // a payroll processor that pulls by transferFrom
  const ops = w.ops.address
  const transferScope = onFunction(ops, w.tokenAddress, SEL.transfer)
  const approveScope = onFunction(ops, w.tokenAddress, SEL.approve)
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      allow(transferScope),
      attach(transferScope, w.args, argsSettings(recipientsPreset([w.vendorA.address, w.vendorB.address]))),
      allow(approveScope),
      attach(approveScope, w.args, argsSettings(spendersPreset([processor], BUDGET))),
      attach(
        anyCall(ops),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: BUDGET, period: MONTH }]),
      ),
      attach(anyCall(ops), w.timelock, timelockSettings({ delay: 0, guardians: [w.guardian.address] })),
    ],
    { modules: [ops] },
  )
  return { ...w, processor }
}

const limitId = (w: World) => attachmentId(anyCall(w.ops.address), Kind.POLICY, addrOf(w.limit))

describe('Story: ERC-20 payments by an ops actor within a monthly budget', () => {
  it('pays a listed vendor; the budget goes down by the amount', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, transfer(w, w.vendorA.address, usdc(1_000)))
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(1_000))
    const left = await w.limit.remaining(w.engineAddress, w.safeAddress, limitId(w), w.tokenAddress)
    expect(left.available).to.equal(BUDGET - usdc(1_000))
  })

  it('denies an unlisted recipient (Args ConstraintFailed)', async () => {
    const w = await loadFixture(world)
    const transferArgsId = attachmentId(
      onFunction(w.ops.address, w.tokenAddress, SEL.transfer),
      Kind.POLICY,
      addrOf(w.args),
    )
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.attacker.address, usdc(1))),
      w,
      w.args,
      'ConstraintFailed',
      [0, transferArgsId, 0],
    )
  })

  it('denies a payment over the budget, and refills it next month (fixed windows)', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, transfer(w, w.vendorA.address, usdc(9_000)))
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.vendorB.address, usdc(1_001))),
      w,
      w.limit,
      'LimitExceeded',
      [0, limitId(w), w.tokenAddress, usdc(1_001), usdc(1_000)],
    )
    await time.increase(MONTH)
    await execModule(w, w.ops, transfer(w, w.vendorB.address, usdc(1_001)))
  })

  it('sums a batch of 5 transfers: 5 × 2,000 fits, 5 × 2,001 is denied at the fifth call', async () => {
    const w = await loadFixture(world)
    const five = (amount: bigint) => batchTx(w, Array(5).fill(transfer(w, w.vendorA.address, amount)))
    await expectPolicyDenied(execModule(w, w.ops, five(usdc(2_001))), w, w.limit, 'LimitExceeded', [
      4,
      limitId(w),
      w.tokenAddress,
      usdc(2_001),
      usdc(10_000) - 4n * usdc(2_001),
    ])
    await execModule(w, w.ops, five(usdc(2_000)))
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(10_000))
  })

  it('a batch is checked call by call: one bad recipient denies the whole batch', async () => {
    const w = await loadFixture(world)
    const calls = [transfer(w, w.vendorA.address, 1n), transfer(w, w.attacker.address, 1n)]
    await expectPolicyDenied(execModule(w, w.ops, batchTx(w, calls)), w, w.args, 'ConstraintFailed')
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(0n)
  })

  it('denies approve(attacker, max): the full amount is priced (Limit), and the spender is not listed (Args)', async () => {
    const w = await loadFixture(world)
    // Policies run in first-match order: the Limit at (Ops, *) (level 3) before the Args at level 5.
    await expectPolicyDenied(
      execModule(w, w.ops, approve(w, w.attacker.address, MAX_UINT)),
      w,
      w.limit,
      'LimitExceeded',
      [0, limitId(w), w.tokenAddress, MAX_UINT, BUDGET],
    )
    // Within the budget, the attacker is still not a listed spender.
    await expectPolicyDenied(
      execModule(w, w.ops, approve(w, w.attacker.address, 1n)),
      w,
      w.args,
      'ConstraintFailed',
    )
    // Within the cap, to the listed processor, it costs its full amount.
    await execModule(w, w.ops, approve(w, w.processor, usdc(4_000)))
    const left = await w.limit.remaining(w.engineAddress, w.safeAddress, limitId(w), w.tokenAddress)
    expect(left.available).to.equal(usdc(6_000))
  })

  it('denies an approve without its own Allow even when Args would pass it (increaseAllowance: NotGranted)', async () => {
    const w = await loadFixture(world)
    await expectEngineError(
      execModule(w, w.ops, {
        to: w.tokenAddress,
        data: w.token.interface.encodeFunctionData('increaseAllowance', [w.processor, 1n]),
      }),
      w,
      'NotGranted',
      [0, w.tokenAddress, SEL.increaseAllowance, 0],
    )
  })

  describe('the refill attack (rev 2 D-4 / D-17): approve, revoke, approve again', () => {
    it('in one batch: approve 6,000, revoke, approve 6,000 is 12,000 of approvals (LimitExceeded)', async () => {
      const w = await loadFixture(world)
      const calls = [
        approve(w, w.processor, usdc(6_000)),
        approve(w, w.processor, 0n),
        approve(w, w.processor, usdc(6_000)),
      ]
      await expectPolicyDenied(execModule(w, w.ops, batchTx(w, calls)), w, w.limit, 'LimitExceeded', [
        2,
        limitId(w),
        w.tokenAddress,
        usdc(6_000),
        usdc(4_000),
      ])
    })

    it('over several transactions: a revocation is free but gives nothing back', async () => {
      const w = await loadFixture(world)
      await execModule(w, w.ops, approve(w, w.processor, BUDGET))
      await execModule(w, w.ops, approve(w, w.processor, 0n)) // revoking is always allowed and free
      await expectPolicyDenied(execModule(w, w.ops, approve(w, w.processor, 1n)), w, w.limit, 'LimitExceeded')
      await expectPolicyDenied(
        execModule(w, w.ops, transfer(w, w.vendorA.address, 1n)),
        w,
        w.limit,
        'LimitExceeded',
      )
    })

    it('the processor pulling the allowance does not refill the budget either', async () => {
      const w = await loadFixture(world)
      await execModule(w, w.ops, approve(w, w.processor, BUDGET))
      await w.token.connect(w.members[0]).transferFrom(w.safeAddress, w.vendorA.address, BUDGET)
      await expectPolicyDenied(
        execModule(w, w.ops, transfer(w, w.vendorA.address, 1n)),
        w,
        w.limit,
        'LimitExceeded',
      )
    })

    it('ops cannot reset its own budget by re-configuring the Limit (module configure needs an exact Allow)', async () => {
      const w = await loadFixture(world)
      const reset = attach(
        anyCall(w.ops.address),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: BUDGET, period: MONTH }]),
      )
      await expectEngineError(execModule(w, w.ops, configureCall(w, [reset])), w, 'NotGranted')
    })
  })

  it('the guardian stops ops at once (Timelock delay 0 is a kill switch); the owners are unaffected', async () => {
    const w = await loadFixture(world)
    const killId = attachmentId(anyCall(w.ops.address), Kind.POLICY, addrOf(w.timelock))
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [killId])
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.vendorA.address, 1n)),
      w,
      w.timelock,
      'AttachmentFrozen',
    )
    await execOwners(w, transfer(w, w.vendorA.address, 1n))
    await time.increase(F)
    await execModule(w, w.ops, transfer(w, w.vendorA.address, 1n))
  })

  it('Args strictness: a word constraint can pin the amount too (LTE per payment)', async () => {
    const w = await loadFixture(world)
    const s = onFunction(w.ops.address, w.tokenAddress, SEL.transfer)
    // Owners tighten the preset: at most 500 USDC per transfer (an owner transaction, no Timelock here).
    await execOwners(
      w,
      configureCall(w, [
        attach(
          s,
          w.args,
          argsSettings([
            ...recipientsPreset([w.vendorA.address]),
            onWord(SEL.transfer, 1, ArgsOp.LTE, [usdc(500)]),
          ]),
        ),
      ]),
    )
    await execModule(w, w.ops, transfer(w, w.vendorA.address, usdc(500)))
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.vendorA.address, usdc(501))),
      w,
      w.args,
      'ConstraintFailed',
      [0, attachmentId(s, Kind.POLICY, addrOf(w.args)), 3],
    )
  })

  it('transferFrom from a third party is free for the Limit: the Recipients preset bounds where it goes', async () => {
    const w = await loadFixture(world)
    // Ops also collects allowances customers give the Safe: Allow transferFrom + the Recipients preset there.
    const s = onFunction(w.ops.address, w.tokenAddress, SEL.transferFrom)
    await execOwners(
      w,
      configureCall(w, [allow(s), attach(s, w.args, argsSettings(recipientsPreset([w.safeAddress])))]),
    )
    await w.token.mint(w.stranger.address, usdc(50_000))
    await w.token.connect(w.stranger).approve(w.safeAddress, usdc(50_000))
    const pull = (to: string) =>
      execModule(w, w.ops, {
        to: w.tokenAddress,
        data: w.token.interface.encodeFunctionData('transferFrom', [w.stranger.address, to, usdc(50_000)]),
      })
    // Without the preset this would pass: the Limit prices transferFrom only from the Safe.
    await expectPolicyDenied(pull(w.attacker.address), w, w.args, 'ConstraintFailed', [
      0,
      attachmentId(s, Kind.POLICY, addrOf(w.args)),
      1,
    ])
    await pull(w.safeAddress)
    expect(await w.token.balanceOf(w.safeAddress)).to.equal(usdc(150_000))
    const left = await w.limit.remaining(w.engineAddress, w.safeAddress, limitId(w), w.tokenAddress)
    expect(left.spent).to.equal(0n)
  })
})
