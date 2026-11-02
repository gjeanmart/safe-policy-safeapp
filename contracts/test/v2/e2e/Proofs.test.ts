import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { type MetaTx, multiSendTx, safeTxHash } from '../fixtures/safe'
import { expectEvent } from '../helpers'
import {
  HOUR,
  OWNERS,
  TX_INDEX,
  addr,
  allow,
  attach,
  attest,
  coSignatures,
  cosign,
  cosignerSettings,
  deployWorld,
  execModule,
  execOwners,
  expectPolicyDenied,
  install,
  moduleCallHash,
  policyContextTail,
  scope,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/** Module-path proof deadline (CoSigner, Safenet) far past any time the story advances to. */
const PROOF_DEADLINE = 2n ** 40n

/**
 * Story: Co-signer and Safenet protect both paths, and one proof covers a whole batch. V1 ports
 * revert on the module path (so a global one bricks every module) and run once per sub-call. In
 * V2 they are transaction-level restrictions: owner path proofs ride in the policy context over
 * the Safe transaction hash; module path proofs are pushed before execution over an EIP-712
 * `ModuleTransaction` digest and consumed by the check (SPEC §6.6, §7, §8.6, §8.7). The Safenet
 * attestations here are real single-signer FROST signatures (as WP5's tests).
 */
describe('E2E story: Co-signer and Safenet on both paths, one proof per batch', () => {
  async function deploy() {
    const w = await deployWorld()
    const protections = (actor: string) => [
      allow(scope(actor)),
      attach(scope(actor), addr(w.cosignerPolicy), cosignerSettings(w.cosigner.address)),
      attach(scope(actor), addr(w.safenet), '0x'),
    ]
    await install(w, [...protections(OWNERS), ...protections(w.agent.address)], [], {
      modules: [w.agent.address],
    })
    return w
  }

  /** Three vendor payments in one MultiSendCallOnly batch. */
  async function batch(w: World): Promise<MetaTx> {
    return multiSendTx(await w.infra.multiSendCallOnly.getAddress(), [
      tokenTransfer(w, w.vendorA.address, usdc(1)),
      tokenTransfer(w, w.vendorB.address, usdc(2)),
      tokenTransfer(w, w.vendorA.address, usdc(3)),
    ])
  }

  /** The owner-path context: one co-signature and one attestation over `hash`. */
  async function ownerProofs(w: World, hash: string) {
    return policyContextTail([
      { policy: addr(w.cosignerPolicy), data: coSignatures([[w.cosigner.address, cosign(w, hash)]]) },
      { policy: addr(w.safenet), data: await attest(w, hash) },
    ])
  }

  describe('owner path (proofs in the policy context)', () => {
    it('one co-signature and one attestation over the Safe tx hash cover a 3-call batch', async () => {
      const w = await loadFixture(deploy)
      const tx = await batch(w)
      const hash = await safeTxHash(w.safe, tx)
      await execOwners(w, tx, w.quorum2, await ownerProofs(w, hash))
      expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(4))
      expect(await w.token.balanceOf(w.vendorB.address)).to.equal(usdc(2))
    })

    it('deny: no context (MissingCoSignature), no attestation (MissingAttestation), proofs of another tx', async () => {
      const w = await loadFixture(deploy)
      const tx = await batch(w)
      const hash = await safeTxHash(w.safe, tx)
      await expectPolicyDenied(
        execOwners(w, tx),
        w.engine,
        w.cosignerPolicy,
        'MissingCoSignature',
        [w.cosigner.address],
        TX_INDEX,
      )
      const cosignOnly = policyContextTail([
        { policy: addr(w.cosignerPolicy), data: coSignatures([[w.cosigner.address, cosign(w, hash)]]) },
      ])
      await expectPolicyDenied(
        execOwners(w, tx, w.quorum2, cosignOnly),
        w.engine,
        w.safenet,
        'MissingAttestation',
      )

      // Proofs of this batch do not carry over to the next nonce.
      await execOwners(w, tx, w.quorum2, await ownerProofs(w, hash))
      await expectPolicyDenied(
        execOwners(w, tx, w.quorum2, await ownerProofs(w, hash)),
        w.engine,
        w.cosignerPolicy,
        'InvalidCoSignature',
        [w.cosigner.address],
      )
    })
  })

  describe('module path (proofs pushed, then consumed)', () => {
    async function pushProofs(w: World, tx: MetaTx) {
      const callHash = await moduleCallHash(w, w.agent.address, tx)
      const cosignDigest = await w.cosignerPolicy.moduleTxDigest(
        w.engineAddress,
        w.safeAddress,
        callHash,
        PROOF_DEADLINE,
      )
      await w.cosignerPolicy
        .connect(w.outsider)
        .cosign(
          w.engineAddress,
          w.safeAddress,
          callHash,
          w.cosigner.address,
          PROOF_DEADLINE,
          cosign(w, cosignDigest),
        )
      const safenetDigest = await w.safenet.moduleTxDigest(
        w.engineAddress,
        w.safeAddress,
        callHash,
        PROOF_DEADLINE,
      )
      const pushed = await w.safenet
        .connect(w.outsider)
        .submitAttestation(
          w.engineAddress,
          w.safeAddress,
          callHash,
          PROOF_DEADLINE,
          await attest(w, safenetDigest),
        )
      await expectEvent(pushed, w.safenet, 'Attested', [w.engineAddress, w.safeAddress, callHash])
      return callHash
    }

    it('one pushed co-signature and one attestation cover the agent’s 3-call batch, once', async () => {
      const w = await loadFixture(deploy)
      const tx = await batch(w)
      const callHash = await pushProofs(w, tx)
      await execModule(w, w.agent, tx)
      expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(4))
      expect(
        await w.cosignerPolicy.isCosigned(w.engineAddress, w.safeAddress, callHash, w.cosigner.address),
      ).to.equal(false)
      expect(await w.safenet.isAttested(w.engineAddress, w.safeAddress, callHash)).to.equal(false)
      // The same call again needs fresh proofs.
      await expectPolicyDenied(execModule(w, w.agent, tx), w.engine, w.cosignerPolicy, 'MissingCoSignature')
      await pushProofs(w, tx)
      await execModule(w, w.agent, tx)
      expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(8))
    })

    it('deny: proofs pushed with a deadline cannot be consumed after it (review L-1 / F4)', async () => {
      const w = await loadFixture(deploy)
      const tx = tokenTransfer(w, w.vendorA.address, usdc(1))
      const callHash = await moduleCallHash(w, w.agent.address, tx)
      const deadline = BigInt(await time.latest()) + HOUR
      const cosignDigest = await w.cosignerPolicy.moduleTxDigest(
        w.engineAddress,
        w.safeAddress,
        callHash,
        deadline,
      )
      await w.cosignerPolicy.cosign(
        w.engineAddress,
        w.safeAddress,
        callHash,
        w.cosigner.address,
        deadline,
        cosign(w, cosignDigest),
      )
      const safenetDigest = await w.safenet.moduleTxDigest(w.engineAddress, w.safeAddress, callHash, deadline)
      await w.safenet.submitAttestation(
        w.engineAddress,
        w.safeAddress,
        callHash,
        deadline,
        await attest(w, safenetDigest),
      )

      await time.increaseTo(deadline + 1n)
      await expectPolicyDenied(execModule(w, w.agent, tx), w.engine, w.cosignerPolicy, 'CoSignatureExpired', [
        w.cosigner.address,
        deadline,
      ])
      // A fresh co-signature: the Safenet credit has expired too.
      const fresh = BigInt(await time.latest()) + HOUR
      await w.cosignerPolicy.cosign(
        w.engineAddress,
        w.safeAddress,
        callHash,
        w.cosigner.address,
        fresh,
        cosign(w, await w.cosignerPolicy.moduleTxDigest(w.engineAddress, w.safeAddress, callHash, fresh)),
      )
      await expectPolicyDenied(execModule(w, w.agent, tx), w.engine, w.safenet, 'AttestationExpired', [
        deadline,
      ])
    })

    it('deny: nothing pushed (MissingCoSignature); co-signed only (MissingAttestation)', async () => {
      const w = await loadFixture(deploy)
      const tx = tokenTransfer(w, w.vendorA.address, usdc(1))
      await expectPolicyDenied(execModule(w, w.agent, tx), w.engine, w.cosignerPolicy, 'MissingCoSignature')
      const callHash = await moduleCallHash(w, w.agent.address, tx)
      const digest = await w.cosignerPolicy.moduleTxDigest(
        w.engineAddress,
        w.safeAddress,
        callHash,
        PROOF_DEADLINE,
      )
      await w.cosignerPolicy.cosign(
        w.engineAddress,
        w.safeAddress,
        callHash,
        w.cosigner.address,
        PROOF_DEADLINE,
        cosign(w, digest),
      )
      await expectPolicyDenied(execModule(w, w.agent, tx), w.engine, w.safenet, 'MissingAttestation')
    })
  })
})
