import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { AbiCoder, TypedDataEncoder } from 'ethers'
import { ethers } from 'hardhat'
import type { ERC20TransferPolicy, SafePolicyGuard } from '../../../typechain-types'
import {
  EIP1271_MAGIC_VALUE,
  deploySafe,
  execAsOwners,
  isValidSignature,
  safeMessageHash,
  setGuard,
  signHashOffchain,
  signHashOnchainTx,
} from '../fixtures/safe'
import { expectEvent } from '../helpers'
import {
  MONTH,
  OPS_BUDGET,
  OWNERS,
  SEL,
  T,
  addr,
  allow,
  attach,
  call,
  deployWorld,
  execOwners,
  expectError,
  expectPolicyDenied,
  install,
  limitSettings,
  recipientsSettings,
  safeCall,
  scheduleOwners,
  scope,
  signPermitCall,
  timelockSettings,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/**
 * Story: Tim's permit attack (design doc §7 gap 1). A USDC-style token validates a Safe's permit
 * through ERC-1271. With Safe's CompatibilityFallbackHandler, owner signatures made off-chain over
 * a `SafeMessage` are valid there, so the owners (or whoever holds a quorum of keys) approve a
 * spender for the full balance without any Safe transaction: the guard never runs, whatever cap
 * it enforces. V2 closes it: `PolicyFallbackHandler` accepts only messages the Safe approved
 * on-chain, and the only way to approve one is a Safe transaction DELEGATECALLing `PolicySignLib`,
 * which the engine matches as a CALL and the policies price (SPEC §10).
 */

const coder = AbiCoder.defaultAbiCoder()
const INVALID = '0xffffffff'
const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

async function permitDigest(w: World, owner: string, spender: string, value: bigint, deadline: bigint) {
  const { chainId } = await ethers.provider.getNetwork()
  return TypedDataEncoder.hash(
    { name: 'USD Coin', version: '2', chainId, verifyingContract: w.tokenAddress },
    PERMIT_TYPES,
    { owner, spender, value, nonce: await w.token.nonces(owner), deadline },
  )
}

const limitId = async (w: World) =>
  w.engine.attachmentId(await w.engine.scopeKey(scope(OWNERS)), 2, addr(w.limit))

describe("E2E story: Tim's permit attack", () => {
  describe('V1: CompatibilityFallbackHandler + SafePolicyGuard', () => {
    /** A Safe whose V1 guard only lets USDC go to vendor A (ERC20TransferPolicy, no fallback). */
    async function deployV1() {
      const w = await deployWorld()
      const safe = await deploySafe(w.owners, 2, { infra: w.infra })
      const safeAddress = await safe.getAddress()
      await w.token.mint(safeAddress, usdc(100_000))
      const guard = (await ethers.deployContract(
        'contracts/vendor/policy-engine/SafePolicyGuard.sol:SafePolicyGuard',
        [T, 9n * T],
      )) as unknown as SafePolicyGuard
      const transferPolicy = (await ethers.deployContract(
        'ERC20TransferPolicy',
      )) as unknown as ERC20TransferPolicy
      const configuration = {
        target: w.tokenAddress,
        selector: SEL.transfer,
        operation: 0,
        policy: await transferPolicy.getAddress(),
        data: coder.encode(['tuple(address recipient, uint8 permission)[]'], [[[w.vendorA.address, 2]]]),
      }
      await execAsOwners(
        safe,
        call(
          await guard.getAddress(),
          guard.interface.encodeFunctionData('configureImmediately', [[configuration]]),
        ),
        w.quorum2,
      )
      await setGuard(safe, await guard.getAddress(), w.quorum2)
      return { ...w, safe, safeAddress, guard, transferPolicy }
    }

    it('the guard caps the owners: a transfer to anyone but vendor A is denied', async () => {
      const v1 = await loadFixture(deployV1)
      await execAsOwners(v1.safe, tokenTransfer(v1, v1.vendorA.address, usdc(1)), v1.quorum2)
      await expectError(
        execAsOwners(v1.safe, tokenTransfer(v1, v1.attacker.address, usdc(1)), v1.quorum2),
        v1.guard,
        'PolicyReverted',
      )
    })

    it('passes: an off-chain owner signature on a permit drains the Safe at t = 0, no guard call', async () => {
      const v1 = await loadFixture(deployV1)
      const balance = await v1.token.balanceOf(v1.safeAddress)
      const deadline = BigInt(await time.latest()) + 3600n
      const digest = await permitDigest(v1, v1.safeAddress, v1.attacker.address, balance, deadline)
      const nonce = await v1.safe.nonce()

      const sigs = await signHashOffchain(v1.safe, digest, v1.quorum2)
      expect(await isValidSignature(v1.safe, digest, sigs)).to.equal(EIP1271_MAGIC_VALUE)
      await v1.token.connect(v1.attacker).permit(v1.safeAddress, v1.attacker.address, balance, deadline, sigs)
      await v1.token.connect(v1.attacker).transferFrom(v1.safeAddress, v1.attacker.address, balance)

      expect(await v1.token.balanceOf(v1.safeAddress)).to.equal(0n)
      expect(await v1.token.balanceOf(v1.attacker.address)).to.equal(balance)
      expect(await v1.safe.nonce()).to.equal(nonce) // no Safe transaction, so no guard check
    })
  })

  describe('V2: PolicyFallbackHandler + SafePolicyGuardV2 (Allow + Recipients + Limit + Timelock)', () => {
    async function deployV2() {
      const w = await deployWorld()
      const router = w.outsider
      const owners = scope(OWNERS)
      await install(w, [
        allow(owners),
        attach(
          owners,
          addr(w.recipients),
          recipientsSettings({ spenders: [router.address], maxApproval: ethers.MaxUint256 }),
        ),
        // passUnpriced: the owners' other calls (Safe management) are not payments; the Timelock covers them.
        attach(
          owners,
          addr(w.limit),
          limitSettings([{ token: w.tokenAddress, amount: OPS_BUDGET, period: MONTH }], true),
        ),
        attach(owners, addr(w.timelock), timelockSettings(T)),
      ])
      return { ...w, router }
    }

    it('denied: the same off-chain owner signature is INVALID, the permit reverts, nothing moves', async () => {
      const w = await loadFixture(deployV2)
      const balance = await w.token.balanceOf(w.safeAddress)
      const deadline = BigInt(await time.latest()) + 3600n
      const digest = await permitDigest(w, w.safeAddress, w.attacker.address, balance, deadline)
      const sigs = await signHashOffchain(w.safe, digest, w.quorum2)

      expect(await isValidSignature(w.safe, digest, sigs)).to.equal(INVALID)
      await expectError(
        w.token.connect(w.attacker).permit(w.safeAddress, w.attacker.address, balance, deadline, sigs),
        w.token,
        'InvalidSignature',
      )
      expect(await w.token.balanceOf(w.safeAddress)).to.equal(balance)
    })

    it('denied: signing on-chain through PolicySignLib is a call the policies judge (spender, budget)', async () => {
      const w = await loadFixture(deployV2)
      const balance = await w.token.balanceOf(w.safeAddress)
      const deadline = BigInt(await time.latest()) + 3n * T
      await expectPolicyDenied(
        execOwners(w, signPermitCall(w, w.attacker.address, balance, deadline)),
        w.engine,
        w.recipients,
        'SpenderNotAllowed',
        [w.attacker.address],
        0n,
      )
      await expectPolicyDenied(
        execOwners(w, signPermitCall(w, w.router.address, balance, deadline)),
        w.engine,
        w.limit,
        'LimitExceeded',
        [await limitId(w), w.tokenAddress, balance, OPS_BUDGET],
      )
    })

    it('denied: the raw message routes (SignMessageLib, PolicySignLib.signMessage) are not granted', async () => {
      const w = await loadFixture(deployV2)
      const digest = await permitDigest(w, w.safeAddress, w.attacker.address, 1n, 1n)
      for (const tx of [
        await signHashOnchainTx(w.infra, digest),
        call(w.signLibAddress, w.signLib.interface.encodeFunctionData('signMessage', [digest]), 0n, 1),
      ]) {
        await expectError(execOwners(w, tx), w.engine, 'NotGranted')
      }
    })

    it('allowed within policy: a timelocked, priced permit the token accepts (slot-7 signedMessages, SignMsg)', async () => {
      const w = await loadFixture(deployV2)
      const deadline = BigInt(await time.latest()) + 3n * T
      const tx = signPermitCall(w, w.router.address, usdc(1_000), deadline)
      await scheduleOwners(w, tx)
      await time.increase(T)
      const sent = await execOwners(w, tx)

      const digest = await permitDigest(w, w.safeAddress, w.router.address, usdc(1_000), deadline)
      const msgHash = await safeMessageHash(w.safe, coder.encode(['bytes32'], [digest]))
      await expectEvent(sent, w.signLib.attach(w.safeAddress) as typeof w.signLib, 'SignMsg', [msgHash])
      expect(await w.safe.signedMessages(msgHash)).to.equal(1n)
      expect(await isValidSignature(w.safe, digest, '0x')).to.equal(EIP1271_MAGIC_VALUE)

      expect(
        (await w.limit.remaining(w.engineAddress, w.safeAddress, await limitId(w), w.tokenAddress)).available,
      ).to.equal(OPS_BUDGET - usdc(1_000))
      await w.token.connect(w.router).permit(w.safeAddress, w.router.address, usdc(1_000), deadline, '0x')
      await w.token.connect(w.router).transferFrom(w.safeAddress, w.router.address, usdc(1_000))
      expect(await w.token.balanceOf(w.router.address)).to.equal(usdc(1_000))
    })

    it('switching back to CompatibilityFallbackHandler is a call to the Safe, under the owners’ Timelock', async () => {
      const w = await loadFixture(deployV2)
      const back = safeCall(w, 'setFallbackHandler', [await w.infra.fallbackHandler.getAddress()])
      await expectPolicyDenied(execOwners(w, back), w.engine, w.timelock, 'NotScheduled')
    })
  })
})
