import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import { revertData } from '../helpers'
import { cover } from '../mirror'
import {
  type Change,
  Kind,
  MONTH,
  Mask,
  OWNERS,
  Op,
  SEL,
  type Scope,
  type World,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  attachmentId,
  batchTx,
  call,
  configureCall,
  deny,
  deployWorld,
  detach,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  install,
  limitSettings,
  onContract,
  onFunction,
  recipientsPreset,
  safeCall,
  timelockSettings,
  transfer,
  usdc,
} from './world'
import { guardsOf } from '../fixtures/safe'

/**
 * Story: configuration is an ordinary Safe transaction to `engine.configure` (SPEC §3.3, COOKBOOK
 * "Configure"). The owners' call is granted without an Allow, so they can never lock themselves
 * out by forgetting one; a module needs the exact Allow `(module, engine.configure)`; it never runs
 * inside a batch, with value or as a DELEGATECALL; DENYs and policies apply to it as to any call,
 * except Limit and Args, which never judge a call to the engine (it moves nothing).
 */

async function world() {
  const w = await deployWorld()
  // The owners have no Allow at all; ops has (Ops, *).
  await install(w, [allow(anyCall(w.ops.address)), allow(anyCall(w.recovery.address))], {
    modules: [w.ops.address, w.recovery.address],
  })
  return w
}

const owners = (w: World) => allow(onFunction(OWNERS, w.tokenAddress, SEL.transfer))
const ids = async (w: World) => (await w.engine.getAttachments(w.safeAddress)).map((a) => a.attachmentId)

