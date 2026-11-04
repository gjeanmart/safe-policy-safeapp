import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import type { Interface } from 'ethers'
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
 * Story: ops supplies to one Morpho Blue market and withdraws (COOKBOOK "Morpho Blue"). `MarketParams`
 * is five static words, so `supply`'s onBehalf is word 7 and `withdraw`'s receiver word 8. Args pins
 * the whole market (words 0 to 4: loan token, collateral token, oracle, IRM, LLTV): pinning only the
 * receiver would let a compromised key supply the Safe's USDC to a market it made, with its own
 * oracle, and borrow it all against worthless collateral. The budget is the bound either way.
 * `setAuthorization` (operator rights, unpriceable) has no Allow.
 */

const MARKET = '(address,address,address,address,uint256)'
const SUPPLY = sel(`supply(${MARKET},uint256,uint256,address,bytes)`)
const WITHDRAW = sel(`withdraw(${MARKET},uint256,uint256,address,address)`)
/** The one market ops may use (collateral, oracle and IRM are stand-in addresses). */
const COLLATERAL = '0x000000000000000000000000000000000000C011'
const ORACLE = '0x00000000000000000000000000000000000004AC'
const IRM = '0x0000000000000000000000000000000000000124'
const LLTV = 860_000_000_000_000_000n

async function world() {
  const w = await deployWorld()
  const morpho = (await ethers.deployContract('StoryMorpho')) as unknown as StoryMorpho
  const morphoAddress = addrOf(morpho)
  const ops = w.ops.address
  const fn = (selector: string) => onFunction(ops, morphoAddress, selector)
  const approveScope = onFunction(ops, w.tokenAddress, SEL.approve)
  const market = [w.tokenAddress, COLLATERAL, ORACLE, IRM, LLTV] as const
  /** `MarketParams` words 0 to 4 EQ the market: Args cannot compare a tuple, so one constraint per word. */
  const pinMarket = (selector: string) => market.map((v, i) => onWord(selector, i, ArgsOp.EQ, [v]))
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
      attach(fn(SUPPLY), w.args, argsSettings([...pinMarket(SUPPLY), receiverIsSafe(SUPPLY, 7)])),
      allow(fn(WITHDRAW)),
      attach(fn(WITHDRAW), w.args, argsSettings([...pinMarket(WITHDRAW), receiverIsSafe(WITHDRAW, 8)])),
    ],
    { modules: [ops] },
  )
  const morphoCall = (name: string, args: unknown[]) =>
    call(morphoAddress, (morpho.interface as Interface).encodeFunctionData(name, args))
  return { ...w, morpho, morphoAddress, morphoCall, market: [...market], fn }
}

describe('Story: Morpho Blue supply and withdraw, market and receiver pinned', () => {
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
      [0, attachmentId(w.fn(WITHDRAW), Kind.POLICY, addrOf(w.args)), 5],
    )
  })

  it('denies supply on behalf of someone else', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.ops, w.morphoCall('supply', [w.market, 1n, 0, w.attacker.address, '0x'])),
      w,
      w.args,
      'ConstraintFailed',
      [0, attachmentId(w.fn(SUPPLY), Kind.POLICY, addrOf(w.args)), 5],
    )
  })

  it('denies any other market: each MarketParams word (loan, collateral, oracle, IRM, LLTV) is pinned', async () => {
    const w = await loadFixture(world)
    const id = attachmentId(w.fn(SUPPLY), Kind.POLICY, addrOf(w.args))
    // An attacker's market: same loan token, its own collateral, oracle, IRM or LLTV.
    const swaps: unknown[] = [
      w.attacker.address,
      w.attacker.address,
      w.attacker.address,
      w.attacker.address,
      1n,
    ]
    for (let i = 0; i < 5; i++) {
      const other = w.market.map((v, j) => (j === i ? swaps[i] : v))
      await expectPolicyDenied(
        execModule(w, w.ops, w.morphoCall('supply', [other, 1n, 0, w.safeAddress, '0x'])),
        w,
        w.args,
        'ConstraintFailed',
        [0, id, i],
      )
    }
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
