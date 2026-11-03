import { expect } from 'chai'
import { ZeroAddress, concat } from 'ethers'
import { ethers } from 'hardhat'
import { expectEvent } from '../helpers'
import {
  ANY,
  Behaviour,
  CallMatch,
  Kind,
  Level,
  OWNERS,
  Op,
  SEL,
  allow,
  attachmentId,
  deny,
  execModule,
  execOwner,
  expectRevert,
  levelOf,
  policy,
  scope,
  scopeKey,
  setup,
} from './fixtures'

/**
 * SPEC.md §3 and §6.3: the 8-scope lookup, the per-Safe level bitmap, op masks and the
 * DELEGATECALL rules.
 */
describe('V2 engine: scope lattice', () => {
  const ping = concat([SEL.ping, '0x'])

  // [level, scope builder, call that must match, calls that must not]
  type Case = { name: string; mk: (module: string, target: string) => ReturnType<typeof scope> }
  const cases: Case[] = [
    { name: '0 (ANY, *)', mk: () => scope(ANY) },
    { name: '1 (ANY, to.*)', mk: (_, t) => scope(ANY, CallMatch.TO, t) },
    { name: '2 (ANY, *.sel)', mk: () => scope(ANY, CallMatch.SELECTOR, ZeroAddress, SEL.ping) },
    { name: '3 (ANY, to.sel)', mk: (_, t) => scope(ANY, CallMatch.TO_SELECTOR, t, SEL.ping) },
    { name: '4 (A, *)', mk: (m) => scope(m) },
    { name: '5 (A, to.*)', mk: (m, t) => scope(m, CallMatch.TO, t) },
    { name: '6 (A, *.sel)', mk: (m) => scope(m, CallMatch.SELECTOR, ZeroAddress, SEL.ping) },
    { name: '7 (A, to.sel)', mk: (m, t) => scope(m, CallMatch.TO_SELECTOR, t, SEL.ping) },
  ]

  cases.forEach((c, lvl) => {
    it(`level ${c.name}: grants exactly the calls it names`, async () => {
      const [, module] = await ethers.getSigners()
      const target = await ethers.deployContract('EngineTarget')
      const t = await target.getAddress()
      const s = c.mk(module.address, t)
      expect(levelOf(s)).to.equal(lvl)
      const f = await setup([allow(s)])
      expect(Number(await f.engine.levelsUsed(f.safeAddr))).to.equal(1 << lvl)

      // The matching call: module -> t.ping
      await execModule(f.safe, f.module, t, ping)

      const namesTo = s.callMatch === CallMatch.TO || s.callMatch === CallMatch.TO_SELECTOR
      const namesSel = s.callMatch === CallMatch.SELECTOR || s.callMatch === CallMatch.TO_SELECTOR
      // Other target
      if (namesTo) {
        await expectRevert(execModule(f.safe, f.module, f.target2Addr, ping), f.engine, 'NotGranted', [
          0,
          f.target2Addr,
          SEL.ping,
          Op.CALL,
        ])
      } else {
        await execModule(f.safe, f.module, f.target2Addr, ping)
      }
      // Other selector
      const transfer = concat([SEL.transfer, ethers.zeroPadValue('0x01', 32)])
      if (namesSel) {
        await expectRevert(execModule(f.safe, f.module, t, transfer), f.engine, 'NotGranted', [
          0,
          t,
          SEL.transfer,
          Op.CALL,
        ])
      } else {
        await execModule(f.safe, f.module, t, transfer)
      }
      // Owner path: matched by ANY levels only
      if (lvl < 4) {
        await execOwner(f.safe, t, ping)
      } else {
        await expectRevert(execOwner(f.safe, t, ping), f.engine, 'NotGranted', [0, t, SEL.ping, Op.CALL])
      }
    })
  })

  it('a scope for one module never matches another module', async () => {
    const [, module, other] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address)), allow(scope(OWNERS))])
    await execOwner(f.safe, f.safeAddr, f.safe.interface.encodeFunctionData('enableModule', [other.address]))
    await execModule(f.safe, module, f.targetAddr, ping)
    await expectRevert(execModule(f.safe, other, f.targetAddr, ping), f.engine, 'NotGranted')
  })

  it('OWNERS scopes apply to the owner path only; ANY applies to everyone', async () => {
    const f = await setup()
    await expectRevert(execOwner(f.safe, f.targetAddr, ping), f.engine, 'NotGranted')
    const g = await setup([allow(scope(OWNERS))])
    await execOwner(g.safe, g.targetAddr, ping)
    await expectRevert(execModule(g.safe, g.module, g.targetAddr, ping), g.engine, 'NotGranted')
    const h = await setup([allow(scope(ANY))])
    await execOwner(h.safe, h.targetAddr, ping)
    await execModule(h.safe, h.module, h.targetAddr, ping)
  })

  it('empty calldata matches selector 0x00000000 (distinct from the selector wildcard)', async () => {
    const [, module] = await ethers.getSigners()
    const target = await ethers.deployContract('EngineTarget')
    const t = await target.getAddress()
    const f = await setup([allow(scope(module.address, CallMatch.TO_SELECTOR, t, SEL.empty))])
    await execModule(f.safe, f.module, t, '0x')
    await execModule(f.safe, f.module, t, '0x00000000aa') // V1 equivalence: 0x00000000 prefix
    await expectRevert(execModule(f.safe, f.module, t, ping), f.engine, 'NotGranted')
  })

  it('denies 1 to 3 bytes of calldata with InvalidSelector', async () => {
    const f = await setup([allow(scope(ANY))])
    await expectRevert(
      execModule(f.safe, f.module, f.targetAddr, '0x123456'),
      f.engine,
      'InvalidSelector',
      [0],
    )
    await expectRevert(execOwner(f.safe, f.targetAddr, '0x12'), f.engine, 'InvalidSelector', [0])
  })

  it('tracks the level bitmap through attach and detach, and skips empty levels', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup()
    const s0 = scope(ANY)
    const s7 = scope(module.address, CallMatch.TO_SELECTOR, f.targetAddr, SEL.ping)
    const s5 = scope(module.address, CallMatch.TO, f.targetAddr)
    expect(Number(await f.engine.levelsUsed(f.safeAddr))).to.equal(0)
    // configureImmediately is closed once installed; use a fresh Safe for each change set.
    const { configureLater, deploySafe } = await import('./fixtures')
    const fresh = await deploySafe()
    await f.engine.connect(fresh.asSafe).configureImmediately([allow(s0), deny(s5), allow(s7)], [])
    expect(Number(await f.engine.levelsUsed(fresh.address))).to.equal((1 << 0) | (1 << 5) | (1 << 7))
    await configureLater(f.engine, fresh.asSafe, [{ ...deny(s5), changeType: 1 }])
    expect(Number(await f.engine.levelsUsed(fresh.address))).to.equal((1 << 0) | (1 << 7))
    const views = await f.engine.getAttachments(fresh.address)
    expect(views.map((v) => v.attachmentId)).to.have.members([
      attachmentId(s0, Kind.ALLOW),
      attachmentId(s7, Kind.ALLOW),
    ])
    expect(await f.engine.scopeKey(s7)).to.equal(scopeKey(s7))
  })
})