describe('Story: configuration is an ordinary transaction', () => {
  it('the owners configure without any Allow (implicit grant on the owner path); nothing else is granted', async () => {
    const w = await loadFixture(world)
    await expectEngineError(execOwners(w, transfer(w, w.vendorA.address, 1n)), w, 'NotGranted')
    await execOwners(w, configureCall(w, [owners(w)]))
    await execOwners(w, transfer(w, w.vendorA.address, 1n))
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(1n)
  })

  it('a module with (Ops, *) cannot configure: calls to the engine need the exact Allow (F5, NotGranted)', async () => {
    const w = await loadFixture(world)
    await expectEngineError(execModule(w, w.ops, configureCall(w, [owners(w)])), w, 'NotGranted', [
      0,
      w.engineAddress,
      SEL.configure,
      0,
    ])
    // The same rule protects the Safe itself: (Ops, *) does not grant Safe.addOwnerWithThreshold.
    await expectEngineError(
      execModule(w, w.ops, safeCall(w, 'addOwnerWithThreshold', [w.attacker.address, 1])),
      w,
      'NotGranted',
    )
  })

  it('a module with the exact Allow (Recovery, engine.configure) configures', async () => {
    const w = await loadFixture(world)
    await execOwners(
      w,
      configureCall(w, [allow(onFunction(w.recovery.address, w.engineAddress, SEL.configure))]),
    )
    await execModule(w, w.recovery, configureCall(w, [owners(w)]))
    await execOwners(w, transfer(w, w.vendorA.address, 1n))
  })

  it('configure inside a batch is denied (GuardTargetDenied names the sub-call)', async () => {
    const w = await loadFixture(world)
    await execOwners(w, configureCall(w, [owners(w)]))
    await expectEngineError(
      execOwners(w, batchTx(w, [transfer(w, w.vendorA.address, 1n), configureCall(w, [owners(w)])])),
      w,
      'GuardTargetDenied',
      [1],
    )
  })

  it('configure with value, as a DELEGATECALL, or any other engine function is denied (GuardTargetDenied)', async () => {
    const w = await loadFixture(world)
    const c = configureCall(w, [owners(w)])
    await expectEngineError(execOwners(w, { ...c, value: 1n }), w, 'GuardTargetDenied', [0])
    await expectEngineError(execOwners(w, { ...c, operation: Op.DELEGATECALL }), w, 'GuardTargetDenied', [0])
    const view = call(w.engineAddress, w.engine.interface.encodeFunctionData('getScopes', [w.safeAddress]))
    await expectEngineError(execOwners(w, view), w, 'GuardTargetDenied', [0])
  })

  it('DENY applies to configure: a DENY at (Owners, engine.configure) blocks the owners (Denied)', async () => {
    const w = await loadFixture(world)
    const lock = deny(onFunction(OWNERS, w.engineAddress, SEL.configure))
    await execOwners(w, configureCall(w, [lock]))
    await expectEngineError(execOwners(w, configureCall(w, [owners(w)])), w, 'Denied', [
      0,
      attachmentId(lock.scope, Kind.DENY),
    ])
  })

  describe('Limit and Args never judge configure (they cannot lock the owners out)', () => {
    it('a Limit at (Owners, *) without passUnpriced: payments are priced, configure passes, Safe admin calls stay Unpriced', async () => {
      const w = await deployWorld()
      const budget = attach(
        anyCall(OWNERS),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(1000), period: MONTH }]),
      )
      await install(w, [allow(anyCall(OWNERS)), budget])
      await execOwners(w, transfer(w, w.vendorA.address, usdc(10)))
      await expectPolicyDenied(execOwners(w, safeCall(w, 'setGuard', [ZeroAddress])), w, w.limit, 'Unpriced')
      await expectPolicyDenied(
        execOwners(w, safeCall(w, 'setModuleGuard', [ZeroAddress])),
        w,
        w.limit,
        'Unpriced',
      )
      // The call to the engine moves nothing: the owners can always detach the culprit.
      await execOwners(w, configureCall(w, [detach(anyCall(OWNERS), Kind.POLICY, w.limit)]))
      expect(await ids(w)).to.deep.equal([attachmentId(anyCall(OWNERS), Kind.ALLOW)])
      await execOwners(w, safeCall(w, 'setGuard', [ZeroAddress]))
    })

    it('a strict Args at (Owners, *) (Recipients preset): configure passes, Safe admin calls stay NoConstraint', async () => {
      const w = await deployWorld()
      await install(w, [
        allow(anyCall(OWNERS)),
        attach(anyCall(OWNERS), w.args, argsSettings(recipientsPreset([w.vendorA.address]), true)),
      ])
      await execOwners(w, transfer(w, w.vendorA.address, usdc(10)))
      await expectPolicyDenied(
        execOwners(w, safeCall(w, 'setGuard', [ZeroAddress])),
        w,
        w.args,
        'NoConstraint',
      )
      await execOwners(w, configureCall(w, [detach(anyCall(OWNERS), Kind.POLICY, w.args)]))
      await execOwners(w, safeCall(w, 'setGuard', [ZeroAddress]))
    })
  })

  describe('leftovers at install', () => {
    /** A Safe installed once, then uninstalled by the owners (guards removed, attachments kept). */
    async function uninstalled() {
      const w = await deployWorld()
      await install(w, [allow(anyCall(OWNERS)), deny(onFunction(ZeroAddress, w.tokenAddress, SEL.approve))])
      await execOwners(w, safeCall(w, 'setGuard', [ZeroAddress]))
      await execOwners(w, safeCall(w, 'setModuleGuard', [ZeroAddress]))
      return w
    }

    it('uninstalling keeps the attachments: the engine still lists them', async () => {
      const w = await loadFixture(uninstalled)
      expect(await guardsOf(w.safe)).to.deep.equal({ guard: ZeroAddress, moduleGuard: ZeroAddress })
      expect((await ids(w)).length).to.equal(2)
    })

    it('a re-install without detaching them inherits the old rules (the old DENY still blocks approve)', async () => {
      const w = await loadFixture(uninstalled)
      await install(w, [allow(onFunction(OWNERS, w.tokenAddress, SEL.approve))])
      await expectEngineError(
        execOwners(w, {
          to: w.tokenAddress,
          data: w.token.interface.encodeFunctionData('approve', [w.vendorA.address, usdc(1)]),
        }),
        w,
        'Denied',
      )
    })

    it('the install batch detaches the leftovers first, then attaches the new configuration', async () => {
      const w = await loadFixture(uninstalled)
      const leftovers = (await w.engine.getAttachments(w.safeAddress)).map((a) =>
        detach(
          {
            actor: a.scope.actor,
            to: a.scope.to,
            selector: a.scope.selector,
            callMatch: Number(a.scope.callMatch),
          },
          Number(a.kind),
          a.policy,
        ),
      )
      const fresh = allow(onFunction(OWNERS, w.tokenAddress, SEL.approve))
      await install(w, [...leftovers, fresh])
      expect(await ids(w)).to.deep.equal([attachmentId(fresh.scope, Kind.ALLOW)])
      await execOwners(w, {
        to: w.tokenAddress,
        data: w.token.interface.encodeFunctionData('approve', [w.vendorA.address, usdc(1)]),
      })
      await expectEngineError(execOwners(w, transfer(w, w.vendorA.address, 1n)), w, 'NotGranted')
    })
  })
})

