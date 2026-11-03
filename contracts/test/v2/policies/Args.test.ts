import { expect } from 'chai'
import { AbiCoder, Interface, ZeroAddress, ZeroHash, getAddress, id, toBeHex, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import type { ArgsLimitEngineStub, ArgsPolicy } from '../../../typechain-types'
import { expectAnyRevert, expectRevert } from '../helpers'

/**
 * ArgsPolicy (SPEC.md §5.2), called through an engine stub: WORD / CALL_TO / VALUE constraints,
 * every op, `ANY_SELECTOR` and empty calldata, `strict`, the per-match merge rule and the app's
 * presets (Recipients, Spenders, Receiver-is-the-Safe).
 */

const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CALL = 0
const ANY_SELECTOR = '0xffffffff'
const NO_SELECTOR = '0x00000000'
const Target = { WORD: 0, CALL_TO: 1, VALUE: 2 }
const Op = { EQ: 0, NEQ: 1, IN: 2, NOT_IN: 3, LTE: 4, GTE: 5, EQ_SAFE: 6 }
const coder = AbiCoder.defaultAbiCoder()

const erc20 = new Interface([
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function approve(address,uint256)',
])
const aave = new Interface([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
])
const sel = (fn: string) => id(fn).slice(0, 10)
const TRANSFER = sel('transfer(address,uint256)')
const TRANSFER_FROM = sel('transferFrom(address,address,uint256)')
const APPROVE = sel('approve(address,uint256)')
const SUPPLY = aave.getFunction('supply')!.selector

const word = (v: string | bigint) => (typeof v === 'bigint' ? toBeHex(v, 32) : zeroPadValue(v, 32))

type Constraint = { selector: string; target: number; index: number; op: number; values: string[] }
const c = (
  selector: string,
  target: number,
  index: number,
  op: number,
  values: (string | bigint)[] = [],
) => ({
  selector,
  target,
  index,
  op,
  values: values.map(word),
})

type CallT = { to: string; value: bigint; data: string; operation: number }
const call = (to: string, data = '0x', value = 0n): CallT => ({ to, value, data, operation: CALL })

// The app's presets (SPEC.md §5.2), as the settings the app writes.
const recipients = (list: string[], strict = true) => ({
  constraints: [
    c(TRANSFER, Target.WORD, 0, Op.IN, list),
    c(TRANSFER_FROM, Target.WORD, 1, Op.IN, list),
    c(NO_SELECTOR, Target.CALL_TO, 0, Op.IN, list),
  ],
  strict,
})
const spenders = (list: string[], cap: bigint) => ({
  constraints: [c(APPROVE, Target.WORD, 0, Op.IN, list), c(APPROVE, Target.WORD, 1, Op.LTE, [cap])],
  strict: true,
})
const receiverIsSafe = (selector: string, index: number) => ({
  constraints: [c(selector, Target.WORD, index, Op.EQ_SAFE)],
  strict: true,
})

describe('V2 rev 3 ArgsPolicy (WP C)', () => {
  let policy: ArgsPolicy
  let engine: ArgsLimitEngineStub
  let engineAddr: string
  const safe = getAddress('0x00000000000000000000000000000000000005af')
  const usdc = getAddress('0x000000000000000000000000000000000000c0c0')
  const pool = getAddress('0x0000000000000000000000000000000000000a7e')
  const alice = getAddress('0x000000000000000000000000000000000000a11c')
  const bob = getAddress('0x0000000000000000000000000000000000000b0b')
  const eve = getAddress('0x0000000000000000000000000000000000000e7e')
  const A = id('attachment A')
  const B = id('attachment B')
  const ctx = { safe, actor: OWNERS, txHash: ZeroHash }
  const scope = { actor: OWNERS, to: ZeroAddress, selector: NO_SELECTOR, callMatch: 0 }

  const configure = async (attachmentId: string, settings: { constraints: Constraint[]; strict: boolean }) =>
    engine.configure(policy, safe, attachmentId, scope, 3, await policy.encodeSettings(settings))
  const check = (calls: CallT[], matches: { callIndex: number; attachmentId: string }[]) =>
    engine.check(
      policy,
      ctx,
      calls,
      matches.map((m) => ({ ...m, level: 3 })),
    )
  /** One call matched by the given attachments. */
  const check1 = (cl: CallT, ids = [A]) =>
    check(
      [cl],
      ids.map((attachmentId) => ({ callIndex: 0, attachmentId })),
    )
  const transfer = (to: string, amount = 1n) => call(usdc, erc20.encodeFunctionData('transfer', [to, amount]))

  beforeEach(async () => {
    policy = await ethers.deployContract('ArgsPolicy')
    engine = await ethers.deployContract('ArgsLimitEngineStub')
    engineAddr = await engine.getAddress()
  })

  describe('settings', () => {
    it('stores and reads back the settings, keyed by engine and Safe', async () => {
      const s = {
        constraints: [
          c(TRANSFER, Target.WORD, 0, Op.IN, [alice, bob]),
          c(ANY_SELECTOR, Target.VALUE, 0, Op.EQ, [0n]),
        ],
        strict: true,
      }
      await configure(A, s)
      const got = await policy.getSettings(engineAddr, safe, A)
      expect(got.strict).to.equal(true)
      expect(got.constraints.map((x) => [x.selector, x.target, x.index, x.op, [...x[4]]])).to.deep.equal(
        s.constraints.map((x) => [x.selector, BigInt(x.target), BigInt(x.index), BigInt(x.op), x.values]),
      )
      expect((await policy.getSettings(alice, safe, A)).constraints.length).to.equal(0)
      expect((await policy.getSettings(engineAddr, alice, A)).constraints.length).to.equal(0)
    })

    it('configure replaces the settings', async () => {
      await configure(A, recipients([alice]))
      await configure(A, { constraints: [c(APPROVE, Target.WORD, 0, Op.EQ, [bob])], strict: false })
      const got = await policy.getSettings(engineAddr, safe, A)
      expect(got.strict).to.equal(false)
      expect(got.constraints.length).to.equal(1)
      await check1(transfer(eve)) // the old recipients list is gone and the new list is not strict
    })

    it('rejects every malformed setting with InvalidSettings', async () => {
      const bad: Constraint[][] = [
        Array.from({ length: 17 }, () => c(TRANSFER, Target.WORD, 0, Op.EQ_SAFE)),
        [c(TRANSFER, Target.CALL_TO, 1, Op.EQ, [alice])], // index on a non-WORD target
        [c(TRANSFER, Target.VALUE, 1, Op.LTE, [1n])],
        [c(TRANSFER, Target.WORD, 0, Op.EQ, [])], // single-operand ops need exactly one value
        [c(TRANSFER, Target.WORD, 0, Op.NEQ, [alice, bob])],
        [c(TRANSFER, Target.WORD, 0, Op.LTE, [])],
        [c(TRANSFER, Target.WORD, 0, Op.GTE, [1n, 2n])],
        [c(TRANSFER, Target.WORD, 0, Op.IN, [])], // set ops need 1 to 32 values
        [
          c(
            TRANSFER,
            Target.WORD,
            0,
            Op.NOT_IN,
            Array.from({ length: 33 }, (_, i) => BigInt(i)),
          ),
        ],
        [c(TRANSFER, Target.WORD, 0, Op.EQ_SAFE, [word(safe)])], // EQ_SAFE takes none
      ]
      for (const constraints of bad)
        await expectRevert(configure(A, { constraints, strict: true }), policy, 'InvalidSettings')
      // An empty list does nothing unless strict (then it is a carve-out denying every matched call).
      await expectRevert(configure(A, { constraints: [], strict: false }), policy, 'InvalidSettings')
      // The edges are accepted.
      await configure(A, {
        constraints: Array.from({ length: 16 }, () => c(TRANSFER, Target.WORD, 0, Op.EQ_SAFE)),
        strict: true,
      })
      await configure(A, {
        constraints: [
          c(
            TRANSFER,
            Target.WORD,
            7,
            Op.IN,
            Array.from({ length: 32 }, (_, i) => BigInt(i)),
          ),
        ],
        strict: false,
      })
      await configure(A, { constraints: [], strict: true })
    })

    it('rejects an out-of-range enum (the settings do not decode)', async () => {
      const raw = (target: number, op: number) =>
        coder.encode(
          ['tuple(tuple(bytes4,uint8,uint16,uint8,bytes32[])[],bool)'],
          [[[[TRANSFER, target, 0, op, [word(alice)]]], false]],
        )
      await engine.configure(policy, safe, A, scope, 3, raw(Target.WORD, Op.EQ))
      await expectAnyRevert(engine.configure(policy, safe, A, scope, 3, raw(3, Op.EQ)))
      await expectAnyRevert(engine.configure(policy, safe, A, scope, 3, raw(Target.WORD, 7)))
    })

    it('supports IPolicy and ERC-165', async () => {
      const iPolicy =
        BigInt(policy.interface.getFunction('configure')!.selector) ^
        BigInt(policy.interface.getFunction('check')!.selector)
      expect(await policy.supportsInterface(toBeHex(iPolicy, 4))).to.equal(true)
      expect(await policy.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await policy.supportsInterface('0xffffffff')).to.equal(false)
    })
  })

  describe('targets and ops', () => {
    it('WORD reads static head word `index`; a short calldata is ArgumentMissing', async () => {
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 1, Op.LTE, [100n])], strict: false })
      await check1(transfer(alice, 100n))
      await expectRevert(check1(transfer(alice, 101n)), policy, 'ConstraintFailed', [0, A, 0])
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 2, Op.EQ, [0n])], strict: false })
      await expectRevert(check1(transfer(alice)), policy, 'ArgumentMissing', [0, A, 0])
      // 4 + 32 * 2 bytes: exactly one word short of word 2.
      await expectRevert(
        check1(call(usdc, transfer(alice).data.slice(0, 2 + 2 * 68))),
        policy,
        'ArgumentMissing',
        [0, A, 0],
      )
    })

    it('CALL_TO reads the target, VALUE the native value', async () => {
      await configure(A, {
        constraints: [
          c(ANY_SELECTOR, Target.CALL_TO, 0, Op.EQ, [usdc]),
          c(ANY_SELECTOR, Target.VALUE, 0, Op.LTE, [5n]),
        ],
        strict: false,
      })
      await check1(call(usdc, '0x', 5n))
      await expectRevert(check1(call(pool, '0x', 5n)), policy, 'ConstraintFailed', [0, A, 0])
      await expectRevert(check1(call(usdc, '0x', 6n)), policy, 'ConstraintFailed', [0, A, 1])
    })

    const cases: [string, number, (string | bigint)[], bigint[], bigint[]][] = [
      // name, op, operands, passing amounts, failing amounts (word 1 of transfer)
      ['EQ', Op.EQ, [7n], [7n], [6n, 8n]],
      ['NEQ', Op.NEQ, [7n], [6n, 8n], [7n]],
      ['IN', Op.IN, [1n, 7n], [1n, 7n], [0n, 2n]],
      ['NOT_IN', Op.NOT_IN, [1n, 7n], [0n, 2n], [1n, 7n]],
      ['LTE', Op.LTE, [7n], [0n, 7n], [8n]],
      ['GTE', Op.GTE, [7n], [7n, 2n ** 256n - 1n], [0n, 6n]],
    ]
    for (const [name, op, operands, ok, ko] of cases)
      it(`${name} (unsigned compare on the whole word)`, async () => {
        await configure(A, { constraints: [c(TRANSFER, Target.WORD, 1, op, operands)], strict: false })
        for (const v of ok) await check1(transfer(alice, v))
        for (const v of ko)
          await expectRevert(check1(transfer(alice, v)), policy, 'ConstraintFailed', [0, A, 0])
      })

    it('EQ_SAFE compares with ctx.safe, on any target', async () => {
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 0, Op.EQ_SAFE)], strict: false })
      await check1(transfer(safe))
      await expectRevert(check1(transfer(alice)), policy, 'ConstraintFailed', [0, A, 0])
      await configure(A, { constraints: [c(NO_SELECTOR, Target.CALL_TO, 0, Op.EQ_SAFE)], strict: false })
      await check1(call(safe))
      await expectRevert(check1(call(alice)), policy, 'ConstraintFailed', [0, A, 0])
    })
  })

  describe('selectors', () => {
    it('ANY_SELECTOR applies to every call, empty calldata included', async () => {
      await configure(A, { constraints: [c(ANY_SELECTOR, Target.VALUE, 0, Op.EQ, [0n])], strict: true })
      await check1(transfer(alice))
      await check1(call(alice))
      await check1(call(pool, aave.encodeFunctionData('supply', [usdc, 1n, safe, 0])))
      await expectRevert(check1(call(alice, '0x', 1n)), policy, 'ConstraintFailed', [0, A, 0])
      await expectRevert(check1(call(usdc, transfer(alice).data, 1n)), policy, 'ConstraintFailed', [0, A, 0])
    })

    it('selector 0 applies to empty calldata only', async () => {
      await configure(A, { constraints: [c(NO_SELECTOR, Target.CALL_TO, 0, Op.EQ, [alice])], strict: true })
      await check1(call(alice, '0x', 1n))
      await expectRevert(check1(call(bob, '0x', 1n)), policy, 'ConstraintFailed', [0, A, 0])
      await expectRevert(check1(transfer(alice)), policy, 'NoConstraint', [0, A])
      // A selector-0 WORD constraint can never be met by empty calldata.
      await configure(A, { constraints: [c(NO_SELECTOR, Target.WORD, 0, Op.EQ, [0n])], strict: true })
      await expectRevert(check1(call(alice)), policy, 'ArgumentMissing', [0, A, 0])
    })

    it('a constraint on another selector does not apply', async () => {
      await configure(A, { constraints: [c(APPROVE, Target.WORD, 0, Op.EQ, [alice])], strict: false })
      await check1(transfer(eve))
    })
  })

  describe('strict and the merge rule', () => {
    it('strict denies a call no constraint applies to; non-strict lets it pass', async () => {
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 0, Op.EQ, [alice])], strict: true })
      await expectRevert(
        check1(call(usdc, erc20.encodeFunctionData('approve', [alice, 1n]))),
        policy,
        'NoConstraint',
        [0, A],
      )
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 0, Op.EQ, [alice])], strict: false })
      await check1(call(usdc, erc20.encodeFunctionData('approve', [alice, 1n])))
    })

    it('an empty strict list denies every matched call', async () => {
      await configure(A, { constraints: [], strict: true })
      await expectRevert(check1(call(alice)), policy, 'NoConstraint', [0, A])
      await expectRevert(check1(transfer(alice)), policy, 'NoConstraint', [0, A])
    })

    it('every constraint of an attachment that applies must hold (AND)', async () => {
      await configure(A, {
        constraints: [
          c(TRANSFER, Target.WORD, 0, Op.EQ, [alice]),
          c(ANY_SELECTOR, Target.WORD, 1, Op.LTE, [10n]),
        ],
        strict: false,
      })
      await check1(transfer(alice, 10n))
      await expectRevert(check1(transfer(bob, 10n)), policy, 'ConstraintFailed', [0, A, 0])
      await expectRevert(check1(transfer(alice, 11n)), policy, 'ConstraintFailed', [0, A, 1])
    })

    it('every matched attachment must pass on its own (AND across attachments)', async () => {
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 0, Op.IN, [alice, bob])], strict: false })
      await configure(B, { constraints: [c(TRANSFER, Target.WORD, 0, Op.NEQ, [bob])], strict: false })
      await check1(transfer(alice), [A, B])
      await expectRevert(check1(transfer(bob), [A, B]), policy, 'ConstraintFailed', [0, B, 0])
      await expectRevert(check1(transfer(eve), [A, B]), policy, 'ConstraintFailed', [0, A, 0])
    })

    it('strict is per attachment: another attachment applying does not satisfy it', async () => {
      await configure(A, { constraints: [c(TRANSFER, Target.WORD, 0, Op.EQ, [alice])], strict: false })
      await configure(B, { constraints: [c(APPROVE, Target.WORD, 0, Op.EQ, [alice])], strict: true })
      await check1(transfer(alice), [A])
      await expectRevert(check1(transfer(alice), [A, B]), policy, 'NoConstraint', [0, B])
    })

    it('each call of a batch is judged with the attachments it matched, and the error names it', async () => {
      await configure(A, recipients([alice]))
      await configure(B, receiverIsSafe(SUPPLY, 2))
      const supply = (onBehalfOf: string) =>
        call(pool, aave.encodeFunctionData('supply', [usdc, 5n, onBehalfOf, 0]))
      const matches = [
        { callIndex: 0, attachmentId: A },
        { callIndex: 1, attachmentId: B },
      ]
      await check([transfer(alice), supply(safe)], matches)
      await expectRevert(check([transfer(alice), supply(eve)], matches), policy, 'ConstraintFailed', [
        1,
        B,
        0,
      ])
      await expectRevert(check([transfer(eve), supply(safe)], matches), policy, 'ConstraintFailed', [0, A, 0])
    })

    it('an attachment configured for another engine or Safe does not apply', async () => {
      await configure(A, { constraints: [], strict: true })
      const other = await ethers.deployContract('ArgsLimitEngineStub')
      await other.check(policy, ctx, [transfer(alice)], [{ callIndex: 0, level: 3, attachmentId: A }])
      await engine.check(
        policy,
        { ...ctx, safe: alice },
        [transfer(alice)],
        [{ callIndex: 0, level: 3, attachmentId: A }],
      )
    })

    it('a check without matches is NoMatches', async () => {
      await expectRevert(check([transfer(alice)], []), policy, 'NoMatches')
    })
  })

  describe('presets', () => {
    it('Recipients: transfer word 0, transferFrom word 1, plain sends to, all IN the list', async () => {
      await configure(A, recipients([alice, bob]))
      await check1(transfer(alice))
      await check1(transfer(bob))
      await check1(call(usdc, erc20.encodeFunctionData('transferFrom', [safe, bob, 1n])))
      await check1(call(alice, '0x', 1n))
      await expectRevert(check1(transfer(eve)), policy, 'ConstraintFailed', [0, A, 0])
      await expectRevert(
        check1(call(usdc, erc20.encodeFunctionData('transferFrom', [safe, eve, 1n]))),
        policy,
        'ConstraintFailed',
        [0, A, 1],
      )
      await expectRevert(check1(call(eve, '0x', 1n)), policy, 'ConstraintFailed', [0, A, 2])
      // Strict: any other shape is denied, including a revocation (dropped from rev 2 Recipients).
      await expectRevert(
        check1(call(usdc, erc20.encodeFunctionData('approve', [eve, 0n]))),
        policy,
        'NoConstraint',
        [0, A],
      )
    })

    it('Spenders: approve word 0 IN spenders, word 1 LTE cap', async () => {
      await configure(A, spenders([pool], 1000n))
      await check1(call(usdc, erc20.encodeFunctionData('approve', [pool, 1000n])))
      await check1(call(usdc, erc20.encodeFunctionData('approve', [pool, 0n])))
      await expectRevert(
        check1(call(usdc, erc20.encodeFunctionData('approve', [pool, 1001n]))),
        policy,
        'ConstraintFailed',
        [0, A, 1],
      )
      await expectRevert(
        check1(call(usdc, erc20.encodeFunctionData('approve', [eve, 1n]))),
        policy,
        'ConstraintFailed',
        [0, A, 0],
      )
      // `approve(x, 0)` for a spender outside the list no longer passes.
      await expectRevert(
        check1(call(usdc, erc20.encodeFunctionData('approve', [eve, 0n]))),
        policy,
        'ConstraintFailed',
        [0, A, 0],
      )
    })

    it('Receiver-is-the-Safe: EQ_SAFE on the receiver word (Aave supply onBehalfOf)', async () => {
      await configure(A, receiverIsSafe(SUPPLY, 2))
      await check1(call(pool, aave.encodeFunctionData('supply', [usdc, 5n, safe, 0])))
      await expectRevert(
        check1(call(pool, aave.encodeFunctionData('supply', [usdc, 5n, eve, 0]))),
        policy,
        'ConstraintFailed',
        [0, A, 0],
      )
      await expectRevert(check1(transfer(safe)), policy, 'NoConstraint', [0, A])
    })
  })
})
