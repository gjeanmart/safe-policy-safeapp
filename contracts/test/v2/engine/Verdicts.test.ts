import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress, concat } from 'ethers'
import { ethers } from 'hardhat'
import { eventsOf } from '../helpers'
import {
  ANY,
  Behaviour,
  CallMatch,
  Kind,
  Level,
  OWNERS,
  Op,
  SEL,
  TIMING,
  TX_INDEX,
  allow,
  coder,
  attachmentId,
  deny,
  execModule,
  execOwner,
  expectRevert,
  multiSendData,
  policy,
  scope,
  setup,
} from './fixtures'

const coderEncodeBytes = (b: string) => coder.encode(['bytes'], [b])

/** SPEC.md §4 (verdicts, grouping) and §6.2–6.5 (units, combination, batches). */
describe('V2 engine: verdict combination', () => {
  it('needs at least one ALLOW: a passing policy alone does not grant', async () => {
    const f0 = await setup()
    const f = await setup([policy(scope(ANY), f0.callPolicyAddr)])
    await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'NotGranted', [
      0,
      f.targetAddr,
      SEL.ping,
      Op.CALL,
    ])
  })

  it('ALLOW + passing policies passes; any DENY wins over ALLOW', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const tp = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const cpA = await cp.getAddress()
    const tpA = await tp.getAddress()
    const f = await setup([
      allow(scope(module.address)),
      policy(scope(ANY), cpA),
      policy(scope(module.address), tpA),
    ])
    const tx = await execModule(f.safe, f.module, f.targetAddr, SEL.ping)
    expect((await eventsOf(tx, cp, 'CallChecked')).length).to.equal(1)
    expect((await eventsOf(tx, tp, 'TransactionChecked')).length).to.equal(1)

    const target = await ethers.deployContract('EngineTarget')
    const t = await target.getAddress()
    const d = scope(ANY, CallMatch.TO, t)
    const g = await setup([allow(scope(module.address, CallMatch.TO_SELECTOR, t, SEL.ping)), deny(d)])
    await expectRevert(execModule(g.safe, g.module, t, SEL.ping), g.engine, 'Denied', [
      0,
      attachmentId(d, Kind.DENY),
    ])
  })

  it('DENY is reported before NotGranted and before policies', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const d = scope(module.address)
    const f = await setup([deny(d), policy(scope(ANY), await cp.getAddress(), Behaviour.REVERT)])
    await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'Denied', [
      0,
      attachmentId(d, Kind.DENY),
    ])
  })

  it('NotGranted is reported before a call-level policy runs', async () => {
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const f = await setup([policy(scope(ANY), await cp.getAddress(), Behaviour.REVERT)])
    await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'NotGranted')
  })

  describe('policy answers (MockPolicyV2 behaviours)', () => {
    const behaviours: [string, number, (id: string) => string][] = [
      ['revert', Behaviour.REVERT, (id) => 'MockDenied:' + id],
      ['wrong magic', Behaviour.WRONG_MAGIC, () => '0x'],
      ['malformed (no return data)', Behaviour.MALFORMED, () => '0x'],
      ['out of gas', Behaviour.BURN_GAS, () => '0x'],
      ['the other level magic', Behaviour.WRONG_LEVEL_MAGIC, () => '0x'],
    ]
    for (const level of [Level.CALL, Level.TRANSACTION]) {
      for (const [name, behaviour, reasonOf] of behaviours) {
        it(`${level === Level.CALL ? 'call' : 'transaction'}-level policy: ${name} is a deny`, async () => {
          const [, module] = await ethers.getSigners()
          const p = await ethers.deployContract('MockPolicyV2', [level])
          const pA = await p.getAddress()
          const s = scope(module.address)
          const f = await setup([allow(s), policy(s, pA, behaviour)])
          const id = attachmentId(s, Kind.POLICY, pA)
          const expected = reasonOf(id)
          const reason = expected.startsWith('MockDenied:')
            ? p.interface.encodeErrorResult('MockDenied', [id])
            : '0x'
          await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'PolicyDenied', [
            level === Level.CALL ? 0 : TX_INDEX,
            pA,
            reason,
          ])
        })
      }
    }
  })

  it('keeps evaluation order across calls: an earlier policy deny wins over a later built-in deny', async () => {
    // Policies run in one runner call per transaction; before a built-in deny of call i the
    // guard first runs the policies of the calls before i.
    const [, module] = await ethers.getSigners()
    const p = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const pA = await p.getAddress()
    const denying = scope(module.address, CallMatch.SELECTOR, ZeroAddress, SEL.ping)
    const f = await setup([
      allow(scope(module.address)),
      policy(denying, pA, Behaviour.REVERT),
      deny(scope(module.address, CallMatch.SELECTOR, ZeroAddress, SEL.approve)),
    ])
    const call = (data: string) => ({ op: Op.CALL, to: f.targetAddr, value: 0n, data })
    const batch = (calls: ReturnType<typeof call>[]) =>
      execModule(f.safe, f.module, f.multiSendAddr, multiSendData(calls), Op.DELEGATECALL)
    const reason = p.interface.encodeErrorResult('MockDenied', [attachmentId(denying, Kind.POLICY, pA)])
    // Call 0's policy denies before call 1's DENY attachment is reported.
    await expectRevert(batch([call(SEL.ping), call(SEL.approve)]), f.engine, 'PolicyDenied', [0, pA, reason])
    // Call 0's DENY attachment comes before call 1's policy runs.
    await expectRevert(batch([call(SEL.approve), call(SEL.ping)]), f.engine, 'Denied')
  })

  it('truncates a long revert reason to 512 bytes', async () => {
    const [, module] = await ethers.getSigners()
    const big = await ethers.deployContract('EngineReentrantPolicy', [Level.CALL])
    const bigA = await big.getAddress()
    // Empty callback settings: the policy reverts with 1000 bytes.
    const s = scope(module.address)
    const f = await setup([
      allow(s),
      { changeType: 0, scope: s, kind: Kind.POLICY, policy: bigA, opMask: 0, data: coderEncodeBytes('0x') },
    ])
    let data: string | undefined
    try {
      await execModule(f.safe, f.module, f.targetAddr, SEL.ping)
    } catch (e) {
      data = (e as { data?: string }).data
    }
    const parsed = f.engine.interface.parseError(data!)
    expect(parsed?.name).to.equal('PolicyDenied')
    expect(ethers.dataLength(parsed!.args.reason)).to.equal(512)
  })

  it('calls each policy once per unit with all its matched attachment ids, in level order', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const cpA = await cp.getAddress()
    const target = await ethers.deployContract('EngineTarget')
    const t = await target.getAddress()
    const s0 = scope(ANY)
    const s5 = scope(module.address, CallMatch.TO, t)
    const s7 = scope(module.address, CallMatch.TO_SELECTOR, t, SEL.ping)
    // Configured out of level order on purpose.
    const f = await setup([allow(s7), policy(s7, cpA), policy(s0, cpA), policy(s5, cpA)])
    const tx = await execModule(f.safe, f.module, t, SEL.ping)
    const logs = await eventsOf(tx, cp, 'CallChecked')
    expect(logs.length).to.equal(1)
    expect([...logs[0].args.attachmentIds]).to.deep.equal([
      attachmentId(s0, Kind.POLICY, cpA),
      attachmentId(s5, Kind.POLICY, cpA),
      attachmentId(s7, Kind.POLICY, cpA),
    ])
    const ctx = logs[0].args.ctx
    expect(ctx.safe).to.equal(f.safeAddr)
    expect(ctx.actor).to.equal(module.address)
    expect(ctx.executor).to.equal(module.address)
    expect(ctx.nonce).to.equal(0n)
    expect(ctx.txHash).to.equal(
      await f.engine.moduleCallHash(f.safeAddr, module.address, t, 0, SEL.ping, Op.CALL),
    )
  })

  it('owner path context: txHash at nonce - 1 with the real gas fields, executor = msg.sender of the Safe', async () => {
    const [deployer] = await ethers.getSigners()
    const tp = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const tpA = await tp.getAddress()
    const f = await setup([allow(scope(OWNERS)), policy(scope(OWNERS), tpA)])
    const nonce = await f.safe.nonce()
    const refund = ethers.Wallet.createRandom().address
    const gasToken = ethers.Wallet.createRandom().address
    const tx = await f.safe.execTransaction(
      f.targetAddr,
      0,
      SEL.ping,
      Op.CALL,
      0,
      7,
      0,
      gasToken,
      refund,
      '0x',
    )
    const logs = await eventsOf(tx, tp, 'TransactionChecked')
    const ctx = logs[0].args.ctx
    expect(ctx.actor).to.equal(OWNERS)
    expect(ctx.nonce).to.equal(nonce)
    expect(ctx.executor).to.equal(deployer.address)
    expect(ctx.txHash).to.equal(
      await f.safe.getTransactionHash(f.targetAddr, 0, SEL.ping, Op.CALL, 0, 7, 0, gasToken, refund, nonce),
    )
  })

  it('rejects refunds and safeTxGas on the owner path', async () => {
    const f = await setup([allow(scope(OWNERS))])
    await expectRevert(
      f.safe.execTransaction(f.targetAddr, 0, SEL.ping, Op.CALL, 0, 0, 1, ZeroAddress, ZeroAddress, '0x'),
      f.engine,
      'NonZeroGasPrice',
    )
    await expectRevert(
      f.safe.execTransaction(f.targetAddr, 0, SEL.ping, Op.CALL, 1, 0, 0, ZeroAddress, ZeroAddress, '0x'),
      f.engine,
      'NonZeroSafeTxGas',
    )
  })

  it('post-hooks deny a failed execution', async () => {
    const f = await setup([allow(scope(ANY))])
    // Owner path: unreachable through a Safe with zero gas fields (GS013 first); call the hook directly.
    await expectRevert(f.engine.checkAfterExecution(ethers.ZeroHash, false), f.engine, 'ExecutionFailed')
    await f.engine.checkAfterExecution(ethers.ZeroHash, true)
    // Module path: a failing inner call reaches the post-hook with success = false.
    const ms = await ethers.deployContract('EngineMultiSend')
    await expectRevert(
      execModule(f.safe, f.module, await ms.getAddress(), concat(['0x8d80ff0a', ethers.ZeroHash])),
      f.engine,
      'ModuleExecutionFailed',
    )
  })
})

