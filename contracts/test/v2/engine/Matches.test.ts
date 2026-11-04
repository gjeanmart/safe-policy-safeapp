import { expect } from 'chai'
import { ZeroAddress, dataSlice } from 'ethers'
import { ethers } from 'hardhat'
import { revertData } from '../helpers'
import {
  ANY,
  Behaviour,
  CallMatch,
  Kind,
  Mask,
  OWNERS,
  Op,
  SEL,
  type Change,
  type Fixture,
  allow,
  attachmentId,
  cover,
  deny,
  execModule,
  execOwner,
  multiSendData,
  policy,
  scope,
  setup,
} from './fixtures'

/**
 * `matches` (SPEC.md §3.5): the app's preview is `matches` plus an `eth_call` of each matched
 * policy's `check` from the engine address. These tests run that preview, then the real
 * transaction, and require the same outcome (the same revert data, or success).
 */
describe('V2 engine: matches agrees with the real check', () => {
  type Scenario = {
    name: string
    changes: (f: Fixture) => Change[]
    tx: (f: Fixture) => { module: boolean; to: string; data: string; op?: number; value?: bigint }
    expect: string | null
    counts?: boolean[]
  }

  const ping = (to: string, value = 0n) => ({ op: Op.CALL, to, value, data: SEL.ping })

  /** The preview: `matches`, then each distinct policy's `check` by `eth_call` from the engine. */
  async function preview(f: Fixture, actor: string, to: string, data: string, op: number, value: bigint) {
    const [calls, found, engineError] = await f.engine.matches(f.safeAddr, actor, to, value, data, op)
    if (engineError !== '0x') return { outcome: engineError, found }
    const txHash =
      actor === OWNERS
        ? await f.safe.getTransactionHash(
            to,
            value,
            data,
            op,
            0,
            0,
            0,
            ZeroAddress,
            ZeroAddress,
            await f.safe.nonce(),
          )
        : await f.engine.moduleCallHash(f.safeAddr, actor, to, value, data, op)
    const iface = (await ethers.getContractAt('contracts/v2/interfaces/IPolicy.sol:IPolicy', ZeroAddress))
      .interface
    const policies = [...new Set(found.filter((m) => Number(m.kind) === Kind.POLICY).map((m) => m.policy))]
    for (const p of policies) {
      const own = found
        .filter((m) => m.policy === p && Number(m.kind) === Kind.POLICY)
        .map((m) => [m.callIndex, m.level, m.attachmentId])
      const callData = iface.encodeFunctionData('check', [
        [f.safeAddr, actor, txHash],
        calls.map((c) => [c.to, c.value, c.data, c.operation]),
        own,
      ])
      try {
        const ret = await ethers.provider.call({ from: f.engineAddr, to: p, data: callData })
        if (ret !== dataSlice(callData, 0, 4) + '00'.repeat(28))
          return { outcome: f.engine.interface.encodeErrorResult('PolicyDenied', [p, '0x']), found }
      } catch (e) {
        return { outcome: f.engine.interface.encodeErrorResult('PolicyDenied', [p, revertData(e)]), found }
      }
    }
    return { outcome: null, found }
  }

  const scenarios: Scenario[] = [
    {
      name: 'ALLOW only',
      changes: () => [allow(scope(OWNERS))],
      tx: (f) => ({ module: false, to: f.targetAddr, data: SEL.ping }),
      expect: null,
      counts: [true],
    },
    {
      name: 'nothing granted',
      changes: (f) => [allow(scope(OWNERS, CallMatch.CONTRACT, f.target2Addr))],
      tx: (f) => ({ module: false, to: f.targetAddr, data: SEL.ping }),
      expect: 'NotGranted',
    },
    {
      name: 'a DENY in a batch',
      changes: (f) => [allow(scope(OWNERS)), deny(scope(ANY, CallMatch.CONTRACT, f.target2Addr))],
      tx: (f) => ({
        module: false,
        to: f.multiSendAddr,
        data: multiSendData([ping(f.targetAddr), ping(f.target2Addr)]),
        op: Op.DELEGATECALL,
      }),
      expect: 'Denied',
    },
    {
      name: 'policies at several levels in a batch, passing',
      changes: (f) => [
        allow(scope(OWNERS)),
        policy(scope(ANY), f.policyAAddr),
        policy(scope(OWNERS, CallMatch.CONTRACT, f.target2Addr), f.policyBAddr),
        policy(scope(OWNERS, CallMatch.FUNCTION, f.targetAddr, SEL.ping), f.policyAAddr),
      ],
      tx: (f) => ({
        module: false,
        to: f.multiSendAddr,
        data: multiSendData([ping(f.targetAddr), ping(f.target2Addr, 1n)]),
        op: Op.DELEGATECALL,
      }),
      expect: null,
    },
    {
      name: 'the second policy denies',
      changes: (f) => [
        allow(scope(f.module.address)),
        policy(scope(f.module.address), f.policyAAddr),
        policy(scope(ANY, CallMatch.CONTRACT, f.targetAddr), f.policyBAddr, Behaviour.REVERT),
      ],
      tx: (f) => ({ module: true, to: f.targetAddr, data: SEL.ping }),
      expect: 'PolicyDenied',
    },
    {
      name: 'a wrong return value',
      changes: (f) => [allow(scope(OWNERS)), policy(scope(OWNERS), f.policyAAddr, Behaviour.WRONG_MAGIC)],
      tx: (f) => ({ module: false, to: f.targetAddr, data: SEL.ping }),
      expect: 'PolicyDenied',
    },
    {
      name: 'F5: a module calling the Safe with a level-4 ALLOW (does not count)',
      changes: (f) => [allow(scope(f.module.address, CallMatch.CONTRACT, f.safeAddr))],
      tx: (f) => ({ module: true, to: f.safeAddr, data: SEL.ping }),
      expect: 'NotGranted',
      counts: [false],
    },
    {
      name: 'F5: a module calling the Safe with the exact ALLOW',
      changes: (f) => [
        allow(scope(f.module.address, CallMatch.CONTRACT, f.safeAddr)),
        allow(scope(f.module.address, CallMatch.FUNCTION, f.safeAddr, '0x610b5925')),
      ],
      tx: (f) => ({
        module: true,
        to: f.safeAddr,
        data: f.safe.interface.encodeFunctionData('enableModule', [f.other.address]),
      }),
      expect: null,
      counts: [false, true],
    },
    {
      name: 'owner configure, no ALLOW needed, a policy runs',
      changes: (f) => [policy(scope(OWNERS), f.policyAAddr)],
      tx: (f) => ({
        module: false,
        to: f.engineAddr,
        data: f.engine.interface.encodeFunctionData('configure', [[]]),
      }),
      expect: null,
    },
    {
      name: 'module configure without the exact ALLOW',
      changes: (f) => [allow(scope(f.module.address, CallMatch.CONTRACT, f.engineAddr))],
      tx: (f) => ({
        module: true,
        to: f.engineAddr,
        data: f.engine.interface.encodeFunctionData('configure', [[]]),
      }),
      expect: 'NotGranted',
      counts: [false],
    },
    {
      name: 'an engine view',
      changes: () => [allow(scope(OWNERS))],
      tx: (f) => ({
        module: false,
        to: f.engineAddr,
        data: f.engine.interface.encodeFunctionData('levelsUsed', [f.safeAddr]),
      }),
      expect: 'GuardTargetDenied',
    },
    {
      name: 'a malformed batch',
      changes: () => [allow(scope(OWNERS))],
      tx: (f) => ({ module: false, to: f.multiSendAddr, data: multiSendData([]), op: Op.DELEGATECALL }),
      expect: 'MalformedBatch',
    },
    {
      name: 'a batch over the cap',
      changes: () => [allow(scope(OWNERS))],
      tx: (f) => ({
        module: false,
        to: f.multiSendAddr,
        data: multiSendData(Array(9).fill(ping(f.targetAddr))),
        op: Op.DELEGATECALL,
      }),
      expect: 'BatchTooLarge',
    },
    {
      name: 'a nested batch',
      changes: (f) => [allow(scope(OWNERS, CallMatch.FUNCTION, f.multiSendAddr, '0x8d80ff0a'), Mask.ALL)],
      tx: (f) => ({
        module: false,
        to: f.multiSendAddr,
        data: multiSendData([
          { op: Op.DELEGATECALL, to: f.multiSendAddr, value: 0n, data: multiSendData([ping(f.targetAddr)]) },
        ]),
        op: Op.DELEGATECALL,
      }),
      expect: 'NestedBatch',
    },
    {
      name: '1 to 3 bytes of calldata',
      changes: () => [allow(scope(OWNERS))],
      tx: (f) => ({ module: false, to: f.targetAddr, data: '0x1234' }),
      expect: 'InvalidSelector',
    },
  ]

  for (const s of scenarios) {
    it(s.name, async () => {
      const f = await setup(s.changes)
      const t = s.tx(f)
      const actor = t.module ? f.module.address : OWNERS
      const [op, value] = [t.op ?? Op.CALL, t.value ?? 0n]
      const { outcome, found } = await preview(f, actor, t.to, t.data, op, value)

      let real: string | null = null
      try {
        await (t.module
          ? execModule(f.safe, f.module, t.to, t.data, op, value)
          : execOwner(f.safe, t.to, t.data, op, value))
      } catch (e) {
        real = revertData(e) ?? 'no data'
      }
      expect(outcome, 'preview vs real').to.equal(real)
      if (s.expect) {
        expect(f.engine.interface.parseError(real!)?.name).to.equal(s.expect)
        cover(s.expect)
      }
      if (s.counts)
        expect(found.filter((m) => Number(m.kind) === Kind.ALLOW).map((m) => m.counts)).to.deep.equal(
          s.counts,
        )
    })
  }

  it('reports every match per call in level order, with its kind, policy, mask and counts', async () => {
    const f = await setup((x) => [
      allow(scope(OWNERS)),
      deny(scope(ANY, CallMatch.CONTRACT, x.target2Addr), Mask.DELEGATECALL),
      policy(scope(ANY), x.policyAAddr),
      policy(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.ping), x.policyBAddr, 0, Mask.CALL),
    ])
    const data = multiSendData([ping(f.targetAddr), ping(f.target2Addr)])
    const [calls, found, err] = await f.engine.matches(
      f.safeAddr,
      OWNERS,
      f.multiSendAddr,
      0n,
      data,
      Op.DELEGATECALL,
    )
    expect(err).to.equal('0x')
    expect(calls.map((c) => c.to)).to.deep.equal([f.targetAddr, f.target2Addr])
    const rows = found.map((m) => [
      Number(m.callIndex),
      Number(m.level),
      Number(m.kind),
      m.policy,
      Number(m.opMask),
      m.counts,
    ])
    expect(rows).to.deep.equal([
      [0, 0, Kind.POLICY, f.policyAAddr, Mask.ALL, true],
      [0, 3, Kind.ALLOW, ZeroAddress, Mask.CALL, true],
      [0, 5, Kind.POLICY, f.policyBAddr, Mask.CALL, true],
      [1, 0, Kind.POLICY, f.policyAAddr, Mask.ALL, true],
      [1, 3, Kind.ALLOW, ZeroAddress, Mask.CALL, true],
    ])
    expect(found[1].attachmentId).to.equal(attachmentId(scope(OWNERS), Kind.ALLOW))
  })

  it('reports F4 through counts: a DELEGATECALL never counts below level 5', async () => {
    // configure forbids such an ALLOW, so the rule is shown on the stored mask of a level-5 one
    // only; a level-3 CALL ALLOW is filtered out by its mask for a DELEGATECALL.
    const f = await setup((x) => [
      allow(scope(OWNERS)),
      allow(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.ping), Mask.ALL),
    ])
    const [, found] = await f.engine.matches(f.safeAddr, OWNERS, f.targetAddr, 0n, SEL.ping, Op.DELEGATECALL)
    expect(found.map((m) => [Number(m.level), m.counts])).to.deep.equal([[5, true]])
  })

  it('reports the first engine error and still lists later calls', async () => {
    const f = await setup((x) => [allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr))])
    const data = multiSendData([
      ping(f.target2Addr),
      ping(f.targetAddr),
      { op: Op.CALL, to: f.targetAddr, value: 0n, data: '0x12' },
    ])
    const [calls, found, err] = await f.engine.matches(
      f.safeAddr,
      OWNERS,
      f.multiSendAddr,
      0n,
      data,
      Op.DELEGATECALL,
    )
    expect(calls.length).to.equal(3)
    expect(f.engine.interface.parseError(err)?.name).to.equal('NotGranted')
    expect(found.map((m) => Number(m.callIndex))).to.deep.equal([1])
  })
})
