import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  Interface,
  MaxUint256,
  ZeroAddress,
  ZeroHash,
  concat,
  getAddress,
  id,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type { ArgsLimitEngineStub, LimitPolicy } from '../../../typechain-types'
import { expectRevert } from '../helpers'

/**
 * LimitPolicy (SPEC.md §5.3), called through an engine stub: every pricing row, one check per
 * transaction summing a batch, per-attachment budgets, the full-amount approval rule (refill
 * attack), the fixed window grid and `passUnpriced`.
 */

const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CALL = 0
const DELEGATECALL = 1
const DAY = 86_400
const NATIVE = ZeroAddress
const erc20 = new Interface([
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function approve(address,uint256)',
  'function increaseAllowance(address,uint256)',
  'function decreaseAllowance(address,uint256)',
])
const misc = new Interface([
  'function setPreSignature(bytes orderUid, bool signed)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function setApprovalForAll(address,bool)',
])
const ens = new Interface([
  'function register(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, bool reverseRecord, uint16 ownerControlledFuses) payable',
])
const sel = (fn: string) => id(fn).slice(0, 10)
const TRANSFER = sel('transfer(address,uint256)')

type TokenLimit = { token: string; amount: bigint; period: bigint }
const limit = (token: string, amount: bigint, period = BigInt(DAY)): TokenLimit => ({ token, amount, period })
type CallT = { to: string; value: bigint; data: string; operation: number }

