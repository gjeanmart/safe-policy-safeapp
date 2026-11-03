import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import type { Interface } from 'ethers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import type { E2eToken, StoryUniswapRouter } from '../../../typechain-types'
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
 * Story: ops swaps USDC on the Uniswap SwapRouter02 (COOKBOOK "Uniswap"). `exactInputSingle` takes
 * a static tuple, so Args pins every word that picks the pool and the payee: tokenIn (word 0) EQ
 * USDC, tokenOut (word 1) IN the listed tokens, fee (word 2) IN the listed tiers, recipient (word 3)
 * EQ_SAFE. With the recipient alone, a compromised key swaps into its own pool of a worthless token.
 * The approval to the router is the spend (the budget is the bound). Universal Router
 * `execute(bytes, bytes[])` is opaque to Args: not allowed.
 */

const EXACT_INPUT_SINGLE = sel('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')
/** The fee tiers ops may use (0.05 %, 0.3 %). */
const FEES = [500n, 3000n] as const

async function world() {
  const w = await deployWorld()
  const router = (await ethers.deployContract('StoryUniswapRouter')) as unknown as StoryUniswapRouter
  const routerAddress = addrOf(router)
  const weth = (await ethers.deployContract('E2eToken')) as unknown as E2eToken
  await weth.mint(routerAddress, usdc(1_000_000))
  const ops = w.ops.address
  const swapScope = onFunction(ops, routerAddress, EXACT_INPUT_SINGLE)
  const pinPool = [
    onWord(EXACT_INPUT_SINGLE, 0, ArgsOp.EQ, [w.tokenAddress]),
    onWord(EXACT_INPUT_SINGLE, 1, ArgsOp.IN, [addrOf(weth)]),
    onWord(EXACT_INPUT_SINGLE, 2, ArgsOp.IN, [FEES[0], FEES[1]]),
  ]
  const approveScope = onFunction(ops, w.tokenAddress, SEL.approve)
  await install(
    w,
    [
      attach(
        anyCall(ops),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(20_000), period: MONTH }], true),
      ),
      allow(approveScope),
      attach(approveScope, w.args, argsSettings([onWord(SEL.approve, 0, ArgsOp.EQ, [routerAddress])])),
      allow(swapScope),
      attach(swapScope, w.args, argsSettings([...pinPool, receiverIsSafe(EXACT_INPUT_SINGLE, 3)])),
    ],
    { modules: [ops] },
  )
  const swap = (recipient: string, amount: bigint, tokenOut = addrOf(weth), fee: bigint = FEES[0]) =>
    call(
      routerAddress,
      (router.interface as Interface).encodeFunctionData('exactInputSingle', [
        [w.tokenAddress, tokenOut, fee, recipient, amount, amount, 0],
      ]),
    )
  return { ...w, router, routerAddress, weth, swap, swapScope }
}

describe('Story: Uniswap swap, pool and recipient pinned', () => {
  it('approves the router and swaps; the output lands in the Safe', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.routerAddress, usdc(1_000)))
    await execModule(w, w.ops, w.swap(w.safeAddress, usdc(1_000)))
    expect(await w.weth.balanceOf(w.safeAddress)).to.equal(usdc(1_000))
  })

  it('denies a swap whose recipient is the attacker (Args EQ_SAFE on word 3)', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.routerAddress, usdc(1_000)))
    await expectPolicyDenied(
      execModule(w, w.ops, w.swap(w.attacker.address, usdc(1_000))),
      w,
      w.args,
      'ConstraintFailed',
      [0, attachmentId(w.swapScope, Kind.POLICY, addrOf(w.args)), 3],
    )
  })

  it('denies a swap into an unlisted token or fee tier (an attacker pool): tokenOut and fee are pinned', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.routerAddress, usdc(1_000)))
    const id = attachmentId(w.swapScope, Kind.POLICY, addrOf(w.args))
    const junk = (await ethers.deployContract('E2eToken')) as unknown as E2eToken
    await junk.mint(w.routerAddress, usdc(1_000))
    await expectPolicyDenied(
      execModule(w, w.ops, w.swap(w.safeAddress, usdc(1_000), addrOf(junk))),
      w,
      w.args,
      'ConstraintFailed',
      [0, id, 1],
    )
    await expectPolicyDenied(
      execModule(w, w.ops, w.swap(w.safeAddress, usdc(1_000), addrOf(w.weth), 10_000n)),
      w,
      w.args,
      'ConstraintFailed',
      [0, id, 2],
    )
    await execModule(w, w.ops, w.swap(w.safeAddress, usdc(1_000), addrOf(w.weth), FEES[1]))
  })

  it('the swap itself is unpriced (passUnpriced); the approval carries the budget', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, approve(w, w.routerAddress, usdc(20_000)))
    await expectPolicyDenied(
      execModule(w, w.ops, approve(w, w.routerAddress, 1n)),
      w,
      w.limit,
      'LimitExceeded',
    )
    await execModule(w, w.ops, w.swap(w.safeAddress, usdc(20_000)))
  })
})