describe('V2 engine: batches', () => {
  it('checks every sub-call; the wrapper itself is transparent (no ALLOW needed, DENY on it never fires)', async () => {
    const [, module] = await ethers.getSigners()
    const t1 = await (await ethers.deployContract('EngineTarget')).getAddress()
    const t2 = await (await ethers.deployContract('EngineTarget')).getAddress()
    const f = await setup([
      allow(scope(module.address, CallMatch.TO, t1)),
      allow(scope(module.address, CallMatch.TO, t2)),
    ])
    // A DENY at (A, MultiSend.*) covering both ops, added through the delayed path.
    const deniedWrapper = deny(scope(module.address, CallMatch.TO, f.multiSendAddr), 3)
    await f.engine
      .connect(f.asSafe)
      .requestConfiguration(await f.engine.configurationRoot([deniedWrapper], []))
    await time.increase(TIMING.delay)
    await f.engine.connect(f.asSafe).applyConfiguration([deniedWrapper], [])
    const batch = multiSendData([
      { op: Op.CALL, to: t1, value: 0n, data: SEL.ping },
      { op: Op.CALL, to: t2, value: 0n, data: SEL.ping },
    ])
    await execModule(f.safe, f.module, f.multiSendAddr, batch, Op.DELEGATECALL)

    const bad = multiSendData([
      { op: Op.CALL, to: t1, value: 0n, data: SEL.ping },
      { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping },
    ])
    await expectRevert(
      execModule(f.safe, f.module, f.multiSendAddr, bad, Op.DELEGATECALL),
      f.engine,
      'NotGranted',
      [1, f.targetAddr, SEL.ping, Op.CALL],
    )
  })

  it('runs a transaction-level policy once with the union of ids; call-level once per sub-call', async () => {
    const [, module] = await ethers.getSigners()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const tp = await ethers.deployContract('MockPolicyV2', [Level.TRANSACTION])
    const cpA = await cp.getAddress()
    const tpA = await tp.getAddress()
    const t1 = await (await ethers.deployContract('EngineTarget')).getAddress()
    const t2 = await (await ethers.deployContract('EngineTarget')).getAddress()
    const sAll = scope(module.address)
    const s1 = scope(module.address, CallMatch.TO, t1)
    const s2 = scope(module.address, CallMatch.TO, t2)
    const f = await setup([
      allow(sAll),
      policy(sAll, cpA),
      policy(s2, tpA),
      policy(sAll, tpA),
      policy(s1, tpA),
    ])
    const batch = multiSendData([
      { op: Op.CALL, to: t1, value: 0n, data: SEL.ping },
      { op: Op.CALL, to: t2, value: 0n, data: SEL.ping },
      { op: Op.CALL, to: t1, value: 0n, data: SEL.ping },
    ])
    const tx = await execModule(f.safe, f.module, f.multiSendAddr, batch, Op.DELEGATECALL)
    expect((await eventsOf(tx, cp, 'CallChecked')).length).to.equal(3)
    const txLogs = await eventsOf(tx, tp, 'TransactionChecked')
    expect(txLogs.length).to.equal(1)
    expect(txLogs[0].args.callCount).to.equal(3n)
    // First-match order: call 0 matches (A,*) then (A,t1.*); call 1 adds (A,t2.*); deduplicated.
    expect([...txLogs[0].args.attachmentIds]).to.deep.equal([
      attachmentId(sAll, Kind.POLICY, tpA),
      attachmentId(s1, Kind.POLICY, tpA),
      attachmentId(s2, Kind.POLICY, tpA),
    ])
  })

  it('denies malformed, oversized, nested and valued batches', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address)), allow(scope(OWNERS))])
    const one = { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping }
    await expectRevert(
      execModule(f.safe, f.module, f.multiSendAddr, multiSendData(Array(9).fill(one)), Op.DELEGATECALL),
      f.engine,
      'BatchTooLarge',
    )
    await execModule(f.safe, f.module, f.multiSendAddr, multiSendData(Array(8).fill(one)), Op.DELEGATECALL)
    await expectRevert(
      execModule(f.safe, f.module, f.multiSendAddr, concat(['0x8d80ff0a', ethers.ZeroHash]), Op.DELEGATECALL),
      f.engine,
      'MalformedBatch',
    )
    await expectRevert(
      execModule(f.safe, f.module, f.multiSendAddr, multiSendData([one]), Op.DELEGATECALL, 1n),
      f.engine,
      'MalformedBatch',
    )
    const nested = multiSendData([
      one,
      { op: Op.DELEGATECALL, to: f.multiSendAddr, value: 0n, data: multiSendData([one]) },
    ])
    await expectRevert(
      execOwner(f.safe, f.multiSendAddr, nested, Op.DELEGATECALL),
      f.engine,
      'NestedBatch',
      [1],
    )
  })

  it('resolves to = 0 in a batch to the Safe (and applies the Safe-target rule)', async () => {
    const [, module] = await ethers.getSigners()
    const f = await setup([allow(scope(module.address))])
    const enable = f.safe.interface.encodeFunctionData('enableModule', [ethers.Wallet.createRandom().address])
    await expectRevert(
      execModule(
        f.safe,
        f.module,
        f.multiSendAddr,
        multiSendData([{ op: Op.CALL, to: ZeroAddress, value: 0n, data: enable }]),
        Op.DELEGATECALL,
      ),
      f.engine,
      'NotGranted',
      [0, f.safeAddr, enable.slice(0, 10), Op.CALL],
    )
  })
})
