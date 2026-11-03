import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import { eventsOf } from '../helpers'
import {
  ANY,
  CallMatch,
  Kind,
  Mask,
  OWNERS,
  Op,
  SEL,
  allow,
  attachmentId,
  deny,
  detach,
  execConfigure,
  execModule,
  execOwner,
  expectRevert,
  lattice,
  multiSendData,
  scope,
  setup,
} from './fixtures'

/**
 * The built-in gates (SPEC.md §3.3, §3.4): the 6 levels, op masks, ALLOW / DENY, F4, F5,
 * `configure` as an ordinary transaction, engine targets, batches and the owner-path gas fields.
 */
describe('V2 engine: verdicts', () => {
  describe('levels and op masks', () => {
    for (let level = 3; level < 6; level++) {
      it(`an ALLOW at level ${level} grants both paths`, async () => {
        const f = await setup((x) => [
          allow(lattice(OWNERS, x.targetAddr, SEL.ping)[level]),
          allow(lattice(x.module.address, x.targetAddr, SEL.ping)[level]),
        ])
        await execOwner(f.safe, f.targetAddr, SEL.ping)
        await execModule(f.safe, f.module, f.targetAddr, SEL.ping)
      })
    }

    for (let level = 0; level < 6; level++) {
      it(`a DENY at level ${level} denies over an exact ALLOW (first DENY in level order)`, async () => {
        const f = await setup((x) => {
          const owners = lattice(OWNERS, x.targetAddr, SEL.ping)
          const mod = lattice(x.module.address, x.targetAddr, SEL.ping)
          return [allow(owners[5]), allow(mod[5]), deny(owners[level]), deny(mod[level]), deny(owners[5])]
        })
        const ownerLattice = lattice(OWNERS, f.targetAddr, SEL.ping)
        await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'Denied', [
          0,
          attachmentId(ownerLattice[level], Kind.DENY),
        ])
        await expectRevert(execModule(f.safe, f.module, f.targetAddr, SEL.ping), f.engine, 'Denied', [
          0,
          attachmentId(lattice(f.module.address, f.targetAddr, SEL.ping)[level], Kind.DENY),
        ])
      })
    }

    it('a scope only matches its own actor, contract and function', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.ping)),
        allow(scope(x.module.address, CallMatch.CONTRACT, x.targetAddr)),
      ])
      await execOwner(f.safe, f.targetAddr, SEL.ping)
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.pong), f.engine, 'NotGranted', [
        0,
        f.targetAddr,
        SEL.pong,
        Op.CALL,
      ])
      await expectRevert(execOwner(f.safe, f.target2Addr, SEL.ping), f.engine, 'NotGranted')
      await execModule(f.safe, f.module, f.targetAddr, SEL.pong)
      await expectRevert(execModule(f.safe, f.module, f.target2Addr, SEL.pong), f.engine, 'NotGranted')
      // Another module has no grant (no shared actor).
      await f.safe.connect(f.asSafe).enableModule(f.other.address)
      await expectRevert(execModule(f.safe, f.other, f.targetAddr, SEL.pong), f.engine, 'NotGranted')
    })

    it('empty calldata is its own FUNCTION scope (selector 0), distinct from CONTRACT', async () => {
      const f = await setup((x) => [allow(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.empty))])
      await execOwner(f.safe, f.targetAddr, '0x', Op.CALL, 1n)
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'NotGranted')
      // Calldata `0x00000000` has selector 0 too, so it shares the scope (SPEC.md §2).
      await execOwner(f.safe, f.targetAddr, SEL.empty)
    })

    it('InvalidSelector: 1 to 3 bytes of calldata, before any lookup', async () => {
      const f = await setup((x) => [allow(scope(OWNERS)), deny(scope(ANY, CallMatch.CONTRACT, x.targetAddr))])
      for (const data of ['0x12', '0x1234', '0x123456'])
        await expectRevert(execOwner(f.safe, f.targetAddr, data), f.engine, 'InvalidSelector', [0])
    })

    it('the op mask filters ALLOW, DENY and POLICY', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.ping), Mask.DELEGATECALL),
        allow(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.pong), Mask.ALL),
        deny(scope(ANY, CallMatch.FUNCTION, x.targetAddr, SEL.pong), Mask.DELEGATECALL),
      ])
      // DELEGATECALL-only ALLOW: the CALL is not granted, the DELEGATECALL is.
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'NotGranted')
      await execOwner(f.safe, f.targetAddr, SEL.ping, Op.DELEGATECALL)
      // A DELEGATECALL-only DENY does not see the CALL.
      await execOwner(f.safe, f.targetAddr, SEL.pong)
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.pong, Op.DELEGATECALL), f.engine, 'Denied')
    })

    it('deny by default: no attachment at all', async () => {
      const f = await setup()
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'NotGranted', [
        0,
        f.targetAddr,
        SEL.ping,
        Op.CALL,
      ])
    })
  })

  describe('F4 and F5', () => {
    it('F4: a DELEGATECALL is granted only by a level-5 ALLOW', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        allow(scope(x.module.address)),
        allow(scope(OWNERS, CallMatch.FUNCTION, x.targetAddr, SEL.pong), Mask.DELEGATECALL),
        allow(scope(x.module.address, CallMatch.FUNCTION, x.targetAddr, SEL.pong), Mask.DELEGATECALL),
      ])
      // Storage-mask filtering would already deny a CALL-only ALLOW; the level rule is shown by
      // `matches` (`counts`) in Matches.test.ts. Here: only the exact DELEGATECALL ALLOW grants.
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping, Op.DELEGATECALL), f.engine, 'NotGranted', [
        0,
        f.targetAddr,
        SEL.ping,
        Op.DELEGATECALL,
      ])
      await execOwner(f.safe, f.targetAddr, SEL.pong, Op.DELEGATECALL)
      await execModule(f.safe, f.module, f.targetAddr, SEL.pong, Op.DELEGATECALL)
    })

    it('F5: a module calls the Safe only through an exact ALLOW; the owners need none', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        allow(scope(x.module.address)),
        allow(scope(x.module.address, CallMatch.CONTRACT, x.safeAddr)),
      ])
      const enable = f.safe.interface.encodeFunctionData('enableModule', [f.other.address])
      await execOwner(f.safe, f.safeAddr, enable)
      await expectRevert(execModule(f.safe, f.module, f.safeAddr, enable), f.engine, 'NotGranted', [
        0,
        f.safeAddr,
        enable.slice(0, 10),
        Op.CALL,
      ])
      // A batch sub-call to `address(0)` is the Safe: the same rule applies.
      const batch = multiSendData([{ op: Op.CALL, to: ZeroAddress, value: 0n, data: enable }])
      await f.engine
        .connect(f.asSafe)
        .configure([
          allow(
            scope(f.module.address, CallMatch.FUNCTION, f.multiSendAddr, '0x8d80ff0a'),
            Mask.DELEGATECALL,
          ),
        ])
      await expectRevert(
        execModule(f.safe, f.module, f.multiSendAddr, batch, Op.DELEGATECALL),
        f.engine,
        'NotGranted',
        [0, f.safeAddr, enable.slice(0, 10), Op.CALL],
      )
      await f.engine
        .connect(f.asSafe)
        .configure([allow(scope(f.module.address, CallMatch.FUNCTION, f.safeAddr, enable.slice(0, 10)))])
      await execModule(f.safe, f.module, f.safeAddr, enable)
      await execModule(f.safe, f.module, f.multiSendAddr, batch, Op.DELEGATECALL)
    })
  })

  describe('configure as a transaction', () => {
    it('owner path: a top-level zero-value CALL is granted without an ALLOW', async () => {
      const f = await setup()
      const tx = await execConfigure(f, [allow(scope(OWNERS))])
      expect((await eventsOf(tx, f.engine, 'Attached')).length).to.equal(1)
      await execOwner(f.safe, f.targetAddr, SEL.ping)
    })

    it('owner path: DENYs still apply to configure', async () => {
      const f = await setup((x) => [deny(scope(ANY, CallMatch.FUNCTION, x.engineAddr, SEL.configure))])
      await expectRevert(execConfigure(f, []), f.engine, 'Denied', [
        0,
        attachmentId(scope(ANY, CallMatch.FUNCTION, f.engineAddr, SEL.configure), Kind.DENY),
      ])
    })

    it('owner path: never with value, never as DELEGATECALL, never in a batch', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        allow(scope(OWNERS, CallMatch.FUNCTION, x.engineAddr, SEL.configure), Mask.ALL),
        allow(scope(OWNERS, CallMatch.FUNCTION, x.multiSendAddr, '0x8d80ff0a'), Mask.DELEGATECALL),
      ])
      await expectRevert(execConfigure(f, [], Op.CALL, 1n), f.engine, 'GuardTargetDenied', [0])
      await expectRevert(execConfigure(f, [], Op.DELEGATECALL), f.engine, 'GuardTargetDenied', [0])
      const data = f.engine.interface.encodeFunctionData('configure', [[]])
      const batch = multiSendData([
        { op: Op.CALL, to: f.targetAddr, value: 0n, data: SEL.ping },
        { op: Op.CALL, to: f.engineAddr, value: 0n, data },
      ])
      await expectRevert(
        execOwner(f.safe, f.multiSendAddr, batch, Op.DELEGATECALL),
        f.engine,
        'GuardTargetDenied',
        [1],
      )
    })

    it('module path: configure needs the exact ALLOW (F5), then applies for the Safe', async () => {
      const f = await setup((x) => [
        allow(scope(x.module.address)),
        allow(scope(x.module.address, CallMatch.CONTRACT, x.engineAddr)),
      ])
      const data = f.engine.interface.encodeFunctionData('configure', [[allow(scope(OWNERS))]])
      await expectRevert(execModule(f.safe, f.module, f.engineAddr, data), f.engine, 'NotGranted', [
        0,
        f.engineAddr,
        SEL.configure,
        Op.CALL,
      ])
      await execConfigure(f, [
        allow(scope(f.module.address, CallMatch.FUNCTION, f.engineAddr, SEL.configure)),
      ])
      const tx = await execModule(f.safe, f.module, f.engineAddr, data)
      const [attached] = await eventsOf(tx, f.engine, 'Attached')
      expect(attached.args.safe).to.equal(f.safeAddr)
      await execOwner(f.safe, f.targetAddr, SEL.ping)
      // Even with the exact ALLOW: no value.
      await expectRevert(
        execModule(f.safe, f.module, f.engineAddr, data, Op.CALL, 1n),
        f.engine,
        'GuardTargetDenied',
        [0],
      )
    })

    it('GuardTargetDenied: any other engine function, on both paths, even with an ALLOW', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS)),
        allow(scope(OWNERS, CallMatch.CONTRACT, x.engineAddr)),
        allow(scope(x.module.address, CallMatch.CONTRACT, x.engineAddr)),
      ])
      const views = [
        f.engine.interface.encodeFunctionData('levelsUsed', [f.safeAddr]),
        f.engine.interface.encodeFunctionData('checkAfterExecution', [ethers.ZeroHash, true]),
        '0x',
      ]
      for (const data of views) {
        await expectRevert(execOwner(f.safe, f.engineAddr, data), f.engine, 'GuardTargetDenied', [0])
        await expectRevert(
          execModule(f.safe, f.module, f.engineAddr, data),
          f.engine,
          'GuardTargetDenied',
          [0],
        )
      }
    })

    it('detaching the only ALLOW through configure still leaves configure reachable', async () => {
      const f = await setup([allow(scope(OWNERS))])
      await execConfigure(f, [detach(scope(OWNERS), Kind.ALLOW)])
      await expectRevert(execOwner(f.safe, f.targetAddr, SEL.ping), f.engine, 'NotGranted')
      await execConfigure(f, [allow(scope(OWNERS))])
      await execOwner(f.safe, f.targetAddr, SEL.ping)
    })
  })

  describe('batches', () => {
    const ping = (to: string, value = 0n) => ({ op: Op.CALL, to, value, data: SEL.ping })

    it('a trusted batch is transparent: each sub-call is judged, the wrapper is not', async () => {
      const f = await setup((x) => [allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr))])
      const tx = await execOwner(
        f.safe,
        f.multiSendAddr,
        multiSendData([ping(f.targetAddr), ping(f.targetAddr, 1n)]),
        Op.DELEGATECALL,
      )
      expect((await eventsOf(tx, f.target, 'Hit')).length).to.equal(2)
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

    it('verdict order across calls: an earlier call’s NotGranted wins over a later DENY', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr)),
        deny(scope(ANY, CallMatch.CONTRACT, x.target2Addr)),
      ])
      await expectRevert(
        execOwner(
          f.safe,
          f.multiSendAddr,
          multiSendData([ping(f.safeAddr), ping(f.target2Addr)]),
          Op.DELEGATECALL,
        ),
        f.engine,
        'NotGranted',
        [0, f.safeAddr, SEL.ping, Op.CALL],
      )
      await expectRevert(
        execOwner(
          f.safe,
          f.multiSendAddr,
          multiSendData([ping(f.targetAddr), ping(f.target2Addr)]),
          Op.DELEGATECALL,
        ),
        f.engine,
        'Denied',
        [1, attachmentId(scope(ANY, CallMatch.CONTRACT, f.target2Addr), Kind.DENY)],
      )
    })

    it('BatchTooLarge above 8 calls; 8 pass', async () => {
      const f = await setup((x) => [allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr))])
      await execOwner(
        f.safe,
        f.multiSendAddr,
        multiSendData(Array(8).fill(ping(f.targetAddr))),
        Op.DELEGATECALL,
      )
      await expectRevert(
        execOwner(f.safe, f.multiSendAddr, multiSendData(Array(9).fill(ping(f.targetAddr))), Op.DELEGATECALL),
        f.engine,
        'BatchTooLarge',
      )
    })

    it('MalformedBatch: value on the wrapper, empty, bad offset, truncated entry, bad op', async () => {
      const f = await setup((x) => [allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr))])
      const good = multiSendData([ping(f.targetAddr)])
      const bads = [
        multiSendData([]),
        '0x8d80ff0a' + '00'.repeat(31) + '40' + good.slice(74),
        good.slice(0, good.length - 2 * 40),
        '0x8d80ff0a' + good.slice(10, 10 + 128) + '02' + good.slice(10 + 130),
      ]
      for (const data of bads)
        await expectRevert(
          execOwner(f.safe, f.multiSendAddr, data, Op.DELEGATECALL),
          f.engine,
          'MalformedBatch',
        )
      await expectRevert(
        execOwner(f.safe, f.multiSendAddr, good, Op.DELEGATECALL, 1n),
        f.engine,
        'MalformedBatch',
      )
    })

    it('NestedBatch: a sub-call DELEGATECALLing a trusted batch', async () => {
      const f = await setup((x) => [
        allow(scope(OWNERS, CallMatch.FUNCTION, x.multiSendAddr, '0x8d80ff0a'), Mask.ALL),
      ])
      const inner = multiSendData([ping(f.targetAddr)])
      await expectRevert(
        execOwner(
          f.safe,
          f.multiSendAddr,
          multiSendData([{ op: Op.DELEGATECALL, to: f.multiSendAddr, value: 0n, data: inner }]),
          Op.DELEGATECALL,
        ),
        f.engine,
        'NestedBatch',
        [0],
      )
    })

    it('an untrusted batch contract, or another selector, is an ordinary call', async () => {
      const f = await setup((x) => [allow(scope(OWNERS, CallMatch.CONTRACT, x.targetAddr))])
      const other = await (await ethers.deployContract('EngineMultiSend')).getAddress()
      await expectRevert(
        execOwner(f.safe, other, multiSendData([ping(f.targetAddr)]), Op.DELEGATECALL),
        f.engine,
        'NotGranted',
        [0, other, '0x8d80ff0a', Op.DELEGATECALL],
      )
      await expectRevert(
        execOwner(f.safe, f.multiSendAddr, SEL.ping, Op.DELEGATECALL),
        f.engine,
        'NotGranted',
        [0, f.multiSendAddr, SEL.ping, Op.DELEGATECALL],
      )
    })

    it('batches on the module path', async () => {
      const f = await setup((x) => [allow(scope(x.module.address, CallMatch.CONTRACT, x.targetAddr))])
      await execModule(
        f.safe,
        f.module,
        f.multiSendAddr,
        multiSendData([ping(f.targetAddr), ping(f.targetAddr)]),
        Op.DELEGATECALL,
      )
      await expectRevert(
        execModule(
          f.safe,
          f.module,
          f.multiSendAddr,
          multiSendData(Array(9).fill(ping(f.targetAddr))),
          Op.DELEGATECALL,
        ),
        f.engine,
        'BatchTooLarge',
      )
    })
  })

  describe('owner-path gas fields and after-hooks', () => {
    it('NonZeroGasPrice then NonZeroSafeTxGas, before anything else; baseGas is allowed', async () => {
      const f = await setup([allow(scope(OWNERS))])
      await expectRevert(
        execOwner(f.safe, f.targetAddr, '0x12', Op.CALL, 0n, { gasPrice: 1n, safeTxGas: 1n }),
        f.engine,
        'NonZeroGasPrice',
      )
      await expectRevert(
        execOwner(f.safe, f.targetAddr, '0x12', Op.CALL, 0n, { safeTxGas: 1n }),
        f.engine,
        'NonZeroSafeTxGas',
      )
      await execOwner(f.safe, f.targetAddr, SEL.ping, Op.CALL, 0n, { baseGas: 5n })
    })

    it('ExecutionFailed and ModuleExecutionFailed on a failed execution', async () => {
      const f = await setup((x) => [allow(scope(x.module.address))])
      await expectRevert(
        execModule(f.safe, f.module, f.targetAddr, SEL.fail),
        f.engine,
        'ModuleExecutionFailed',
      )
      // MockSafeV2 (like Safe) reverts GS013 before the after-hook for a zero-gas owner
      // transaction, so the owner-path after-hook is called directly.
      await expectRevert(f.engine.checkAfterExecution(ethers.ZeroHash, false), f.engine, 'ExecutionFailed')
      await f.engine.checkAfterExecution(ethers.ZeroHash, true)
      await f.engine.checkAfterModuleExecution(ethers.ZeroHash, true)
    })
  })

  it('the lattice helper matches the scope levels', () => {
    expect(
      lattice(OWNERS, ZeroAddress, SEL.ping).map((s) => (s.actor === ANY ? 0 : 3) + s.callMatch),
    ).to.deep.equal([0, 1, 2, 3, 4, 5])
  })
})
