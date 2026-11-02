import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { Interface, MaxUint256, ZeroAddress, ZeroHash, getAddress, id, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import type { LimitEngineStub, LimitPolicy, MockTokenV2 } from '../../../typechain-types'
import { expectRevert } from '../helpers'

/**
 * LimitPolicy, "Transfer budget" (SPEC.md §8.4), called through an engine stub. Each call is
 * priced once and debited from every matched attachment; approvals reserve, decreases give back.
 */

const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CALL = 0
const DELEGATECALL = 1
const DAY = 86_400
const scope = { actor: ZeroAddress, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }
const erc20 = new Interface([
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function approve(address,uint256)',
  'function increaseAllowance(address,uint256)',
  'function decreaseAllowance(address,uint256)',
  'function deposit()',
])
const signLibAbi = new Interface([
  'function signPermit(address token, address spender, uint256 value, uint256 deadline, uint256 nonce)',
  'function signPermit2(address token, address spender, uint160 amount, uint48 expiration, uint48 nonce, uint256 sigDeadline)',
  'function signMessage(bytes32)',
  'function signCowOrder((address sellToken, address buyToken, address receiver, uint256 sellAmount, uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, bytes32 kind, bool partiallyFillable, bytes32 sellTokenBalance, bytes32 buyTokenBalance) order)',
])
const TRANSFER = '0xa9059cbb'

type TokenLimit = { token: string; amount: bigint; period: bigint }
const limit = (token: string, amount: bigint, period = BigInt(DAY)): TokenLimit => ({ token, amount, period })

describe('V2 LimitPolicy', () => {
  let policy: LimitPolicy
  let engine: LimitEngineStub
  let engineAddr: string
  let token: MockTokenV2
  let usdc: string
  let dai: string
  const safe = getAddress('0x00000000000000000000000000000000000005af')
  const alice = getAddress('0x000000000000000000000000000000000000a11c')
  const router = getAddress('0x00000000000000000000000000000000000004a7')
  const signLib = getAddress('0x0000000000000000000000000000000000005160')
  const A = id('attachment A')
  const B = id('attachment B')
  const ctx = { safe, actor: OWNERS, txHash: ZeroHash, nonce: 0n, executor: ZeroAddress }

  const call = (to: string, data = '0x', value = 0n, operation = CALL) => ({ to, value, data, operation })
  const tokenCall = (fn: string, args: unknown[], to = usdc) => call(to, erc20.encodeFunctionData(fn, args))
  const configure = async (attachmentId: string, limits: TokenLimit[], passUnpriced = false) =>
    engine.configure(
      policy,
      safe,
      attachmentId,
      scope,
      1,
      await policy.encodeSettings({ limits, passUnpriced }),
    )
  const check = (c: ReturnType<typeof call>, ids = [A]) => engine.checkCall(policy, ctx, c, ids)
  const batch = (calls: ReturnType<typeof call>[], ids = [A]) => engine.checkBatch(policy, ctx, calls, ids)
  const spent = async (attachmentId = A, t = usdc) =>
    (await policy.remaining(engineAddr, safe, attachmentId, t)).spent
  const reserved = (spender = router, attachmentId = A, t = usdc) =>
    policy.reserved(engineAddr, safe, attachmentId, t, spender)

  beforeEach(async () => {
    policy = await ethers.deployContract('LimitPolicy')
    engine = await ethers.deployContract('LimitEngineStub')
    engineAddr = await engine.getAddress()
    token = await ethers.deployContract('MockTokenV2')
    usdc = await token.getAddress()
    dai = await (await ethers.deployContract('MockTokenV2')).getAddress()
    await engine.setSignLib(signLib)
  })

  describe('settings', () => {
    it('stores and reads back the limits', async () => {
      await configure(A, [limit(usdc, 100n), limit(ZeroAddress, 5n, 0n)], true)
      const s = await policy.getSettings(engineAddr, safe, A)
      expect(s.passUnpriced).to.equal(true)
      expect(s.limits.map((l) => [l.token, l.amount, l.period])).to.deep.equal([
        [usdc, 100n, BigInt(DAY)],
        [ZeroAddress, 5n, 0n],
      ])
    })

    it('rejects more than 16 tokens, duplicates and zero amounts', async () => {
      const tokens = Array.from({ length: 17 }, (_, i) =>
        limit(zeroPadValue(`0x${(i + 16).toString(16)}`, 20), 1n),
      )
      await expectRevert(configure(A, tokens), policy, 'InvalidSettings')
      await configure(A, tokens.slice(0, 16))
      await expectRevert(configure(A, [limit(usdc, 1n), limit(usdc, 2n)]), policy, 'InvalidSettings')
      await expectRevert(configure(A, [limit(usdc, 0n)]), policy, 'InvalidSettings')
    })

    it('reconfiguration replaces the limits and starts fresh budgets', async () => {
      await configure(A, [limit(usdc, 100n), limit(dai, 100n)])
      await check(tokenCall('transfer', [alice, 60n]))
      expect(await spent()).to.equal(60n)
      await configure(A, [limit(usdc, 80n)])
      expect(await spent()).to.equal(0n)
      expect((await policy.remaining(engineAddr, safe, A, dai)).amount).to.equal(0n)
      expect((await policy.getSettings(engineAddr, safe, A)).limits.length).to.equal(1)
      await expectRevert(check(tokenCall('transfer', [alice, 1n], dai)), policy, 'Unpriced', [
        A,
        dai,
        TRANSFER,
      ])
    })

    it('is a call-level policy with no delay floor', async () => {
      expect(await policy.policyLevel()).to.equal(0n)
      const s = await policy.encodeSettings({ limits: [limit(usdc, 1n)], passUnpriced: false })
      expect(await engine.configure.staticCall(policy, safe, A, scope, 1, s)).to.equal(0n)
    })
  })

  describe('transfers', () => {
    beforeEach(async () => {
      await configure(A, [limit(usdc, 100n)])
    })

    it('debits transfer(to, amount) and denies beyond the budget', async () => {
      await check(tokenCall('transfer', [alice, 70n]))
      await expectRevert(check(tokenCall('transfer', [alice, 31n])), policy, 'LimitExceeded', [
        A,
        usdc,
        31n,
        30n,
      ])
      await check(tokenCall('transfer', [alice, 30n]))
      const r = await policy.remaining(engineAddr, safe, A, usdc)
      expect([r.amount, r.spent, r.available]).to.deep.equal([100n, 100n, 0n])
    })

    it('debits transferFrom only when the Safe is the source', async () => {
      await check(tokenCall('transferFrom', [safe, alice, 40n]))
      expect(await spent()).to.equal(40n)
      await check(tokenCall('transferFrom', [alice, safe, 1000n]))
      expect(await spent()).to.equal(40n)
    })

    it('denies malformed calldata of a known selector', async () => {
      const short = tokenCall('transfer', [alice, 1n])
      short.data = short.data.slice(0, 2 + 8 + 64)
      await expectRevert(check(short), policy, 'MalformedCall', [TRANSFER])
    })
  })

  describe('periods', () => {
    it('resets on a fixed grid anchored at configure time', async () => {
      await configure(A, [limit(usdc, 100n)])
      const start = (await policy.remaining(engineAddr, safe, A, usdc)).windowStart
      await check(tokenCall('transfer', [alice, 100n]))
      await time.increase(DAY + DAY / 2)
      const r = await policy.remaining(engineAddr, safe, A, usdc)
      expect(r.windowStart).to.equal(start + BigInt(DAY))
      expect(r.available).to.equal(100n)
      await check(tokenCall('transfer', [alice, 100n]))
      await expectRevert(check(tokenCall('transfer', [alice, 1n])), policy, 'LimitExceeded', [
        A,
        usdc,
        1n,
        0n,
      ])
      await time.increase(DAY)
      await check(tokenCall('transfer', [alice, 1n]))
      expect((await policy.remaining(engineAddr, safe, A, usdc)).windowStart).to.equal(
        start + BigInt(2 * DAY),
      )
    })

    it('never resets a one-time budget (period 0)', async () => {
      await configure(A, [limit(usdc, 100n, 0n)])
      await check(tokenCall('transfer', [alice, 100n]))
      await time.increase(365 * DAY)
      await expectRevert(check(tokenCall('transfer', [alice, 1n])), policy, 'LimitExceeded', [
        A,
        usdc,
        1n,
        0n,
      ])
    })

    it('reports zeros for a token the attachment does not list', async () => {
      await configure(A, [limit(usdc, 100n)])
      const r = await policy.remaining(engineAddr, safe, A, dai)
      expect([r.amount, r.spent, r.available, r.period, r.windowStart]).to.deep.equal([0n, 0n, 0n, 0n, 0n])
    })
  })

  describe('native value', () => {
    beforeEach(async () => {
      await configure(A, [limit(ZeroAddress, 10n), limit(usdc, 100n)])
    })

    it('debits ETH sent with any call', async () => {
      await configure(A, [limit(ZeroAddress, 10n), limit(usdc, 100n)], true)
      await check(call(alice, '0x', 4n))
      await check(call(router, erc20.encodeFunctionData('deposit'), 4n), [A])
      expect(await spent(A, ZeroAddress)).to.equal(8n)
      await expectRevert(check(call(alice, '0x', 3n)), policy, 'LimitExceeded', [A, ZeroAddress, 3n, 2n])
    })

    it('debits both the value and the token spend of one call', async () => {
      await check(call(usdc, erc20.encodeFunctionData('transfer', [alice, 50n]), 2n))
      expect(await spent(A, ZeroAddress)).to.equal(2n)
      expect(await spent(A, usdc)).to.equal(50n)
    })

    it('denies ETH when the attachment has no native limit', async () => {
      await configure(B, [limit(usdc, 100n)])
      await expectRevert(check(call(alice, '0x', 1n), [B]), policy, 'Unpriced', [
        B,
        ZeroAddress,
        '0x00000000',
      ])
      await check(call(alice), [B])
    })
  })

  describe('unpriced calls', () => {
    it('denies a call it cannot price, and a spend of a token it does not list', async () => {
      await configure(A, [limit(usdc, 100n)])
      const deposit = erc20.encodeFunctionData('deposit')
      await expectRevert(check(call(router, deposit)), policy, 'Unpriced', [A, ZeroAddress, deposit])
      await expectRevert(check(tokenCall('transfer', [alice, 1n], dai)), policy, 'Unpriced', [
        A,
        dai,
        TRANSFER,
      ])
      await expectRevert(
        check(call(usdc, tokenCall('transfer', [alice, 1n]).data, 0n, DELEGATECALL)),
        policy,
        'Unpriced',
        [A, ZeroAddress, TRANSFER],
      )
    })

    it('lets them pass with passUnpriced, still debiting what it can price', async () => {
      await configure(A, [limit(usdc, 100n)], true)
      await check(call(router, erc20.encodeFunctionData('deposit')))
      await check(tokenCall('transfer', [alice, 1000n], dai))
      await check(call(alice, '0x', 1n))
      await expectRevert(check(tokenCall('transfer', [alice, 101n])), policy, 'LimitExceeded', [
        A,
        usdc,
        101n,
        100n,
      ])
    })

    it('prices empty calldata and zero amounts as free', async () => {
      await configure(A, [limit(usdc, 100n)])
      await check(call(alice))
      await check(tokenCall('transfer', [alice, 0n], dai))
    })
  })

  describe('batches', () => {
    beforeEach(async () => {
      await configure(A, [limit(usdc, 100n)])
    })

    it('sums sub-calls: each debits in order', async () => {
      await batch([tokenCall('transfer', [alice, 40n]), tokenCall('transfer', [router, 40n])])
      expect(await spent()).to.equal(80n)
    })

    it('denies the sub-call that exceeds the budget, and the whole batch with it', async () => {
      const t = tokenCall('transfer', [alice, 40n])
      await expectRevert(batch([t, t, t]), policy, 'LimitExceeded', [A, usdc, 40n, 20n])
      expect(await spent()).to.equal(0n)
    })

    it('cannot free budget with approve(x, 0) then approve(x, a) in one batch', async () => {
      await check(tokenCall('approve', [router, 100n]))
      await token.setAllowance(safe, router, 100n)
      expect(await spent()).to.equal(100n)
      await batch([tokenCall('approve', [router, 0n]), tokenCall('approve', [router, 100n])])
      expect(await spent()).to.equal(100n)
    })

    it('counts approve then decrease in one batch conservatively', async () => {
      // The decrease is capped by the smaller of on-chain (0) and expected (60) allowance: no give-back.
      await batch([tokenCall('approve', [router, 60n]), tokenCall('decreaseAllowance', [router, 60n])])
      expect(await spent()).to.equal(60n)
    })
  })

  describe('approvals as reservations', () => {
    beforeEach(async () => {
      await configure(A, [limit(usdc, 100n)])
    })

    it('spends the allowance increase, read before the call', async () => {
      await token.setAllowance(safe, router, 30n)
      await check(tokenCall('approve', [router, 50n]))
      expect(await spent()).to.equal(20n)
      expect(await reserved()).to.equal(20n)
      await expectRevert(check(tokenCall('approve', [router, 131n])), policy, 'LimitExceeded', [
        A,
        usdc,
        101n,
        80n,
      ])
    })

    it('gives back the unused part when the allowance is reduced', async () => {
      await check(tokenCall('approve', [router, 100n]))
      await token.setAllowance(safe, router, 100n) // executed
      await check(tokenCall('approve', [router, 30n]))
      expect(await spent()).to.equal(30n)
      expect(await reserved()).to.equal(30n)
      await token.setAllowance(safe, router, 0n) // the router pulled 30
      await check(tokenCall('approve', [router, 0n]))
      expect(await spent()).to.equal(30n)
    })

    it('gives back only what was reserved in the current window', async () => {
      await check(tokenCall('approve', [router, 100n]))
      await token.setAllowance(safe, router, 100n)
      await time.increase(DAY)
      await check(tokenCall('transfer', [alice, 60n]))
      expect(await reserved()).to.equal(0n)
      await check(tokenCall('approve', [router, 0n]))
      expect(await spent()).to.equal(60n)
    })

    it('frees nothing when lowering an allowance granted before the limit', async () => {
      await token.setAllowance(safe, router, 500n)
      await check(tokenCall('transfer', [alice, 50n]))
      await check(tokenCall('approve', [router, 0n]))
      await check(tokenCall('decreaseAllowance', [router, 500n]))
      expect(await spent()).to.equal(50n)
    })

    it('reserves increaseAllowance and gives back decreaseAllowance up to the allowance', async () => {
      await check(tokenCall('increaseAllowance', [router, 70n]))
      expect(await spent()).to.equal(70n)
      await token.setAllowance(safe, router, 20n) // the router pulled 50
      await check(tokenCall('decreaseAllowance', [router, 70n]))
      expect(await spent()).to.equal(50n)
      expect(await reserved()).to.equal(50n)
    })

    it('debits every attachment and gives back per attachment', async () => {
      await configure(B, [limit(usdc, 200n)])
      await check(tokenCall('approve', [router, 80n]), [A, B])
      expect([await spent(A), await spent(B)]).to.deep.equal([80n, 80n])
      await token.setAllowance(safe, router, 80n)
      await check(tokenCall('approve', [router, 0n]), [B])
      expect([await spent(A), await spent(B)]).to.deep.equal([80n, 0n])
    })

    it('denies an increase on a token the attachment does not list, never a decrease', async () => {
      const approveDai = (v: bigint) => tokenCall('approve', [router, v], dai)
      await expectRevert(check(approveDai(1n)), policy, 'Unpriced', [A, dai, '0x095ea7b3'])
      await check(approveDai(0n))
    })
  })

  describe('PolicySignLib typed entries', () => {
    const sign = (fn: string, args: unknown[]) =>
      call(signLib, signLibAbi.encodeFunctionData(fn, args), 0n, DELEGATECALL)
    const cowOrder = (sellToken: string, sellAmount: bigint, feeAmount: bigint) => ({
      sellToken,
      buyToken: dai,
      receiver: ZeroAddress,
      sellAmount,
      buyAmount: 1n,
      validTo: 1,
      appData: ZeroHash,
      feeAmount,
      kind: ZeroHash,
      partiallyFillable: false,
      sellTokenBalance: ZeroHash,
      buyTokenBalance: ZeroHash,
    })

    beforeEach(async () => {
      await configure(A, [limit(usdc, 100n)])
    })

    it('debits a CoW order as sellAmount + feeAmount of sellToken', async () => {
      await check(sign('signCowOrder', [cowOrder(usdc, 60n, 5n)]))
      expect(await spent()).to.equal(65n)
      await expectRevert(check(sign('signCowOrder', [cowOrder(usdc, 30n, 6n)])), policy, 'LimitExceeded', [
        A,
        usdc,
        36n,
        35n,
      ])
      await expectRevert(check(sign('signCowOrder', [cowOrder(dai, 1n, 0n)])), policy, 'Unpriced', [
        A,
        dai,
        '0x3d296e04',
      ])
    })

    it('debits a permit in full, whatever the current allowance, and never gives it back (review M-1)', async () => {
      await check(sign('signPermit', [usdc, router, 40n, 1n, 0n]))
      expect(await spent()).to.equal(40n)
      expect(await reserved()).to.equal(0n)
      // An allowance already at the permit value does not make the next permit free.
      await token.setAllowance(safe, router, 40n)
      await check(sign('signPermit', [usdc, router, 40n, 1n, 1n]))
      expect(await spent()).to.equal(80n)
      // Revoking the allowance gives nothing back: the permits stay submittable.
      await check(tokenCall('approve', [router, 0n]))
      expect(await spent()).to.equal(80n)
      await expectRevert(check(sign('signPermit', [usdc, router, 21n, 1n, 2n])), policy, 'LimitExceeded', [
        A,
        usdc,
        21n,
        20n,
      ])
    })

    it('never reads the token for a permit: an unlimited allowance does not price it lower', async () => {
      await token.setAllowance(safe, router, MaxUint256)
      await check(sign('signPermit', [usdc, router, 30n, 1n, 0n]))
      expect(await spent()).to.equal(30n)
    })

    it('debits a Permit2 signature in full', async () => {
      await token.setAllowance(safe, router, 1000n)
      await check(sign('signPermit2', [usdc, router, 30n, 1n, 0n, 1n]))
      expect(await spent()).to.equal(30n)
      expect(await reserved()).to.equal(0n)
    })

    it('only prices them as DELEGATECALLs to the engine SIGN_LIB', async () => {
      const data = signLibAbi.encodeFunctionData('signPermit', [usdc, router, 40n, 1n, 0n])
      await expectRevert(check(call(alice, data, 0n, DELEGATECALL)), policy, 'Unpriced', [
        A,
        ZeroAddress,
        '0x51bdfa61',
      ])
      await expectRevert(check(call(signLib, data)), policy, 'Unpriced', [A, ZeroAddress, '0x51bdfa61'])
    })

    it('denies signMessage as unpriced unless passUnpriced', async () => {
      const raw = sign('signMessage', [ZeroHash])
      await expectRevert(check(raw), policy, 'Unpriced', [A, ZeroAddress, raw.data.slice(0, 10)])
      await configure(A, [limit(usdc, 100n)], true)
      await check(raw)
    })

    it('denies a truncated typed entry', async () => {
      const c = sign('signCowOrder', [cowOrder(usdc, 1n, 0n)])
      c.data = c.data.slice(0, c.data.length - 64)
      await expectRevert(check(c), policy, 'MalformedCall', ['0x3d296e04'])
    })
  })

  describe('several attachments (merge)', () => {
    it('debits every attachment; each must have room', async () => {
      await configure(A, [limit(usdc, 100n)])
      await configure(B, [limit(usdc, 50n)])
      await check(tokenCall('transfer', [alice, 40n]), [A, B])
      expect([await spent(A), await spent(B)]).to.deep.equal([40n, 40n])
      await expectRevert(check(tokenCall('transfer', [alice, 20n]), [A, B]), policy, 'LimitExceeded', [
        B,
        usdc,
        20n,
        10n,
      ])
      await check(tokenCall('transfer', [alice, 20n]), [A])
      expect([await spent(A), await spent(B)]).to.deep.equal([60n, 40n])
    })

    it('denies when one attachment does not list the token', async () => {
      await configure(A, [limit(usdc, 100n)])
      await configure(B, [limit(dai, 100n)])
      await expectRevert(check(tokenCall('transfer', [alice, 1n]), [A, B]), policy, 'Unpriced', [
        B,
        usdc,
        TRANSFER,
      ])
    })

    it('keeps budgets apart per engine', async () => {
      await configure(A, [limit(usdc, 100n)])
      await check(tokenCall('transfer', [alice, 100n]))
      const [other] = await ethers.getSigners()
      expect((await policy.remaining(other.address, safe, A, usdc)).amount).to.equal(0n)
    })
  })
})
