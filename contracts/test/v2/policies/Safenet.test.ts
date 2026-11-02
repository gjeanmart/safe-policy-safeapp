import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  AbiCoder,
  SigningKey,
  TypedDataEncoder,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  hexlify,
  id,
  keccak256,
  randomBytes,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type { FrostChallenge, ProofEngineStub, SafenetPolicyV2 } from '../../../typechain-types'
import { expectAnyRevert, expectEvent, expectRevert } from '../helpers'

/**
 * WP5 SafenetPolicyV2 (SPEC.md §8.7), driven by ProofEngineStub acting as the engine. Attestations
 * are real single-signer FROST (Schnorr) signatures, built as in V1's `test/utils/frost.ts`.
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const PASS = '0xe18ffdca'
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const CONSENSUS_CHAIN_ID = 100n
const CONSENSUS_ADDRESS = '0x1111111111111111111111111111111111111111'
const GENESIS_EPOCH = 7n
/** Module-path attestation deadline far in the future (the expiry tests use their own). */
const DEADLINE = 2n ** 40n
const GROUP_SECRET = 0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe5afen
const TRANSACTION_PROPOSAL_TYPEHASH = id(
  'TransactionProposal(uint64 epoch,address oracle,bytes oracleData,bytes32 safeTxHash)',
)
const EPOCH_ROLLOVER_TYPEHASH = id(
  'EpochRollover(uint64 activeEpoch,uint64 proposedEpoch,uint64 rolloverBlock,uint256 groupKeyX,uint256 groupKeyY)',
)
const randomHash = () => hexlify(randomBytes(32))
const randomAddress = () => Wallet.createRandom().address

type Point = { x: bigint; y: bigint }
type ScopeData = { actor: string; to: string; selector: string; callMatch: number }
const globalScope: ScopeData = { actor: ANY, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }
const ownersScope: ScopeData = { actor: OWNERS, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }

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