/**
 * Review B8: random configure orderings against the app's mirror of the covering rule
 * (`src/lib/v2/rev3/cover.ts`). From a pool of Timelock covers, narrow owner delays, their
 * detaches, a module delay and an Allow, 200 seeded sequences are split into 1 to 3 batches and
 * applied; each batch must be accepted exactly when the mirror finds the final configuration
 * covered (and refused naming the route the mirror names), and the rule must hold on-chain after
 * every accepted batch. The oracle is the mirror on both sides (acceptance, and the rule read back
 * from `getAttachments`), so a misreading shared by mirror and contract would pass here: the unit
 * tests of `policies/Timelock.test.ts`, with selectors derived from the signatures, anchor the rule
 * itself. `configure` acts for its caller, so an owner EOA configures itself here: the
 * rule only reads attachments, and `msg.sender` stands for the Safe.
 */
describe('Story: random configure orderings keep the covering rule (review B8)', () => {
  const H72 = 3 * 24 * 3600
  const H24 = 24 * 3600

  /** mulberry32: a small seeded PRNG, so a failure is reproducible from its sequence number. */
  function rng(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  type Entry = { scope: Scope; kind: number; opMask: number; delay: number }

  it('200 sequences: the engine accepts a batch exactly when the mirror does; the rule holds after each', async function () {
    this.timeout(600_000)
    const w = await loadFixture(deployWorld)
    const actor = w.o1
    const self = actor.address
    const tl = addrOf(w.timelock)
    const timelock = (delay: number) => timelockSettings({ delay: BigInt(delay) })
    const owners = anyCall(OWNERS)
    const everyone = anyCall(ZeroAddress)
    const safeAdmin = onContract(OWNERS, self)
    const engineConfigure = onFunction(OWNERS, w.engineAddress, SEL.configure)
    const narrow24 = onFunction(OWNERS, w.tokenAddress, SEL.transfer)
    const narrow72 = onContract(OWNERS, w.tokenAddress)
    const moduleScope = anyCall(w.ops.address)
    const pool: { change: Change; entry?: Entry }[] = []
    const add = (s: Scope, delay: number, opMask: number = Mask.DEFAULT) =>
      pool.push(
        {
          change: attach(s, tl, timelock(delay), opMask),
          entry: { scope: s, kind: Kind.POLICY, opMask, delay },
        },
        { change: detach(s, Kind.POLICY, tl) },
      )
    add(owners, H72)
    add(everyone, H72)
    add(safeAdmin, H72)
    add(engineConfigure, H72)
    add(narrow24, H24)
    add(narrow72, H72)
    add(moduleScope, H72)
    // Updates of the same ids: a shorter cover, and (Owners, *) DELEGATECALL-only.
    pool.push({
      change: attach(owners, tl, timelock(H24)),
      entry: { scope: owners, kind: Kind.POLICY, opMask: Mask.DEFAULT, delay: H24 },
    })
    pool.push({
      change: attach(owners, tl, timelock(H72), Mask.DELEGATECALL),
      entry: { scope: owners, kind: Kind.POLICY, opMask: Mask.DELEGATECALL, delay: H72 },
    })
    const allowOps = allow(onFunction(w.ops.address, w.tokenAddress, SEL.transfer))
    pool.push({ change: allowOps, entry: { scope: allowOps.scope, kind: Kind.ALLOW, opMask: 0, delay: 0 } })
    pool.push({ change: detach(allowOps.scope, Kind.ALLOW) })

    const idOf = (s: Scope, kind: number) => attachmentId(s, kind, kind === Kind.POLICY ? tl : ZeroAddress)
    const covers = (state: Map<string, Entry>) =>
      [...state.values()]
        .filter((e) => e.kind === Kind.POLICY)
        .map((e) => ({ scope: e.scope, opMask: e.opMask === 0 ? 3 : e.opMask, delay: e.delay }))
    const onChainCovers = async () => {
      const all = await w.engine.getAttachments(self)
      return Promise.all(
        all
          .filter((a) => Number(a.kind) === Kind.POLICY)
          .map(async (a) => ({
            scope: {
              actor: a.scope.actor,
              to: a.scope.to,
              selector: a.scope.selector,
              callMatch: Number(a.scope.callMatch),
            },
            opMask: Number(a.opMask),
            delay: Number((await w.timelock.getSettings(w.engineAddress, self, a.attachmentId)).delay),
          })),
      )
    }

    let accepted = 0
    let refused = 0
    for (let seq = 0; seq < 200; seq++) {
      const snapshot = await ethers.provider.send('evm_snapshot', [])
      const random = rng(seq + 1)
      const changes = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        () => pool[Math.floor(random() * pool.length)],
      )
      const batches: (typeof changes)[] = []
      const parts = 1 + Math.floor(random() * Math.min(3, changes.length))
      for (let i = 0; i < parts; i++) batches.push([])
      changes.forEach((c, i) => batches[i < parts ? i : Math.floor(random() * parts)].push(c))

      let state = new Map<string, Entry>()
      for (const batch of batches) {
        const next = new Map(state)
        let missing = false
        for (const { change, entry } of batch) {
          const id = idOf(change.scope, change.kind)
          if (change.detach) missing ||= !next.delete(id)
          else next.set(id, entry!)
        }
        const expected = cover.uncoveredRoute(covers(next), w.engineAddress, self)
        let data: string | undefined
        try {
          await (await w.engine.connect(actor).configure(batch.map((b) => b.change))).wait()
        } catch (e) {
          data = revertData(e)
          if (data === undefined) throw e
        }
        const where = `sequence ${seq}, batch ${batches.indexOf(batch)}`
        if (missing) {
          expect(w.engine.interface.parseError(data!)?.name, where).to.equal('NotAttached')
          continue
        }
        if (expected) {
          expect(data, `${where}: the mirror refuses (${expected.name}), the engine accepted`).to.not.equal(
            undefined,
          )
          const outer = w.engine.interface.parseError(data!)!
          expect(outer.name, where).to.equal('PolicyConfigurationFailed')
          const inner = w.timelock.interface.parseError(outer.args.reason)!
          expect(inner.name, where).to.equal('TimelockNotCoveringConfiguration')
          expect(
            [inner.args[0].toLowerCase(), inner.args[1], Number(inner.args[2]), Number(inner.args[3])],
            where,
          ).to.deep.equal([expected.to.toLowerCase(), expected.selector, expected.op, expected.delay])
          refused++
          continue
        }
        expect(data, `${where}: the mirror accepts, the engine refused ${data}`).to.equal(undefined)
        state = next
        accepted++
        // The rule holds on-chain, read back through the engine as the app reads it.
        expect(cover.uncoveredRoute(await onChainCovers(), w.engineAddress, self), where).to.equal(null)
      }
      await ethers.provider.send('evm_revert', [snapshot])
    }
    // Both outcomes are exercised.
    expect(accepted).to.be.greaterThan(50)
    expect(refused).to.be.greaterThan(50)
  })
})
