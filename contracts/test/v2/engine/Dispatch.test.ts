import { expect } from 'chai'
import { ZeroAddress, ZeroHash, dataLength } from 'ethers'
import { eventsOf, revertData } from '../helpers'
import {
  ANY,
  Behaviour,
  CallMatch,
  Kind,
  Mask,
  OWNERS,
  Op,
  SEL,
  allow,
  attachmentId,
  checksIn,
  cover,
  execConfigure,
  execModule,
  execOwner,
  expectRevert,
  multiSendData,
  policy,
  scope,
  setup,
} from './fixtures'

/**
 * Policy dispatch (SPEC.md §3.4 step 4): each distinct policy once per Safe transaction, in
 * first-match order, with every `(callIndex, level, attachmentId)` it matched; the context; deny
 * reasons; the re-entrancy lock.
 */
describe('V2 engine: policy dispatch', () => {
  const ping = (to: string) => ({ op: Op.CALL, to, value: 0n, data: SEL.ping })

  it('owner path: one check per policy with all its matches, in first-match order, and the Safe tx hash', async () => {
    const f = await setup((x) => [
      allow(scope(OWNERS)),
      policy(scope(ANY), x.policyAAddr),
      policy(scope(OWNERS), x.policyAAddr),
      policy(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.ping), x.policyAAddr),
      policy(scope(ANY, CallMatch.CONTRACT, x.targetAddr), x.policyBAddr),
      // Not matched: another contract, and a DELEGATECALL-only mask.
      policy(scope(ANY, CallMatch.CONTRACT, x.target2Addr), x.policyBAddr),
      policy(
        scope(OWNERS, CallMatch.CONTRACT, x.targetAddr),
        x.policyBAddr,
        Behaviour.REVERT,
        Mask.DELEGATECALL,
      ),
    ])
    const tx = await execOwner(f.safe, f.targetAddr, SEL.ping, Op.CALL, 0n, {
      baseGas: 7n,
      refundReceiver: f.other.address,
    })
    const checks = await checksIn(tx, [f.policyA, f.policyB])
    const [executed] = await eventsOf(tx, f.safe, 'ExecutionSuccess')
    expect(checks.map((c) => c.policy)).to.deep.equal([f.policyAAddr, f.policyBAddr])
    for (const c of checks) {
      expect(c.ctx).to.deep.equal({ safe: f.safeAddr, actor: OWNERS, txHash: executed.args.txHash })
      expect(c.calls).to.deep.equal([{ to: f.targetAddr, value: 0n, data: SEL.ping, operation: Op.CALL }])
    }
    expect(checks[0].matches).to.deep.equal([
      { callIndex: 0, level: 0, attachmentId: attachmentId(scope(ANY), Kind.POLICY, f.policyAAddr) },
      { callIndex: 0, level: 3, attachmentId: attachmentId(scope(OWNERS), Kind.POLICY, f.policyAAddr) },
      {
        callIndex: 0,
        level: 5,
        attachmentId: attachmentId(
          scope(OWNERS, CallMatch.FUNCTION, f.targetAddr, SEL.ping),
          Kind.POLICY,
          f.policyAAddr,
        ),
      },
    ])
    expect(checks[1].matches).to.deep.equal([
      {
        callIndex: 0,
        level: 1,
        attachmentId: attachmentId(scope(ANY, CallMatch.CONTRACT, f.targetAddr), Kind.POLICY, f.policyBAddr),
      },
    ])
  })

  it('module path: the actor is the module and the tx hash the module call hash', async () => {
    const f = await setup((x) => [
      allow(scope(x.module.address)),
      policy(scope(x.module.address), x.policyAAddr),
    ])
    const tx = await execModule(f.safe, f.module, f.targetAddr, SEL.ping, Op.CALL, 3n)
    const [c] = await checksIn(tx, [f.policyA])
    const hash = await f.engine.moduleCallHash(
      f.safeAddr,
      f.module.address,
      f.targetAddr,
      3n,
      SEL.ping,
      Op.CALL,
    )
    expect(c.ctx).to.deep.equal({ safe: f.safeAddr, actor: f.module.address, txHash: hash })
    expect(c.matches).to.deep.equal([
      {
        callIndex: 0,
        level: 3,
        attachmentId: attachmentId(scope(f.module.address), Kind.POLICY, f.policyAAddr),
      },
    ])
  })

  it('batch: the decoded calls and every call a policy matched, each policy once, ordered by first match', async () => {
    const f = await setup((x) => [
      allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr)),
      allow(scope(OWNERS, CallMatch.CONTRACT, x.target2Addr)),
      policy(scope(OWNERS), x.policyAAddr),
      policy(scope(ANY, CallMatch.CONTRACT, x.target2Addr), x.policyBAddr),
    ])
    const idA = attachmentId(scope(OWNERS), Kind.POLICY, f.policyAAddr)
    const idB = attachmentId(scope(ANY, CallMatch.CONTRACT, f.target2Addr), Kind.POLICY, f.policyBAddr)
    let tx = await execOwner(
      f.safe,
      f.multiSendAddr,
      multiSendData([ping(f.targetAddr), ping(f.target2Addr), ping(f.targetAddr)]),
      Op.DELEGATECALL,
    )
    let checks = await checksIn(tx, [f.policyA, f.policyB])
    expect(checks.map((c) => c.policy)).to.deep.equal([f.policyAAddr, f.policyBAddr])
    expect(checks[0].calls.map((c) => c.to)).to.deep.equal([f.targetAddr, f.target2Addr, f.targetAddr])
    expect(checks[0].matches).to.deep.equal(
      [0, 1, 2].map((i) => ({ callIndex: i, level: 3, attachmentId: idA })),
    )
    expect(checks[1].matches).to.deep.equal([{ callIndex: 1, level: 1, attachmentId: idB }])

    // Call 0 now targets target2: B (level 1) matches first.
    tx = await execOwner(
      f.safe,
      f.multiSendAddr,
      multiSendData([ping(f.target2Addr), ping(f.targetAddr)]),
      Op.DELEGATECALL,
    )
    checks = await checksIn(tx, [f.policyA, f.policyB])
    expect(checks.map((c) => c.policy)).to.deep.equal([f.policyBAddr, f.policyAAddr])
    expect(checks[1].matches).to.deep.equal(
      [0, 1].map((i) => ({ callIndex: i, level: 3, attachmentId: idA })),
    )
  })

  it('an ALLOW-only transaction calls no policy', async () => {
    const f = await setup((x) => [allow(scope(OWNERS)), policy(scope(x.module.address), x.policyAAddr)])
    const tx = await execOwner(f.safe, f.targetAddr, SEL.ping)
    expect(await checksIn(tx, [f.policyA])).to.deep.equal([])
  })

  describe('deny', () => {
    it('policies run after every built-in gate of every call', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr)),
        policy(scope(OWNERS), x.policyAAddr, Behaviour.REVERT),
      ])
      await expectRevert(
        execOwner(
          f.safe,
          f.multiSendAddr,
          multiSendData([ping(f.targetAddr), ping(f.target2Addr)]),
          Op.DELEGATECALL,
        ),
        f.engine,
        'NotGranted',
        [1, f.target2Addr, SEL.ping, Op.CALL],
      )
    })

    it('the first denying policy in first-match order wins, with its revert data', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        policy(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr), x.policyAAddr, Behaviour.REVERT),
        policy(scope(ANY), x.policyBAddr, Behaviour.REVERT),
      ])
      const idB = attachmentId(scope(ANY), Kind.POLICY, f.policyBAddr)
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'PolicyDenied', [
        f.policyBAddr,
        f.policyB.interface.encodeErrorResult('MockDenied', [idB]),
      ])
    })

    it('the policy owns the merge rule: it sees every match and may deny on any', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        policy(scope(ANY), x.policyAAddr),
        policy(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.ping), x.policyAAddr, Behaviour.REVERT),
      ])
      const id = attachmentId(
        scope(OWNERS, CallMatch.FUNCTION, f.targetAddr, SEL.ping),
        Kind.POLICY,
        f.policyAAddr,
      )
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'PolicyDenied', [
        f.policyAAddr,
        f.policyA.interface.encodeErrorResult('MockDenied', [id]),
      ])
      await execOwner(f.safe, f.targetAddr, SEL.pong)
    })

    it('a wrong, empty or longer return value is a deny with an empty reason', async () => {
      for (const b of [Behaviour.WRONG_MAGIC, Behaviour.MALFORMED, Behaviour.LONG_MAGIC]) {
        const f = await setup((x) => [allow(scope(OWNERS)), policy(scope(OWNERS), x.policyAAddr, b)])
        await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'PolicyDenied', [
          f.policyAAddr,
          '0x',
        ])
      }
    })

    it('a long revert reason is truncated to 512 bytes', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        policy(scope(OWNERS), x.policyAAddr, Behaviour.LONG_REVERT),
      ])
      let data: string | undefined
      try {
        await execOwner(f.safe, f.targetAddr, SEL.ping)
      } catch (e) {
        data = revertData(e)
      }
      const parsed = f.engine.interface.parseError(data!)
      expect(parsed?.name).to.equal('PolicyDenied')
      expect(parsed!.args[0]).to.equal(f.policyAAddr)
      // The mock reverts with 1,000 bytes of its memory; the engine keeps the first 512.
      expect(dataLength(parsed!.args[1])).to.equal(512)
    })

    it('a deny on the module path', async () => {
      const f = await setup((x) => [
        allow(scope(x.module.address)),
        policy(scope(ANY), x.policyAAddr, Behaviour.REVERT),
      ])
      await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'PolicyDenied')
    })

    it('policies also judge configure on the owner path', async () => {
      const f = await setup((x) => [
        policy(scope(OWNERS, CallMatch.CONTRACT, x.engineAddr), x.policyAAddr, Behaviour.REVERT),
      ])
      await expectRevert(execConfigure(f, []), f.engine, 'PolicyDenied')
    })
  })

  describe('re-entrancy', () => {
    const callback = (f: Awaited<ReturnType<typeof setup>>, data: string) => [
      allow(scope(OWNERS)),
      allow(scope(f.module.address)),
      policy(scope(ANY, CallMatch.CONTRACT, f.targetAddr), f.policyAAddr, Behaviour.CALLBACK, 0, data),
    ]

    async function reentrancyReason(data: (f: Awaited<ReturnType<typeof setup>>) => string, owner = true) {
      const f = await setup()
      await f.engine.connect(f.asSafe).configure(callback(f, data(f)))
      return {
        f,
        exec: () =>
          owner
            ? execOwner(f.safe, f.targetAddr, SEL.ping)
            : execModule(f.safe, f.module, f.targetAddr, SEL.ping),
      }
    }

    it('configure during a check reverts Reentrancy (reported as the policy deny reason)', async () => {
      const { f, exec } = await reentrancyReason((x) =>
        x.engine.interface.encodeFunctionData('configure', [[]]),
      )
      const reason = f.engine.interface.encodeErrorResult('Reentrancy')
      await expectRevert(exec(), f.engine, 'PolicyDenied', [f.policyAAddr, reason])
      cover('Reentrancy')
    })

    for (const [name, owner] of [
      ['checkTransaction', true],
      ['checkModuleTransaction', false],
      ['checkAfterExecution', true],
      ['checkAfterModuleExecution', false],
    ] as const) {
      it(`${name} during a check reverts Reentrancy`, async () => {
        const { f, exec } = await reentrancyReason((x) => {
          const i = x.engine.interface
          if (name === 'checkTransaction')
            return i.encodeFunctionData(name, [
              x.targetAddr,
              0,
              '0x',
              0,
              0,
              0,
              0,
              ZeroAddress,
              ZeroAddress,
              '0x',
              ZeroAddress,
            ])
          if (name === 'checkModuleTransaction')
            return i.encodeFunctionData(name, [x.targetAddr, 0, '0x', 0, x.module.address])
          return i.encodeFunctionData(name as 'checkAfterExecution', [ZeroHash, true])
        }, owner)
        await expectRevert(exec(), f.engine, 'PolicyDenied', [
          f.policyAAddr,
          f.engine.interface.encodeErrorResult('Reentrancy'),
        ])
      })
    }

    it('the owner-path gas fields are checked before the lock', async () => {
      const { f, exec } = await reentrancyReason((x) =>
        x.engine.interface.encodeFunctionData('checkTransaction', [
          x.targetAddr,
          0,
          '0x',
          0,
          0,
          0,
          1,
          ZeroAddress,
          ZeroAddress,
          '0x',
          ZeroAddress,
        ]),
      )
      await expectRevert(exec(), f.engine, 'PolicyDenied', [
        f.policyAAddr,
        f.engine.interface.encodeErrorResult('NonZeroGasPrice'),
      ])
    })

    it('views stay readable during a check, and the lock is released after it', async () => {
      const { f, exec } = await reentrancyReason((x) =>
        x.engine.interface.encodeFunctionData('getAttachment', [
          x.safeAddr,
          attachmentId(scope(OWNERS), Kind.ALLOW),
        ]),
      )
      const tx = await exec()
      expect((await checksIn(tx, [f.policyA])).length).to.equal(1)
      await execConfigure(f, [])
      await f.engine.connect(f.asSafe).configure([])
    })
  })
})
