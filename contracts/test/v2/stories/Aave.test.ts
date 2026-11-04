import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { Interface } from 'ethers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import type { StoryAavePool } from '../../../typechain-types'
import {
  ArgsOp,
  Kind,
  MONTH,
  SEL,
  addrOf,
  allow,
  anyCall,
  approve,
  argsSettings,
  attach,
  attachmentId,
  call,
  deployWorld,
  execModule,
  expectEngineError,
  expectPolicyDenied,
  install,
  limitSettings,
  onFunction,
  onWord,
  receiverIsSafe,
  sel,
  usdc,
} from './world'

/**
 * Story: ops supplies USDC to Aave v3 and withdraws it (COOKBOOK "Aave v3"). The approval to the
 * Pool is the spend (Limit); Args pins every receiver to the Safe: `supply` onBehalfOf (word 2),
 * `withdraw` to (word 2), `repay` onBehalfOf (word 3).
 */

const SUPPLY = sel('supply(address,uint256,address,uint16)')
const WITHDRAW = sel('withdraw(address,uint256,address)')
const REPAY = sel('repay(address,uint256,uint256,address)')

async function world() {
  const w = await deployWorld()
  const pool = (await ethers.deployContract('StoryAavePool')) as unknown as StoryAavePool
  const poolAddress = addrOf(pool)
  const ops = w.ops.address
  const fn = (selector: string) => onFunction(ops, poolAddress, selector)
  const approveScope = onFunction(ops, w.tokenAddress, SEL.approve)
  await install(
    w,
    [
      attach(
        anyCall(ops),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(50_000), period: MONTH }], true),
      ),
      allow(approveScope),
      attach(approveScope, w.args, argsSettings([onWord(SEL.approve, 0, ArgsOp.EQ, [poolAddress])])),
      allow(fn(SUPPLY)),
      attach(fn(SUPPLY), w.args, argsSettings([receiverIsSafe(SUPPLY, 2)])),
      allow(fn(WITHDRAW)),
      attach(fn(WITHDRAW), w.args, argsSettings([receiverIsSafe(WITHDRAW, 2)])),
      allow(fn(REPAY)),
      attach(fn(REPAY), w.args, argsSettings([receiverIsSafe(REPAY, 3)])),
    ],
    { modules: [ops] },
  )
  const poolCall = (name: string, args: unknown[]) =>
    call(poolAddress, (pool.interface as Interface).encodeFunctionData(name, args))
  return { ...w, pool, poolAddress, poolCall, fn }
}

describe('Story: Aave v3 supply and withdraw with the Safe as the only receiver', () => {
  it('approves the Pool, supplies on behalf of the Safe, withdraws to the Safe', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.poolAddress, usdc(10_000)))
    await execModule(w, w.ops, w.poolCall('supply', [w.tokenAddress, usdc(10_000), w.safeAddress, 0]))
    expect(await w.pool.supplied(w.tokenAddress, w.safeAddress)).to.equal(usdc(10_000))
    await execModule(w, w.ops, w.poolCall('withdraw', [w.tokenAddress, usdc(4_000), w.safeAddress]))
    expect(await w.token.balanceOf(w.safeAddress)).to.equal(usdc(94_000))
  })

  it('denies supply on behalf of the attacker (Args EQ_SAFE on onBehalfOf)', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.poolAddress, usdc(10_000)))
    await expectPolicyDenied(
      execModule(w, w.ops, w.poolCall('supply', [w.tokenAddress, usdc(10_000), w.attacker.address, 0])),
      w,
      w.args,
      'ConstraintFailed',
      [0, attachmentId(w.fn(SUPPLY), Kind.POLICY, addrOf(w.args)), 0],
    )
  })

  it('denies withdraw to the attacker (Args EQ_SAFE on to)', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.ops, w.poolCall('withdraw', [w.tokenAddress, 1n, w.attacker.address])),
      w,
      w.args,
      'ConstraintFailed',
    )
  })

  it('the approval is the spend: approving the Pool above the budget is denied (Limit)', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.ops, approve(w, w.poolAddress, usdc(50_001))),
      w,
      w.limit,
      'LimitExceeded',
    )
  })

  it('borrow has no Allow: ops cannot take debt (NotGranted)', async () => {
    const w = await loadFixture(world)
    await expectEngineError(
      execModule(w, w.ops, w.poolCall('borrow', [w.tokenAddress, 1n, 2, 0, w.safeAddress])),
      w,
      'NotGranted',
    )
  })
})
