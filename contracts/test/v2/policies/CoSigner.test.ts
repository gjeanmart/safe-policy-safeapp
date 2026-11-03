import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { AbiCoder, Signature, TypedDataEncoder, concat, id, keccak256, toBeHex, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import type { CoSignerEngineStub, CoSignerERC1271Approver, CoSignerPolicy } from '../../../typechain-types'
import { expectEvent, expectRevert } from '../helpers'

/**
 * WP D: CoSignerPolicy (SPEC.md §5.4). M-of-N approvals pushed on-chain (directly, or by a relayer
 * with an ECDSA / ERC-1271 signature), keyed by the engine's `ctx.txHash` on both paths, consumed
 * on pass. The engine is a stub that forwards `configure` and `check`.
 */

const coder = AbiCoder.defaultAbiCoder()
const OWNERS = '0x0000000000000000000000000000000000000001'
const ZERO = '0x0000000000000000000000000000000000000000'
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const HOUR = 3600

const ATT_A = id('attachment A')
const ATT_B = id('attachment B')
const SAFE_TX = id('safe tx hash at nonce 7')

type Match = { callIndex: number; level: number; attachmentId: string }
const match = (attachmentId: string, callIndex = 0, level = 3): Match => ({ callIndex, level, attachmentId })

function settings(approvers: string[], required: number): string {
  return coder.encode(['tuple(address[] approvers, uint8 required)'], [[approvers, required]])
}

/** `ScopeLib.moduleCallHash`: the module path's `ctx.txHash`. */
function moduleCallHash(
  safe: string,
  module: string,
  to: string,
  value: bigint,
  data: string,
  op: number,
): string {
  return keccak256(
    coder.encode(
      ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
      [safe, module, to, value, data, op],
    ),
  )
}

async function fixture() {
  const [, a1, a2, a3, relayer, safeSigner, otherSafe, moduleSigner, stranger] = await ethers.getSigners()
  const policy = (await (
    await ethers.getContractFactory('CoSignerPolicy')
  ).deploy()) as unknown as CoSignerPolicy
  const Stub = await ethers.getContractFactory('CoSignerEngineStub')
  const engine = (await Stub.deploy()) as unknown as CoSignerEngineStub
  const engine2 = (await Stub.deploy()) as unknown as CoSignerEngineStub
  const wallet = (await (
    await ethers.getContractFactory('CoSignerERC1271Approver')
  ).deploy()) as unknown as CoSignerERC1271Approver
  const p = await policy.getAddress()
  const e = await engine.getAddress()
  const safe = safeSigner.address
  const chainId = (await ethers.provider.getNetwork()).chainId

  const configure = (attachmentId: string, approvers: string[], required: number, eng = engine, s = safe) =>
    eng.configure(p, s, attachmentId, settings(approvers, required))
  const check = (txHash: string, matches: Match[], eng = engine, actor = OWNERS, s = safe) =>
    eng.check(p, { safe: s, actor, txHash }, matches)
  const until = async (secs = HOUR) => BigInt(await time.latest()) + BigInt(secs)

  const domain = { name: 'CoSignerPolicy', version: '1', chainId, verifyingContract: p }
  const types = {
    Approval: [
      { name: 'engine', type: 'address' },
      { name: 'safe', type: 'address' },
      { name: 'txHash', type: 'bytes32' },
      { name: 'approver', type: 'address' },
      { name: 'useCount', type: 'uint256' },
      { name: 'revision', type: 'uint256' },
      { name: 'validUntil', type: 'uint64' },
    ],
  }
  const approval = (
    txHash: string,
    validUntil: bigint,
    useCount = 0n,
    eng = e,
    s = safe,
    revision = 0n,
    approver = a1.address,
  ) => ({
    engine: eng,
    safe: s,
    txHash,
    approver,
    useCount,
    revision,
    validUntil,
  })
  const sign = (
    signer: HardhatEthersSigner,
    txHash: string,
    validUntil: bigint,
    useCount = 0n,
    eng = e,
    s = safe,
    revision = 0n,
  ) =>
    signer.signTypedData(
      domain,
      types,
      approval(txHash, validUntil, useCount, eng, s, revision, signer.address),
    )
  const digest = (
    txHash: string,
    validUntil: bigint,
    useCount = 0n,
    eng = e,
    s = safe,
    revision = 0n,
    approver = a1.address,
  ) =>
    TypedDataEncoder.hash(domain, types, approval(txHash, validUntil, useCount, eng, s, revision, approver))

  return {
    policy,
    engine,
    engine2,
    wallet,
    e,
    safe,
    a1,
    a2,
    a3,
    relayer,
    otherSafe,
    moduleSigner,
    stranger,
    configure,
    check,
    until,
    sign,
    digest,
  }
}

describe('CoSignerPolicy (rev 4)', () => {
  describe('configure', () => {
    it('stores the approvers and the required count per (engine, safe, attachment), overwriting', async () => {
      const { policy, e, safe, a1, a2, a3, configure } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address, a3.address], 2)
      let s = await policy.getSettings(e, safe, ATT_A)
      expect(s.approvers).to.deep.equal([a1.address, a2.address, a3.address])
      expect(s.required).to.equal(2n)

      await configure(ATT_A, [a2.address], 1)
      s = await policy.getSettings(e, safe, ATT_A)
      expect(s.approvers).to.deep.equal([a2.address])
      expect(s.required).to.equal(1n)
      expect((await policy.getSettings(e, safe, ATT_B)).approvers).to.deep.equal([])
    })

    it('encodeSettings matches abi.encode, and ERC-165 reports IPolicy', async () => {
      const { policy, a1, a2 } = await loadFixture(fixture)
      expect(await policy.encodeSettings({ approvers: [a1.address, a2.address], required: 2 })).to.equal(
        settings([a1.address, a2.address], 2),
      )
      expect(await policy.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await policy.supportsInterface('0xffffffff')).to.equal(false)
    })

    it('rejects invalid settings (InvalidSettings)', async () => {
      const { policy, safe, a1, a2, configure } = await loadFixture(fixture)
      const many = Array.from({ length: 9 }, (_, i) => zeroPadValue(toBeHex(0x1000 + i), 20))
      const bad: [string[], number][] = [
        [[], 1], // no approver
        [many, 1], // more than MAX_ROLE_MEMBERS
        [[a1.address], 0], // required 0
        [[a1.address, a2.address], 3], // required > approvers
        [[a1.address, ZERO], 1], // zero approver
        [[a1.address, safe], 1], // the Safe itself
        [[a1.address, a2.address, a1.address], 1], // duplicate
      ]
      for (const [approvers, required] of bad) {
        await expectRevert(configure(ATT_A, approvers, required), policy, 'InvalidSettings')
      }
      // The maximum is accepted.
      await configure(ATT_A, many.slice(0, 8), 8)
    })
  })

  describe('approve and revoke', () => {
    it('records msg.sender until validUntil and emits Approved; revoke removes it and emits Revoked', async () => {
      const { policy, e, safe, a1, until } = await loadFixture(fixture)
      const v = await until()
      const tx = await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await expectEvent(tx, policy, 'Approved', [e, safe, SAFE_TX, a1.address, v])
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(v)

      const r = await policy.connect(a1).revoke(e, safe, SAFE_TX)
      await expectEvent(r, policy, 'Revoked', [e, safe, SAFE_TX, a1.address])
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(0n)
    })

    it('reverts ApprovalExpired for a validUntil in the past', async () => {
      const { policy, e, safe, a1 } = await loadFixture(fixture)
      const past = BigInt(await time.latest()) - 1n
      await expectRevert(policy.connect(a1).approve(e, safe, SAFE_TX, past), policy, 'ApprovalExpired', [
        past,
      ])
      await expectRevert(policy.connect(a1).approve(e, safe, SAFE_TX, 0), policy, 'ApprovalExpired', [0])
    })

    it('a later approval of the same use overwrites the earlier one', async () => {
      const { policy, e, safe, a1, until } = await loadFixture(fixture)
      await policy.connect(a1).approve(e, safe, SAFE_TX, await until(HOUR))
      const v = await until(2 * HOUR)
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(v)
    })
  })

  describe('approveWithSig', () => {
    it('approvalDigest is the EIP-712 digest of Approval(engine, safe, txHash, approver, useCount, revision, validUntil)', async () => {
      const { policy, e, safe, a1, a2, until, digest } = await loadFixture(fixture)
      const v = await until()
      expect(await policy.approvalDigest(e, safe, SAFE_TX, a1.address, v)).to.equal(digest(SAFE_TX, v))
      // The revision is the approver's own: a revoke by a1 changes a1's digest only.
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      expect(await policy.revision(e, safe, SAFE_TX, a1.address)).to.equal(1n)
      expect(await policy.revision(e, safe, SAFE_TX, a2.address)).to.equal(0n)
      expect(await policy.approvalDigest(e, safe, SAFE_TX, a1.address, v)).to.equal(
        digest(SAFE_TX, v, 0n, e, safe, 1n),
      )
      expect(await policy.approvalDigest(e, safe, SAFE_TX, a2.address, v)).to.equal(
        digest(SAFE_TX, v, 0n, e, safe, 0n, a2.address),
      )
    })

    it('records an ECDSA approval pushed by a relayer', async () => {
      const { policy, e, safe, a1, relayer, until, sign } = await loadFixture(fixture)
      const v = await until()
      const tx = await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v))
      await expectEvent(tx, policy, 'Approved', [e, safe, SAFE_TX, a1.address, v])
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(v)
    })

    it('records an ERC-1271 approval, and InvalidSignature when the contract does not approve the digest', async () => {
      const { policy, wallet, e, safe, relayer, until, digest } = await loadFixture(fixture)
      const w = await wallet.getAddress()
      const v = await until()
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, w, v, '0x'),
        policy,
        'InvalidSignature',
        [w],
      )
      await wallet.setApproved(digest(SAFE_TX, v, 0n, e, safe, 0n, w), true)
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, w, v, '0x')
      expect(await policy.approvedUntil(e, safe, SAFE_TX, w)).to.equal(v)
    })

    it('two approvers can push their signatures of the same digest', async () => {
      const { policy, e, safe, a1, a2, relayer, until, sign } = await loadFixture(fixture)
      const v = await until()
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v))
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a2.address, v, await sign(a2, SAFE_TX, v))
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a2.address)).to.equal(v)
    })

    it('reverts InvalidSignature for a wrong signer, a bad encoding, a high s, a bad v and the zero approver', async () => {
      const { policy, e, safe, a1, a2, relayer, until, sign } = await loadFixture(fixture)
      const v = await until()
      const good = await sign(a1, SAFE_TX, v)
      const sig = Signature.from(good)
      const highS = concat([sig.r, toBeHex(N - BigInt(sig.s), 32), toBeHex(sig.v === 27 ? 28 : 27, 1)])
      const badV = concat([sig.r, sig.s, toBeHex(29, 1)])
      const push = (approver: string, signature: string) =>
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, approver, v, signature)

      await expectRevert(push(a2.address, good), policy, 'InvalidSignature', [a2.address])
      await expectRevert(push(a1.address, good.slice(0, -2)), policy, 'InvalidSignature', [a1.address])
      await expectRevert(push(a1.address, highS), policy, 'InvalidSignature', [a1.address])
      await expectRevert(push(a1.address, badV), policy, 'InvalidSignature', [a1.address])
      await expectRevert(
        push(ZERO, concat([toBeHex(1, 32), toBeHex(1, 32), '0x1b'])),
        policy,
        'InvalidSignature',
        [ZERO],
      )
      // The good one still works.
      await push(a1.address, good)
    })

    it('reverts InvalidSignature for a signature over another engine, Safe or txHash', async () => {
      const { policy, engine2, e, safe, otherSafe, a1, relayer, until, sign } = await loadFixture(fixture)
      const v = await until()
      const e2 = await engine2.getAddress()
      const push = (signature: string) =>
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, signature)
      await expectRevert(push(await sign(a1, SAFE_TX, v, 0n, e2)), policy, 'InvalidSignature', [a1.address])
      await expectRevert(
        push(await sign(a1, SAFE_TX, v, 0n, e, otherSafe.address)),
        policy,
        'InvalidSignature',
        [a1.address],
      )
      await expectRevert(push(await sign(a1, id('another tx'), v)), policy, 'InvalidSignature', [a1.address])
      // A different validUntil than signed is a different digest too.
      await expectRevert(
        policy
          .connect(relayer)
          .approveWithSig(e, safe, SAFE_TX, a1.address, v + 1n, await sign(a1, SAFE_TX, v)),
        policy,
        'InvalidSignature',
        [a1.address],
      )
    })

    it('reverts ApprovalExpired for a validUntil in the past', async () => {
      const { policy, e, safe, a1, relayer, sign } = await loadFixture(fixture)
      const past = BigInt(await time.latest()) - 1n
      await expectRevert(
        policy
          .connect(relayer)
          .approveWithSig(e, safe, SAFE_TX, a1.address, past, await sign(a1, SAFE_TX, past)),
        policy,
        'ApprovalExpired',
        [past],
      )
    })

    it('a digest is pushed once (SignatureAlreadyUsed); after a revoke the old signature is void (InvalidSignature)', async () => {
      const { policy, e, safe, a1, relayer, until, sign, digest } = await loadFixture(fixture)
      const v = await until()
      const sig = await sign(a1, SAFE_TX, v)
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, sig)
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, sig),
        policy,
        'SignatureAlreadyUsed',
        [digest(SAFE_TX, v)],
      )
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, sig),
        policy,
        'InvalidSignature',
        [a1.address],
      )
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(0n)
      // The approver can still approve again, with a fresh signature over revision 1 or directly.
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v, 0n, e, safe, 1n))
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(v)
    })
  })

  describe('revoke against signatures not pushed yet (review A2)', () => {
    it('sign, revoke, push: InvalidSignature; push, revoke: the approval is gone', async () => {
      const { policy, e, safe, a1, relayer, configure, check, until, sign } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      const v = await until()
      const push = (signature: string) =>
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, signature)
      const early = await sign(a1, SAFE_TX, v)
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      await expectRevert(push(early), policy, 'InvalidSignature', [a1.address])
      await push(await sign(a1, SAFE_TX, v, 0n, e, safe, 1n))
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 1, 0])
    })

    it('sign, push, revoke, re-sign at revision 1, push: it counts', async () => {
      const { policy, e, safe, a1, relayer, configure, check, until, sign } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      const v = await until()
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v))
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      const resigned = await sign(a1, SAFE_TX, v, 0n, e, safe, 1n)
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, resigned)
      await check(SAFE_TX, [match(ATT_A)])
    })

    it("one approver's revoke does not touch another approver's signature", async () => {
      const { policy, e, safe, a1, a2, relayer, configure, check, until, sign } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address], 1)
      const v = await until()
      const sig1 = await sign(a1, SAFE_TX, v)
      const sig2 = await sign(a2, SAFE_TX, v)
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, sig1),
        policy,
        'InvalidSignature',
        [a1.address],
      )
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a2.address, v, sig2)
      await check(SAFE_TX, [match(ATT_A)])
    })

    it('the revision survives consumption: the next use is signed with useCount 1 and the same revision', async () => {
      const { policy, e, safe, a1, relayer, configure, check, until, sign } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      const v = await until()
      await policy.connect(a1).revoke(e, safe, SAFE_TX)
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await check(SAFE_TX, [match(ATT_A)])
      expect(await policy.revision(e, safe, SAFE_TX, a1.address)).to.equal(1n)
      const push = (signature: string) =>
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, signature)
      await expectRevert(push(await sign(a1, SAFE_TX, v, 1n)), policy, 'InvalidSignature', [a1.address])
      await push(await sign(a1, SAFE_TX, v, 1n, e, safe, 1n))
      await check(SAFE_TX, [match(ATT_A)])
    })
  })

  describe('the digest binds the approver (review rev 4, fable P1)', () => {
    it("an ERC-1271 approver that accepts another approver's digest gains nothing from it", async () => {
      const { policy, wallet, e, safe, a1, relayer, configure, check, until, sign, digest } =
        await loadFixture(fixture)
      const w = await wallet.getAddress()
      await configure(ATT_A, [a1.address, w], 2)
      const v = await until()
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v))
      // The wallet vouches for a1's digest: that is not the wallet's own approval.
      await wallet.setApproved(digest(SAFE_TX, v), true)
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, w, v, '0x'),
        policy,
        'InvalidSignature',
        [w],
      )
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 2, 1])
      expect(digest(SAFE_TX, v)).to.not.equal(digest(SAFE_TX, v, 0n, e, safe, 0n, w))
    })
  })

  describe('check', () => {
    it('1-of-1: passes with the approval, consumes it (Consumed, useCount), then denies a second run', async () => {
      const { policy, e, safe, a1, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 1, 0])

      await policy.connect(a1).approve(e, safe, SAFE_TX, await until())
      const tx = await check(SAFE_TX, [match(ATT_A)])
      await expectEvent(tx, policy, 'Consumed', [e, safe, SAFE_TX, 1])
      expect(await policy.useCount(e, safe, SAFE_TX)).to.equal(1n)
      expect(await policy.approvedUntil(e, safe, SAFE_TX, a1.address)).to.equal(0n)
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 1, 0])
    })

    it('2-of-3: one approval is not enough, two are; approvals by non-approvers do not count', async () => {
      const { policy, e, safe, a1, a2, a3, stranger, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address, a3.address], 2)
      const v = await until()
      await policy.connect(stranger).approve(e, safe, SAFE_TX, v)
      await policy.connect(a3).approve(e, safe, SAFE_TX, v)
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 2, 1])
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await check(SAFE_TX, [match(ATT_A)])
      expect(await policy.useCount(e, safe, SAFE_TX)).to.equal(1n)
    })

    it('ECDSA and ERC-1271 approvers together, pushed by a relayer', async () => {
      const { policy, wallet, e, safe, a1, relayer, configure, check, until, sign, digest } =
        await loadFixture(fixture)
      const w = await wallet.getAddress()
      await configure(ATT_A, [a1.address, w], 2)
      const v = await until()
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v))
      await wallet.setApproved(digest(SAFE_TX, v, 0n, e, safe, 0n, w), true)
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, w, v, '0x')
      await check(SAFE_TX, [match(ATT_A)])
    })

    it('a contract approver can also approve and revoke directly', async () => {
      const { policy, wallet, e, safe, configure, check, until } = await loadFixture(fixture)
      const w = await wallet.getAddress()
      const p = await policy.getAddress()
      await configure(ATT_A, [w], 1)
      await wallet.exec(p, policy.interface.encodeFunctionData('approve', [e, safe, SAFE_TX, await until()]))
      await wallet.exec(p, policy.interface.encodeFunctionData('revoke', [e, safe, SAFE_TX]))
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 1, 0])
      await wallet.exec(p, policy.interface.encodeFunctionData('approve', [e, safe, SAFE_TX, await until()]))
      await check(SAFE_TX, [match(ATT_A)])
    })

    it('expiry: an approval counts up to validUntil inclusive, not after', async () => {
      const { policy, e, safe, a1, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      const v = await until(100)
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await time.setNextBlockTimestamp(v + 1n)
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 1, 0])

      const v2 = await until(100)
      await policy.connect(a1).approve(e, safe, SAFE_TX, v2)
      await time.setNextBlockTimestamp(v2)
      await check(SAFE_TX, [match(ATT_A)])
    })

    it('revoke: a revoked approval no longer counts', async () => {
      const { policy, e, safe, a1, a2, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address], 2)
      const v = await until()
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await policy.connect(a2).approve(e, safe, SAFE_TX, v)
      await policy.connect(a2).revoke(e, safe, SAFE_TX)
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 2, 1])
    })

    it('replay after consumption: the signature of the consumed use is invalid for the next one', async () => {
      const { policy, wallet, e, safe, a1, relayer, configure, check, until, sign, digest } =
        await loadFixture(fixture)
      const w = await wallet.getAddress()
      await configure(ATT_A, [a1.address], 1)
      await configure(ATT_B, [w], 1)
      const v = await until()
      const sig = await sign(a1, SAFE_TX, v)
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, sig)
      await wallet.setApproved(digest(SAFE_TX, v, 0n, e, safe, 0n, w), true)
      await policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, w, v, '0x')
      await check(SAFE_TX, [match(ATT_A), match(ATT_B, 0, 4)])

      // The digest now carries useCount 1: the old ECDSA signature and the standing ERC-1271
      // approval of the old digest are both rejected.
      expect(await policy.approvalDigest(e, safe, SAFE_TX, a1.address, v)).to.equal(digest(SAFE_TX, v, 1n))
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, a1.address, v, sig),
        policy,
        'InvalidSignature',
        [a1.address],
      )
      await expectRevert(
        policy.connect(relayer).approveWithSig(e, safe, SAFE_TX, w, v, '0x'),
        policy,
        'InvalidSignature',
        [w],
      )
      await expectRevert(check(SAFE_TX, [match(ATT_A)]), policy, 'MissingApprovals', [ATT_A, 1, 0])

      // A signature over the new use works.
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a1.address, v, await sign(a1, SAFE_TX, v, 1n))
      await check(SAFE_TX, [match(ATT_A)])
      expect(await policy.useCount(e, safe, SAFE_TX)).to.equal(2n)
    })

    it('several attachments: each approver set needs its own required count (AND)', async () => {
      const { policy, e, safe, a1, a2, a3, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address], 1)
      await configure(ATT_B, [a3.address], 1)
      const matches = [match(ATT_A, 0, 3), match(ATT_B, 0, 5)]
      const v = await until()
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await expectRevert(check(SAFE_TX, matches), policy, 'MissingApprovals', [ATT_B, 1, 0])
      await policy.connect(a3).approve(e, safe, SAFE_TX, v)
      await check(SAFE_TX, matches)
    })

    it('several attachments: one approval counts for every attachment that lists the approver', async () => {
      const { policy, e, safe, a1, a2, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address], 2)
      await configure(ATT_B, [a1.address], 1)
      const matches = [match(ATT_A, 0, 3), match(ATT_B, 0, 5)]
      const v = await until()
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await expectRevert(check(SAFE_TX, matches), policy, 'MissingApprovals', [ATT_A, 2, 1])
      await policy.connect(a2).approve(e, safe, SAFE_TX, v)
      await check(SAFE_TX, matches)
    })

    it('a batch: one approval set covers every call, consumed once', async () => {
      const { policy, e, safe, a1, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      await policy.connect(a1).approve(e, safe, SAFE_TX, await until())
      const tx = await check(SAFE_TX, [match(ATT_A, 0), match(ATT_A, 1), match(ATT_A, 2)])
      await expectEvent(tx, policy, 'Consumed', [e, safe, SAFE_TX, 1])
      expect(await policy.useCount(e, safe, SAFE_TX)).to.equal(1n)
    })

    it('module path: the call hash has no nonce, so each execution of the same call needs new approvals', async () => {
      const { policy, e, safe, a1, moduleSigner, configure, check, until } = await loadFixture(fixture)
      const module = moduleSigner.address
      const callHash = moduleCallHash(safe, module, a1.address, 0n, '0xa9059cbb', 0)
      await configure(ATT_A, [a1.address], 1)
      await policy.connect(a1).approve(e, safe, callHash, await until())
      // Approvals are per hash: an owner-path approval of another hash does not help.
      await expectRevert(check(SAFE_TX, [match(ATT_A)], undefined, OWNERS), policy, 'MissingApprovals', [
        ATT_A,
        1,
        0,
      ])
      await check(callHash, [match(ATT_A)], undefined, module)
      await expectRevert(check(callHash, [match(ATT_A)], undefined, module), policy, 'MissingApprovals', [
        ATT_A,
        1,
        0,
      ])
      await policy.connect(a1).approve(e, safe, callHash, await until())
      await check(callHash, [match(ATT_A)], undefined, module)
      expect(await policy.useCount(e, safe, callHash)).to.equal(2n)
    })

    it('owner path: the Safe transaction hash (nonce-bound) is approved and consumed', async () => {
      const { policy, e, safe, a1, a2, relayer, configure, check, until, sign } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address, a2.address], 2)
      const v = await until()
      await policy.connect(a1).approve(e, safe, SAFE_TX, v)
      await policy
        .connect(relayer)
        .approveWithSig(e, safe, SAFE_TX, a2.address, v, await sign(a2, SAFE_TX, v))
      await check(SAFE_TX, [match(ATT_A)], undefined, OWNERS)
      // The next nonce is another hash and needs its own approvals.
      const next = id('safe tx hash at nonce 8')
      await expectRevert(check(next, [match(ATT_A)], undefined, OWNERS), policy, 'MissingApprovals', [
        ATT_A,
        2,
        0,
      ])
    })

    it('state is namespaced by engine and Safe', async () => {
      const { policy, engine2, e, safe, otherSafe, a1, configure, check, until } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      await configure(ATT_A, [a1.address], 1, engine2)
      await configure(ATT_A, [a1.address], 1, undefined, otherSafe.address)
      await policy.connect(a1).approve(e, safe, SAFE_TX, await until())
      // Another engine, or another Safe, sees no approval of the same hash.
      await expectRevert(check(SAFE_TX, [match(ATT_A)], engine2), policy, 'MissingApprovals', [ATT_A, 1, 0])
      await expectRevert(
        check(SAFE_TX, [match(ATT_A)], undefined, OWNERS, otherSafe.address),
        policy,
        'MissingApprovals',
        [ATT_A, 1, 0],
      )
      await check(SAFE_TX, [match(ATT_A)])
    })

    it('fails closed on an attachment never configured (InvalidSettings) and on no match (NoMatches)', async () => {
      const { policy, engine2, a1, configure, check } = await loadFixture(fixture)
      await configure(ATT_A, [a1.address], 1)
      await expectRevert(check(SAFE_TX, [match(ATT_A)], engine2), policy, 'InvalidSettings')
      await expectRevert(check(SAFE_TX, [match(ATT_B, 0, 4), match(ATT_A)]), policy, 'InvalidSettings')
      await expectRevert(check(SAFE_TX, []), policy, 'NoMatches')
    })
  })
})
