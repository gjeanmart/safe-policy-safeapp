import { expect } from 'chai'
import { ZeroAddress, concat } from 'ethers'
import { ethers } from 'hardhat'
import {
  ANY,
  Behaviour,
  CallMatch,
  GateKind,
  Kind,
  Level,
  NO_LEVEL,
  OWNERS,
  Op,
  SEL,
  TX_INDEX,
  Verdict,
  allow,
  attachmentId,
  deny,
  execModule,
  expectRevert,
  multiSendData,
  policy,
  previewGates,
  scope,
  setup,
} from './fixtures'

/** SPEC.md §6.7: preview runs every gate, never stops, never persists. */
describe('V2 engine: preview', () => {
  it('reports every gate in evaluation order, without stopping at a deny', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const tp = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const cpA = await cp.getAddress()
    const tpA = await tp.getAddress()
    const sAny = scope(ANY)
    const sA = scope(module.address)
    const f = await setup([
      allow(sA),
      deny(sAny),
      policy(sAny, cpA, Behaviour.REVERT),
      policy(sA, cpA, Behaviour.PASS),
      policy(sA, tpA, Behaviour.WRONG_MAGIC),
    ])
    const gates = await previewGates(f.engine, f.safeAddr, module.address, f.targetAddr, SEL.ping)
    const idCp0 = attachmentId(sAny, Kind.POLICY, cpA)
    expect(
      gates.map((g) => [g.callIndex, g.scopeLevel, g.kind, g.attachmentId, g.verdict, g.reasonName]),
    ).to.deep.equal([
      [0, 0, GateKind.DENY, attachmentId(sAny, Kind.DENY), Verdict.DENY, 'Denied'],
      [0, 4, GateKind.ALLOW, attachmentId(sA, Kind.ALLOW), Verdict.ALLOW, ''],
      // One call-level run (both attachments), denied by the first REVERT attachment.
      [0, 0, GateKind.POLICY, idCp0, Verdict.DENY, gates[2].reasonName],
      [0, 4, GateKind.POLICY, attachmentId(sA, Kind.POLICY, cpA), Verdict.DENY, gates[2].reasonName],
      [TX_INDEX, 4, GateKind.POLICY, attachmentId(sA, Kind.POLICY, tpA), Verdict.DENY, ''],
    ])
    expect(gates[2].reason).to.equal(cp.interface.encodeErrorResult('MockDenied', [idCp0]))
    expect(gates[2].policy).to.equal(cpA)
  })

  it('reports a non-counting ALLOW as PASS + AllowNotExact and adds the NotGranted rule gate', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address))])
    const data = f.safe.interface.encodeFunctionData('setGuard', [ZeroAddress])
    const gates = await previewGates(f.engine, f.safeAddr, module.address, f.safeAddr, data)
    expect(gates.map((g) => [g.kind, g.verdict, g.reasonName])).to.deep.equal([
      [GateKind.ALLOW, Verdict.PASS, 'AllowNotExact'],
      [GateKind.RULE, Verdict.DENY, 'NotGranted'],
    ])
    expect(gates[1].scopeLevel).to.equal(NO_LEVEL)
    // The same transaction for the owners: allowed (no DENY gate) once they have an ALLOW.
    const g = await setup([allow(scope(OWNERS))])
    const ok = await previewGates(g.engine, g.safeAddr, OWNERS, g.safeAddr, data)
    expect(ok.every((x) => x.verdict !== Verdict.DENY)).to.equal(true)
  })

  it('reports engine-rule gates: malformed batch (single gate), invalid selector, module config, config path', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address)), allow(scope(OWNERS))])
    const malformed = await previewGates(
      f.engine,
      f.safeAddr,
      module.address,
      f.multiSendAddr,
      concat(['0x8d80ff0a', ethers.ZeroHash]),
      Op.DELEGATECALL,
    )
    expect(malformed.map((g) => [g.callIndex, g.kind, g.reasonName])).to.deep.equal([
      [TX_INDEX, GateKind.RULE, 'MalformedBatch'],
    ])
    const short = await previewGates(f.engine, f.safeAddr, module.address, f.targetAddr, '0x1234')
    expect(short.map((g) => g.reasonName)).to.deep.equal(['InvalidSelector'])
    const req = f.engine.interface.encodeFunctionData('requestConfiguration', [ethers.ZeroHash])
    expect(
      (await previewGates(f.engine, f.safeAddr, module.address, f.engineAddr, req)).map((g) => g.reasonName),
    ).to.deep.equal(['ModuleConfigurationDenied'])
    expect(await previewGates(f.engine, f.safeAddr, OWNERS, f.engineAddr, req)).to.deep.equal([])
    // A batch: gates for every call, the bad one included.
    const batch = multiSendData([
      { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping },
      {
        op: Op.CALL,
        to: f.engineAddr,
        value: 0n,
        data: f.engine.interface.encodeFunctionData('levelsUsed', [f.safeAddr]),
      },
    ])
    const gates = await previewGates(
      f.engine,
      f.safeAddr,
      module.address,
      f.multiSendAddr,
      batch,
      Op.DELEGATECALL,
    )
    expect(gates.map((g) => [g.callIndex, g.kind, g.verdict, g.reasonName])).to.deep.equal([
      [0, GateKind.ALLOW, Verdict.ALLOW, ''],
      [1, GateKind.RULE, Verdict.DENY, 'GuardTargetDenied'],
      [1, GateKind.ALLOW, Verdict.PASS, 'AllowNotExact'],
      [1, GateKind.RULE, Verdict.DENY, 'NotGranted'],
    ])
  })

  it('reports an out-of-gas policy instead of aborting', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const s = scope(module.address, CallMatch.ANY)
    const f = await setup([allow(s), policy(s, await cp.getAddress(), Behaviour.BURN_GAS)])
    const gates = await previewGates(f.engine, f.safeAddr, module.address, f.targetAddr, SEL.ping)
    expect(gates.map((g) => [g.kind, g.verdict, g.reason])).to.deep.equal([
      [GateKind.ALLOW, Verdict.ALLOW, '0x'],
      [GateKind.POLICY, Verdict.DENY, '0x'],
    ])
  })

  it('never persists: a policy that writes state on every check is unchanged, and the lock is released', async () => {
    const [, module] = await ethers.getSigners()
    const counter = await ethers.deployContract('EngineCountingPolicy', [Level.CALL])
    const s = scope(module.address)
    const f = await setup([allow(s), policy(s, await counter.getAddress())])
    // A sent transaction (not eth_call) that previews: reverts, nothing persists.
    await expectRevert(
      f.engine.preview(f.safeAddr, module.address, f.targetAddr, 0, SEL.ping, Op.CALL),
      f.engine,
      'Preview',
    )
    expect(await counter.checks()).to.equal(0n)
    expect(Number(await f.engine.levelsUsed(f.safeAddr))).to.equal(1 << 4)
    await execModule(f.safe, f.module, f.targetAddr, SEL.ping)
    expect(await counter.checks()).to.equal(1n)
  })

  it('InvalidActor for ANY', async () => {
    const f = await setup()
    await expectRevert(
      f.engine.preview(f.safeAddr, ANY, f.targetAddr, 0, '0x', 0),
      f.engine,
      'InvalidActor',
      [ANY],
    )
  })
})
