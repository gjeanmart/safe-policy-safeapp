import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import type { Interface } from 'ethers'
import { type MetaTx, multiSendTx } from '../fixtures/safe'
import {
  Kind,
  MONTH,
  OPS_BUDGET,
  SEL,
  addr,
  allow,
  attach,
  call,
  deployWorld,
  execModule,
  expectPolicyDenied,
  install,
  limitSettings,
  recipientsSettings,
  scope,
  tokenApprove,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/**
 * Story: the Limit ("transfer budget") counts where the Safe gives up control (design doc §6),
 * across a batch: sub-calls of a MultiSend debit in order; an approval reserves budget and a
 * reduction in the same window gives it back; and the batch refill attack
 * `[approve(x, 0), approve(x, a)]` — which would give back and not spend if each sub-call read
 * the on-chain allowance — is closed by the expected-allowance the Limit carries through the batch.
 */
describe('E2E story: Limit across a batch, approval reservations, the refill attack', () => {
  async function deploy() {
    const w = await deployWorld()
    const router = w.outsider // a DEX router the Ops may approve
    const ops = w.ops.address
    const fn = (name: string) => (w.token.interface as Interface).getFunction(name)!.selector
    await install(
      w,
      [
        attach(
          scope(ops),
          addr(w.limit),
          limitSettings([{ token: w.tokenAddress, amount: OPS_BUDGET, period: MONTH }]),
        ),
        attach(
          scope(ops),
          addr(w.recipients),
          recipientsSettings({
            recipients: [w.vendorA.address, w.vendorB.address],
            spenders: [router.address],
            maxApproval: OPS_BUDGET,
          }),
        ),
        allow(scope(ops, w.tokenAddress, SEL.transfer)),
        allow(scope(ops, w.tokenAddress, SEL.approve)),
        allow(scope(ops, w.tokenAddress, fn('increaseAllowance'))),
        allow(scope(ops, w.tokenAddress, fn('decreaseAllowance'))),
      ],
      [],
      { modules: [ops] },
    )
    const limitId = await w.engine.attachmentId(
      await w.engine.scopeKey(scope(ops)),
      Kind.POLICY,
      addr(w.limit),
    )
    return { ...w, router, limitId }
  }
  type W = Awaited<ReturnType<typeof deploy>>

  const available = async (w: W) =>
    (await w.limit.remaining(w.engineAddress, w.safeAddress, w.limitId, w.tokenAddress)).available
  const opsBatch = async (w: World, calls: MetaTx[]) =>
    execModule(w, w.ops, multiSendTx(await w.infra.multiSendCallOnly.getAddress(), calls))
  const tokenCall = (w: World, fn: string, args: unknown[]) =>
    call(w.tokenAddress, (w.token.interface as Interface).encodeFunctionData(fn, args))

  it('a batch sums its sub-calls: 2,000 + 2,000 + 1,001 is denied at the third, 2,000 + 2,000 + 1,000 passes', async () => {
    const w = await loadFixture(deploy)
    const pays = (last: bigint) => [
      tokenTransfer(w, w.vendorA.address, usdc(2_000)),
      tokenTransfer(w, w.vendorB.address, usdc(2_000)),
      tokenTransfer(w, w.vendorA.address, last),
    ]
    await expectPolicyDenied(
      opsBatch(w, pays(usdc(1_001))),
      w.engine,
      w.limit,
      'LimitExceeded',
      [w.limitId, w.tokenAddress, usdc(1_001), usdc(1_000)],
      2n,
    )
    await opsBatch(w, pays(usdc(1_000)))
    expect(await available(w)).to.equal(0n)
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(3_000))
  })

  it('an approval reserves budget; lowering it in the same window gives back what was not pulled', async () => {
    const w = await loadFixture(deploy)
    await execModule(w, w.ops, tokenApprove(w, w.router.address, usdc(3_000)))
    expect(await available(w)).to.equal(usdc(2_000))

    // The router pulls 1,000; the remaining 2,000 of allowance is still reserved.
    await w.token.connect(w.router).transferFrom(w.safeAddress, w.router.address, usdc(1_000))
    await execModule(w, w.ops, tokenApprove(w, w.router.address, 0n))
    expect(await available(w)).to.equal(usdc(4_000))

    // increaseAllowance reserves its amount; decreaseAllowance gives back.
    await execModule(w, w.ops, tokenCall(w, 'increaseAllowance', [w.router.address, usdc(500)]))
    expect(await available(w)).to.equal(usdc(3_500))
    await execModule(w, w.ops, tokenCall(w, 'decreaseAllowance', [w.router.address, usdc(200)]))
    expect(await available(w)).to.equal(usdc(3_700))
  })

  it('a give-back only covers the current window (no carry-over into the next month)', async () => {
    const w = await loadFixture(deploy)
    await execModule(w, w.ops, tokenApprove(w, w.router.address, OPS_BUDGET))
    await time.increase(MONTH)
    expect(await available(w)).to.equal(OPS_BUDGET)
    await execModule(w, w.ops, tokenApprove(w, w.router.address, 0n))
    expect(await available(w)).to.equal(OPS_BUDGET)
  })

  it('the refill attack is denied: [approve(x, 0), approve(x, a)] in one batch does not refill', async () => {
    const w = await loadFixture(deploy)
    await execModule(w, w.ops, tokenApprove(w, w.router.address, OPS_BUDGET))
    expect(await available(w)).to.equal(0n)

    // Without the expected allowance, the second approve would read 5,000 on-chain and spend 0.
    await expectPolicyDenied(
      opsBatch(w, [
        tokenApprove(w, w.router.address, 0n),
        tokenApprove(w, w.router.address, OPS_BUDGET),
        tokenTransfer(w, w.vendorA.address, usdc(1)),
      ]),
      w.engine,
      w.limit,
      'LimitExceeded',
      [w.limitId, w.tokenAddress, usdc(1), 0n],
      2n,
    )
    // The give-back and re-approve net out: nothing gained.
    await opsBatch(w, [tokenApprove(w, w.router.address, 0n), tokenApprove(w, w.router.address, OPS_BUDGET)])
    expect(await available(w)).to.equal(0n)
    // Same with decreaseAllowance then approve.
    await opsBatch(w, [
      tokenCall(w, 'decreaseAllowance', [w.router.address, OPS_BUDGET]),
      tokenApprove(w, w.router.address, OPS_BUDGET),
    ])
    expect(await available(w)).to.equal(0n)
    await expectPolicyDenied(
      execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, 1n)),
      w.engine,
      w.limit,
      'LimitExceeded',
    )
  })

  it('Recipients judges the same calls: an approval to an unlisted spender is denied', async () => {
    const w = await loadFixture(deploy)
    await expectPolicyDenied(
      execModule(w, w.ops, tokenApprove(w, w.attacker.address, 1n)),
      w.engine,
      w.recipients,
      'SpenderNotAllowed',
      [w.attacker.address],
    )
  })
})
