import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import { eventsOf, expectAnyRevert, expectEvent } from '../helpers'
import {
  ANY,
  Behaviour,
  CallMatch,
  Kind,
  Mask,
  OWNERS,
  SEL,
  allow,
  attachmentId,
  deny,
  deployEngine,
  deploySafe,
  detach,
  expectRevert,
  levelOf,
  policy,
  scope,
  scopeKey,
  settings,
} from './fixtures'

/** `configure` (SPEC.md §3.2): every configure-time rule, the stored state, events and views. */
describe('V2 engine: configure', () => {
  async function fresh() {
    const [, module] = await ethers.getSigners()
    const { engine, guard, config, multiSend } = await deployEngine()
    const { address: safeAddr, asSafe } = await deploySafe()
    const target = await (await ethers.deployContract('EngineTarget')).getAddress()
    const p = await ethers.deployContract('EngineMockPolicy')
    const pAddr = await p.getAddress()
    const configure = (changes: Parameters<typeof engine.configure>[0]) =>
      engine.connect(asSafe).configure(changes)
    return { engine, guard, config, multiSend, safeAddr, asSafe, module, target, p, pAddr, configure }
  }

  describe('deployment', () => {
    it('rejects zero, duplicate or too many trusted batches and a config without code', async () => {
      const config = await (await ethers.deployContract('PolicyGuardConfig')).getAddress()
      const [a, b, c, d, e] = (await ethers.getSigners()).map((s) => s.address)
      const factory = await ethers.getContractFactory('PolicyGuard')
      const iface = (await ethers.getContractAt('IPolicyGuard', ZeroAddress)).interface
      for (const [batches, cfg] of [
        [[], config],
        [[ZeroAddress], config],
        [[a, a], config],
        [[a, b, c, d, e], config],
        [[a], ZeroAddress],
        [[a], b],
      ] as [string[], string][]) {
        await expectRevert(factory.deploy(batches, cfg), { interface: iface }, 'InvalidDeployment')
      }
    })

    it('lists the trusted batches and answers ERC-165 for the engine and both Safe guard interfaces', async () => {
      const [a, b, c] = (await ethers.getSigners()).map((s) => s.address)
      const { engine } = await deployEngine([a, b, c])
      expect(await engine.trustedBatches()).to.deep.equal([a, b, c])
      expect(await engine.isTrustedBatch(b)).to.equal(true)
      expect(await engine.isTrustedBatch(ZeroAddress)).to.equal(false)
      const { engine: one } = await deployEngine([a])
      expect(await one.trustedBatches()).to.deep.equal([a])
      // IPolicyGuard (own functions), ITransactionGuard, IModuleGuard (Safe 1.5.0 ids), IERC165.
      const ids = ['0xe6d7a83a', '0x58401ed8', '0x01ffc9a7']
      for (const i of ids) expect(await engine.supportsInterface(i), i).to.equal(true)
      expect(await engine.supportsInterface('0xffffffff')).to.equal(false)
      const iface = engine.interface
      let own = 0n
      iface.forEachFunction((fn) => {
        if (
          ![
            'checkTransaction',
            'checkAfterExecution',
            'checkModuleTransaction',
            'checkAfterModuleExecution',
            'supportsInterface',
          ].includes(fn.name)
        )
          own ^= BigInt(fn.selector)
      })
      expect(await engine.supportsInterface('0x' + own.toString(16).padStart(8, '0'))).to.equal(true)
    })

    it('reverts unknown selectors through the fallback', async () => {
      const { engine } = await fresh()
      await expectAnyRevert(ethers.provider.call({ to: await engine.getAddress(), data: '0xdeadbeef' }))
    })
  })

  describe('attach and detach', () => {
    it('attaches, emits Attached with everything, calls the policy, updates and detaches', async () => {
      const { engine, configure, safeAddr, target, p, pAddr, module } = await fresh()
      const s = scope(module.address, CallMatch.FUNCTION, target, SEL.ping)
      const key = scopeKey(s)
      const id = attachmentId(s, Kind.POLICY, pAddr)
      const tx = await configure([policy(s, pAddr)])
      await expectEvent(tx, engine, 'Attached', [
        safeAddr,
        id,
        key,
        [s.actor, s.to, s.selector, s.callMatch],
        Kind.POLICY,
        pAddr,
        Mask.ALL,
        settings(),
      ])
      await expectEvent(tx, p, 'Configured', [
        await engine.getAddress(),
        safeAddr,
        id,
        [s.actor, s.to, s.selector, s.callMatch],
        Mask.ALL,
      ])
      expect(await engine.scopeKey(s)).to.equal(key)
      expect(await engine.attachmentId(key, Kind.POLICY, pAddr)).to.equal(id)
      let [exists, view] = await engine.getAttachment(safeAddr, id)
      expect(exists).to.equal(true)
      expect(view.opMask).to.equal(BigInt(Mask.ALL))
      expect(view.scope.actor).to.equal(module.address)

      // Update in place: same id, new mask, the policy is configured again.
      const tx2 = await configure([policy(s, pAddr, Behaviour.PASS, Mask.CALL)])
      await expectEvent(tx2, p, 'Configured')
      ;[exists, view] = await engine.getAttachment(safeAddr, id)
      expect(view.opMask).to.equal(BigInt(Mask.CALL))
      expect((await engine.getAttachments(safeAddr)).length).to.equal(1)

      // Detach: no policy call.
      const tx3 = await configure([detach(s, Kind.POLICY, pAddr)])
      await expectEvent(tx3, engine, 'Detached', [safeAddr, id, key])
      expect((await eventsOf(tx3, p, 'Configured')).length).to.equal(0)
      ;[exists] = await engine.getAttachment(safeAddr, id)
      expect(exists).to.equal(false)
      expect(await engine.levelsUsed(safeAddr)).to.equal(0n)
      expect((await engine.getScopes(safeAddr))[0].length).to.equal(0)
    })

    it('normalizes zero op masks: CALL for ALLOW, both ops for DENY and POLICY', async () => {
      const { engine, configure, safeAddr, pAddr } = await fresh()
      await configure([allow(scope(OWNERS)), deny(scope(ANY)), policy(scope(OWNERS), pAddr)])
      const masks = (await engine.getAttachments(safeAddr)).map((a) => [Number(a.kind), Number(a.opMask)])
      expect(masks).to.deep.equal([
        [Kind.ALLOW, Mask.CALL],
        [Kind.POLICY, Mask.ALL],
        [Kind.DENY, Mask.ALL],
      ])
    })

    it('enumerates scopes and attachments, fills the level bitmap, and keeps both after swap-removals', async () => {
      const { engine, configure, safeAddr, target, pAddr, module } = await fresh()
      const m = module.address
      const scopes = [
        scope(ANY),
        scope(ANY, CallMatch.CONTRACT, target),
        scope(ANY, CallMatch.FUNCTION, target, SEL.ping),
        scope(m),
        scope(m, CallMatch.CONTRACT, target),
        scope(m, CallMatch.FUNCTION, target, SEL.ping),
      ]
      expect(scopes.map(levelOf)).to.deep.equal([0, 1, 2, 3, 4, 5])
      await configure(scopes.flatMap((s) => [deny(s), policy(s, pAddr)]))
      expect(await engine.levelsUsed(safeAddr)).to.equal(0b111111n)
      const [keys, got] = await engine.getScopes(safeAddr)
      expect(keys).to.deep.equal(scopes.map(scopeKey))
      expect(got.map((s) => [s.actor, s.to, s.selector, Number(s.callMatch)])).to.deep.equal(
        scopes.map((s) => [s.actor, s.to, s.selector, s.callMatch]),
      )
      expect((await engine.getAttachments(safeAddr)).length).to.equal(12)

      // Remove the first attachment of scope 0 (the last one moves into its place) and all of scope 2.
      await configure([
        detach(scopes[0], Kind.DENY),
        detach(scopes[2], Kind.DENY),
        detach(scopes[2], Kind.POLICY, pAddr),
      ])
      expect(await engine.levelsUsed(safeAddr)).to.equal(0b111011n)
      const at0 = await engine.getScopeAttachments(safeAddr, scopeKey(scopes[0]))
      expect(at0.map((a) => a.attachmentId)).to.deep.equal([attachmentId(scopes[0], Kind.POLICY, pAddr)])
      const [exists, moved] = await engine.getAttachment(
        safeAddr,
        attachmentId(scopes[0], Kind.POLICY, pAddr),
      )
      expect(exists && moved.scopeKey === scopeKey(scopes[0])).to.equal(true)
      const after = [...(await engine.getScopes(safeAddr))[0]]
      expect(after.sort()).to.deep.equal([0, 1, 3, 4, 5].map((i) => scopeKey(scopes[i])).sort())
      // The scope that moved into slot 2 still detaches cleanly.
      await configure(
        scopes
          .filter((_, i) => i !== 2)
          .flatMap((s, i) => [...(i === 0 ? [] : [detach(s, Kind.DENY)]), detach(s, Kind.POLICY, pAddr)]),
      )
      expect((await engine.getScopes(safeAddr))[0].length).to.equal(0)
      expect((await engine.getAttachments(safeAddr)).length).to.equal(0)
    })

    it('the attachment is stored before its policy is configured, and views answer during configure', async () => {
      const { configure, p, pAddr, target } = await fresh()
      const allowId = attachmentId(scope(OWNERS), Kind.ALLOW)
      const missing = attachmentId(scope(OWNERS, CallMatch.CONTRACT, target), Kind.ALLOW)
      // Own id: visible with the new mask; another attachment of the same configure call, applied
      // earlier: visible too.
      let tx = await configure([
        allow(scope(OWNERS)),
        policy(scope(OWNERS), pAddr, Behaviour.CONFIG_PROBE, Mask.CALL, allowId),
      ])
      await expectEvent(tx, p, 'ConfigureSaw', [true, Mask.CALL, true, Mask.CALL])
      // An update: the policy sees the updated mask; an id never attached: not visible.
      tx = await configure([policy(scope(OWNERS), pAddr, Behaviour.CONFIG_PROBE, Mask.ALL, missing)])
      await expectEvent(tx, p, 'ConfigureSaw', [true, Mask.ALL, false, 0])
    })

    it('keeps each Safe apart', async () => {
      const { engine, configure, safeAddr } = await fresh()
      const other = await deploySafe()
      await configure([allow(scope(OWNERS))])
      expect((await engine.getAttachments(other.address)).length).to.equal(0)
      expect(await engine.levelsUsed(safeAddr)).to.equal(0b1000n)
    })

    it('applies in order: attach then detach in one call', async () => {
      const { engine, configure, safeAddr } = await fresh()
      await configure([allow(scope(OWNERS)), detach(scope(OWNERS), Kind.ALLOW)])
      expect((await engine.getAttachments(safeAddr)).length).to.equal(0)
    })
  })

  describe('rules', () => {
    it('InvalidScope: a non-normalized scope', async () => {
      const { engine, configure, target } = await fresh()
      const bad = [
        { actor: OWNERS, to: target, selector: SEL.empty, callMatch: CallMatch.ANY },
        { actor: OWNERS, to: ZeroAddress, selector: SEL.ping, callMatch: CallMatch.ANY },
        { actor: OWNERS, to: ZeroAddress, selector: SEL.empty, callMatch: CallMatch.CONTRACT },
        { actor: OWNERS, to: target, selector: SEL.ping, callMatch: CallMatch.CONTRACT },
        { actor: OWNERS, to: ZeroAddress, selector: SEL.ping, callMatch: CallMatch.FUNCTION },
      ]
      for (const s of bad) {
        await expectRevert(configure([allow(s)]), engine, 'InvalidScope')
        await expectRevert(configure([detach(s, Kind.ALLOW)]), engine, 'InvalidScope')
      }
      // A FUNCTION scope on empty calldata is valid.
      await configure([allow(scope(OWNERS, CallMatch.FUNCTION, target, SEL.empty))])
    })

    it('AllowNotPerActor: an ALLOW at ANY', async () => {
      const { engine, configure, target } = await fresh()
      for (const s of [
        scope(ANY),
        scope(ANY, CallMatch.CONTRACT, target),
        scope(ANY, CallMatch.FUNCTION, target, SEL.ping),
      ])
        await expectRevert(configure([allow(s)]), engine, 'AllowNotPerActor')
    })

    it('DelegateCallNotExact: an ALLOW covering DELEGATECALL below level 5', async () => {
      const { engine, configure, target, module } = await fresh()
      for (const actor of [OWNERS, module.address]) {
        for (const s of [scope(actor), scope(actor, CallMatch.CONTRACT, target)]) {
          await expectRevert(configure([allow(s, Mask.DELEGATECALL)]), engine, 'DelegateCallNotExact')
          await expectRevert(configure([allow(s, Mask.ALL)]), engine, 'DelegateCallNotExact')
        }
        await configure([allow(scope(actor, CallMatch.FUNCTION, target, SEL.ping), Mask.ALL)])
      }
      // DENY and POLICY may cover DELEGATECALL anywhere.
      await configure([deny(scope(ANY), Mask.DELEGATECALL)])
    })

    it('InvalidOpMask: a mask above 3', async () => {
      const { engine, configure, pAddr } = await fresh()
      await expectRevert(configure([allow(scope(OWNERS), 4)]), engine, 'InvalidOpMask', [4])
      await expectRevert(configure([policy(scope(ANY), pAddr, 0, 255)]), engine, 'InvalidOpMask', [255])
    })

    it('InvalidPolicy: zero, no code, no IPolicy, a bad ERC-165 answer; ALLOW/DENY with a policy or settings', async () => {
      const { engine, configure, pAddr, target } = await fresh()
      const bads = [
        ZeroAddress,
        (await ethers.getSigners())[5].address,
        target,
        ...(await Promise.all(
          [0, 1, 2].map(async (mode) =>
            (await ethers.deployContract('EngineBadPolicy', [mode])).getAddress(),
          ),
        )),
      ]
      for (const bad of bads) {
        await expectRevert(configure([policy(scope(ANY), bad)]), engine, 'InvalidPolicy', [bad])
      }
      await expectRevert(configure([{ ...allow(scope(OWNERS)), policy: pAddr }]), engine, 'InvalidPolicy', [
        pAddr,
      ])
      await expectRevert(configure([{ ...deny(scope(ANY)), settings: '0x01' }]), engine, 'InvalidPolicy', [
        ZeroAddress,
      ])
    })

    it('PolicyConfigurationFailed: the policy rejects its settings (reason forwarded)', async () => {
      const { engine, configure, p, pAddr } = await fresh()
      const reason = p.interface.encodeErrorResult('MockConfigRejected')
      await expectRevert(
        configure([policy(scope(ANY), pAddr, Behaviour.CONFIG_REVERT)]),
        engine,
        'PolicyConfigurationFailed',
        [pAddr, reason],
      )
      // Undecodable settings: the policy reverts without data.
      await expectRevert(
        configure([{ ...policy(scope(ANY), pAddr), settings: '0x' }]),
        engine,
        'PolicyConfigurationFailed',
        [pAddr, '0x'],
      )
    })

    it('TooManyAttachments: a 9th attachment at one scope (all kinds count)', async () => {
      const { engine, configure } = await fresh()
      const policies = await Promise.all(
        Array.from({ length: 8 }, async () => (await ethers.deployContract('EngineMockPolicy')).getAddress()),
      )
      const s = scope(OWNERS)
      await configure([allow(s), deny(s), ...policies.slice(0, 6).map((p) => policy(s, p))])
      await expectRevert(configure([policy(s, policies[6])]), engine, 'TooManyAttachments', [scopeKey(s)])
      // Updating an existing one is fine at the cap.
      await configure([allow(s, Mask.CALL)])
    })

    it('NotAttached: detaching what does not exist', async () => {
      const { engine, configure, pAddr } = await fresh()
      const id = attachmentId(scope(ANY), Kind.POLICY, pAddr)
      await expectRevert(configure([detach(scope(ANY), Kind.POLICY, pAddr)]), engine, 'NotAttached', [id])
    })

    it('a failing change reverts the whole configure', async () => {
      const { engine, configure, safeAddr } = await fresh()
      await expectRevert(configure([allow(scope(OWNERS)), allow(scope(ANY))]), engine, 'AllowNotPerActor')
      expect((await engine.getAttachments(safeAddr)).length).to.equal(0)
    })
  })

  describe('pure views', () => {
    it('moduleCallHash matches ScopeLib', async () => {
      const { engine, safeAddr, module, target } = await fresh()
      const expected = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
          [safeAddr, module.address, target, 5n, SEL.ping, 1],
        ),
      )
      expect(await engine.moduleCallHash(safeAddr, module.address, target, 5n, SEL.ping, 1)).to.equal(
        expected,
      )
    })

    it('the configure selector used by the tests is the engine one', async () => {
      const { engine } = await fresh()
      expect(engine.interface.getFunction('configure')!.selector).to.equal(SEL.configure)
    })
  })
})
