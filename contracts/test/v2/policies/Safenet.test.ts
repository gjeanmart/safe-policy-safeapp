import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  AbiCoder,
  SigningKey,
  TypedDataEncoder,
  Wallet,
  ZeroAddress,
  concat,
  hexlify,
  id,
  keccak256,
  randomBytes,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type { CoSignerEngineStub, SafenetFrostChallenge, SafenetPolicy } from '../../../typechain-types'
import { expectEvent, expectRevert } from '../helpers'

/**
 * WP D: SafenetPolicy (SPEC.md §5.5), ported from rev 2. Attestations are submitted on-chain on both
 * paths (deadline 0: owner path, over the Safe transaction hash; otherwise module path, over
 * `attestationDigest`) and one credit is consumed per transaction. Attestations are real
 * single-signer FROST (Schnorr) signatures, built as in V1's `test/utils/frost.ts`.
 */

const coder = AbiCoder.defaultAbiCoder()
const OWNERS = '0x0000000000000000000000000000000000000001'
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const CONSENSUS_CHAIN_ID = 100n
const CONSENSUS_ADDRESS = '0x1111111111111111111111111111111111111111'
const GENESIS_EPOCH = 7n
const DEADLINE = 2n ** 40n
const GROUP_SECRET = 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afen
const TRANSACTION_PROPOSAL_TYPEHASH = id(
  'TransactionProposal(uint64 epoch,address oracle,bytes oracleData,bytes32 safeTxHash)',
)
const EPOCH_ROLLOVER_TYPEHASH = id(
  'EpochRollover(uint64 activeEpoch,uint64 proposedEpoch,uint64 rolloverBlock,uint256 groupKeyX,uint256 groupKeyY)',
)
const ATT_A = id('attachment A')
const ATT_B = id('attachment B')
const randomHash = () => hexlify(randomBytes(32))
const randomAddress = () => Wallet.createRandom().address
const match = (attachmentId: string, callIndex = 0, level = 0) => ({ callIndex, level, attachmentId })

type Point = { x: bigint; y: bigint }

function pointFromScalar(scalar: bigint): Point {
  const uncompressed = SigningKey.computePublicKey(zeroPadValue(toBeHex(scalar), 32), false)
  return { x: BigInt(`0x${uncompressed.slice(4, 68)}`), y: BigInt(`0x${uncompressed.slice(68, 132)}`) }
}

const domainSeparator = keccak256(
  coder.encode(
    ['bytes32', 'uint256', 'address'],
    [id('EIP712Domain(uint256 chainId,address verifyingContract)'), CONSENSUS_CHAIN_ID, CONSENSUS_ADDRESS],
  ),
)
const eip712 = (structHash: string) => keccak256(concat(['0x1901', domainSeparator, structHash]))
const proposalMessage = (epoch: bigint, oracle: string, oracleDataHash: string, safeTxHash: string) =>
  eip712(
    keccak256(
      coder.encode(
        ['bytes32', 'uint64', 'address', 'bytes32', 'bytes32'],
        [TRANSACTION_PROPOSAL_TYPEHASH, epoch, oracle, oracleDataHash, safeTxHash],
      ),
    ),
  )

async function fixture() {
  const Stub = await ethers.getContractFactory('CoSignerEngineStub')
  const engine = (await Stub.deploy()) as unknown as CoSignerEngineStub
  const otherEngine = (await Stub.deploy()) as unknown as CoSignerEngineStub
  const frost = (await (
    await ethers.getContractFactory('SafenetFrostChallenge')
  ).deploy()) as unknown as SafenetFrostChallenge
  const groupKey = pointFromScalar(GROUP_SECRET)
  const policy = (await (
    await ethers.getContractFactory('SafenetPolicy')
  ).deploy(CONSENSUS_CHAIN_ID, CONSENSUS_ADDRESS, GENESIS_EPOCH, groupKey)) as unknown as SafenetPolicy
  const p = await policy.getAddress()
  const e = await engine.getAddress()
  const safe = randomAddress()
  const module = randomAddress()
  await engine.configure(p, safe, ATT_A, '0x')
  await engine.configure(p, safe, ATT_B, '0x')

  /** A FROST signature over `message` by the group of `secret` (one participant = Schnorr). */
  const signFrost = async (secret: bigint, message: string, nonce = BigInt(randomHash()) % N) => {
    const r = pointFromScalar(nonce)
    const c = await frost.challenge(r, pointFromScalar(secret), message)
    return { groupKey: pointFromScalar(secret), signature: { r, z: (nonce + c * secret) % N } }
  }
  /** V1's 256-byte attestation over `safeTxHash`. */
  const attest = async (safeTxHash: string, { secret = GROUP_SECRET, epoch = GENESIS_EPOCH } = {}) => {
    const oracle = randomAddress()
    const oracleDataHash = id('oracle-data')
    const { groupKey: key, signature } = await signFrost(
      secret,
      proposalMessage(epoch, oracle, oracleDataHash, safeTxHash),
    )
    const encoded = coder.encode(
      [
        'uint64',
        'address',
        'bytes32',
        'tuple(uint256 x, uint256 y)',
        'tuple(tuple(uint256 x, uint256 y) r, uint256 z)',
      ],
      [epoch, oracle, oracleDataHash, key, signature],
    )
    return { encoded, signature }
  }
  const digest = (txHash: string, deadline: bigint, eng = e) =>
    policy.attestationDigest(eng, safe, txHash, deadline)
  const check = (txHash: string, actor = OWNERS, matches = [match(ATT_A)], eng = engine, s = safe) =>
    eng.check(p, { safe: s, actor, txHash }, matches)

  return { policy, engine, otherEngine, groupKey, e, safe, module, signFrost, attest, digest, check }
}

