import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { guardsOf } from '../fixtures/safe'
import { previewGates } from '../engine/fixtures'
import {
  ANY,
  DELAY,
  GateKind,
  Kind,
  OWNERS,
  T,
  TX_INDEX,
  Verdict,
  addr,
  allow,
  applyConfig,
  attach,
  deployOrg,
  detach,
  execModule,
  execOwners,
  expectError,
  expectPolicyDenied,
  requestConfig,
  safeCall,
  scheduleOwners,
  scope,
  timelockSettings,
} from './world'

/**
 * Story: WA-4014 is fixed. In V1 a narrow rule hides the fallback, so with a fallback Timelock the
 * owners still remove the guard (`setGuard(0)`) or change owners at once whenever someone wrote an
 * Allow rule for that call. In V2 every matching scope runs: the owners' Timelock at `(Owners, *)`
 * covers every owner transaction, Safe management included, and a narrower Allow cannot hide it.
 * The configuration path is bound too: `DELAY ≥` the owners' timelock (SPEC §5.3).
 */
describe('E2E story: WA-4014 fixed (owners cannot skip their timelock)', () => {
  it('setGuard(0), setModuleGuard(0) and setFallbackHandler need the 24h delay', async () => {
    const w = await loadFixture(deployOrg)
    for (const tx of [
      safeCall(w, 'setGuard', [ZeroAddress]),
      safeCall(w, 'setModuleGuard', [ZeroAddress]),
      safeCall(w, 'setFallbackHandler', [ZeroAddress]),
    ]) {
      await expectPolicyDenied(execOwners(w, tx), w.engine, w.timelock, 'NotScheduled', undefined, TX_INDEX)
    }
    expect(await guardsOf(w.safe)).to.deep.equal({ guard: w.engineAddress, moduleGuard: w.engineAddress })
  })

  it('owner and module changes (add, swap, threshold, enableModule) need the 24h delay', async () => {
    const w = await loadFixture(deployOrg)
    for (const tx of [
      safeCall(w, 'addOwnerWithThreshold', [w.attacker.address, 1]),
      safeCall(w, 'swapOwner', [OWNERS, w.o1.address, w.attacker.address]),
      safeCall(w, 'changeThreshold', [1]),
      safeCall(w, 'enableModule', [w.attacker.address]),
    ]) {
      await expectPolicyDenied(execOwners(w, tx), w.engine, w.timelock, 'NotScheduled')
    }
  })

  it('a scheduled guard removal executes after 24h, and the guardian can stop it in between', async () => {
    const w = await loadFixture(deployOrg)
    const removal = safeCall(w, 'setGuard', [ZeroAddress])
    const hash = await scheduleOwners(w, removal)
    const readyAt = (await w.timelock.getSchedule(w.engineAddress, w.safeAddress, hash)).readyAt
    await expectPolicyDenied(execOwners(w, removal), w.engine, w.timelock, 'NotReady', [hash, readyAt])

    // The alert fires (Scheduled carries the full call); the guardian freezes; the schedule is void.
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    await time.increaseTo(readyAt)
    await expectPolicyDenied(execOwners(w, removal), w.engine, w.freeze, 'Frozen')
    await w.engine.connect(w.recovery).lift(w.safeAddress, ANY)
    await expectPolicyDenied(execOwners(w, removal), w.engine, w.timelock, 'ClearedByFreeze', [hash])

    // Re-scheduled after the freeze, it is a normal, visible, delayed owner decision.
    await scheduleOwners(w, removal)
    await time.increase(T)
    await execOwners(w, removal)
    expect((await guardsOf(w.safe)).guard).to.equal(ZeroAddress)
  })

  it("an exact Allow at (Owners, Safe.setGuard) — V1's hiding rule — does not skip the timelock", async () => {
    const w = await loadFixture(deployOrg)
    const exact = allow(scope(OWNERS, w.safeAddress, w.safe.interface.getFunction('setGuard')!.selector))
    const global = allow(scope(ANY, w.safeAddress, w.safe.interface.getFunction('setGuard')!.selector))
    await requestConfig(w, [exact, global])
    await time.increase(DELAY)
    await applyConfig(w, [exact, global])

    const removal = safeCall(w, 'setGuard', [ZeroAddress])
    await expectPolicyDenied(execOwners(w, removal), w.engine, w.timelock, 'NotScheduled')
    // Preview: three ALLOWs grant, the Timelock still denies ("needs a schedule").
    const gates = await previewGates(w.engine, w.safeAddress, OWNERS, removal.to, removal.data as string)
    expect(gates.filter((g) => g.kind === GateKind.ALLOW && g.verdict === Verdict.ALLOW)).to.have.length(3)
    const tl = gates.find((g) => g.policy === addr(w.timelock))!
    expect(tl.verdict).to.equal(Verdict.DENY)
    expect(tl.callIndex).to.equal(Number(TX_INDEX))
  })

  it('the configuration path cannot dodge it: removing the timelock waits DELAY ≥ T', async () => {
    const w = await loadFixture(deployOrg)
    const removeTimelock = [detach(scope(OWNERS), Kind.POLICY, addr(w.timelock))]
    const root = await requestConfig(w, removeTimelock)
    const validFrom = await w.engine.rootConfigured(w.safeAddress, root)
    expect(validFrom).to.equal(BigInt(await time.latest()) + T)
    await expectError(applyConfig(w, removeTimelock), w.engine, 'RootPending', [root, validFrom])
    // ConfigRequested is the alert; the guardian freezes, which blocks applying it (SPEC §7.1).
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    await time.increaseTo(validFrom)
    await expectError(applyConfig(w, removeTimelock), w.engine, 'ConfigFrozen')
  })

  it('a timelock longer than DELAY cannot be attached for the owners (DelayBelowTimelock)', async () => {
    const w = await loadFixture(deployOrg)
    const longer = [attach(scope(OWNERS), addr(w.timelock), timelockSettings(2n * DELAY))]
    await requestConfig(w, longer)
    await time.increase(DELAY)
    await expectError(applyConfig(w, longer), w.engine, 'DelayBelowTimelock', [DELAY, 2n * DELAY])
  })

  it('a module never touches the guard: an Allow at (*, Safe.setGuard) does not count for it (F5)', async () => {
    const w = await loadFixture(deployOrg)
    const setGuardSel = w.safe.interface.getFunction('setGuard')!.selector
    const anyone = allow(scope(ANY, w.safeAddress, setGuardSel))
    await requestConfig(w, [anyone])
    await time.increase(DELAY)
    await applyConfig(w, [anyone])

    const removal = safeCall(w, 'setGuard', [ZeroAddress])
    await expectError(execModule(w, w.ops, removal), w.engine, 'NotGranted', [
      0n,
      w.safeAddress,
      setGuardSel,
      0,
    ])
    const gates = await previewGates(
      w.engine,
      w.safeAddress,
      w.ops.address,
      removal.to,
      removal.data as string,
    )
    const anyAllow = gates.find((g) => g.kind === GateKind.ALLOW)!
    expect(anyAllow.verdict).to.equal(Verdict.PASS)
    expect(anyAllow.reasonName).to.equal('AllowNotExact')
  })
})