describe('V2 rev 3 LimitPolicy (WP C)', () => {
  let policy: LimitPolicy
  let engine: ArgsLimitEngineStub
  let engineAddr: string
  const safe = getAddress('0x00000000000000000000000000000000000005af')
  const usdc = getAddress('0x000000000000000000000000000000000000c0c0')
  const dai = getAddress('0x000000000000000000000000000000000000da10')
  const alice = getAddress('0x000000000000000000000000000000000000a11c')
  const relayer = getAddress('0x0000000000000000000000000000000000000c0e')
  const settlement = getAddress('0x0000000000000000000000000000000000009a7e')
  const controller = getAddress('0x00000000000000000000000000000000000e9500')
  const A = id('attachment A')
  const B = id('attachment B')
  const ctx = { safe, actor: OWNERS, txHash: ZeroHash }
  const scope = { actor: OWNERS, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }

  const call = (to: string, data = '0x', value = 0n, operation = CALL): CallT => ({
    to,
    value,
    data,
    operation,
  })
  const tok = (fn: string, args: unknown[], to = usdc) => call(to, erc20.encodeFunctionData(fn, args))
  const configure = async (attachmentId: string, limits: TokenLimit[], passUnpriced = false) =>
    engine.configure(
      policy,
      safe,
      attachmentId,
      scope,
      3,
      await policy.encodeSettings({ limits, passUnpriced }),
    )
  /** Every call matched by every attachment in `ids`, in call order (as the engine orders matches). */
  const check = (calls: CallT[], ids = [A]) =>
    engine.check(
      policy,
      ctx,
      calls,
      calls.flatMap((_, callIndex) => ids.map((attachmentId) => ({ callIndex, level: 3, attachmentId }))),
    )
  const spent = async (attachmentId = A, token = usdc) =>
    (await policy.remaining(engineAddr, safe, attachmentId, token)).spent

  beforeEach(async () => {
    policy = await ethers.deployContract('LimitPolicy')
    engine = await ethers.deployContract('ArgsLimitEngineStub')
    engineAddr = await engine.getAddress()
  })

  describe('settings', () => {
    it('stores and reads back the limits', async () => {
      await configure(A, [limit(usdc, 100n), limit(NATIVE, 5n, 0n)], true)
      const s = await policy.getSettings(engineAddr, safe, A)
      expect(s.passUnpriced).to.equal(true)
      expect(s.limits.map((l) => [l.token, l.amount, l.period])).to.deep.equal([
        [usdc, 100n, BigInt(DAY)],
        [NATIVE, 5n, 0n],
      ])
    })

    it('rejects no token, more than 16, duplicates and zero amounts with InvalidSettings', async () => {
      const tokens = Array.from({ length: 17 }, (_, i) => limit(zeroPadValue(toBeHex(i + 16), 20), 1n))
      await expectRevert(configure(A, []), policy, 'InvalidSettings')
      await expectRevert(configure(A, tokens), policy, 'InvalidSettings')
      await expectRevert(
        configure(A, [limit(usdc, 1n), limit(dai, 1n), limit(usdc, 2n)]),
        policy,
        'InvalidSettings',
      )
      await expectRevert(configure(A, [limit(usdc, 0n)]), policy, 'InvalidSettings')
      await configure(A, tokens.slice(0, 16))
    })

    it('re-configuring resets the budget and replaces the token list', async () => {
      await configure(A, [limit(usdc, 100n), limit(dai, 100n)])
      await check([tok('transfer', [alice, 60n])])
      expect(await spent()).to.equal(60n)
      await configure(A, [limit(usdc, 80n)])
      expect(await spent()).to.equal(0n)
      expect((await policy.remaining(engineAddr, safe, A, usdc)).available).to.equal(80n)
      expect((await policy.remaining(engineAddr, safe, A, dai)).amount).to.equal(0n)
      expect((await policy.getSettings(engineAddr, safe, A)).limits.length).to.equal(1)
      await expectRevert(check([tok('transfer', [alice, 1n], dai)]), policy, 'Unpriced', [
        0,
        A,
        dai,
        TRANSFER,
      ])
      await check([tok('transfer', [alice, 80n])])
    })

    it('budgets are keyed by engine, Safe and attachment', async () => {
      await configure(A, [limit(usdc, 100n)])
      await check([tok('transfer', [alice, 100n])])
      expect(await spent(B)).to.equal(0n)
      expect((await policy.remaining(alice, safe, A, usdc)).amount).to.equal(0n)
      expect((await policy.remaining(engineAddr, alice, A, usdc)).amount).to.equal(0n)
      // Another Safe has no budget under A: its transfer is unpriced, not debited from this one.
      await expectRevert(
        engine.check(
          policy,
          { ...ctx, safe: alice },
          [tok('transfer', [alice, 1n])],
          [{ callIndex: 0, level: 3, attachmentId: A }],
        ),
        policy,
        'Unpriced',
        [0, A, usdc, TRANSFER],
      )
    })

    it('a check without matches is NoMatches', async () => {
      await expectRevert(engine.check(policy, ctx, [call(alice)], []), policy, 'NoMatches')
    })
  })

  describe('pricing', () => {
    beforeEach(async () => {
      await configure(A, [limit(usdc, 1000n), limit(NATIVE, 1000n)])
    })

    it('native value: `value`, on any call', async () => {
      await check([call(alice, '0x', 10n)])
      expect(await spent(A, NATIVE)).to.equal(10n)
      // Value on a priced ERC-20 call counts both.
      await check([call(usdc, erc20.encodeFunctionData('transfer', [alice, 7n]), 3n)])
      expect(await spent(A, NATIVE)).to.equal(13n)
      expect(await spent()).to.equal(7n)
    })

    it('native value with an unpriced selector: value counts, the selector is still Unpriced', async () => {
      const supply = call(settlement, misc.encodeFunctionData('supply', [usdc, 1n, safe, 0]), 4n)
      await expectRevert(check([supply]), policy, 'Unpriced', [0, A, ZeroAddress, supply.data.slice(0, 10)])
      expect(await spent(A, NATIVE)).to.equal(0n)
    })

    it('ENS register with value under passUnpriced, native listed: passes and debits the value', async () => {
      const register = call(
        controller,
        ens.encodeFunctionData('register', [
          'safe',
          safe,
          365n * BigInt(DAY),
          ZeroHash,
          ZeroAddress,
          [],
          false,
          0,
        ]),
        4n,
      )
      await configure(B, [limit(NATIVE, 10n)], true)
      await check([register], [B])
      expect(await spent(B, NATIVE)).to.equal(4n)
      await expectRevert(check([{ ...register, value: 7n }], [B]), policy, 'LimitExceeded', [
        0,
        B,
        NATIVE,
        7n,
        6n,
      ])
    })

    it('unlisted native value is Unpriced (token 0), even with passUnpriced', async () => {
      await configure(B, [limit(usdc, 10n)])
      await expectRevert(check([call(alice, '0x', 1n)], [B]), policy, 'Unpriced', [
        0,
        B,
        NATIVE,
        '0x00000000',
      ])
      await configure(B, [limit(usdc, 10n)], true)
      await expectRevert(check([call(alice, '0x', 1n)], [B]), policy, 'Unpriced', [
        0,
        B,
        NATIVE,
        '0x00000000',
      ])
      const supply = call(settlement, misc.encodeFunctionData('supply', [usdc, 1n, safe, 0]), 1n)
      await expectRevert(check([supply], [B]), policy, 'Unpriced', [0, B, NATIVE, supply.data.slice(0, 10)])
      // Zero value on an unknown selector is let through.
      await check([{ ...supply, value: 0n }], [B])
    })

    it('transfer(to, a): `a` of call.to', async () => {
      await check([tok('transfer', [alice, 100n])])
      expect(await spent()).to.equal(100n)
    })

    it('transferFrom(from, to, a): `a` if from is the Safe, else free', async () => {
      await check([tok('transferFrom', [safe, alice, 40n])])
      expect(await spent()).to.equal(40n)
      await check([tok('transferFrom', [alice, safe, 500n])])
      expect(await spent()).to.equal(40n)
      // Free even for an unlisted token: nothing leaves the Safe.
      await check([tok('transferFrom', [alice, safe, 500n], dai)])
    })

    it('transferFrom with dirty upper bits on the Safe address still counts', async () => {
      const clean = erc20.encodeFunctionData('transferFrom', [safe, alice, 40n])
      const dirty = concat(['0x23b872dd', '0xff' + clean.slice(12, 74), '0x' + clean.slice(74)])
      await check([call(usdc, dirty)])
      expect(await spent()).to.equal(40n)
    })

    it('approve(s, a > 0) and increaseAllowance(s, a): `a` in full', async () => {
      await check([tok('approve', [relayer, 100n])])
      expect(await spent()).to.equal(100n)
      await check([tok('increaseAllowance', [relayer, 50n])])
      expect(await spent()).to.equal(150n)
    })

    it('approve(s, 0) and decreaseAllowance are free revocations (no give-back)', async () => {
      await check([tok('approve', [relayer, 100n])])
      await check([tok('approve', [relayer, 0n])])
      await check([tok('decreaseAllowance', [relayer, 100n])])
      expect(await spent()).to.equal(100n)
      // Free for an unlisted token too.
      await check([tok('approve', [relayer, 0n], dai), tok('decreaseAllowance', [relayer, 1n], dai)])
    })

    it('empty calldata with zero value: free', async () => {
      await configure(B, [limit(usdc, 1n)])
      await check([call(alice)], [B])
    })

    it('a spend of an unlisted token is Unpriced (names the token), even with passUnpriced', async () => {
      for (const c of [
        tok('transfer', [alice, 1n], dai),
        tok('transferFrom', [safe, alice, 1n], dai),
        tok('approve', [relayer, 1n], dai),
        tok('increaseAllowance', [relayer, 1n], dai),
      ])
        await expectRevert(check([c]), policy, 'Unpriced', [0, A, dai, c.data.slice(0, 10)])
      await configure(B, [limit(usdc, 1n)], true)
      for (const c of [
        tok('transfer', [alice, 1n], dai),
        tok('transferFrom', [safe, alice, 1n], dai),
        tok('approve', [relayer, MaxUint256], dai),
        tok('increaseAllowance', [relayer, 1n], dai),
      ])
        await expectRevert(check([c], [B]), policy, 'Unpriced', [0, B, dai, c.data.slice(0, 10)])
      // A zero amount of an unlisted token is a free call, not a spend.
      await check([tok('transfer', [alice, 0n], dai)])
    })

    it('any other selector is Unpriced (token 0) unless passUnpriced: setPreSignature, setApprovalForAll', async () => {
      const preSign = call(settlement, misc.encodeFunctionData('setPreSignature', ['0x1234', true]))
      const forAll = call(usdc, misc.encodeFunctionData('setApprovalForAll', [alice, true]))
      await expectRevert(check([preSign]), policy, 'Unpriced', [0, A, ZeroAddress, preSign.data.slice(0, 10)])
      await expectRevert(check([forAll]), policy, 'Unpriced', [0, A, ZeroAddress, forAll.data.slice(0, 10)])
      await configure(A, [limit(usdc, 1000n)], true)
      await check([preSign, forAll])
    })

    it('a spend selector with short calldata is Unpriced (names call.to), even with passUnpriced', async () => {
      const short = tok('transfer', [alice, 1n]).data.slice(0, 2 + 2 * 67)
      await expectRevert(check([call(usdc, short)]), policy, 'Unpriced', [0, A, usdc, TRANSFER])
      await configure(B, [limit(usdc, 1n)], true)
      await expectRevert(check([call(usdc, short)], [B]), policy, 'Unpriced', [0, B, usdc, TRANSFER])
    })

    it('a DELEGATECALL is never a known shape: Unpriced unless passUnpriced', async () => {
      const c = { ...tok('transfer', [alice, 1n]), operation: DELEGATECALL }
      await expectRevert(check([c]), policy, 'Unpriced', [0, A, ZeroAddress, TRANSFER])
      await expectRevert(check([call(alice, '0x', 0n, DELEGATECALL)]), policy, 'Unpriced', [
        0,
        A,
        ZeroAddress,
        '0x00000000',
      ])
      await configure(B, [limit(usdc, 1n)], true)
      await check([c, call(alice, '0x', 0n, DELEGATECALL)], [B])
    })

    it('over budget is LimitExceeded(call, attachment, token, requested, available)', async () => {
      await check([tok('transfer', [alice, 900n])])
      await expectRevert(check([tok('transfer', [alice, 101n])]), policy, 'LimitExceeded', [
        0,
        A,
        usdc,
        101n,
        100n,
      ])
      await expectRevert(check([tok('approve', [relayer, MaxUint256])]), policy, 'LimitExceeded', [
        0,
        A,
        usdc,
        MaxUint256,
        100n,
      ])
      await expectRevert(check([call(alice, '0x', 1001n)]), policy, 'LimitExceeded', [
        0,
        A,
        NATIVE,
        1001n,
        1000n,
      ])
      await check([tok('transfer', [alice, 100n])])
      expect((await policy.remaining(engineAddr, safe, A, usdc)).available).to.equal(0n)
    })
  })

  describe('batches and the merge rule', () => {
    it('a batch sums: the call that crosses the budget is named, nothing is debited', async () => {
      await configure(A, [limit(usdc, 100n)])
      await expectRevert(
        check([tok('transfer', [alice, 60n]), tok('approve', [relayer, 50n])]),
        policy,
        'LimitExceeded',
        [1, A, usdc, 50n, 40n],
      )
      expect(await spent()).to.equal(0n)
      await check([tok('transfer', [alice, 60n]), tok('approve', [relayer, 40n])])
      expect(await spent()).to.equal(100n)
    })

    it('refill attack [approve(x, 0), approve(x, a)] counts `a`', async () => {
      await configure(A, [limit(usdc, 100n)])
      await check([tok('approve', [relayer, 0n]), tok('approve', [relayer, 60n])])
      expect(await spent()).to.equal(60n)
      // Revoke and re-approve: counts again, never refills.
      await expectRevert(
        check([tok('approve', [relayer, 0n]), tok('approve', [relayer, 60n])]),
        policy,
        'LimitExceeded',
        [1, A, usdc, 60n, 40n],
      )
      await check([tok('decreaseAllowance', [relayer, 60n]), tok('approve', [relayer, 40n])])
      expect(await spent()).to.equal(100n)
    })

    it('every matched attachment is debited; the smallest budget decides', async () => {
      await configure(A, [limit(usdc, 100n)])
      await configure(B, [limit(usdc, 30n)])
      await check([tok('transfer', [alice, 30n])], [A, B])
      expect(await spent(A)).to.equal(30n)
      expect(await spent(B)).to.equal(30n)
      await expectRevert(check([tok('transfer', [alice, 1n])], [A, B]), policy, 'LimitExceeded', [
        0,
        B,
        usdc,
        1n,
        0n,
      ])
      expect(await spent(A)).to.equal(30n)
    })

    it('an attachment prices only the calls it matched', async () => {
      await configure(A, [limit(usdc, 100n)])
      await configure(B, [limit(usdc, 10n)])
      const calls = [tok('transfer', [alice, 50n]), tok('transfer', [alice, 10n])]
      await engine.check(policy, ctx, calls, [
        { callIndex: 0, level: 3, attachmentId: A },
        { callIndex: 1, level: 3, attachmentId: A },
        { callIndex: 1, level: 5, attachmentId: B },
      ])
      expect(await spent(A)).to.equal(60n)
      expect(await spent(B)).to.equal(10n)
    })

    it('passUnpriced is per attachment', async () => {
      await configure(A, [limit(usdc, 100n)], true)
      await configure(B, [limit(usdc, 100n)])
      const preSign = call(settlement, misc.encodeFunctionData('setPreSignature', ['0x12', true]))
      await check([preSign], [A])
      await expectRevert(check([preSign], [A, B]), policy, 'Unpriced', [
        0,
        B,
        ZeroAddress,
        preSign.data.slice(0, 10),
      ])
    })

    it('CoW: the approval to the vault relayer is the budget, setPreSignature passes with passUnpriced', async () => {
      await configure(A, [limit(usdc, 500n)], true)
      await check([
        tok('approve', [relayer, 500n]),
        call(settlement, misc.encodeFunctionData('setPreSignature', ['0xabcd', true])),
      ])
      expect(await spent()).to.equal(500n)
      await expectRevert(check([tok('approve', [relayer, 1n])]), policy, 'LimitExceeded', [
        0,
        A,
        usdc,
        1n,
        0n,
      ])
    })
  })

  describe('periods', () => {
    it('windows are a fixed grid anchored at configure', async () => {
      await configure(A, [limit(usdc, 100n)])
      const anchor = BigInt(await time.latest())
      await time.increase(3600)
      await check([tok('transfer', [alice, 100n])])
      await expectRevert(check([tok('transfer', [alice, 1n])]), policy, 'LimitExceeded', [0, A, usdc, 1n, 0n])

      // Into the second window: refilled, and the window starts on the grid, not at the spend.
      await time.increaseTo(anchor + BigInt(DAY) + 5n * 3600n)
      let r = await policy.remaining(engineAddr, safe, A, usdc)
      expect([r.spent, r.available, r.windowStart, r.period]).to.deep.equal([
        0n,
        100n,
        anchor + BigInt(DAY),
        BigInt(DAY),
      ])
      await check([tok('transfer', [alice, 70n])])

      // Skipping windows lands on the grid too.
      await time.increaseTo(anchor + 3n * BigInt(DAY) + 12n * 3600n)
      r = await policy.remaining(engineAddr, safe, A, usdc)
      expect([r.spent, r.windowStart]).to.deep.equal([0n, anchor + 3n * BigInt(DAY)])
      await check([tok('transfer', [alice, 60n])])
      // The last second of the window is still in it; the next one starts a new window.
      await time.setNextBlockTimestamp(anchor + 4n * BigInt(DAY) - 1n)
      await check([tok('transfer', [alice, 40n])])
      expect(await spent()).to.equal(100n)
      await check([tok('transfer', [alice, 1n])])
      expect(await spent()).to.equal(1n)
    })

    it('period 0 is a one-time budget that never refills', async () => {
      await configure(A, [limit(usdc, 100n, 0n)])
      const anchor = BigInt(await time.latest())
      await check([tok('transfer', [alice, 100n])])
      await time.increase(365 * DAY)
      const r = await policy.remaining(engineAddr, safe, A, usdc)
      expect([r.spent, r.available, r.windowStart, r.period]).to.deep.equal([100n, 0n, anchor, 0n])
      await expectRevert(check([tok('transfer', [alice, 1n])]), policy, 'LimitExceeded', [0, A, usdc, 1n, 0n])
    })

    it('each token keeps its own period', async () => {
      await configure(A, [limit(usdc, 100n, BigInt(DAY)), limit(NATIVE, 10n, 7n * BigInt(DAY))])
      await check([call(usdc, erc20.encodeFunctionData('transfer', [alice, 100n]), 10n)])
      await time.increase(DAY)
      await check([tok('transfer', [alice, 100n])])
      await expectRevert(check([call(alice, '0x', 1n)]), policy, 'LimitExceeded', [0, A, NATIVE, 1n, 0n])
    })
  })
})