describe('SafenetPolicy (rev 3)', () => {
  describe('deployment and settings', () => {
    it('derives the Consensus domain, seeds the genesis epoch only, reports IPolicy', async () => {
      const { policy, groupKey } = await loadFixture(fixture)
      expect(await policy.getConsensusDomainSeparator()).to.equal(domainSeparator)
      expect(await policy.isKnownEpoch(groupKey, GENESIS_EPOCH)).to.equal(true)
      expect(await policy.isKnownEpoch(groupKey, GENESIS_EPOCH + 1n)).to.equal(false)
      expect(await policy.supportsInterface('0x01ffc9a7')).to.equal(true)
    })

    it('rejects a zero Consensus address (InvalidAddress) and an off-curve genesis key', async () => {
      const factory = await ethers.getContractFactory('SafenetPolicy')
      await expectRevert(
        factory.deploy(CONSENSUS_CHAIN_ID, ZeroAddress, GENESIS_EPOCH, pointFromScalar(GROUP_SECRET)),
        factory,
        'InvalidAddress',
      )
      await expectRevert(
        factory.deploy(CONSENSUS_CHAIN_ID, CONSENSUS_ADDRESS, GENESIS_EPOCH, { x: 0n, y: 0n }),
        factory,
        'NotOnCurve',
      )
    })

    it('takes no settings: non-empty data is InvalidSettings', async () => {
      const { policy, engine, safe } = await loadFixture(fixture)
      await expectRevert(engine.configure(policy, safe, ATT_A, '0x00'), policy, 'InvalidSettings')
    })
  })

  describe('owner path (deadline 0, over the Safe transaction hash)', () => {
    it('a submitted attestation passes once and is consumed', async () => {
      const { policy, e, safe, attest, check } = await loadFixture(fixture)
      const txHash = randomHash()
      await expectRevert(check(txHash), policy, 'MissingAttestation')
      const { encoded, signature } = await attest(txHash)
      const tx = await policy.submitAttestation(e, safe, txHash, 0, encoded)
      await expectEvent(tx, policy, 'Attested', [e, safe, txHash, 0])
      expect(await policy.isAttested(e, safe, txHash)).to.equal(true)
      expect(await policy.isAttestationSpent(e, safe, signature)).to.equal(true)

      // No expiry on the owner path.
      await time.increase(365 * 24 * 3600)
      await check(txHash)
      expect(await policy.isAttested(e, safe, txHash)).to.equal(false)
      await expectRevert(check(txHash), policy, 'MissingAttestation')
      await expectRevert(
        policy.submitAttestation(e, safe, txHash, 0, encoded),
        policy,
        'AttestationAlreadySpent',
      )
    })

    it('a front-run under a wrong engine or Safe does not burn the attestation: spent is keyed by (engine, safe)', async () => {
      const { policy, otherEngine, e, safe, attest, check } = await loadFixture(fixture)
      const txHash = randomHash()
      const { encoded, signature } = await attest(txHash)
      // The owner-path message is the Safe transaction hash alone: engine and Safe come from the caller.
      const wrongEngine = await otherEngine.getAddress()
      const wrongSafe = randomAddress()
      await policy.submitAttestation(wrongEngine, safe, txHash, 0, encoded)
      await policy.submitAttestation(e, wrongSafe, txHash, 0, encoded)
      expect(await policy.isAttestationSpent(wrongEngine, safe, signature)).to.equal(true)
      expect(await policy.isAttestationSpent(e, safe, signature)).to.equal(false)
      // The real submission still works and the real transaction passes once.
      await policy.submitAttestation(e, safe, txHash, 0, encoded)
      await check(txHash)
      await expectRevert(check(txHash), policy, 'MissingAttestation')
      await expectRevert(
        policy.submitAttestation(e, safe, txHash, 0, encoded),
        policy,
        'AttestationAlreadySpent',
      )
    })

    it('one attestation covers a batch and every matched attachment', async () => {
      const { policy, e, safe, attest, check } = await loadFixture(fixture)
      const txHash = randomHash()
      await policy.submitAttestation(e, safe, txHash, 0, (await attest(txHash)).encoded)
      await check(txHash, OWNERS, [match(ATT_A, 0, 0), match(ATT_B, 0, 3), match(ATT_A, 1, 0)])
      await expectRevert(check(txHash), policy, 'MissingAttestation')
    })

    it('rejects an attestation of another transaction, and the module digest submitted as deadline 0', async () => {
      const { policy, e, safe, attest, digest } = await loadFixture(fixture)
      const txHash = randomHash()
      await expectRevert(
        policy.submitAttestation(e, safe, txHash, 0, (await attest(randomHash())).encoded),
        policy,
        'InvalidMulMulAddWitness',
      )
      const moduleAttestation = await attest(await digest(txHash, DEADLINE))
      await expectRevert(
        policy.submitAttestation(e, safe, txHash, 0, moduleAttestation.encoded),
        policy,
        'InvalidMulMulAddWitness',
      )
    })

    it('rejects a wrong length or dirty epoch / oracle words (MalformedAttestation)', async () => {
      const { policy, e, safe, attest } = await loadFixture(fixture)
      const txHash = randomHash()
      const { encoded } = await attest(txHash)
      const dirtyEpoch = '0x' + '01' + encoded.slice(4)
      const dirtyOracle = encoded.slice(0, 66) + '01' + encoded.slice(68)
      for (const data of ['0x', hexlify(randomBytes(128)), encoded + '00', dirtyEpoch, dirtyOracle]) {
        await expectRevert(policy.submitAttestation(e, safe, txHash, 0, data), policy, 'MalformedAttestation')
      }
    })

    it('rejects an untrusted group key or epoch (UntrustedAttestationKey)', async () => {
      const { policy, e, safe, attest } = await loadFixture(fixture)
      const txHash = randomHash()
      for (const opts of [{ secret: GROUP_SECRET + 1n }, { epoch: GENESIS_EPOCH + 1n }]) {
        await expectRevert(
          policy.submitAttestation(e, safe, txHash, 0, (await attest(txHash, opts)).encoded),
          policy,
          'UntrustedAttestationKey',
        )
      }
    })
  })

  describe('module path (deadline > 0, over attestationDigest)', () => {
    const callHash = (safe: string, module: string) =>
      keccak256(
        coder.encode(
          ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
          [safe, module, CONSENSUS_ADDRESS, 5n, '0x', 0],
        ),
      )

    it('attestationDigest is the EIP-712 ModuleTransaction under the policy domain', async () => {
      const { policy, e, safe, module, digest } = await loadFixture(fixture)
      const { chainId } = await ethers.provider.getNetwork()
      const h = callHash(safe, module)
      expect(await digest(h, DEADLINE)).to.equal(
        TypedDataEncoder.hash(
          { name: 'SafenetPolicy', version: '1', chainId, verifyingContract: await policy.getAddress() },
          {
            ModuleTransaction: [
              { name: 'engine', type: 'address' },
              { name: 'safe', type: 'address' },
              { name: 'callHash', type: 'bytes32' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          { engine: e, safe, callHash: h, deadline: DEADLINE },
        ),
      )
    })

    it('credits one execution per attestation; the same call needs a fresh one each time', async () => {
      const { policy, e, safe, module, attest, digest, check } = await loadFixture(fixture)
      const h = callHash(safe, module)
      const d = await digest(h, DEADLINE)
      const { encoded } = await attest(d)
      const tx = await policy.submitAttestation(e, safe, h, DEADLINE, encoded)
      await expectEvent(tx, policy, 'Attested', [e, safe, h, DEADLINE])
      await check(h, module)
      await expectRevert(check(h, module), policy, 'MissingAttestation')
      await expectRevert(
        policy.submitAttestation(e, safe, h, DEADLINE, encoded),
        policy,
        'AttestationAlreadySpent',
      )

      await policy.submitAttestation(e, safe, h, DEADLINE, (await attest(d)).encoded)
      await policy.submitAttestation(e, safe, h, DEADLINE, (await attest(d)).encoded)
      await check(h, module)
      await check(h, module)
      await expectRevert(check(h, module), policy, 'MissingAttestation')
    })

    it('an attestation over the raw call hash does not verify on the module path', async () => {
      const { policy, e, safe, module, attest } = await loadFixture(fixture)
      const h = callHash(safe, module)
      await expectRevert(
        policy.submitAttestation(e, safe, h, DEADLINE, (await attest(h)).encoded),
        policy,
        'InvalidMulMulAddWitness',
      )
    })

    it('expiry: AttestationExpired on submit and on consume; a fresh attestation replaces the expired credit', async () => {
      const { policy, e, safe, module, attest, digest, check } = await loadFixture(fixture)
      const h = callHash(safe, module)
      const deadline = BigInt(await time.latest()) + 3600n
      const { encoded } = await attest(await digest(h, deadline))
      // The deadline is signed: another deadline does not verify.
      await expectRevert(
        policy.submitAttestation(e, safe, h, deadline + 1n, encoded),
        policy,
        'InvalidMulMulAddWitness',
      )
      await policy.submitAttestation(e, safe, h, deadline, encoded)

      await time.increaseTo(deadline + 1n)
      expect(await policy.isAttested(e, safe, h)).to.equal(false)
      await expectRevert(check(h, module), policy, 'AttestationExpired', [deadline])
      const late = await attest(await digest(h, deadline))
      await expectRevert(
        policy.submitAttestation(e, safe, h, deadline, late.encoded),
        policy,
        'AttestationExpired',
        [deadline],
      )

      const fresh = BigInt(await time.latest()) + 3600n
      await policy.submitAttestation(e, safe, h, fresh, (await attest(await digest(h, fresh))).encoded)
      await check(h, module)
      await expectRevert(check(h, module), policy, 'MissingAttestation')
    })

    it('several credits of one call share the earliest deadline', async () => {
      const { policy, e, safe, module, attest, digest, check } = await loadFixture(fixture)
      const h = callHash(safe, module)
      const now = BigInt(await time.latest())
      for (const deadline of [now + 7200n, now + 600n]) {
        await policy.submitAttestation(
          e,
          safe,
          h,
          deadline,
          (await attest(await digest(h, deadline))).encoded,
        )
      }
      await check(h, module)
      await time.increaseTo(now + 601n)
      await expectRevert(check(h, module), policy, 'AttestationExpired', [now + 600n])
    })

    it('a credit is bound to its engine and Safe', async () => {
      const { policy, otherEngine, e, safe, module, attest, digest, check } = await loadFixture(fixture)
      const h = callHash(safe, module)
      await policy.submitAttestation(e, safe, h, DEADLINE, (await attest(await digest(h, DEADLINE))).encoded)
      await otherEngine.configure(policy, safe, ATT_A, '0x')
      await expectRevert(check(h, module, [match(ATT_A)], otherEngine), policy, 'MissingAttestation')
      await expectRevert(
        check(h, module, [match(ATT_A)], undefined, randomAddress()),
        policy,
        'MissingAttestation',
      )
      await check(h, module)
    })
  })

  describe('epoch rollover (as V1)', () => {
    it('records an epoch signed by the trusted group; its attestations then pass', async () => {
      const { policy, groupKey, e, safe, signFrost, attest, check } = await loadFixture(fixture)
      const newSecret = GROUP_SECRET + 42n
      const newKey = pointFromScalar(newSecret)
      const proposed = GENESIS_EPOCH + 1n
      const message = eip712(
        keccak256(
          coder.encode(
            ['bytes32', 'uint64', 'uint64', 'uint64', 'uint256', 'uint256'],
            [EPOCH_ROLLOVER_TYPEHASH, GENESIS_EPOCH, proposed, 1234n, newKey.x, newKey.y],
          ),
        ),
      )
      const { signature } = await signFrost(GROUP_SECRET, message)
      await policy.updateEpoch(groupKey, GENESIS_EPOCH, proposed, 1234n, newKey, signature)
      expect(await policy.isKnownEpoch(newKey, proposed)).to.equal(true)

      const txHash = randomHash()
      await policy.submitAttestation(
        e,
        safe,
        txHash,
        0,
        (await attest(txHash, { secret: newSecret, epoch: proposed })).encoded,
      )
      await check(txHash)
    })

    it('rejects a rollover from an unknown parent', async () => {
      const { policy, signFrost } = await loadFixture(fixture)
      const rogue = pointFromScalar(GROUP_SECRET + 1n)
      const { signature } = await signFrost(GROUP_SECRET + 1n, randomHash())
      await expectRevert(
        policy.updateEpoch(rogue, GENESIS_EPOCH, GENESIS_EPOCH + 1n, 0n, pointFromScalar(5n), signature),
        policy,
        'UnknownParent',
      )
    })
  })

  it('check with no match reverts NoMatches', async () => {
    const { policy, check } = await loadFixture(fixture)
    await expectRevert(check(randomHash(), OWNERS, []), policy, 'NoMatches')
  })
})
