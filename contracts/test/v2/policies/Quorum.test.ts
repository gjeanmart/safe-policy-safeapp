import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  AbiCoder,
  BaseWallet,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  hexlify,
  id,
  randomBytes,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type { ProofEngineStub, ProofSafeStub, QuorumPolicyV2 } from '../../../typechain-types'
import { expectRevert } from '../helpers'

/**
 * WP5 QuorumPolicyV2 (SPEC.md §8.8), driven by ProofEngineStub acting as the engine against
 * ProofSafeStub (owners, threshold and Safe 1.5.0 `checkNSignatures`).
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const PASS = '0xe18ffdca'
const ETH = 10n ** 18n
const sel = (signature: string) => id(signature).slice(0, 10)
const TRANSFER = sel('transfer(address,uint256)')
const TRANSFER_FROM = sel('transferFrom(address,address,uint256)')
const APPROVE = sel('approve(address,uint256)')
const INCREASE_ALLOWANCE = sel('increaseAllowance(address,uint256)')
const SIGN_PERMIT = '0x51bdfa61'
const SIGN_PERMIT2 = '0xda3c0cb0'
const SIGN_COW_ORDER = '0x3d296e04'
const randomHash = () => hexlify(randomBytes(32))
const randomAddress = () => Wallet.createRandom().address
const safeError = (code: string) => '0x08c379a0' + coder.encode(['string'], [code]).slice(2)

type ScopeData = { actor: string; to: string; selector: string; callMatch: number }
type Tier = { token: string; above: bigint; required: number }
type CallT = { to: string; value: bigint; data: string; operation: number }
const globalScope: ScopeData = { actor: ANY, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }
const ownersScope: ScopeData = { actor: OWNERS, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }

const SETTINGS_TYPE = 'tuple(uint8 required, tuple(address token, uint256 above, uint8 required)[] tiers)'
const settings = (required: number, tiers: Tier[] = []) => coder.encode([SETTINGS_TYPE], [[required, tiers]])
const encodeCall = (selector: string, types: string[], values: unknown[]) =>
  concat([selector, coder.encode(types, values)])
const call = (to: string, data = '0x', value = 0n, operation = 0): CallT => ({ to, value, data, operation })

describe('QuorumPolicyV2', function () {
  async function fixture() {
    const engine = (await (
      await ethers.getContractFactory('ProofEngineStub')
    ).deploy()) as unknown as ProofEngineStub
    const policy = (await (
      await ethers.getContractFactory('QuorumPolicyV2')
    ).deploy()) as unknown as QuorumPolicyV2
    const owners = Array.from({ length: 4 }, () => Wallet.createRandom()).sort((a, b) =>
      BigInt(a.address) < BigInt(b.address) ? -1 : 1,
    )
    const safeStub = (await (
      await ethers.getContractFactory('ProofSafeStub')
    ).deploy(
      owners.map((o) => o.address),
      2,
    )) as unknown as ProofSafeStub
    const safe = await safeStub.getAddress()
    const token = randomAddress()
    const tokenScope: ScopeData = { actor: ANY, to: token, selector: TRANSFER, callMatch: 3 }
    return { engine, policy, owners, safeStub, safe, token, tokenScope }
  }

  async function attach(
    engine: ProofEngineStub,
    policy: QuorumPolicyV2,
    safe: string,
    scope: ScopeData,
    data: string,
  ) {
    const [attachmentId] = await engine.configure.staticCall(policy, safe, scope, 1, data)
    await engine.configure(policy, safe, scope, 1, data)
    return attachmentId
  }

  /** Owner signatures over `txHash`, sorted by owner as the Safe requires. */
  const ownerSigs = (signers: BaseWallet[], txHash: string) =>
    concat(
      [...signers]
        .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
        .map((w) => w.signingKey.sign(txHash).serialized),
    )
  const approvedSig = (owner: string) => concat([zeroPadValue(owner, 32), zeroPadValue('0x', 32), '0x01'])
  const ownerCtx = (safe: string, txHash: string, executor = randomAddress()) => ({
    safe,
    actor: OWNERS,
    txHash,
    nonce: 1n,
    executor,
  })

  describe('policy shape and settings', function () {
    it('is a transaction-level IPolicyV2 with a zero delay floor', async function () {
      const { engine, policy, safe } = await loadFixture(fixture)
      expect(await policy.policyLevel()).to.equal(1n)
      expect(await policy.supportsInterface('0x55872811')).to.equal(true)
      const [, delayFloor] = await engine.configure.staticCall(policy, safe, globalScope, 1, settings(3))
      expect(delayFloor).to.equal(0n)
    })

    it('stores and overwrites settings per attachment', async function () {
      const { engine, policy, safe, token } = await loadFixture(fixture)
      const tiers = [{ token, above: 100n, required: 4 }]
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(3, tiers))
      let stored = await policy.getSettings(engine, safe, attachmentId)
      expect(stored.required).to.equal(3n)
      expect(stored.tiers.map((t) => [t.token, t.above, t.required])).to.deep.equal([[token, 100n, 4n]])
      expect(await policy.encodeSettings({ required: 3, tiers })).to.equal(settings(3, tiers))

      await attach(engine, policy, safe, globalScope, settings(2))
      stored = await policy.getSettings(engine, safe, attachmentId)
      expect(stored.required).to.equal(2n)
      expect(stored.tiers.length).to.equal(0)
    })

    it('rejects invalid settings: InvalidSettings', async function () {
      const { engine, policy, safe, token } = await loadFixture(fixture)
      const nine = Array.from({ length: 9 }, () => ({ token, above: 1n, required: 3 }))
      for (const data of [
        settings(0),
        settings(2, nine),
        settings(2, [{ token, above: 1n, required: 0 }]),
        '0x',
        '0x1234',
        coder.encode(['uint256', 'uint256'], [32n, 300n]),
      ]) {
        await expectRevert(engine.configure(policy, safe, globalScope, 1, data), policy, 'InvalidSettings')
      }
    })

    it('denies an attachment that was never configured, and a call-level check', async function () {
      const { engine, policy, safe, token } = await loadFixture(fixture)
      const ctx = ownerCtx(safe, randomHash())
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', '0x', [randomHash()]),
        policy,
        'InvalidSettings',
      )
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(2))
      await expectRevert(
        engine.checkCall(policy, ctx, call(token), [attachmentId]),
        policy,
        'WrongPolicyLevel',
      )
    })
  })

  describe('owner path', function () {
    it('passes with `required` owner signatures and denies with fewer: QuorumNotMet', async function () {
      const { engine, policy, owners, safe, token } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(3))
      const txHash = randomHash()
      const ctx = ownerCtx(safe, txHash)
      const calls = [call(token)]
      expect(
        await engine.checkTransaction.staticCall(
          policy,
          ctx,
          calls,
          ownerSigs(owners.slice(0, 3), txHash),
          '0x',
          [attachmentId],
        ),
      ).to.equal(PASS)
      await expectRevert(
        engine.checkTransaction(policy, ctx, calls, ownerSigs(owners.slice(0, 2), txHash), '0x', [
          attachmentId,
        ]),
        policy,
        'QuorumNotMet',
        [3n, safeError('GS020')],
      )
    })

    it('denies signatures by non-owners or over another hash', async function () {
      const { engine, policy, owners, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(2))
      const txHash = randomHash()
      for (const sigs of [
        ownerSigs([owners[0], Wallet.createRandom()], txHash),
        ownerSigs(owners.slice(0, 2), randomHash()),
      ]) {
        await expectRevert(
          engine.checkTransaction(policy, ownerCtx(safe, txHash), [], sigs, '0x', [attachmentId]),
          policy,
          'QuorumNotMet',
          [2n, safeError('GS026')],
        )
      }
    })

    it("counts the executing owner's v = 1 signature only when the Safe says it executes", async function () {
      const { engine, policy, owners, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(2))
      const txHash = randomHash()
      const [low, high] = [owners[0], owners[3]]
      const sigs = concat([ownerSigs([low], txHash), approvedSig(high.address)])
      expect(
        await engine.checkTransaction.staticCall(
          policy,
          ownerCtx(safe, txHash, high.address),
          [],
          sigs,
          '0x',
          [attachmentId],
        ),
      ).to.equal(PASS)
      await expectRevert(
        engine.checkTransaction(policy, ownerCtx(safe, txHash), [], sigs, '0x', [attachmentId]),
        policy,
        'QuorumNotMet',
        [2n, safeError('GS025')],
      )
    })

    it('reads the signatures from the front and ignores the policy-context tail', async function () {
      const { engine, policy, owners, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(3))
      const txHash = randomHash()
      const sigs = concat([ownerSigs(owners.slice(0, 3), txHash), hexlify(randomBytes(100))])
      expect(
        await engine.checkTransaction.staticCall(policy, ownerCtx(safe, txHash), [], sigs, '0x', [
          attachmentId,
        ]),
      ).to.equal(PASS)
    })

    it('denies the preview context (no signatures, no executor)', async function () {
      const { engine, policy, safe } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(3))
      const ctx = { safe, actor: OWNERS, txHash: randomHash(), nonce: 0n, executor: ZeroAddress }
      await expectRevert(
        engine.checkTransaction(policy, ctx, [], '0x', '0x', [attachmentId]),
        policy,
        'QuorumNotMet',
        [3n, safeError('GS020')],
      )
    })
  })

  describe('module path', function () {
    it('denies: ModulePathUnsupported', async function () {
      const { engine, policy, safe, token } = await loadFixture(fixture)
      const attachmentId = await attach(engine, policy, safe, globalScope, settings(2))
      const top = call(token)
      await expectRevert(
        engine.checkModuleTransaction(policy, safe, randomAddress(), top, [top], [attachmentId]),
        policy,
        'ModulePathUnsupported',
      )
    })
  })

  describe('requirement: merge, tiers and pricing', function () {
    it('takes the max over attachments and clamps to the owner count', async function () {
      const { engine, policy, safe, tokenScope } = await loadFixture(fixture)
      const a = await attach(engine, policy, safe, globalScope, settings(2))
      const b = await attach(engine, policy, safe, tokenScope, settings(3))
      const c = await attach(engine, policy, safe, ownersScope, settings(9))
      expect(await policy.requiredSignatures(engine, safe, [], [a])).to.equal(2n)
      expect(await policy.requiredSignatures(engine, safe, [], [a, b])).to.equal(3n)
      expect(await policy.requiredSignatures(engine, safe, [], [a, b, c])).to.equal(4n)
    })

    it('a native tier sums the values of a batch', async function () {
      const { engine, policy, owners, safe } = await loadFixture(fixture)
      const attachmentId = await attach(
        engine,
        policy,
        safe,
        globalScope,
        settings(2, [{ token: ZeroAddress, above: 10n * ETH, required: 3 }]),
      )
      const r = randomAddress()
      expect(
        await policy.requiredSignatures(engine, safe, [call(r, '0x', 6n * ETH)], [attachmentId]),
      ).to.equal(2n)
      expect(
        await policy.requiredSignatures(engine, safe, [call(r, '0x', 10n * ETH)], [attachmentId]),
      ).to.equal(2n)
      const batch = [call(r, '0x', 6n * ETH), call(randomAddress(), '0x', 5n * ETH)]
      expect(await policy.requiredSignatures(engine, safe, batch, [attachmentId])).to.equal(3n)

      // End to end: the batch needs 3 signatures.
      const txHash = randomHash()
      await expectRevert(
        engine.checkTransaction(
          policy,
          ownerCtx(safe, txHash),
          batch,
          ownerSigs(owners.slice(0, 2), txHash),
          '0x',
          [attachmentId],
        ),
        policy,
        'QuorumNotMet',
        [3n, safeError('GS020')],
      )
      expect(
        await engine.checkTransaction.staticCall(
          policy,
          ownerCtx(safe, txHash),
          batch,
          ownerSigs(owners.slice(1, 4), txHash),
          '0x',
          [attachmentId],
        ),
      ).to.equal(PASS)
    })

    it('prices token transfers, transferFrom from the Safe, approvals and allowance increases', async function () {
      const { engine, policy, safe, token } = await loadFixture(fixture)
      const attachmentId = await attach(
        engine,
        policy,
        safe,
        globalScope,
        settings(2, [{ token, above: 100n, required: 4 }]),
      )
      const r = randomAddress()
      const need = (calls: CallT[]) => policy.requiredSignatures(engine, safe, calls, [attachmentId])
      const transfer = (amount: bigint) =>
        call(token, encodeCall(TRANSFER, ['address', 'uint256'], [r, amount]))

      expect(await need([transfer(100n)])).to.equal(2n)
      expect(await need([transfer(101n)])).to.equal(4n)
      expect(await need([transfer(60n), transfer(60n)])).to.equal(4n)
      // Another token is not this tier's.
      expect(
        await need([call(randomAddress(), encodeCall(TRANSFER, ['address', 'uint256'], [r, 1000n]))]),
      ).to.equal(2n)
      const from = (owner: string) =>
        call(token, encodeCall(TRANSFER_FROM, ['address', 'address', 'uint256'], [owner, r, 500n]))
      expect(await need([from(safe)])).to.equal(4n)
      expect(await need([from(randomAddress())])).to.equal(2n)
      expect(await need([call(token, encodeCall(APPROVE, ['address', 'uint256'], [r, 500n]))])).to.equal(4n)
      expect(
        await need([call(token, encodeCall(INCREASE_ALLOWANCE, ['address', 'uint256'], [r, 500n]))]),
      ).to.equal(4n)
      // Malformed (too short) calldata and unknown selectors move nothing.
      expect(await need([call(token, TRANSFER + '00'.repeat(40))])).to.equal(2n)
      expect(await need([call(token, sel('mint(address,uint256)') + '00'.repeat(64))])).to.equal(2n)
      // A plain CALL with a sign-library selector is not priced as a signature.
      const permitAsCall = call(
        randomAddress(),
        encodeCall(
          SIGN_PERMIT,
          ['address', 'address', 'uint256', 'uint256', 'uint256'],
          [token, r, 500n, 0n, 0n],
        ),
      )
      expect(await need([permitAsCall])).to.equal(2n)
    })

    it('prices typed approvals signed through the sign library (DELEGATECALL)', async function () {
      const { engine, policy, safe, token } = await loadFixture(fixture)
      const attachmentId = await attach(
        engine,
        policy,
        safe,
        globalScope,
        settings(2, [{ token, above: 100n, required: 3 }]),
      )
      const lib = randomAddress()
      const r = randomAddress()
      const need = (c: CallT) => policy.requiredSignatures(engine, safe, [c], [attachmentId])
      const permit = encodeCall(
        SIGN_PERMIT,
        ['address', 'address', 'uint256', 'uint256', 'uint256'],
        [token, r, 101n, 0n, 0n],
      )
      expect(await need(call(lib, permit, 0n, 1))).to.equal(3n)
      const permit2 = encodeCall(
        SIGN_PERMIT2,
        ['address', 'address', 'uint160', 'uint48', 'uint48', 'uint256'],
        [token, r, 101n, 0n, 0n, 0n],
      )
      expect(await need(call(lib, permit2, 0n, 1))).to.equal(3n)
      const order = (sellAmount: bigint, feeAmount: bigint) =>
        encodeCall(
          SIGN_COW_ORDER,
          [
            'tuple(address,address,address,uint256,uint256,uint32,bytes32,uint256,bytes32,bool,bytes32,bytes32)',
          ],
          [
            [
              token,
              randomAddress(),
              r,
              sellAmount,
              1n,
              0n,
              randomHash(),
              feeAmount,
              randomHash(),
              false,
              randomHash(),
              randomHash(),
            ],
          ],
        )
      expect(await need(call(lib, order(90n, 10n), 0n, 1))).to.equal(2n)
      expect(await need(call(lib, order(90n, 11n), 0n, 1))).to.equal(3n)
      // Overflowing amounts saturate instead of reverting.
      const max = 2n ** 256n - 1n
      expect(await need(call(lib, order(max, 1n), 0n, 1))).to.equal(3n)
    })

    it('several tiers and attachments: the strictest matching requirement wins', async function () {
      const { engine, policy, safe, token, tokenScope } = await loadFixture(fixture)
      const a = await attach(
        engine,
        policy,
        safe,
        globalScope,
        settings(2, [
          { token, above: 100n, required: 3 },
          { token, above: 1000n, required: 4 },
        ]),
      )
      const b = await attach(
        engine,
        policy,
        safe,
        tokenScope,
        settings(2, [{ token: ZeroAddress, above: 0n, required: 3 }]),
      )
      const r = randomAddress()
      const transfer = (amount: bigint, value = 0n) =>
        call(token, encodeCall(TRANSFER, ['address', 'uint256'], [r, amount]), value)
      expect(await policy.requiredSignatures(engine, safe, [transfer(50n)], [a, b])).to.equal(2n)
      expect(await policy.requiredSignatures(engine, safe, [transfer(500n)], [a, b])).to.equal(3n)
      expect(await policy.requiredSignatures(engine, safe, [transfer(5000n)], [a, b])).to.equal(4n)
      expect(await policy.requiredSignatures(engine, safe, [transfer(50n, 1n)], [a, b])).to.equal(3n)
    })
  })
})
