import { expect } from 'chai'
import { ZeroAddress, concat, toBeHex, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import { eventsOf } from '../helpers'
import {
  ANY,
  CONTEXT_TYPE_HASH,
  CallMatch,
  Kind,
  Level,
  OWNERS,
  Op,
  SEL,
  allow,
  attachmentId,
  coder,
  coveredErrors,
  deny,
  envelope,
  execModule,
  execOwner,
  expectRevert,
  multiSendData,
  policy,
  scope,
  setup,
  withContext,
} from './fixtures'

/** SPEC.md §6.4 (Safe and engine targets), §6.6 (owner-path context), §6.1 re-entrancy. */
describe('V2 engine: Safe and engine targets (F5)', () => {
  it('module path: a call to the Safe needs an ALLOW at level 7; wildcard and (ANY, to.sel) ALLOWs do not count', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address)), allow(scope(ANY))])
    const setGuard = f.safe.interface.encodeFunctionData('setGuard', [ZeroAddress])
    const sel = setGuard.slice(0, 10)
    await expectRevert(execModule(f.safe, f.module, f.safeAddr, setGuard), f.engine, 'NotGranted', [
      0,
      f.safeAddr,
      sel,
      Op.CALL,
    ])
    // Owners: any matching ALLOW counts for a Safe-admin call.
    const enable = f.safe.interface.encodeFunctionData('enableModule', [ethers.Wallet.createRandom().address])
    await execOwner(f.safe, f.safeAddr, enable)
  })

  it('module path: an exact (module, safe.selector) ALLOW grants the Safe-admin call; restrictions still run', async () => {
    const [, module] = await ethers.getSigners()
    const { deploySafe, deployEngine } = await import('./fixtures')
    // Build the Safe first so the exact scope can name it.
    const { engine } = await deployEngine()
    const s = await deploySafe()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const enableSel = s.safe.interface.getFunction('enableModule')!.selector
    const exact = scope(module.address, CallMatch.TO_SELECTOR, s.address, enableSel)
    const level3 = scope(ANY, CallMatch.TO_SELECTOR, s.address, enableSel)
    await engine
      .connect(s.asSafe)
      .configureImmediately([allow(level3), allow(exact), policy(scope(ANY), await cp.getAddress())], [])
    const eAddr = await engine.getAddress()
    await execOwner(s.safe, s.address, s.safe.interface.encodeFunctionData('enableModule', [module.address]))
    await execOwner(s.safe, s.address, s.safe.interface.encodeFunctionData('setModuleGuard', [eAddr]))
    const tx = await execModule(
      s.safe,
      module,
      s.address,
      s.safe.interface.encodeFunctionData('enableModule', [ethers.Wallet.createRandom().address]),
    )
    expect((await eventsOf(tx, cp, 'CallChecked')).length).to.equal(1)
  })

  it('engine targets: hooks, configureImmediately, preview and views are GuardTargetDenied on both paths', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address)), allow(scope(OWNERS))])
    const e = f.engine.interface
    const calls = [
      e.encodeFunctionData('checkAfterExecution', [ethers.ZeroHash, true]),
      e.encodeFunctionData('configureImmediately', [[], []]),
      e.encodeFunctionData('levelsUsed', [f.safeAddr]),
      e.encodeFunctionData('preview', [f.safeAddr, OWNERS, f.targetAddr, 0, '0x', 0]),
      '0x',
    ]
    for (const data of calls) {
      await expectRevert(execOwner(f.safe, f.engineAddr, data), f.engine, 'GuardTargetDenied')
      await expectRevert(execModule(f.safe, f.module, f.engineAddr, data), f.engine, 'GuardTargetDenied')
    }
  })

  it('engine targets in a batch: configuration selectors are denied (owners: GuardTargetDenied, module: ModuleConfigurationDenied)', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address)), allow(scope(OWNERS))])
    const req = f.engine.interface.encodeFunctionData('requestConfiguration', [ethers.ZeroHash])
    const batch = multiSendData([{ op: Op.CALL, to: f.engineAddr, value: 0n, data: req }])
    await expectRevert(
      execOwner(f.safe, f.multiSendAddr, batch, Op.DELEGATECALL),
      f.engine,
      'GuardTargetDenied',
    )
    await expectRevert(
      execModule(f.safe, f.module, f.multiSendAddr, batch, Op.DELEGATECALL),
      f.engine,
      'ModuleConfigurationDenied',
    )
  })
})

