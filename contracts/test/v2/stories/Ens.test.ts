import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress, ZeroHash, id, parseEther } from 'ethers'
import { ethers } from 'hardhat'
import type { StoryEnsController } from '../../../typechain-types'
import {
  Kind,
  MONTH,
  addrOf,
  allow,
  anyCall,
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
  receiverIsSafe,
  sel,
  usdc,
} from './world'

/**
 * Story: ops registers and renews ENS names, paying in ETH (COOKBOOK "ENS"). `register` and `renew`
 * are payable: the Limit prices the native value, always (native must be listed, even with
 * `passUnpriced`). Args pins the name's owner (word 1, after the name's offset) to the Safe.
 */

const YEAR = 365n * 24n * 3600n
const REGISTER = sel('register(string,address,uint256,bytes32,address,bytes[],bool,uint16)')
const RENEW = sel('renew(string,uint256)')
const ETH_BUDGET = parseEther('0.02')

async function deploy(withNative: boolean) {
  const w = await deployWorld()
  const limits = [{ token: w.tokenAddress, amount: usdc(1_000), period: MONTH }]
  if (withNative) limits.unshift({ token: ZeroAddress, amount: ETH_BUDGET, period: MONTH })
  const ens = (await ethers.deployContract('StoryEnsController')) as unknown as StoryEnsController
  const ensAddress = addrOf(ens)
  const ops = w.ops.address
  const registerScope = onFunction(ops, ensAddress, REGISTER)
  await install(
    w,
    [
      attach(anyCall(ops), w.limit, limitSettings(limits, true)),
      allow(registerScope),
      attach(registerScope, w.args, argsSettings([receiverIsSafe(REGISTER, 1)])),
      allow(onFunction(ops, ensAddress, RENEW)),
    ],
    { modules: [ops] },
  )
  const register = (owner: string, years: bigint) =>
    call(
      ensAddress,
      ens.interface.encodeFunctionData('register', [
        'safe',
        owner,
        years * YEAR,
        ZeroHash,
        ZeroAddress,
        [],
        false,
        0,
      ]),
      parseEther('0.01') * years,
    )
  const renew = (years: bigint) =>
    call(
      ensAddress,
      ens.interface.encodeFunctionData('renew', ['safe', years * YEAR]),
      parseEther('0.01') * years,
    )
  return { ...w, ens, ensAddress, register, renew, registerScope }
}

/** Limit at (Ops, *): 0.02 ETH and 1,000 USDC a month, passUnpriced. */
const world = () => deploy(true)
/** The same Limit without native listed: only USDC. */
const usdcOnly = () => deploy(false)

describe('Story: ENS registration paid in ETH, owner pinned to the Safe', () => {
  it('registers a name for the Safe and renews it; the native value is debited', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, w.register(w.safeAddress, 1n))
    expect(await w.ens.ownerOf(id('safe'))).to.equal(w.safeAddress)
    await execModule(w, w.ops, w.renew(1n))
    const limitId = attachmentId(anyCall(w.ops.address), Kind.POLICY, addrOf(w.limit))
    const left = await w.limit.remaining(w.engineAddress, w.safeAddress, limitId, ZeroAddress)
    expect(left.available).to.equal(0n)
  })

  it('denies a registration owned by the attacker (Args EQ_SAFE on word 1)', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.ops, w.register(w.attacker.address, 1n)),
      w,
      w.args,
      'ConstraintFailed',
      [0, attachmentId(w.registerScope, Kind.POLICY, addrOf(w.args)), 0],
    )
  })

  it('prices the native value: a 3-year registration (0.03 ETH) exceeds the 0.02 ETH budget', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(execModule(w, w.ops, w.register(w.safeAddress, 3n)), w, w.limit, 'LimitExceeded')
  })

  it('native value is never unpriced: with native unlisted, even passUnpriced denies (Unpriced)', async () => {
    const w = await loadFixture(usdcOnly)
    const limitId = attachmentId(anyCall(w.ops.address), Kind.POLICY, addrOf(w.limit))
    await expectPolicyDenied(execModule(w, w.ops, w.register(w.safeAddress, 1n)), w, w.limit, 'Unpriced', [
      0,
      limitId,
      ZeroAddress,
      REGISTER,
    ])
  })
})
