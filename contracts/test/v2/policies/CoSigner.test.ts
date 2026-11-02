import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  AbiCoder,
  BaseWallet,
  Signature,
  TypedDataEncoder,
  Wallet,
  ZeroAddress,
  getAddress,
  hexlify,
  id,
  randomBytes,
  toBeHex,
} from 'ethers'
import { ethers } from 'hardhat'
import type { CoSignerPolicyV2, ProofEngineStub } from '../../../typechain-types'
import { expectEvent, expectRevert } from '../helpers'

/**
 * WP5 CoSignerPolicyV2 (SPEC.md §8.6), driven by ProofEngineStub acting as the engine: owner path
 * (co-signatures in the policy context over the Safe transaction hash), module path (pushed with
 * `cosign` over the EIP-712 module digest, consumed by the check), batches, several attachments.
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const PASS = '0xe18ffdca'
const TRANSFER = id('transfer(address,uint256)').slice(0, 10)
const randomHash = () => hexlify(randomBytes(32))
const randomAddress = () => Wallet.createRandom().address

type ScopeData = { actor: string; to: string; selector: string; callMatch: number }
type CallT = { to: string; value: bigint; data: string; operation: number }
const globalScope: ScopeData = { actor: ANY, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }
const ownersScope: ScopeData = { actor: OWNERS, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }

const settings = (cosigner: string) => coder.encode(['address'], [cosigner])
const coSignatures = (entries: [string, string][]) =>
  coder.encode(['tuple(address cosigner, bytes signature)[]'], [entries])
const sign = (wallet: BaseWallet, digest: string) => wallet.signingKey.sign(digest).serialized

describe('CoSignerPolicyV2', function () {
  async function fixture() {
    const engine = (await (
      await ethers.getContractFactory('ProofEngineStub')
    ).deploy()) as unknown as ProofEngineStub
    const otherEngine = (await (
      await ethers.getContractFactory('ProofEngineStub')
    ).deploy()) as unknown as ProofEngineStub
    const policy = (await (
      await ethers.getContractFactory('CoSignerPolicyV2')
    ).deploy()) as unknown as CoSignerPolicyV2
    const contractCosigner = await (await ethers.getContractFactory('ERC1271SignerStub')).deploy()
    const alice = Wallet.createRandom()
    const bob = Wallet.createRandom()
    const safe = randomAddress()
    const module = randomAddress()
    const token = randomAddress()
    const tokenScope: ScopeData = { actor: ANY, to: token, selector: TRANSFER, callMatch: 3 }
    return { engine, otherEngine, policy, contractCosigner, alice, bob, safe, module, token, tokenScope }
  }

  async function attach(
    engine: ProofEngineStub,
    policy: CoSignerPolicyV2,
    safe: string,
    scope: ScopeData,
    cosigner: string,
  ) {
    const args = [await policy.getAddress(), safe, scope, 1, settings(cosigner)] as const
    const [attachmentId] = await engine.configure.staticCall(...args)
    await engine.configure(...args)
    return attachmentId
  }

  const ownerCtx = (safe: string, txHash: string) => ({
    safe,
    actor: OWNERS,
    txHash,
    nonce: 7n,
    executor: randomAddress(),
  })
  const transferCall = (token: string, amount = 1n): CallT => ({
    to: token,
    value: 0n,
    data: TRANSFER + coder.encode(['address', 'uint256'], [randomAddress(), amount]).slice(2),
    operation: 0,
  })

  describe('policy shape and settings', function () {
    it('is a transaction-level IPolicyV2', async function () {
      const { policy } = await loadFixture(fixture)
      expect(await policy.policyLevel()).to.equal(1n)
      expect(await policy.supportsInterface('0x55872811')).to.equal(true)
      expect(await policy.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await policy.supportsInterface('0xffffffff')).to.equal(false)
    })

    it('stores the co-signer per (engine, safe, attachment) with a zero delay floor', async function () {
      const { engine, otherEngine, policy, alice, safe } = await loadFixture(fixture)
      const [, delayFloor] = await engine.configure.staticCall(
        policy,
        safe,
        globalScope,
        1,
        settings(alice.address),
      )
      expect(delayFloor).to.equal(0n)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      expect((await policy.getSettings(engine, safe, attachmentId)).cosigner).to.equal(alice.address)
      expect((await policy.getSettings(otherEngine, safe, attachmentId)).cosigner).to.equal(ZeroAddress)
      expect(await policy.encodeSettings({ cosigner: alice.address })).to.equal(settings(alice.address))
    })

    it('rejects a zero co-signer, a wrong length and dirty upper bits with InvalidSettings', async function () {
      const { engine, policy, safe } = await loadFixture(fixture)
      for (const data of [
        settings(ZeroAddress),
        '0x',
        settings(randomAddress()) + '00',
        toBeHex(1n << 200n, 32),
      ]) {
        await expectRevert(engine.configure(policy, safe, globalScope, 1, data), policy, 'InvalidSettings')
      }
    })

    it('denies an attachment that was never configured (fail closed)', async function () {
      const { engine, policy, safe } = await loadFixture(fixture)
      await expectRevert(
        engine.checkTransaction(policy, ownerCtx(safe, randomHash()), [], '0x', '0x', [randomHash()]),
        policy,
        'InvalidSettings',
      )
    })

    it('rejects a call-level check and an empty attachment list', async function () {
      const { engine, policy, alice, safe, token } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      const ctx = ownerCtx(safe, randomHash())
      await expectRevert(
        engine.checkCall(policy, ctx, transferCall(token), [attachmentId]),
        policy,
        'WrongPolicyLevel',
      )
      await expectRevert(engine.checkTransaction(policy, ctx, [], '0x', '0x', []), policy, 'NoAttachments')
    })
  })

  describe('owner path', function () {
    it('passes with the co-signature over the Safe transaction hash', async function () {
      const { engine, policy, alice, safe, token } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      const txHash = randomHash()
      const data = coSignatures([[alice.address, sign(alice, txHash)]])
      const ctx = ownerCtx(safe, txHash)
      expect(
        await engine.checkTransaction.staticCall(policy, ctx, [transferCall(token)], '0x', data, [
          attachmentId,
        ]),
      ).to.equal(PASS)
    })

    it('denies without a context: MissingCoSignature (what preview reports)', async function () {
      const { engine, policy, alice, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      await expectRevert(
        engine.checkTransaction(policy, ownerCtx(safe, randomHash()), [], '0x', '0x', [attachmentId]),
        policy,
        'MissingCoSignature',
        [alice.address],
      )
    })

    it('denies a signature by another key, over another hash, with a high s or a bad v', async function () {
      const { engine, policy, alice, bob, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      const txHash = randomHash()
      const good = Signature.from(sign(alice, txHash))
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
      const highS = good.r + toBeHex(n - BigInt(good.s), 32).slice(2) + (good.v === 27 ? '1c' : '1b')
      const badV = good.r + good.s.slice(2) + '00'
      for (const signature of [sign(bob, txHash), sign(alice, randomHash()), highS, badV, '0x1234']) {
        await expectRevert(
          engine.checkTransaction(
            policy,
            ownerCtx(safe, txHash),
            [],
            '0x',
            coSignatures([[alice.address, signature]]),
            [attachmentId],
          ),
          policy,
          'InvalidCoSignature',
          [alice.address],
        )
      }
    })

    it('checks the first entry naming the co-signer and ignores the others', async function () {
      const { engine, policy, alice, bob, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      const txHash = randomHash()
      const ctx = ownerCtx(safe, txHash)
      const extra = coSignatures([
        [bob.address, sign(bob, txHash)],
        [alice.address, sign(alice, txHash)],
      ])
      expect(await engine.checkTransaction.staticCall(policy, ctx, [], '0x', extra, [attachmentId])).to.equal(
        PASS,
      )
      const badFirst = coSignatures([
        [alice.address, sign(bob, txHash)],
        [alice.address, sign(alice, txHash)],
      ])
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', badFirst, [attachmentId]),
        policy,
        'InvalidCoSignature',
      )
    })

    it('denies a context that does not decode: MalformedPolicyData', async function () {
      const { engine, policy, alice, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      for (const data of [
        '0x1234',
        hexlify(randomBytes(96)),
        coder.encode(['uint256', 'uint256'], [32n, 5n]),
      ]) {
        await expectRevert(
          engine.checkTransaction(policy, ownerCtx(safe, randomHash()), [], '0x', data, [attachmentId]),
          policy,
          'MalformedPolicyData',
        )
      }
    })

    it('one co-signature covers a whole batch (one run per transaction)', async function () {
      const { engine, policy, alice, safe, token, tokenScope } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, tokenScope, alice.address)
      const txHash = randomHash()
      const calls = [transferCall(token, 1n), transferCall(token, 2n), transferCall(token, 1n)]
      const data = coSignatures([[alice.address, sign(alice, txHash)]])
      expect(
        await engine.checkTransaction.staticCall(policy, ownerCtx(safe, txHash), calls, '0x', data, [
          attachmentId,
        ]),
      ).to.equal(PASS)
    })

    it('one policy at several scopes: one signature per distinct co-signer', async function () {
      const { engine, policy, alice, bob, safe, tokenScope } = await loadFixture(fixture)
      const a1 = await attach(engine, policy, safe, globalScope, alice.address)
      const a2 = await attach(engine, policy, safe, tokenScope, alice.address)
      const b = await attach(engine, policy, safe, ownersScope, bob.address)
      const txHash = randomHash()
      const ctx = ownerCtx(safe, txHash)
      const onlyAlice = coSignatures([[alice.address, sign(alice, txHash)]])
      expect(await engine.checkTransaction.staticCall(policy, ctx, [], '0x', onlyAlice, [a1, a2])).to.equal(
        PASS,
      )
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', onlyAlice, [a1, a2, b]),
        policy,
        'MissingCoSignature',
        [bob.address],
      )
      const both = coSignatures([
        [bob.address, sign(bob, txHash)],
        [alice.address, sign(alice, txHash)],
      ])
      expect(await engine.checkTransaction.staticCall(policy, ctx, [], '0x', both, [a1, a2, b])).to.equal(
        PASS,
      )
    })

    it('accepts an ERC-1271 co-signer that approves the hash', async function () {
      const { engine, policy, contractCosigner, safe } = await loadFixture(fixture)
      const cosigner = await contractCosigner.getAddress()
      const attachmentId = await attach(engine, policy, safe, globalScope, cosigner)
      const txHash = randomHash()
      const data = coSignatures([[cosigner, '0x']])
      const ctx = ownerCtx(safe, txHash)
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', data, [attachmentId]),
        policy,
        'InvalidCoSignature',
        [cosigner],
      )
      await contractCosigner.approve(txHash)
      expect(await engine.checkTransaction.staticCall(policy, ctx, [], '0x', data, [attachmentId])).to.equal(
        PASS,
      )
    })

    it('is namespaced by engine: another engine has no settings for the id', async function () {
      const { engine, otherEngine, policy, alice, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, alice.address)
      const txHash = randomHash()
      const data = coSignatures([[alice.address, sign(alice, txHash)]])
      await expectRevert(
        otherEngine.checkTransaction(policy, ownerCtx(safe, txHash), [], '0x', data, [attachmentId]),
        policy,
        'InvalidSettings',
      )
    })
  })

  describe('module path', function () {
    async function moduleSetup() {
      const f = await loadFixture(fixture)
      const attachmentId = await attach(f.engine, f.policy, f.safe, globalScope, f.alice.address)
      const top = transferCall(f.token)
      const callHash = await f.engine.moduleCallHash(
        f.safe,
        f.module,
        top.to,
        top.value,
        top.data,
        top.operation,
      )
      const digest = await f.policy.moduleTxDigest(f.engine, f.safe, callHash)
      return { ...f, attachmentId, top, callHash, digest }
    }

    it('signs an EIP-712 ModuleTransaction under the policy domain, with a use counter', async function () {
      const { engine, policy, safe, callHash, digest } = await moduleSetup()
      const { chainId } = await ethers.provider.getNetwork()
      const expected = TypedDataEncoder.hash(
        { name: 'CoSignerPolicyV2', version: '1', chainId, verifyingContract: await policy.getAddress() },
        {
          ModuleTransaction: [
            { name: 'engine', type: 'address' },
            { name: 'safe', type: 'address' },
            { name: 'callHash', type: 'bytes32' },
            { name: 'nonce', type: 'uint256' },
          ],
        },
        { engine: await engine.getAddress(), safe, callHash, nonce: 0n },
      )
      expect(digest).to.equal(expected)
    })

    it('a pushed co-signature passes once and is consumed', async function () {
      const { engine, policy, alice, safe, module, top, attachmentId, callHash, digest } = await moduleSetup()
      const tx = await policy.cosign(engine, safe, callHash, alice.address, sign(alice, digest))
      await expectEvent(tx, policy, 'Cosigned', [await engine.getAddress(), safe, callHash, alice.address])
      expect(await policy.isCosigned(engine, safe, callHash, alice.address)).to.equal(true)
      expect(
        await engine.checkModuleTransaction.staticCall(policy, safe, module, top, [top], [attachmentId]),
      ).to.equal(PASS)

      await engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId])
      expect(await policy.isCosigned(engine, safe, callHash, alice.address)).to.equal(false)
      expect(await policy.moduleTxNonce(engine, safe, callHash)).to.equal(1n)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId]),
        policy,
        'MissingCoSignature',
        [alice.address],
      )
    })

    it('a consumed co-signature cannot be pushed again; the same call twice needs a new one', async function () {
      const { engine, policy, alice, safe, module, top, attachmentId, callHash, digest } = await moduleSetup()
      const first = sign(alice, digest)
      await policy.cosign(engine, safe, callHash, alice.address, first)
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId])

      await expectRevert(
        policy.cosign(engine, safe, callHash, alice.address, first),
        policy,
        'InvalidCoSignature',
        [alice.address],
      )
      const nextDigest = await policy.moduleTxDigest(engine, safe, callHash)
      expect(nextDigest).to.not.equal(digest)
      await policy.cosign(engine, safe, callHash, alice.address, sign(alice, nextDigest))
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId])
    })

    it('a failed execution rolls the consumption back', async function () {
      const { engine, policy, alice, safe, module, top, attachmentId, callHash, digest } = await moduleSetup()
      await policy.cosign(engine, safe, callHash, alice.address, sign(alice, digest))
      await expectRevert(
        engine.checkModuleTransactionThenFail(policy, safe, module, top, [top], [attachmentId]),
        engine,
        'ExecutionFailed',
      )
      expect(await policy.isCosigned(engine, safe, callHash, alice.address)).to.equal(true)
    })

    it('rejects a push by the wrong key, over the owner-path hash, or for a zero co-signer', async function () {
      const { engine, policy, alice, bob, safe, callHash, digest } = await moduleSetup()
      await expectRevert(
        policy.cosign(engine, safe, callHash, alice.address, sign(bob, digest)),
        policy,
        'InvalidCoSignature',
        [alice.address],
      )
      await expectRevert(
        policy.cosign(engine, safe, callHash, alice.address, sign(alice, callHash)),
        policy,
        'InvalidCoSignature',
        [alice.address],
      )
      await expectRevert(
        policy.cosign(engine, safe, callHash, ZeroAddress, '0x'),
        policy,
        'InvalidCoSignature',
        [ZeroAddress],
      )
    })

    it('a proof is bound to its engine, Safe and call', async function () {
      const { engine, otherEngine, policy, alice, safe, module, top, attachmentId, callHash, digest, token } =
        await moduleSetup()
      await policy.cosign(engine, safe, callHash, alice.address, sign(alice, digest))
      // Same co-signer configured on another engine: the proof pushed for `engine` does not count there.
      const otherId = await attach(otherEngine, policy, safe, globalScope, alice.address)
      await expectRevert(
        otherEngine.checkModuleTransaction(policy, safe, module, top, [top], [otherId]),
        policy,
        'MissingCoSignature',
      )
      const otherCall = transferCall(token, 2n)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, otherCall, [otherCall], [attachmentId]),
        policy,
        'MissingCoSignature',
      )
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, randomAddress(), top, [top], [attachmentId]),
        policy,
        'MissingCoSignature',
      )
    })

    it('several attachments of one co-signer consume one proof; distinct co-signers each need one', async function () {
      const { engine, policy, alice, bob, safe, module, top, attachmentId, callHash, digest, tokenScope } =
        await moduleSetup()
      const a2 = await attach(engine, policy, safe, tokenScope, alice.address)
      const b = await attach(engine, policy, safe, ownersScope, bob.address)
      await policy.cosign(engine, safe, callHash, alice.address, sign(alice, digest))
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId, a2, b]),
        policy,
        'MissingCoSignature',
        [bob.address],
      )
      await policy.cosign(engine, safe, callHash, bob.address, sign(bob, digest))
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId, a2, b])
      expect(await policy.isCosigned(engine, safe, callHash, alice.address)).to.equal(false)
      expect(await policy.isCosigned(engine, safe, callHash, bob.address)).to.equal(false)
    })

    it('one co-signature covers a whole module batch', async function () {
      const { engine, policy, alice, safe, module, attachmentId, token } = await moduleSetup()
      const batchTop = { to: randomAddress(), value: 0n, data: '0x8d80ff0a' + '00'.repeat(64), operation: 1 }
      const calls = [transferCall(token, 1n), transferCall(token, 2n)]
      const callHash = await engine.moduleCallHash(safe, module, batchTop.to, 0n, batchTop.data, 1)
      await policy.cosign(
        engine,
        safe,
        callHash,
        alice.address,
        sign(alice, await policy.moduleTxDigest(engine, safe, callHash)),
      )
      expect(
        await engine.checkModuleTransaction.staticCall(policy, safe, module, batchTop, calls, [attachmentId]),
      ).to.equal(PASS)
    })

    it('accepts an ERC-1271 co-signer, checked when pushed', async function () {
      const { engine, policy, contractCosigner, safe, module, top, callHash, digest } = await moduleSetup()
      const cosigner = await contractCosigner.getAddress()
      const attachmentId = await attach(engine, policy, safe, ownersScope, cosigner)
      await expectRevert(
        policy.cosign(engine, safe, callHash, cosigner, '0x'),
        policy,
        'InvalidCoSignature',
        [cosigner],
      )
      await contractCosigner.approve(digest)
      await policy.cosign(engine, safe, callHash, cosigner, '0x')
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [attachmentId])
      // The approval of the old digest is permanent, but the next use has a new digest.
      await expectRevert(
        policy.cosign(engine, safe, callHash, cosigner, '0x'),
        policy,
        'InvalidCoSignature',
        [cosigner],
      )
    })

    it('ignores any owner-path context on the module path', async function () {
      const { engine, policy, alice, safe, module, attachmentId, callHash } = await moduleSetup()
      const ctx = { safe, actor: module, txHash: callHash, nonce: 0n, executor: module }
      const data = coSignatures([[alice.address, sign(alice, callHash)]])
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', data, [attachmentId]),
        policy,
        'MissingCoSignature',
      )
    })
  })
})
