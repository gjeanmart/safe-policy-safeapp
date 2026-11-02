import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import { AbiCoder, ZeroAddress, concat, getAddress, getBytes, hexlify, keccak256 } from 'ethers'
import { ethers } from 'hardhat'
import type { FreezePolicy, TimelockEngineStub, TimelockMockSafe } from '../../../typechain-types'
import { expectRevert } from '../helpers'

/**
 * FreezePolicy (SPEC.md §7.1, §8.1): a stateless reader of the engine's freeze state, attached by
 * placement. Runs against TimelockEngineStub, which holds the freeze state machine and calls the
 * policy as the engine does.
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CallMatch = { ANY: 0, TO: 1 } as const
const POLICY_KIND = 2
const OP_ALL = 3
const HOUR = 3600
const F = 7 * 24 * HOUR
const C = 12 * HOUR
const GUARDIAN = 0
const LIFTER = 1

type Scope = { actor: string; to: string; selector: string; callMatch: number }
const scope = (actor: string, to = ZeroAddress, callMatch: number = CallMatch.ANY): Scope => ({
  actor,
  to,
  selector: '0x00000000',
  callMatch,
})
const attachmentId = (s: Scope, policy: string) =>
  keccak256(
    coder.encode(
      ['bytes32', 'uint8', 'address'],
      [
        keccak256(
          coder.encode(['address', 'address', 'bytes4', 'uint8'], [s.actor, s.to, s.selector, s.callMatch]),
        ),
        POLICY_KIND,
        policy,
      ],
    ),
  )
const encodeFreeze = (safeWide: boolean, actor: boolean) =>
  coder.encode(['tuple(bool,bool)'], [[safeWide, actor]])

async function sign(hash: string, signers: HardhatEthersSigner[]): Promise<string> {
  const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const sigs = await Promise.all(
    sorted.map(async (s) => {
      const b = getBytes(await s.signMessage(getBytes(hash)))
      b[64] += 4
      return b
    }),
  )
  return hexlify(concat(sigs))
}

function revertData(e: unknown): string | undefined {
  const err = e as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } }
  for (const d of [err?.data, err?.info?.error?.data, err?.error?.data]) {
    if (typeof d === 'string' && d.startsWith('0x')) return d
    if (d && typeof (d as { data?: unknown }).data === 'string') return (d as { data: string }).data
  }
  return undefined
}

/** Asserts `outerError` from the stub naming `policy`, with a reason decoding to `errorName(args)`. */
async function expectPolicyError(
  action: Promise<unknown>,
  stub: TimelockEngineStub,
  policy: FreezePolicy,
  errorName: string,
  args?: unknown[],
  outerError = 'PolicyDenied',
): Promise<void> {
  let data: string | undefined
  try {
    await action
  } catch (e) {
    data = revertData(e)
    if (data === undefined) throw e
  }
  if (data === undefined) expect.fail(`expected ${outerError}(${errorName}), but the call succeeded`)
  const outer = stub.interface.parseError(data)
  expect(outer?.name, `revert data ${data}`).to.equal(outerError)
  expect(outer!.args.policy).to.equal(await policy.getAddress())
  const inner = policy.interface.parseError(outer!.args.reason)
  expect(inner?.name).to.equal(errorName)
  if (args) {
    expect([...inner!.args].map((a) => (typeof a === 'string' ? a.toLowerCase() : a))).to.deep.equal(
      args.map((a) => (typeof a === 'string' ? a.toLowerCase() : typeof a === 'number' ? BigInt(a) : a)),
    )
  }
}

async function deploy() {
  const [, o1, o2, guardian, lifter, ops, recovery, outsider] = await ethers.getSigners()
  const stub = await ethers.deployContract('TimelockEngineStub', [F, C, ZeroAddress])
  const freeze = await ethers.deployContract('FreezePolicy')
  const safe = await ethers.deployContract('TimelockMockSafe', [
    [o1.address, o2.address],
    2,
    await stub.getAddress(),
    [ops.address, recovery.address],
  ])
  const safeAddress = await safe.getAddress()
  await stub.setRole(safeAddress, GUARDIAN, guardian.address, true)
  await stub.setRole(safeAddress, LIFTER, lifter.address, true)
  const target = getAddress('0x000000000000000000000000000000000000d1a1')
  return { o1, o2, guardian, lifter, ops, recovery, outsider, stub, freeze, safe, safeAddress, target }
}