describe('V2 engine: owner-path policy context (§6.6)', () => {
  async function ctxSetup() {
    const tp = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const tp2 = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const tpA = await tp.getAddress()
    const tp2A = await tp2.getAddress()
    const f = await setup([allow(scope(OWNERS)), policy(scope(OWNERS), tpA), policy(scope(ANY), tp2A)])
    return { f, tp, tp2, tpA, tp2A }
  }

  it('delivers each policy its own entry, the full signatures, and empty data when absent', async () => {
    const { f, tp, tp2, tpA } = await ctxSetup()
    const sigs = withContext([{ policy: tpA, data: '0xc0ffee' }], '0x' + 'ab'.repeat(65))
    const tx = await execOwner(f.safe, f.targetAddr, SEL.ping, Op.CALL, 0n, sigs)
    const [log] = await eventsOf(tx, tp, 'TransactionChecked')
    expect(log.args.policyData).to.equal('0xc0ffee')
    expect(log.args.signatures).to.equal(sigs)
    const [log2] = await eventsOf(tx, tp2, 'TransactionChecked')
    expect(log2.args.policyData).to.equal('0x')
    // No envelope: everyone gets empty data.
    const plain = await execOwner(f.safe, f.targetAddr, SEL.ping, Op.CALL, 0n, '0x1234')
    expect((await eventsOf(plain, tp, 'TransactionChecked'))[0].args.policyData).to.equal('0x')
  })

  it('MalformedContext: bad envelope, bad ABI, duplicate policy', async () => {
    const { f, tpA } = await ctxSetup()
    const bad = [
      // payload length runs past the front
      concat([zeroPadValue(toBeHex(999), 32), CONTEXT_TYPE_HASH]),
      // too short for the envelope
      CONTEXT_TYPE_HASH,
      // not an abi-encoded PolicyContext[]
      envelope('0x1234'),
      envelope(coder.encode(['uint256', 'uint256'], [0x40, 1])),
      // dirty address word
      envelope(
        concat([
          coder.encode(['uint256', 'uint256', 'uint256'], [0x20, 1, 0x20]),
          coder.encode(['uint256', 'uint256', 'uint256'], [(1n << 160n) + 1n, 0x40, 0]),
        ]),
      ),
      // data offset out of bounds
      envelope(
        concat([
          coder.encode(['uint256', 'uint256', 'uint256'], [0x20, 1, 0x20]),
          coder.encode(['uint256', 'uint256'], [1, 0x400]),
        ]),
      ),
      // a policy listed twice
      withContext([
        { policy: tpA, data: '0x01' },
        { policy: tpA, data: '0x02' },
      ]),
    ]
    for (const sigs of bad) {
      await expectRevert(
        execOwner(f.safe, f.targetAddr, SEL.ping, Op.CALL, 0n, sigs),
        f.engine,
        'MalformedContext',
      )
    }
    // An empty context list is fine.
    await execOwner(f.safe, f.targetAddr, SEL.ping, Op.CALL, 0n, withContext([]))
  })

  it('MalformedContext comes before the engine rules (the runner checks it before any deny)', async () => {
    const { f } = await ctxSetup()
    const engine = await f.engine.getAddress()
    // A call to the engine outside the configuration path is GuardTargetDenied...
    await expectRevert(execOwner(f.safe, engine, SEL.ping), f.engine, 'GuardTargetDenied')
    // ...unless the context is malformed: that deny comes first, as when the hook decoded it.
    await expectRevert(
      execOwner(f.safe, engine, SEL.ping, Op.CALL, 0n, envelope('0x1234')),
      f.engine,
      'MalformedContext',
    )
  })
})

