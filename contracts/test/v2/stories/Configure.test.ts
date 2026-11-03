import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import {
  Kind,
  OWNERS,
  Op,
  SEL,
  type World,
  allow,
  anyCall,
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
  install,
  onFunction,
  safeCall,
  transfer,
  usdc,
} from './world'
import { guardsOf } from '../fixtures/safe'

/**
 * Story: configuration is an ordinary Safe transaction to `engine.configure` (SPEC §3.3, COOKBOOK
 * "Configure"). The owners' call is granted without an Allow, so they can never lock themselves
 * out by forgetting one; a module needs the exact Allow `(module, engine.configure)`; it never runs
 * inside a batch, with value or as a DELEGATECALL; DENYs and policies apply to it as to any call.
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