describe('SafenetPolicyV2', function () {
  async function fixture() {
    const engine = (await (
      await ethers.getContractFactory('ProofEngineStub')
    ).deploy()) as unknown as ProofEngineStub
    const otherEngine = (await (
      await ethers.getContractFactory('ProofEngineStub')
    ).deploy()) as unknown as ProofEngineStub
    const frost = (await (
      await ethers.getContractFactory('FrostChallenge')
    ).deploy()) as unknown as FrostChallenge
    const groupKey = pointFromScalar(GROUP_SECRET)
    const policy = (await (
      await ethers.getContractFactory('SafenetPolicyV2')
    ).deploy(CONSENSUS_CHAIN_ID, CONSENSUS_ADDRESS, GENESIS_EPOCH, groupKey)) as unknown as SafenetPolicyV2
    const safe = randomAddress()
    const module = randomAddress()
    const [globalId] = await engine.configure.staticCall(policy, safe, globalScope, 1, '0x')
    await engine.configure(policy, safe, globalScope, 1, '0x')
    return { engine, otherEngine, frost, policy, groupKey, safe, module, globalId }
  }

  /** A FROST signature over `message` by the group of `secret` (one participant = Schnorr). */
  async function signFrost(
    frost: FrostChallenge,
    secret: bigint,
    message: string,
    nonce = BigInt(randomHash()) % N,
  ) {
    const groupKey = pointFromScalar(secret)
    const r = pointFromScalar(nonce)
    const c = await frost.challenge(r, groupKey, message)
    return { groupKey, signature: { r, z: (nonce + c * secret) % N } }
  }

  /** V1's 256-byte attestation over `safeTxHash`. */
  async function attest(
    frost: FrostChallenge,
    safeTxHash: string,
    { secret = GROUP_SECRET, epoch = GENESIS_EPOCH }: { secret?: bigint; epoch?: bigint } = {},
  ) {
    const oracle = randomAddress()
    const oracleDataHash = id('oracle-data')
    const { groupKey, signature } = await signFrost(
      frost,
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
      [epoch, oracle, oracleDataHash, groupKey, signature],
    )
    return { encoded, signature }
  }

  const ownerCtx = (safe: string, txHash: string) => ({
    safe,
    actor: OWNERS,
    txHash,
    nonce: 3n,
    executor: randomAddress(),
  })
  const call = (value = 1n) => ({ to: randomAddress(), value, data: '0x', operation: 0 })

  describe('deployment and settings', function () {
    it('derives the Consensus domain and seeds the genesis epoch only', async function () {
      const { policy, groupKey } = await loadFixture(fixture)
      expect(await policy.getConsensusDomainSeparator()).to.equal(domainSeparator)
      expect(await policy.isKnownEpoch(groupKey, GENESIS_EPOCH)).to.equal(true)
      expect(await policy.isKnownEpoch(groupKey, GENESIS_EPOCH + 1n)).to.equal(false)
      expect(await policy.policyLevel()).to.equal(1n)
      expect(await policy.supportsInterface('0x55872811')).to.equal(true)
    })

    it('rejects a zero Consensus address and an off-curve genesis key', async function () {
      const factory = await ethers.getContractFactory('SafenetPolicyV2')
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

    it('takes no settings: non-empty data is InvalidSettings', async function () {
      const { engine, policy, safe } = await loadFixture(fixture)
      const [, delayFloor] = await engine.configure.staticCall(policy, safe, ownersScope, 3, '0x')
      expect(delayFloor).to.equal(0n)
      await expectRevert(engine.configure(policy, safe, ownersScope, 1, '0x00'), policy, 'InvalidSettings')
    })

    it('rejects a call-level check', async function () {
      const { engine, policy, safe, globalId } = await loadFixture(fixture)
      await expectRevert(
        engine.checkCall(policy, ownerCtx(safe, randomHash()), call(), [globalId]),
        policy,
        'WrongPolicyLevel',
      )
    })
  })

  describe('owner path', function () {
    it('passes with an attestation over the Safe transaction hash', async function () {
      const { engine, frost, policy, safe, globalId } = await loadFixture(fixture)
      const txHash = randomHash()
      const { encoded } = await attest(frost, txHash)
      expect(
        await engine.checkTransaction.staticCall(policy, ownerCtx(safe, txHash), [call()], '0x', encoded, [
          globalId,
        ]),
      ).to.equal(PASS)
    })

    it('one attestation covers a batch and every matched attachment', async function () {
      const { engine, frost, policy, safe, globalId } = await loadFixture(fixture)
      const [ownersId] = await engine.configure.staticCall(policy, safe, ownersScope, 1, '0x')
      await engine.configure(policy, safe, ownersScope, 1, '0x')
      const txHash = randomHash()
      const { encoded } = await attest(frost, txHash)
      const calls = [call(1n), call(2n), call(1n)]
      expect(
        await engine.checkTransaction.staticCall(policy, ownerCtx(safe, txHash), calls, '0x', encoded, [
          globalId,
          ownersId,
        ]),
      ).to.equal(PASS)
    })

    it('denies without an attestation: MissingAttestation (what preview reports)', async function () {
      const { engine, policy, safe, globalId } = await loadFixture(fixture)
      await expectRevert(
        engine.checkTransaction(policy, ownerCtx(safe, randomHash()), [call()], '0x', '0x', [globalId]),
        policy,
        'MissingAttestation',
      )
    })

    it('denies a wrong length or dirty epoch / oracle words: MalformedAttestation', async function () {
      const { engine, frost, policy, safe, globalId } = await loadFixture(fixture)
      const txHash = randomHash()
      const { encoded } = await attest(frost, txHash)
      const dirtyEpoch = '0x' + '01' + encoded.slice(4)
      const dirtyOracle = encoded.slice(0, 66) + '01' + encoded.slice(68)
      for (const data of [hexlify(randomBytes(128)), encoded + '00', dirtyEpoch, dirtyOracle]) {
        await expectRevert(
          engine.checkTransaction(policy, ownerCtx(safe, txHash), [], '0x', data, [globalId]),
          policy,
          'MalformedAttestation',
        )
      }
    })

    it('denies an untrusted group key or epoch: UntrustedAttestationKey', async function () {
      const { engine, frost, policy, safe, globalId } = await loadFixture(fixture)
      const txHash = randomHash()
      for (const opts of [{ secret: GROUP_SECRET + 1n }, { epoch: GENESIS_EPOCH + 1n }]) {
        const { encoded } = await attest(frost, txHash, opts)
        await expectRevert(
          engine.checkTransaction(policy, ownerCtx(safe, txHash), [], '0x', encoded, [globalId]),
          policy,
          'UntrustedAttestationKey',
        )
      }
    })

    it('denies an attestation of another transaction (the FROST check fails)', async function () {
      const { engine, frost, policy, safe, globalId } = await loadFixture(fixture)
      const { encoded } = await attest(frost, randomHash())
      await expectRevert(
        engine.checkTransaction(policy, ownerCtx(safe, randomHash()), [], '0x', encoded, [globalId]),
        policy,
        'InvalidMulMulAddWitness',
      )
    })
  })

  describe('module path', function () {
    async function moduleSetup() {
      const f = await loadFixture(fixture)
      const top = call(5n)
      const callHash = await f.engine.moduleCallHash(
        f.safe,
        f.module,
        top.to,
        top.value,
        top.data,
        top.operation,
      )
      const digest = await f.policy.moduleTxDigest(f.engine, f.safe, callHash, DEADLINE)
      return { ...f, top, callHash, digest }
    }

    it('stands an EIP-712 ModuleTransaction under the policy domain in for the Safe tx hash', async function () {
      const { engine, policy, safe, callHash, digest } = await moduleSetup()
      const { chainId } = await ethers.provider.getNetwork()
      const expected = TypedDataEncoder.hash(
        { name: 'SafenetPolicyV2', version: '1', chainId, verifyingContract: await policy.getAddress() },
        {
          ModuleTransaction: [
            { name: 'engine', type: 'address' },
            { name: 'safe', type: 'address' },
            { name: 'callHash', type: 'bytes32' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        { engine: await engine.getAddress(), safe, callHash, deadline: DEADLINE },
      )
      expect(digest).to.equal(expected)
    })

    it('an attestation cannot be submitted or consumed after its deadline (review L-1 / F4)', async function () {
      const { engine, frost, policy, safe, module, top, globalId, callHash } = await moduleSetup()
      const deadline = BigInt(await time.latest()) + 3600n
      const { encoded } = await attest(frost, await policy.moduleTxDigest(engine, safe, callHash, deadline))
      // The deadline is signed: submitting the attestation under another deadline does not verify.
      await expectAnyRevert(policy.submitAttestation(engine, safe, callHash, deadline + 1n, encoded))
      await policy.submitAttestation(engine, safe, callHash, deadline, encoded)
      expect(await policy.isAttested(engine, safe, callHash)).to.equal(true)

      await time.increaseTo(deadline + 1n)
      expect(await policy.isAttested(engine, safe, callHash)).to.equal(false)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId]),
        policy,
        'AttestationExpired',
        [deadline],
      )
      const late = await attest(frost, await policy.moduleTxDigest(engine, safe, callHash, deadline))
      await expectRevert(
        policy.submitAttestation(engine, safe, callHash, deadline, late.encoded),
        policy,
        'AttestationExpired',
        [deadline],
      )

      // A fresh attestation replaces the expired credit (one execution, not two).
      const fresh = BigInt(await time.latest()) + 3600n
      const next = await attest(frost, await policy.moduleTxDigest(engine, safe, callHash, fresh))
      await policy.submitAttestation(engine, safe, callHash, fresh, next.encoded)
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId])
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId]),
        policy,
        'MissingAttestation',
      )
    })

    it('several credits of one call share the earliest deadline', async function () {
      const { engine, frost, policy, safe, module, top, globalId, callHash } = await moduleSetup()
      const now = BigInt(await time.latest())
      for (const deadline of [now + 7200n, now + 600n]) {
        const { encoded } = await attest(frost, await policy.moduleTxDigest(engine, safe, callHash, deadline))
        await policy.submitAttestation(engine, safe, callHash, deadline, encoded)
      }
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId])
      await time.increaseTo(now + 601n)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId]),
        policy,
        'AttestationExpired',
        [now + 600n],
      )
    })

    it('a submitted attestation passes once and is consumed', async function () {
      const { engine, frost, policy, safe, module, top, globalId, callHash, digest } = await moduleSetup()
      const { encoded, signature } = await attest(frost, digest)
      const tx = await policy.submitAttestation(engine, safe, callHash, DEADLINE, encoded)
      await expectEvent(tx, policy, 'Attested', [await engine.getAddress(), safe, callHash])
      expect(await policy.isAttested(engine, safe, callHash)).to.equal(true)
      expect(await policy.isAttestationSpent(signature)).to.equal(true)

      await engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId])
      expect(await policy.isAttested(engine, safe, callHash)).to.equal(false)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId]),
        policy,
        'MissingAttestation',
      )
    })

    it('a submitted attestation can never be submitted again; a fresh one credits another run', async function () {
      const { engine, frost, policy, safe, module, top, globalId, callHash, digest } = await moduleSetup()
      const { encoded } = await attest(frost, digest)
      await policy.submitAttestation(engine, safe, callHash, DEADLINE, encoded)
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId])
      await expectRevert(
        policy.submitAttestation(engine, safe, callHash, DEADLINE, encoded),
        policy,
        'AttestationAlreadySpent',
      )

      // Two fresh attestations credit two executions of the same call.
      await policy.submitAttestation(engine, safe, callHash, DEADLINE, (await attest(frost, digest)).encoded)
      await policy.submitAttestation(engine, safe, callHash, DEADLINE, (await attest(frost, digest)).encoded)
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId])
      await engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId])
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, top, [top], [globalId]),
        policy,
        'MissingAttestation',
      )
    })

    it('several matched attachments consume one credit; one attestation covers a batch', async function () {
      const { engine, frost, policy, safe, module, globalId } = await moduleSetup()
      const [ownersId] = await engine.configure.staticCall(policy, safe, ownersScope, 1, '0x')
      await engine.configure(policy, safe, ownersScope, 1, '0x')
      const batchTop = { to: randomAddress(), value: 0n, data: '0x8d80ff0a' + '00'.repeat(64), operation: 1 }
      const callHash = await engine.moduleCallHash(safe, module, batchTop.to, 0n, batchTop.data, 1)
      const { encoded } = await attest(frost, await policy.moduleTxDigest(engine, safe, callHash, DEADLINE))
      await policy.submitAttestation(engine, safe, callHash, DEADLINE, encoded)
      await engine.checkModuleTransaction(
        policy,
        safe,
        module,
        batchTop,
        [call(1n), call(2n)],
        [globalId, ownersId],
      )
      expect(await policy.isAttested(engine, safe, callHash)).to.equal(false)
    })

    it('a failed execution rolls the consumption back', async function () {
      const { engine, frost, policy, safe, module, top, globalId, callHash, digest } = await moduleSetup()
      await policy.submitAttestation(engine, safe, callHash, DEADLINE, (await attest(frost, digest)).encoded)
      await expectRevert(
        engine.checkModuleTransactionThenFail(policy, safe, module, top, [top], [globalId]),
        engine,
        'ExecutionFailed',
      )
      expect(await policy.isAttested(engine, safe, callHash)).to.equal(true)
    })

    it('rejects attestations over the raw call hash, untrusted or malformed', async function () {
      const { engine, frost, policy, safe, callHash, digest } = await moduleSetup()
      await expectRevert(
        policy.submitAttestation(engine, safe, callHash, DEADLINE, (await attest(frost, callHash)).encoded),
        policy,
        'InvalidMulMulAddWitness',
      )
      await expectRevert(
        policy.submitAttestation(
          engine,
          safe,
          callHash,
          DEADLINE,
          (await attest(frost, digest, { secret: 3n })).encoded,
        ),
        policy,
        'UntrustedAttestationKey',
      )
      await expectRevert(
        policy.submitAttestation(engine, safe, callHash, DEADLINE, '0x'),
        policy,
        'MalformedAttestation',
      )
    })

    it('a credit is bound to its engine, Safe and call', async function () {
      const { engine, otherEngine, frost, policy, safe, module, top, globalId, callHash, digest } =
        await moduleSetup()
      await policy.submitAttestation(engine, safe, callHash, DEADLINE, (await attest(frost, digest)).encoded)
      const [otherId] = await otherEngine.configure.staticCall(policy, safe, globalScope, 1, '0x')
      await otherEngine.configure(policy, safe, globalScope, 1, '0x')
      await expectRevert(
        otherEngine.checkModuleTransaction(policy, safe, module, top, [top], [otherId]),
        policy,
        'MissingAttestation',
      )
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, randomAddress(), top, [top], [globalId]),
        policy,
        'MissingAttestation',
      )
      const other = call(6n)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, module, other, [other], [globalId]),
        policy,
        'MissingAttestation',
      )
    })

    it('ignores any owner-path context on the module path', async function () {
      const { engine, frost, policy, safe, module, globalId, callHash, digest } = await moduleSetup()
      const ctx = { safe, actor: module, txHash: callHash, nonce: 0n, executor: module }
      const { encoded } = await attest(frost, digest)
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', encoded, [globalId]),
        policy,
        'MissingAttestation',
      )
    })
  })

  describe('epoch rollover (as V1)', function () {
    it('records an epoch signed by the trusted group; its attestations then pass', async function () {
      const { engine, frost, policy, groupKey, safe, globalId } = await loadFixture(fixture)
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
      const { signature } = await signFrost(frost, GROUP_SECRET, message)
      await policy.updateEpoch(groupKey, GENESIS_EPOCH, proposed, 1234n, newKey, signature)
      expect(await policy.isKnownEpoch(newKey, proposed)).to.equal(true)

      const txHash = randomHash()
      const { encoded } = await attest(frost, txHash, { secret: newSecret, epoch: proposed })
      expect(
        await engine.checkTransaction.staticCall(policy, ownerCtx(safe, txHash), [], '0x', encoded, [
          globalId,
        ]),
      ).to.equal(PASS)
    })

    it('rejects a rollover from an unknown parent', async function () {
      const { frost, policy } = await loadFixture(fixture)
      const rogue = pointFromScalar(GROUP_SECRET + 1n)
      const { signature } = await signFrost(frost, GROUP_SECRET + 1n, randomHash())
      await expectRevert(
        policy.updateEpoch(rogue, GENESIS_EPOCH, GENESIS_EPOCH + 1n, 0n, pointFromScalar(5n), signature),
        policy,
        'UnknownParent',
      )
    })
  })
})