type Fx = Awaited<ReturnType<typeof deploy>>

async function attach(fx: Fx, s: Scope, safeWide: boolean, actor: boolean) {
  const policy = await fx.freeze.getAddress()
  const tx = await fx.stub.attachPolicy(fx.safeAddress, s, policy, OP_ALL, encodeFreeze(safeWide, actor))
  return { id: attachmentId(s, policy), tx }
}

async function execOwner(fx: Fx, safe: TimelockMockSafe, to: string) {
  const hash = await safe.getTransactionHash(
    to,
    0,
    '0x',
    0,
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    await safe.nonce(),
  )
  return safe.execTransaction(to, 0, '0x', 0, await sign(hash, [fx.o1, fx.o2]))
}

const execModule = (fx: Fx, module: HardhatEthersSigner, to: string) =>
  fx.safe.connect(module).execTransactionFromModule(to, 0, '0x', 0)

describe('FreezePolicy (WP3)', () => {
  describe('settings', () => {
    it('stores the flags, reports no delay floor, and needs at least one flag', async () => {
      const fx = await loadFixture(deploy)
      const { id, tx } = await attach(fx, scope(OWNERS), true, false)
      const receipt = await tx.wait()
      const configured = receipt!.logs
        .map((l) => fx.stub.interface.parseLog(l))
        .find((l) => l?.name === 'Configured')
      expect(configured!.args.delayFloor).to.equal(0n)
      const s = await fx.freeze.getSettings(await fx.stub.getAddress(), fx.safeAddress, id)
      expect([s.safeWide, s.actor]).to.deep.equal([true, false])
      const both = await attach(fx, scope(fx.ops.address), true, true)
      const s2 = await fx.freeze.getSettings(await fx.stub.getAddress(), fx.safeAddress, both.id)
      expect([s2.safeWide, s2.actor]).to.deep.equal([true, true])

      await expectPolicyError(
        fx.stub.attachPolicy(
          fx.safeAddress,
          scope(OWNERS),
          await fx.freeze.getAddress(),
          OP_ALL,
          encodeFreeze(false, false),
        ),
        fx.stub,
        fx.freeze,
        'InvalidSettings',
        [],
        'PolicyConfigurationFailed',
      )
    })

    it('encodes settings and is a transaction-level IPolicyV2', async () => {
      const { freeze } = await loadFixture(deploy)
      expect(await freeze.encodeSettings({ safeWide: true, actor: false })).to.equal(
        encodeFreeze(true, false),
      )
      expect(await freeze.policyLevel()).to.equal(1n)
      expect(await freeze.supportsInterface('0x55872811')).to.equal(true)
      expect(await freeze.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await freeze.supportsInterface('0xffffffff')).to.equal(false)
    })
  })

  describe('Safe-wide freeze', () => {
    it('denies the owners while frozen, until lifted', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), true, false)
      await execOwner(fx, fx.safe, fx.target)

      await fx.stub.connect(fx.guardian).freeze([fx.safeAddress])
      const until = (await fx.stub.getFreezeState(fx.safeAddress, ANY)).frozenUntil
      expect(until).to.equal(BigInt(await time.latest()) + BigInt(F))
      await expectPolicyError(execOwner(fx, fx.safe, fx.target), fx.stub, fx.freeze, 'Frozen', [
        fx.safeAddress,
        ANY,
        until,
      ])

      await fx.stub.connect(fx.lifter).lift(fx.safeAddress, ANY)
      await execOwner(fx, fx.safe, fx.target)
    })

    it('stops denying when the freeze expires after F', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), true, false)
      await fx.stub.connect(fx.guardian).freeze([fx.safeAddress])
      const until = (await fx.stub.getFreezeState(fx.safeAddress, ANY)).frozenUntil
      await time.setNextBlockTimestamp(until - 1n)
      await expectPolicyError(execOwner(fx, fx.safe, fx.target), fx.stub, fx.freeze, 'Frozen')
      await time.setNextBlockTimestamp(until)
      await execOwner(fx, fx.safe, fx.target)
    })

    it('does not deny an actor-only attachment', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), false, true)
      await fx.stub.connect(fx.guardian).freeze([fx.safeAddress])
      await execModule(fx, fx.ops, fx.target)
    })
  })

  describe('actor freeze (agent kill switch)', () => {
    it("denies the frozen actor through an actor attachment, reporting the actor's freeze", async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), false, true)
      await fx.stub.connect(fx.guardian).freezeActor(fx.safeAddress, fx.ops.address)
      const until = (await fx.stub.getFreezeState(fx.safeAddress, fx.ops.address)).frozenUntil
      await expectPolicyError(execModule(fx, fx.ops, fx.target), fx.stub, fx.freeze, 'Frozen', [
        fx.safeAddress,
        fx.ops.address,
        until,
      ])
      await fx.stub.connect(fx.guardian).lift(fx.safeAddress, fx.ops.address)
      await execModule(fx, fx.ops, fx.target)
    })

    it('does not deny a Safe-wide-only attachment, nor another actor', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), true, false)
      await attach(fx, scope(fx.recovery.address), true, true)
      await fx.stub.connect(fx.guardian).freezeActor(fx.safeAddress, fx.ops.address)
      await execModule(fx, fx.ops, fx.target)
      await execModule(fx, fx.recovery, fx.target)
    })
  })

  describe('merge and placement', () => {
    it('denies if any matched attachment reads an active freeze', async () => {
      const fx = await loadFixture(deploy)
      // (ops, *) reads the Safe-wide freeze; (ops, target.*) also reads the actor freeze.
      await attach(fx, scope(fx.ops.address), true, false)
      await attach(fx, scope(fx.ops.address, fx.target, CallMatch.TO), false, true)
      await fx.stub.connect(fx.guardian).freezeActor(fx.safeAddress, fx.ops.address)
      await expectPolicyError(execModule(fx, fx.ops, fx.target), fx.stub, fx.freeze, 'Frozen')
      await execModule(fx, fx.ops, fx.outsider.address)
    })

    it('reports the Safe-wide freeze first when both are active', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(fx.ops.address), true, true)
      await fx.stub.connect(fx.guardian).freezeActor(fx.safeAddress, fx.ops.address)
      await fx.stub.connect(fx.guardian).freeze([fx.safeAddress])
      const until = (await fx.stub.getFreezeState(fx.safeAddress, ANY)).frozenUntil
      await expectPolicyError(execModule(fx, fx.ops, fx.target), fx.stub, fx.freeze, 'Frozen', [
        fx.safeAddress,
        ANY,
        until,
      ])
    })

    it('lets recovery through a Safe-wide freeze because nothing froze it (placement, no exemption)', async () => {
      const fx = await loadFixture(deploy)
      await attach(fx, scope(OWNERS), true, false)
      await attach(fx, scope(fx.ops.address), true, true)
      await fx.stub.connect(fx.guardian).freeze([fx.safeAddress])
      await expectPolicyError(execOwner(fx, fx.safe, fx.target), fx.stub, fx.freeze, 'Frozen')
      await expectPolicyError(execModule(fx, fx.ops, fx.target), fx.stub, fx.freeze, 'Frozen')
      await execModule(fx, fx.recovery, fx.target)
    })

    it('keeps settings per engine: another engine sees none', async () => {
      const fx = await loadFixture(deploy)
      const { id } = await attach(fx, scope(OWNERS), true, true)
      const s = await fx.freeze.getSettings(fx.outsider.address, fx.safeAddress, id)
      expect([s.safeWide, s.actor]).to.deep.equal([false, false])
    })
  })

  describe('engine-facing input checks', () => {
    it('rejects a call-level check (WrongPolicyLevel) and an empty id list (NoAttachments)', async () => {
      const fx = await loadFixture(deploy)
      const ctx = {
        safe: fx.safeAddress,
        actor: OWNERS,
        txHash: keccak256('0x01'),
        nonce: 0,
        executor: fx.o1.address,
      }
      const policy = await fx.freeze.getAddress()
      await expectRevert(
        fx.stub.callCheckCall(policy, ctx, { to: fx.target, value: 0, data: '0x', operation: 0 }, [
          keccak256('0x02'),
        ]),
        fx.freeze,
        'WrongPolicyLevel',
      )
      await expectRevert(fx.stub.callCheckTransaction(policy, ctx, [], []), fx.freeze, 'NoAttachments')
    })
  })
})
