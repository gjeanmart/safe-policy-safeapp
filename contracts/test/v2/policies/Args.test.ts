import { expect } from 'chai'
import { Interface, ZeroAddress, ZeroHash, getAddress, id, toBeHex, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import type { ArgsPolicy, LimitEngineStub } from '../../../typechain-types'
import { expectRevert } from '../helpers'

/**
 * ArgsPolicy (SPEC.md §8.5), called through an engine stub: constraints on static argument words,
 * AND across every matched attachment.
 */

const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const scope = { actor: ZeroAddress, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }
const Op = { EQ: 0, NEQ: 1, IN: 2, NOT_IN: 3, LTE: 4, GTE: 5, EQ_SAFE: 6 } as const
const vault = new Interface([
  'function deposit(uint256 assets, address receiver)',
  'function redeem(uint256 shares, address receiver, address owner)',
  'function totalAssets()',
])
const DEPOSIT = vault.getFunction('deposit')!.selector
const REDEEM = vault.getFunction('redeem')!.selector
const word = (v: bigint | string) => (typeof v === 'bigint' ? toBeHex(v, 32) : zeroPadValue(v, 32))

type Constraint = { selector: string; argIndex: number; op: number; values: string[] }
const c = (selector: string, argIndex: number, op: number, values: string[] = []): Constraint => ({
  selector,
  argIndex,
  op,
  values,
})

describe('V2 ArgsPolicy', () => {
  let policy: ArgsPolicy
  let engine: LimitEngineStub
  const safe = getAddress('0x00000000000000000000000000000000000005af')
  const alice = getAddress('0x000000000000000000000000000000000000a11c')
  const bob = getAddress('0x0000000000000000000000000000000000000b0b')
  const vaultAddr = getAddress('0x0000000000000000000000000000000000004626')
  const A = id('attachment A')
  const B = id('attachment B')
  const ctx = { safe, actor: OWNERS, txHash: ZeroHash, nonce: 0n, executor: ZeroAddress }

  const call = (data: string) => ({ to: vaultAddr, value: 0n, data, operation: 0 })
  const deposit = (assets: bigint, receiver: string) =>
    call(vault.encodeFunctionData('deposit', [assets, receiver]))
  const configure = async (attachmentId: string, constraints: Constraint[], strict = false) =>
    engine.configure(
      policy,
      safe,
      attachmentId,
      scope,
      1,
      await policy.encodeSettings({ constraints, strict }),
    )
  const check = (cl: ReturnType<typeof call>, ids = [A]) => engine.checkCall(policy, ctx, cl, ids)

  beforeEach(async () => {
    policy = await ethers.deployContract('ArgsPolicy')
    engine = await ethers.deployContract('LimitEngineStub')
  })

  describe('settings', () => {
    it('stores, reads back and replaces constraints', async () => {
      const engineAddr = await engine.getAddress()
      await configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE), c(DEPOSIT, 0, Op.IN, [word(1n), word(2n)])], true)
      const s = await policy.getSettings(engineAddr, safe, A)
      expect(s.strict).to.equal(true)
      expect(s.constraints.map((x) => [x[0], x[1], x[2], [...x[3]]])).to.deep.equal([
        [DEPOSIT, 1n, 6n, []],
        [DEPOSIT, 0n, 2n, [word(1n), word(2n)]],
      ])
      await configure(A, [c(REDEEM, 1, Op.EQ_SAFE)])
      const s2 = await policy.getSettings(engineAddr, safe, A)
      expect(s2.constraints.length).to.equal(1)
      expect(s2.strict).to.equal(false)
      await check(deposit(5n, bob))
    })

    it('rejects too many constraints or values and wrong operand counts', async () => {
      const many = Array.from({ length: 17 }, () => c(DEPOSIT, 1, Op.EQ_SAFE))
      await expectRevert(configure(A, many), policy, 'InvalidSettings')
      await configure(A, many.slice(0, 16))
      const values = Array.from({ length: 33 }, (_, i) => word(BigInt(i)))
      await expectRevert(configure(A, [c(DEPOSIT, 0, Op.IN, values)]), policy, 'InvalidSettings')
      await configure(A, [c(DEPOSIT, 0, Op.IN, values.slice(0, 32))])
      await expectRevert(configure(A, [c(DEPOSIT, 0, Op.IN)]), policy, 'InvalidSettings')
      await expectRevert(configure(A, [c(DEPOSIT, 0, Op.NOT_IN)]), policy, 'InvalidSettings')
      await expectRevert(configure(A, [c(DEPOSIT, 0, Op.EQ)]), policy, 'InvalidSettings')
      await expectRevert(
        configure(A, [c(DEPOSIT, 0, Op.LTE, [word(1n), word(2n)])]),
        policy,
        'InvalidSettings',
      )
      await expectRevert(configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE, [word(safe)])]), policy, 'InvalidSettings')
    })

    it('is a call-level policy with no delay floor', async () => {
      expect(await policy.policyLevel()).to.equal(0n)
      const s = await policy.encodeSettings({ constraints: [], strict: false })
      expect(await engine.configure.staticCall(policy, safe, A, scope, 1, s)).to.equal(0n)
    })
  })

  describe('operators', () => {
    it('EQ_SAFE: the ERC-4626 receiver must be the Safe', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE)])
      await check(deposit(100n, safe))
      await expectRevert(check(deposit(100n, bob)), policy, 'ArgViolation', [DEPOSIT, 1n])
    })

    it('EQ and NEQ', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.EQ, [word(alice)])])
      await check(deposit(1n, alice))
      await expectRevert(check(deposit(1n, bob)), policy, 'ArgViolation', [DEPOSIT, 1n])
      await configure(A, [c(DEPOSIT, 1, Op.NEQ, [word(alice)])])
      await check(deposit(1n, bob))
      await expectRevert(check(deposit(1n, alice)), policy, 'ArgViolation', [DEPOSIT, 1n])
    })

    it('IN and NOT_IN', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.IN, [word(alice), word(safe)])])
      await check(deposit(1n, safe))
      await check(deposit(1n, alice))
      await expectRevert(check(deposit(1n, bob)), policy, 'ArgViolation', [DEPOSIT, 1n])
      await configure(A, [c(DEPOSIT, 1, Op.NOT_IN, [word(alice), word(bob)])])
      await check(deposit(1n, safe))
      await expectRevert(check(deposit(1n, bob)), policy, 'ArgViolation', [DEPOSIT, 1n])
    })

    it('LTE and GTE (unsigned)', async () => {
      await configure(A, [c(DEPOSIT, 0, Op.LTE, [word(100n)]), c(DEPOSIT, 0, Op.GTE, [word(10n)])])
      await check(deposit(100n, safe))
      await check(deposit(10n, safe))
      await expectRevert(check(deposit(101n, safe)), policy, 'ArgViolation', [DEPOSIT, 0n])
      await expectRevert(check(deposit(9n, safe)), policy, 'ArgViolation', [DEPOSIT, 0n])
    })

    it('denies with ArgMissing when the calldata is too short', async () => {
      await configure(A, [c(REDEEM, 2, Op.EQ_SAFE)])
      await check(deposit(1n, safe))
      const short = vault.encodeFunctionData('redeem', [1n, safe, safe]).slice(0, 2 + 8 + 128)
      await expectRevert(check(call(short)), policy, 'ArgMissing', [REDEEM, 2n])
    })
  })

  describe('unconstrained calls', () => {
    it('pass when no attachment is strict', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE)])
      await check(call(vault.encodeFunctionData('totalAssets')))
      await check(call('0x'))
    })

    it('deny with NoConstraint when an attachment is strict', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE)])
      await configure(B, [], true)
      const total = vault.encodeFunctionData('totalAssets')
      await expectRevert(check(call(total), [A, B]), policy, 'NoConstraint', [total])
      await expectRevert(check(call('0x'), [A, B]), policy, 'NoConstraint', ['0x00000000'])
      // A constraint of another attachment applying is enough.
      await check(deposit(1n, safe), [A, B])
    })
  })

  describe('several attachments (merge)', () => {
    it('requires every constraint of every attachment to hold', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE)])
      await configure(B, [c(DEPOSIT, 0, Op.LTE, [word(50n)])])
      await check(deposit(50n, safe), [A, B])
      await check(deposit(500n, safe), [A])
      await expectRevert(check(deposit(51n, safe), [A, B]), policy, 'ArgViolation', [DEPOSIT, 0n])
      await expectRevert(check(deposit(1n, bob), [A, B]), policy, 'ArgViolation', [DEPOSIT, 1n])
    })

    it('keeps settings apart per engine', async () => {
      await configure(A, [c(DEPOSIT, 1, Op.EQ_SAFE)])
      const [other] = await ethers.getSigners()
      expect((await policy.getSettings(other.address, safe, A)).constraints.length).to.equal(0)
      await policy.checkCall(ctx, deposit(1n, bob), [A]) // the caller's own (empty) namespace
    })
  })
})
