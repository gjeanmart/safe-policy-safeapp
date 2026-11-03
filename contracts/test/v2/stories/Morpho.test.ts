import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { type Interface, ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import type { StoryMorpho } from '../../../typechain-types'
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
 * Story: ops supplies to a Morpho Blue market and withdraws (COOKBOOK "Morpho Blue"). `MarketParams`
 * is five static words, so `supply`'s onBehalf is word 7 and `withdraw`'s receiver word 8; Args
 * also pins the market's loan token (word 0). `setAuthorization` (operator rights, unpriceable) has
 * no Allow.
 */

const MARKET = '(address,address,address,address,uint256)'
const SUPPLY = sel(`supply(${MARKET},uint256,uint256,address,bytes)`)
const WITHDRAW = sel(`withdraw(${MARKET},uint256,uint256,address,address)`)

async function world() {
  const w = await deployWorld()
  const morpho = (await ethers.deployContract('StoryMorpho')) as unknown as StoryMorpho
  const morphoAddress = addrOf(morpho)
  const ops = w.ops.address
  const fn = (selector: string) => onFunction(ops, morphoAddress, selector)
  const approveScope = onFunction(ops, w.tokenAddress, SEL.approve)
  const loanIsUsdc = (selector: string) => onWord(selector, 0, ArgsOp.EQ, [w.tokenAddress])
  await install(
    w,
    [
      attach(
        anyCall(ops),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(50_000), period: MONTH }], true),
      ),
      allow(approveScope),
      attach(approveScope, w.args, argsSettings([onWord(SEL.approve, 0, ArgsOp.EQ, [morphoAddress])])),
      allow(fn(SUPPLY)),
      attach(fn(SUPPLY), w.args, argsSettings([loanIsUsdc(SUPPLY), receiverIsSafe(SUPPLY, 7)])),
      allow(fn(WITHDRAW)),
      attach(fn(WITHDRAW), w.args, argsSettings([loanIsUsdc(WITHDRAW), receiverIsSafe(WITHDRAW, 8)])),
    ],
    { modules: [ops] },
  )
  const market = [w.tokenAddress, ZeroAddress, ZeroAddress, ZeroAddress, 860_000_000_000_000_000n]
  const morphoCall = (name: string, args: unknown[]) =>
    call(morphoAddress, (morpho.interface as Interface).encodeFunctionData(name, args))
  return { ...w, morpho, morphoAddress, morphoCall, market, fn }
}

describe('Story: Morpho Blue supply and withdraw, receiver pinned to the Safe', () => {
  it('supplies on behalf of the Safe and withdraws to the Safe', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.morphoAddress, usdc(5_000)))
    await execModule(w, w.ops, w.morphoCall('supply', [w.market, usdc(5_000), 0, w.safeAddress, '0x']))
    expect(await w.morpho.supplyAssets(w.safeAddress)).to.equal(usdc(5_000))
    await execModule(
      w,
      w.ops,
      w.morphoCall('withdraw', [w.market, usdc(5_000), 0, w.safeAddress, w.safeAddress]),
    )
    expect(await w.token.balanceOf(w.safeAddress)).to.equal(usdc(100_000))
  })

  it('denies withdraw to the attacker as receiver (Args EQ_SAFE on word 8)', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.morphoAddress, usdc(5_000)))
    await execModule(w, w.ops, w.morphoCall('supply', [w.market, usdc(5_000), 0, w.safeAddress, '0x']))
    await expectPolicyDenied(
      execModule(
        w,
        w.ops,
        w.morphoCall('withdraw', [w.market, usdc(5_000), 0, w.safeAddress, w.attacker.address]),
      ),
      w,
      w.args,
      'ConstraintFailed',
      [0, attachmentId(w.fn(WITHDRAW), Kind.POLICY, addrOf(w.args)), 1],
    )
  })

  it('denies supply on behalf of someone else, and a market with another loan token', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.ops, w.morphoCall('supply', [w.market, 1n, 0, w.attacker.address, '0x'])),
      w,
      w.args,
      'ConstraintFailed',
    )
    const other = [w.attacker.address, ...w.market.slice(1)]
    await expectPolicyDenied(
      execModule(w, w.ops, w.morphoCall('supply', [other, 1n, 0, w.safeAddress, '0x'])),
      w,
      w.args,
      'ConstraintFailed',
    )
  })

  it('setAuthorization (operator rights over every position) has no Allow (NotGranted)', async () => {
    const w = await loadFixture(world)
    await expectEngineError(
      execModule(w, w.ops, w.morphoCall('setAuthorization', [w.attacker.address, true])),
      w,
      'NotGranted',
    )
  })
})
