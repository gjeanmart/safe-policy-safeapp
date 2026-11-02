import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import {
  DAY,
  Operation,
  Permission,
  TRANSFER,
  accessSelector,
  allOfConfig,
  recipientsConfig,
  spendingLimitConfig,
  transferData,
} from './helpers'

const USDC = (n: number) => BigInt(n) * 10n ** 6n

/**
 * End-to-end through the real SafePolicyGuard: a MockSafe configures the guard and runs module
 * checks, so the policies are reached exactly as on a live Safe.
 */
describe('AllOfPolicy (with SafePolicyGuard)', () => {
  async function deploy() {
    const [module, alice, bob, stranger] = await ethers.getSigners()
    // No delay needed: the MockSafe never installs the guard, so configureImmediately applies.
    const guard = await ethers.deployContract('SafePolicyGuard', [0, DAY])
    const safe = await ethers.deployContract('MockSafe')
    const allOf = await ethers.deployContract('AllOfPolicy', [await guard.getAddress()])
    const recipients = await ethers.deployContract('ERC20TransferPolicy')
    const spending = await ethers.deployContract('SpendingLimitPolicy')
    const token = ethers.Wallet.createRandom().address

    /** Binds `token.transfer` to AllOfPolicy with the given inner policies. */
    const bind = (inner: { policy: string; data: string }[]) =>
      safe.configure(guard, [
        {
          target: token,
          selector: TRANSFER,
          operation: Operation.CALL,
          policy: allOf,
          data: allOfConfig(inner),
        },
      ])
    const transfer = (to: string, amount: bigint, success = true) =>
      safe.connect(module).execFromModule(guard, token, 0n, transferData(to, amount), Operation.CALL, success)

    const recipientsEntry = {
      policy: await recipients.getAddress(),
      data: recipientsConfig([{ recipient: alice.address, permission: Permission.ALWAYS }]),
    }
    const spendingEntry = { policy: await spending.getAddress(), data: spendingLimitConfig(USDC(100), DAY) }
    const spent = async () => (await spending.getLimit(allOf, safe, token))[1]

    return {
      guard,
      safe,
      allOf,
      recipients,
      spending,
      token,
      alice,
      bob,
      stranger,
      bind,
      transfer,
      recipientsEntry,
      spendingEntry,
      spent,
    }
  }

  /** The guard wraps policy reverts in PolicyReverted(policy, reason): rebuild the expected reason. */
  const innerReverted = async (
    allOf: Awaited<ReturnType<typeof deploy>>['allOf'],
    inner: {
      getAddress(): Promise<string>
      interface: { encodeErrorResult(name: string, args: unknown[]): string }
    },
    error: string,
    args: unknown[] = [],
  ) =>
    allOf.interface.encodeErrorResult('InnerPolicyReverted', [
      await inner.getAddress(),
      inner.interface.encodeErrorResult(error, args),
    ])

  it('passes when every inner policy accepts', async () => {
    const { bind, transfer, alice, recipientsEntry, spendingEntry, spent } = await loadFixture(deploy)
    await bind([recipientsEntry, spendingEntry])
    await transfer(alice.address, USDC(60))
    expect(await spent()).to.equal(USDC(60))
  })

  it('denies a recipient outside the allowlist (ERC20TransferPolicy)', async () => {
    const { guard, allOf, recipients, bind, transfer, bob, recipientsEntry, spendingEntry } =
      await loadFixture(deploy)
    await bind([recipientsEntry, spendingEntry])
    await expect(transfer(bob.address, USDC(1)))
      .to.be.revertedWithCustomError(guard, 'PolicyReverted')
      .withArgs(await allOf.getAddress(), await innerReverted(allOf, recipients, 'Unauthorized'))
  })

  it('denies an allowed recipient above the budget (SpendingLimitPolicy)', async () => {
    const { guard, allOf, spending, bind, transfer, alice, recipientsEntry, spendingEntry } =
      await loadFixture(deploy)
    await bind([recipientsEntry, spendingEntry])
    await transfer(alice.address, USDC(60))
    await expect(transfer(alice.address, USDC(50)))
      .to.be.revertedWithCustomError(guard, 'PolicyReverted')
      .withArgs(
        await allOf.getAddress(),
        await innerReverted(allOf, spending, 'LimitExceeded', [USDC(50), USDC(40)]),
      )
  })

  it('rolls back a spend staged before a later inner policy denies', async () => {
    const { guard, bind, transfer, bob, recipientsEntry, spendingEntry, spent } = await loadFixture(deploy)
    // Spending limit first: it records the spend, then the recipient check fails.
    await bind([spendingEntry, recipientsEntry])
    await expect(transfer(bob.address, USDC(10))).to.be.revertedWithCustomError(guard, 'PolicyReverted')
    expect(await spent()).to.equal(0n)
  })

  it('rolls back the spend when the module execution fails', async () => {
    const { guard, bind, transfer, alice, recipientsEntry, spendingEntry, spent } = await loadFixture(deploy)
    await bind([recipientsEntry, spendingEntry])
    await expect(transfer(alice.address, USDC(10), false)).to.be.revertedWithCustomError(
      guard,
      'ModuleExecutionFailed',
    )
    expect(await spent()).to.equal(0n)
  })

  it('configures inner policies in the namespace of the combinator', async () => {
    const { allOf, recipients, spending, safe, token, alice, bind, recipientsEntry, spendingEntry } =
      await loadFixture(deploy)
    await bind([recipientsEntry, spendingEntry])
    expect(await allOf.getPolicies(safe, accessSelector(token, TRANSFER, Operation.CALL))).to.deep.equal([
      await recipients.getAddress(),
      await spending.getAddress(),
    ])
    expect(await recipients.getRecipientPermission(allOf, safe, token, alice.address)).to.equal(
      Permission.ALWAYS,
    )
    expect((await spending.getLimit(allOf, safe, token))[0]).to.equal(USDC(100))
  })

  it('only serves its own policy guard', async () => {
    const { allOf, safe, token, stranger, spendingEntry } = await loadFixture(deploy)
    const access = accessSelector(token, TRANSFER, Operation.CALL)
    await expect(
      allOf.connect(stranger).configure(safe, access, allOfConfig([spendingEntry])),
    ).to.be.revertedWithCustomError(allOf, 'UnauthorizedCaller')
    await expect(
      allOf
        .connect(stranger)
        .checkTransaction(
          safe,
          token,
          0n,
          transferData(stranger.address, 1n),
          Operation.CALL,
          stranger.address,
          '0x',
          access,
        ),
    ).to.be.revertedWithCustomError(allOf, 'UnauthorizedCaller')
  })

  it('rejects invalid inner policy lists', async () => {
    const { allOf, bind, recipientsEntry, spendingEntry } = await loadFixture(deploy)
    const self = { policy: await allOf.getAddress(), data: '0x' }
    const zero = { policy: ethers.ZeroAddress, data: '0x' }
    for (const inner of [
      [],
      [recipientsEntry, recipientsEntry],
      [self],
      [zero],
      Array(6).fill(spendingEntry),
    ]) {
      // configureImmediately does not wrap policy errors: the combinator's revert bubbles up.
      await expect(bind(inner)).to.be.revertedWithCustomError(allOf, 'InvalidConfiguration')
    }
  })

  it('denies when no inner policies are bound for the access selector', async () => {
    const { allOf, safe, token } = await loadFixture(deploy)
    // Called as the guard would, for a binding that was never configured.
    const guardAddress = await allOf.POLICY_GUARD()
    await ethers.provider.send('hardhat_impersonateAccount', [guardAddress])
    await ethers.provider.send('hardhat_setBalance', [guardAddress, '0xde0b6b3a7640000'])
    const asGuard = await ethers.getSigner(guardAddress)
    await expect(
      allOf
        .connect(asGuard)
        .checkTransaction(
          safe,
          token,
          0n,
          transferData(guardAddress, 1n),
          Operation.CALL,
          guardAddress,
          '0x',
          accessSelector(token, TRANSFER, Operation.CALL),
        ),
    ).to.be.revertedWithCustomError(allOf, 'NoPoliciesConfigured')
  })
})
