import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  ANY,
  OWNERS,
  R,
  SEL,
  addr,
  allow,
  attach,
  deployWorld,
  execModule,
  expectPolicyDenied,
  install,
  recipientsSettings,
  scheduleModule,
  scope,
  swapOwnerCall,
  timelockSettings,
  tokenTransfer,
  usdc,
} from './world'

/**
 * Story: WA-4016 is fixed. In V1 every caller shares one rule table keyed `(to, selector, op)`, so
 * the payment allowlist the owners install as the fallback also judges the recovery module's
 * `swapOwner` and blocks it. In V2 the allowlist is a restriction attached where the owners want
 * it: per actor, per call, or even everywhere, and a restriction only judges the calls it
 * understands (Recipients classifies payments; `swapOwner` is not one).
 */
describe('E2E story: WA-4016 fixed (a payment allowlist no longer blocks recovery)', () => {
  async function deploy(allowlistAt: 'everyone' | 'usdc.transfer' | 'ops-strict') {
    const w = await deployWorld()
    const list = recipientsSettings({
      recipients: [w.vendorA.address],
      strict: allowlistAt === 'ops-strict',
    })
    const allowlist = {
      everyone: attach(scope(ANY), addr(w.recipients), list),
      'usdc.transfer': attach(scope(ANY, w.tokenAddress, SEL.transfer), addr(w.recipients), list),
      'ops-strict': attach(scope(w.ops.address), addr(w.recipients), list),
    }[allowlistAt]
    await install(
      w,
      [
        allow(scope(OWNERS)),
        allowlist,
        allow(scope(w.ops.address, w.tokenAddress, SEL.transfer)),
        attach(scope(w.recovery.address), addr(w.timelock), timelockSettings(R)),
        allow(scope(w.recovery.address, w.safeAddress, SEL.swapOwner)),
      ],
      [],
      { modules: [w.ops.address, w.recovery.address] },
    )
    return w
  }

  for (const at of ['everyone', 'usdc.transfer', 'ops-strict'] as const) {
    it(`allowlist at ${at}: payments to an unlisted recipient are denied, recovery replaces an owner`, async () => {
      const w = await deploy(at)
      await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, usdc(10)))
      await expectPolicyDenied(
        execModule(w, w.ops, tokenTransfer(w, w.attacker.address, usdc(10))),
        w.engine,
        w.recipients,
        'RecipientNotAllowed',
        [w.attacker.address],
      )

      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      await scheduleModule(w, w.recovery, swap)
      await time.increase(R)
      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
    })
  }
})