describe('V2 engine: re-entrancy', () => {
  for (const [name, fn, args] of [
    ['requestConfiguration', 'requestConfiguration', [ethers.ZeroHash]],
    ['freeze', 'freeze', [[]]],
    ['a hook', 'checkAfterModuleExecution', [ethers.ZeroHash, true]],
    ['preview', 'preview', [ZeroAddress, OWNERS, ZeroAddress, 0, '0x', 0]],
  ] as const) {
    it(`a policy calling ${name} during a check gets Reentrancy (reported as its deny reason)`, async () => {
      const [, module] = await ethers.getSigners()
      const p = await ethers.deployContract('EngineReentrantPolicy', [Level.CALL])
      const pA = await p.getAddress()
      const { deployEngine } = await import('./fixtures')
      const { engine: iface } = await deployEngine()
      const callback = iface.interface.encodeFunctionData(fn as 'freeze', args as never)
      const s = scope(module.address)
      const f = await setup([
        allow(s),
        {
          changeType: 0,
          scope: s,
          kind: Kind.POLICY,
          policy: pA,
          opMask: 0,
          data: coder.encode(['bytes'], [callback]),
        },
      ])
      await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'PolicyDenied', [
        0,
        pA,
        f.engine.interface.encodeErrorResult('Reentrancy', []),
      ])
      coveredReentrancy()
    })
  }

  it('views stay callable during a check (policies read freezeStatus)', async () => {
    const [, module] = await ethers.getSigners()
    const p = await ethers.deployContract('EngineReentrantPolicy', [Level.TRANSACTION])
    const pA = await p.getAddress()
    const s = scope(module.address)
    const { deployEngine } = await import('./fixtures')
    const { engine: iface } = await deployEngine()
    const f = await setup([
      allow(s),
      {
        changeType: 0,
        scope: s,
        kind: Kind.POLICY,
        policy: pA,
        opMask: 0,
        data: coder.encode(['bytes'], [iface.interface.encodeFunctionData('getAttachments', [ZeroAddress])]),
      },
    ])
    await execModule(f.safe, f.module, f.targetAddr, SEL.ping)
  })
})

describe('V2 engine: getMatchingAttachments', () => {
  it('lists matches per call after the op filter, optionally for one policy; empty for a malformed batch', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const cpA = await cp.getAddress()
    const t = await (await ethers.deployContract('EngineTarget')).getAddress()
    const sAll = scope(module.address)
    const sT = scope(module.address, CallMatch.TO, t)
    const f = await setup([allow(sAll), policy(sT, cpA), deny(scope(ANY), 2)])
    const batch = multiSendData([
      { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping },
      { op: Op.CALL, to: t, value: 0n, data: SEL.ping },
    ])
    const all = await f.engine.getMatchingAttachments(
      f.safeAddr,
      module.address,
      f.multiSendAddr,
      0,
      batch,
      Op.DELEGATECALL,
      ZeroAddress,
    )
    expect(
      all.map((m) => [Number(m.callIndex), Number(m.scopeLevel), m.attachment.attachmentId]),
    ).to.deep.equal([
      [0, 4, attachmentId(sAll, Kind.ALLOW)],
      [1, 4, attachmentId(sAll, Kind.ALLOW)],
      [1, 5, attachmentId(sT, Kind.POLICY, cpA)],
    ])
    expect(all[2].attachment.scope.to).to.equal(t)
    const only = await f.engine.getMatchingAttachments(
      f.safeAddr,
      module.address,
      f.multiSendAddr,
      0,
      batch,
      Op.DELEGATECALL,
      cpA,
    )
    expect(only.length).to.equal(1)
    const malformed = await f.engine.getMatchingAttachments(
      f.safeAddr,
      module.address,
      f.multiSendAddr,
      0,
      concat(['0x8d80ff0a', ethers.ZeroHash]),
      Op.DELEGATECALL,
      ZeroAddress,
    )
    expect(malformed.length).to.equal(0)
    // DELEGATECALL: only the DENY (mask 2) matches.
    const dc = await f.engine.getMatchingAttachments(
      f.safeAddr,
      module.address,
      t,
      0,
      SEL.ping,
      Op.DELEGATECALL,
      ZeroAddress,
    )
    expect(dc.map((m) => Number(m.attachment.kind))).to.deep.equal([Kind.DENY])
  })
})

/** Reentrancy is asserted inside PolicyDenied's reason; record it for the coverage check. */
function coveredReentrancy() {
  coveredErrors.add('Reentrancy')
}
