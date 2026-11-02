import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import {
  DAY,
  Operation,
  TRANSFER,
  TRANSFER_FROM,
  accessSelector,
  spendingLimitConfig,
  transferData,
} from './helpers'

const USDC = (n: number) => BigInt(n) * 10n ** 6n
const MAGIC = ethers
  .id('checkTransaction(address,address,uint256,bytes,uint8,address,bytes,uint256)')
  .slice(0, 10)

describe('SpendingLimitPolicy', () => {
  /** The "guard" is a plain account here: state is keyed by msg.sender, whoever it is. */
  async function deploy() {
    const [guard, otherGuard, safe, recipient] = await ethers.getSigners()
    const policy = await ethers.deployContract('SpendingLimitPolicy')
    const token = ethers.Wallet.createRandom().address
    const access = accessSelector(token, TRANSFER, Operation.CALL)

    const configure = (amount: bigint, period: number | bigint, from = guard) =>
      policy.connect(from).configure(safe.address, access, spendingLimitConfig(amount, period))
    const check = (
      amount: bigint,
      from = guard,
      overrides: { value?: bigint; operation?: number; data?: string } = {},
    ) =>
      policy
        .connect(from)
        .checkTransaction(
          safe.address,
          token,
          overrides.value ?? 0n,
          overrides.data ?? transferData(recipient.address, amount),
          overrides.operation ?? Operation.CALL,
          ethers.ZeroAddress,
          '0x',
          access,
        )
    /** Same as `check`, without sending a transaction: returns the magic value if allowed. */
    const checkStatic = (amount: bigint) =>
      policy
        .connect(guard)
        .checkTransaction.staticCall(
          safe.address,
          token,
          0n,
          transferData(recipient.address, amount),
          Operation.CALL,
          ethers.ZeroAddress,
          '0x',
          access,
        )
    const limit = (from = guard) => policy.getLimit(from.address, safe.address, token)

    return { policy, guard, otherGuard, safe, token, access, configure, check, checkStatic, limit }
  }

  describe('configure', () => {
    it('only accepts transfer(address,uint256) with CALL', async () => {
      const { policy, safe, token } = await loadFixture(deploy)
      const data = spendingLimitConfig(USDC(100), DAY)
      await expect(
        policy.configure(safe.address, accessSelector(token, TRANSFER_FROM, Operation.CALL), data),
      ).to.be.revertedWithCustomError(policy, 'InvalidSelector')
      await expect(
        policy.configure(safe.address, accessSelector(token, TRANSFER, Operation.DELEGATECALL), data),
      ).to.be.revertedWithCustomError(policy, 'InvalidOperation')
    })

    it('rejects values that do not fit storage', async () => {
      const { policy, configure } = await loadFixture(deploy)
      await expect(configure(2n ** 128n, DAY)).to.be.revertedWithCustomError(policy, 'InvalidConfiguration')
      await expect(configure(USDC(1), 2n ** 64n)).to.be.revertedWithCustomError(
        policy,
        'InvalidConfiguration',
      )
    })

    it('emits LimitConfigured and starts a fresh window', async () => {
      const { policy, guard, safe, token, configure, limit } = await loadFixture(deploy)
      await expect(configure(USDC(100), DAY))
        .to.emit(policy, 'LimitConfigured')
        .withArgs(guard.address, safe.address, token, USDC(100), DAY)
      const [amount, spent, available, period, windowStart] = await limit()
      expect([amount, spent, available, period]).to.deep.equal([USDC(100), 0n, USDC(100), BigInt(DAY)])
      expect(windowStart).to.equal(BigInt(await time.latest()))
    })
  })

  describe('checkTransaction', () => {
    it('allows transfers within the budget and accumulates them', async () => {
      const { policy, guard, safe, token, configure, check, checkStatic, limit } = await loadFixture(deploy)
      await configure(USDC(100), DAY)
      await check(USDC(60))
      expect(await checkStatic(USDC(40))).to.equal(MAGIC)
      await expect(check(USDC(40)))
        .to.emit(policy, 'Spent')
        .withArgs(guard.address, safe.address, token, USDC(40), USDC(100))
      const [, spent, available] = await limit()
      expect([spent, available]).to.deep.equal([USDC(100), 0n])
    })

    it('denies a transfer above what is left, reporting the available amount', async () => {
      const { policy, configure, check } = await loadFixture(deploy)
      await configure(USDC(100), DAY)
      await check(USDC(70))
      await expect(check(USDC(31)))
        .to.be.revertedWithCustomError(policy, 'LimitExceeded')
        .withArgs(USDC(31), USDC(30))
    })

    it('resets the budget when the period elapses, on a fixed grid', async () => {
      const { configure, check, limit } = await loadFixture(deploy)
      await configure(USDC(100), DAY)
      const [, , , , start] = await limit()
      await check(USDC(100))

      // 2.5 days later: two full periods elapsed, the window starts at start + 2 days.
      await time.increaseTo(start + BigInt(DAY * 2.5))
      const [, spentBefore, availableBefore, , windowBefore] = await limit()
      expect([spentBefore, availableBefore, windowBefore]).to.deep.equal([
        0n,
        USDC(100),
        start + BigInt(2 * DAY),
      ])

      await check(USDC(80))
      const [, spent, , , windowStart] = await limit()
      expect([spent, windowStart]).to.deep.equal([USDC(80), start + BigInt(2 * DAY)])
    })

    it('treats period 0 as a one-time budget that never resets', async () => {
      const { policy, configure, check } = await loadFixture(deploy)
      await configure(USDC(50), 0)
      await check(USDC(50))
      await time.increase(365 * DAY)
      await expect(check(1n)).to.be.revertedWithCustomError(policy, 'LimitExceeded').withArgs(1n, 0n)
    })

    it('denies tokens without a limit, and an amount of 0 removes the limit', async () => {
      const { policy, configure, check } = await loadFixture(deploy)
      await expect(check(1n)).to.be.revertedWithCustomError(policy, 'NoLimitConfigured')
      await configure(USDC(100), DAY)
      await configure(0n, DAY)
      await expect(check(1n)).to.be.revertedWithCustomError(policy, 'NoLimitConfigured')
    })

    it('reconfiguring resets what was spent', async () => {
      const { configure, check, limit } = await loadFixture(deploy)
      await configure(USDC(100), DAY)
      await check(USDC(90))
      await configure(USDC(100), DAY)
      const [, spent, available] = await limit()
      expect([spent, available]).to.deep.equal([0n, USDC(100)])
    })

    it('only accepts plain ERC-20 transfers with CALL and no value', async () => {
      const { policy, safe, configure, check } = await loadFixture(deploy)
      await configure(USDC(100), DAY)
      const transferFrom =
        TRANSFER_FROM +
        ethers.AbiCoder.defaultAbiCoder()
          .encode(['address', 'address', 'uint256'], [safe.address, safe.address, USDC(1)])
          .slice(2)
      await expect(check(0n, undefined, { data: transferFrom })).to.be.revertedWithCustomError(
        policy,
        'InvalidTransfer',
      )
      await expect(check(0n, undefined, { data: '0x' })).to.be.revertedWithCustomError(
        policy,
        'InvalidTransfer',
      )
      await expect(check(USDC(1), undefined, { value: 1n })).to.be.revertedWithCustomError(
        policy,
        'InvalidTransfer',
      )
      await expect(
        check(USDC(1), undefined, { operation: Operation.DELEGATECALL }),
      ).to.be.revertedWithCustomError(policy, 'InvalidOperation')
    })

    it('namespaces limits by policy guard', async () => {
      const { policy, otherGuard, configure, check } = await loadFixture(deploy)
      await configure(USDC(100), DAY)
      await expect(check(1n, otherGuard)).to.be.revertedWithCustomError(policy, 'NoLimitConfigured')
    })
  })
})