describe('V2 engine: op masks and DELEGATECALL', () => {
  it('an attachment covers only the ops in its mask; mask 0 means CALL', async () => {
    const [, module] = await ethers.getSigners()
    const target = await ethers.deployContract('EngineTarget')
    const t = await target.getAddress()
    const exact = scope(module.address, CallMatch.TO_SELECTOR, t, SEL.ping)
    // Exact ALLOW covering DELEGATECALL only.
    const f = await setup([allow(exact, 2)])
    await execModule(f.safe, f.module, t, SEL.ping, Op.DELEGATECALL)
    await expectRevert(execModule(f.safe, f.module, t, SEL.ping, Op.CALL), f.engine, 'NotGranted', [
      0,
      t,
      SEL.ping,
      Op.CALL,
    ])
    // Mask 0 = CALL only
    const g = await setup([allow(scope(module.address, CallMatch.TO_SELECTOR, t, SEL.ping), 0)])
    await execModule(g.safe, g.module, t, SEL.ping)
    await expectRevert(execModule(g.safe, g.module, t, SEL.ping, Op.DELEGATECALL), g.engine, 'NotGranted')
    const attachment = await g.engine.getAttachment(g.safeAddr, attachmentId(exact, Kind.ALLOW))
    expect(attachment[0]).to.equal(true)
    expect(attachment[1].opMask).to.equal(1n)
  })

  it('a wildcard ALLOW never grants DELEGATECALL; restrictions may cover it anywhere', async () => {
    const [, module] = await ethers.getSigners()
    const target = await ethers.deployContract('EngineTarget')
    const t = await target.getAddress()
    const f = await setup([
      allow(scope(module.address)),
      allow(scope(module.address, CallMatch.TO_SELECTOR, t, SEL.ping), 3),
      deny(scope(ANY, CallMatch.SELECTOR, ZeroAddress, SEL.transfer), 2),
    ])
    // Wildcard ALLOW at (A, *) is CALL only: a DELEGATECALL elsewhere is not granted.
    await expectRevert(
      execModule(f.safe, f.module, f.target2Addr, SEL.ping, Op.DELEGATECALL),
      f.engine,
      'NotGranted',
    )
    await execModule(f.safe, f.module, t, SEL.ping, Op.DELEGATECALL)
    // DENY covering DELEGATECALL at level 2.
    const transfer = concat([SEL.transfer, ethers.zeroPadValue('0x01', 32)])
    await execModule(f.safe, f.module, t, transfer, Op.CALL)
    await expectRevert(execModule(f.safe, f.module, t, transfer, Op.DELEGATECALL), f.engine, 'Denied', [
      0,
      attachmentId(scope(ANY, CallMatch.SELECTOR, ZeroAddress, SEL.transfer), Kind.DENY),
    ])
  })

  it('PolicySignLib DELEGATECALLs (typed and signMessage) are matched as CALL; others stay DELEGATECALL', async () => {
    const lib = await ethers.deployContract('EngineTarget')
    const libAddr = await lib.getAddress()
    const f = await setup([allow(scope(OWNERS))], [], { signLib: libAddr })
    const signPermit = ethers.id('signPermit(address,address,uint256,uint256,uint256)').slice(0, 10)
    const signMessage = ethers.id('signMessage(bytes32)').slice(0, 10)
    expect(signPermit).to.equal('0x51bdfa61')
    const tx = await execOwner(f.safe, libAddr, concat([signPermit, ethers.ZeroHash]), Op.DELEGATECALL)
    // The target's code ran in the Safe's context (DELEGATECALL really executed).
    const { eventsOf } = await import('../helpers')
    expect((await eventsOf(tx, f.safe, 'ExecutionSuccess')).length).to.equal(1)
    // signMessage too since D-22: a CALL Allow grants it (the Safe can sign as a nested owner).
    const message = await execOwner(f.safe, libAddr, concat([signMessage, ethers.ZeroHash]), Op.DELEGATECALL)
    expect((await eventsOf(message, f.safe, 'ExecutionSuccess')).length).to.equal(1)
    await expectRevert(execOwner(f.safe, libAddr, SEL.ping, Op.DELEGATECALL), f.engine, 'NotGranted')
    await expectRevert(
      execOwner(f.safe, f.targetAddr, concat([signPermit, ethers.ZeroHash]), Op.DELEGATECALL),
      f.engine,
      'NotGranted',
    )
  })

  it('restrictions match the raw op too: a DELEGATECALL-only DENY or policy on SIGN_LIB fires (D-23)', async () => {
    const lib = await ethers.deployContract('EngineTarget')
    const libAddr = await lib.getAddress()
    const signPermit = '0x51bdfa61'
    const exact = scope(OWNERS, CallMatch.TO_SELECTOR, libAddr, signPermit)
    const data = concat([signPermit, ethers.ZeroHash])
    // A DENY whose mask names only DELEGATECALL, what a user who knows signing is a DELEGATECALL picks.
    const denied = await setup([allow(scope(OWNERS)), deny(exact, 2)], [], { signLib: libAddr })
    await expectRevert(execOwner(denied.safe, libAddr, data, Op.DELEGATECALL), denied.engine, 'Denied', [
      0,
      attachmentId(exact, Kind.DENY),
    ])
    // A policy with the same mask runs.
    const p = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const runs = await setup(
      [
        allow(scope(OWNERS)),
        policy(scope(ANY, CallMatch.TO, libAddr), await p.getAddress(), Behaviour.REVERT, 2),
      ],
      [],
      { signLib: libAddr },
    )
    await expectRevert(execOwner(runs.safe, libAddr, data, Op.DELEGATECALL), runs.engine, 'PolicyDenied')
    // An ALLOW still grants by the effective op only: a DELEGATECALL-only exact Allow does not
    // grant the typed entry (a CALL one does).
    const allowOnly = await setup([allow(exact, 2)], [], { signLib: libAddr })
    await expectRevert(
      execOwner(allowOnly.safe, libAddr, data, Op.DELEGATECALL),
      allowOnly.engine,
      'NotGranted',
    )
  })

  it('emits ExecutionSuccess through the mock for an allowed owner transaction', async () => {
    const f = await setup([allow(scope(OWNERS))])
    const tx = await execOwner(f.safe, f.targetAddr, SEL.ping)
    await expectEvent(tx, f.target, 'Hit')
  })
})
