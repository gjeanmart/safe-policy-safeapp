import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import { FQN, deployEngineV2, engineAt } from '../../../scripts/lib/v2-deployment'
import { eventsOf, expectAnyRevert, expectEvent } from '../helpers'
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
  allow,
  attachmentId,
  deny,
  deployEngine,
  deploySafe,
  detach,
  execModule,
  execOwner,
  expectRevert,
  policy,
  scope,
  scopeKey,
  settings,
  setup,
} from './fixtures'

/** SPEC.md §5: configureImmediately, request / apply / invalidate, change validation, roles. */
describe('V2 engine: configuration', () => {
  async function fresh() {
    const { engine } = await deployEngine()
    const safe = await deploySafe()
    const cp = await ethers.deployContract('MockPolicyV2', [Level.CALL])
    const target = await ethers.deployContract('EngineTarget')
    return { engine, ...safe, cp, cpA: await cp.getAddress(), t: await target.getAddress() }
  }

  describe('constructor', () => {
    it('validates timing and deployment', async () => {
      const { engine } = await deployEngine()
      const batch = ethers.Wallet.createRandom().address
      const lib = ethers.Wallet.createRandom().address
      // The modules check the arguments first (they share the guard's constructor checks).
      const deploy = async ([delay, expiry, maxFreeze, freezeCooldown, trustedBatches, signLib]: [
        number,
        number,
        number,
        number,
        string[],
        string,
      ]) => {
        const deployed = await deployEngineV2({
          delay: BigInt(delay),
          expiry: BigInt(expiry),
          maxFreeze: BigInt(maxFreeze),
          freezeCooldown: BigInt(freezeCooldown),
          trustedBatches,
          signLib,
        })
        return engineAt(deployed.engine)
      }
      await expectRevert(deploy([0, 0, 1, 0, [batch], lib]), engine, 'InvalidTiming')
      await expectRevert(deploy([0, 10, 0, 0, [batch], lib]), engine, 'InvalidTiming')
      await expectRevert(deploy([5, 10, 4, 2, [batch], lib]), engine, 'InvalidTiming') // 10 < 4 + 2 + 5
      await deploy([4, 10, 4, 2, [batch], lib])
      await expectRevert(deploy([0, 10, 1, 0, [batch], ZeroAddress]), engine, 'InvalidDeployment')
      await expectRevert(deploy([0, 10, 1, 0, [], lib]), engine, 'InvalidDeployment')
      await expectRevert(deploy([0, 10, 1, 0, [ZeroAddress], lib]), engine, 'InvalidDeployment')
      await expectRevert(deploy([0, 10, 1, 0, [batch, batch], lib]), engine, 'InvalidDeployment')
      const five = Array.from({ length: 5 }, () => ethers.Wallet.createRandom().address)
      await expectRevert(deploy([0, 10, 1, 0, five, lib]), engine, 'InvalidDeployment')
      const four = await deploy([0, 10, 1, 0, five.slice(0, 4), lib])
      expect(await four.getFunction('getTrustedBatches')()).to.deep.equal(five.slice(0, 4))
      expect(await four.getFunction('isTrustedBatch')(five[3])).to.equal(true)
      expect(await four.getFunction('isTrustedBatch')(five[4])).to.equal(false)
      expect(await four.getFunction('SIGN_LIB')()).to.equal(lib)
    })

    it('exposes its immutables and interface ids', async () => {
      const { engine } = await deployEngine()
      expect(await engine.DELAY()).to.equal(TIMING.delay)
      expect(await engine.EXPIRY()).to.equal(TIMING.expiry)
      expect(await engine.MAX_FREEZE()).to.equal(TIMING.maxFreeze)
      expect(await engine.FREEZE_COOLDOWN()).to.equal(TIMING.cooldown)
      for (const id of ['0xdc1727e9', '0xe6d7a83a', '0x58401ed8', '0x01ffc9a7']) {
        expect(await engine.supportsInterface(id), id).to.equal(true)
      }
      expect(await engine.supportsInterface('0xffffffff')).to.equal(false)
    })

    it('lists its modules and refuses modules deployed with other arguments', async () => {
      const { engine, multiSend, signLib, modules } = await deployEngine()
      expect([...(await engine.engineModules())]).to.deep.equal(modules)
      const params = [
        TIMING.delay,
        TIMING.expiry,
        TIMING.maxFreeze,
        TIMING.cooldown,
        [await multiSend.getAddress()],
        signLib,
      ]
      await ethers.deployContract(FQN.engine, [...params, modules]) // same arguments: accepted
      const other = [TIMING.delay + 1n, ...params.slice(1)]
      await expectRevert(ethers.deployContract(FQN.engine, [...other, modules]), engine, 'InvalidDeployment')
      const swapped = [modules[0], modules[1], modules[2], modules[3], ethers.Wallet.createRandom().address]
      await expectRevert(ethers.deployContract(FQN.engine, [...params, swapped]), engine, 'InvalidDeployment')
    })

    it('rejects direct calls to its modules, and unknown selectors', async () => {
      const { engine, modules } = await deployEngine()
      const [configAddress, freezeAddress, previewAddress, viewsAddress, runnerAddress] = modules
      const config = await ethers.getContractAt(FQN.engineConfig, configAddress)
      const freeze = await ethers.getContractAt(FQN.engineFreeze, freezeAddress)
      const preview = await ethers.getContractAt(FQN.enginePreview, previewAddress)
      const views = await ethers.getContractAt(FQN.engineViews, viewsAddress)
      const runner = await ethers.getContractAt(FQN.engineRunner, runnerAddress)
      await expectRevert(config.requestConfiguration(ethers.ZeroHash), config, 'NotDelegated')
      await expectRevert(freeze.lift(ZeroAddress, ZeroAddress), freeze, 'NotDelegated')
      await expectRevert(freeze.isGuardian(ZeroAddress, ZeroAddress), freeze, 'NotDelegated')
      await expectRevert(
        preview.preview(ZeroAddress, OWNERS, ZeroAddress, 0, '0x', 0),
        preview,
        'NotDelegated',
      )
      await expectRevert(views.getAttachments(ZeroAddress), views, 'NotDelegated')
      // The runner answers the hooks' own calldata (forwarded by the guard), never directly.
      const [signer] = await ethers.getSigners()
      const hook = engine.interface.encodeFunctionData('checkModuleTransaction', [
        ZeroAddress,
        0,
        '0x',
        0,
        ZeroAddress,
      ])
      await expectRevert(signer.sendTransaction({ to: runnerAddress, data: hook }), runner, 'NotDelegated')
      await expectRevert(
        signer.sendTransaction({ to: runnerAddress, data: '0xdeadbeef' }),
        runner,
        'NotDelegated',
      )
      // The guard's fallback sends unknown selectors to the freeze module, which has no fallback.
      await expectAnyRevert(signer.sendTransaction({ to: await engine.getAddress(), data: '0xdeadbeef' }))
    })
  })

  describe('configureImmediately', () => {
    it('applies at once, emits ConfiguredImmediately first, then the change logs', async () => {
      const f = await fresh()
      const s = scope(OWNERS)
      const changes = [allow(s), policy(s, f.cpA, Behaviour.PASS)]
      const roles = [{ role: 0, account: f.t, enabled: true }]
      const tx = await f.engine.connect(f.asSafe).configureImmediately(changes, roles)
      const receipt = await tx.wait()
      const names = receipt!.logs
        .map((l) => {
          try {
            return f.engine.interface.parseLog(l)?.name
          } catch {
            return undefined
          }
        })
        .filter(Boolean)
      expect(names).to.deep.equal(['ConfiguredImmediately', 'Attached', 'Attached', 'RoleSet'])
      await expectEvent(tx, f.engine, 'ConfiguredImmediately', [
        f.address,
        await f.engine.configurationRoot(changes, roles),
      ])
      const attached = (await eventsOf(tx, f.engine, 'Attached'))[1]
      expect(attached.args.attachmentId).to.equal(attachmentId(s, Kind.POLICY, f.cpA))
      expect(attached.args.scopeKey).to.equal(scopeKey(s))
      expect(attached.args.policyLevel).to.equal(BigInt(Level.CALL))
      expect(attached.args.opMask).to.equal(1n)
      expect(attached.args.data).to.equal(settings(Behaviour.PASS))
      expect(
        await f.cp.configured(await f.engine.getAddress(), f.address, attachmentId(s, Kind.POLICY, f.cpA)),
      ).to.equal(1n)
    })

    it('is closed once the engine is the Safe guard or module guard', async () => {
      for (const setter of ['setGuard', 'setModuleGuard'] as const) {
        const f = await fresh()
        await execOwner(
          f.safe,
          f.address,
          f.safe.interface.encodeFunctionData(setter as 'setGuard', [await f.engine.getAddress()]),
        )
        await expectRevert(
          f.engine.connect(f.asSafe).configureImmediately([], []),
          f.engine,
          'GuardAlreadyEnabled',
        )
      }
    })

    it('works for a caller that is not a Safe (no getStorageAt)', async () => {
      const { engine } = await deployEngine()
      const [, eoa] = await ethers.getSigners()
      await engine.connect(eoa).configureImmediately([allow(scope(ANY))], [])
      expect(Number(await engine.levelsUsed(eoa.address))).to.equal(1)
    })
  })

  describe('change validation (§5.2)', () => {
    it('InvalidScope: wildcard parts not zero, named to == 0', async () => {
      const f = await fresh()
      const bad = [
        { actor: ANY, to: f.t, selector: SEL.empty, callMatch: CallMatch.ANY },
        { actor: ANY, to: ZeroAddress, selector: SEL.ping, callMatch: CallMatch.TO },
        { actor: ANY, to: f.t, selector: SEL.ping, callMatch: CallMatch.SELECTOR },
        { actor: ANY, to: ZeroAddress, selector: SEL.ping, callMatch: CallMatch.TO_SELECTOR },
        { actor: ANY, to: ZeroAddress, selector: SEL.empty, callMatch: CallMatch.TO },
      ]
      for (const s of bad) {
        await expectRevert(
          f.engine.connect(f.asSafe).configureImmediately([allow(s)], []),
          f.engine,
          'InvalidScope',
        )
      }
      // A named selector may be 0x00000000 (empty calldata).
      await f.engine
        .connect(f.asSafe)
        .configureImmediately([allow(scope(ANY, CallMatch.TO_SELECTOR, f.t, SEL.empty))], [])
    })

    it('InvalidOpMask above 3', async () => {
      const f = await fresh()
      await expectRevert(
        f.engine.connect(f.asSafe).configureImmediately([allow(scope(ANY), 4)], []),
        f.engine,
        'InvalidOpMask',
        [4],
      )
    })

    it('DelegateCallNotExact: an ALLOW covering DELEGATECALL below level 7', async () => {
      const f = await fresh()
      for (const s of [scope(ANY, CallMatch.TO_SELECTOR, f.t, SEL.ping), scope(f.t, CallMatch.TO, f.t)]) {
        await expectRevert(
          f.engine.connect(f.asSafe).configureImmediately([allow(s, 2)], []),
          f.engine,
          'DelegateCallNotExact',
        )
      }
      // DENY may cover DELEGATECALL anywhere; ALLOW at level 7 may.
      await f.engine
        .connect(f.asSafe)
        .configureImmediately(
          [deny(scope(ANY), 3), allow(scope(f.t, CallMatch.TO_SELECTOR, f.t, SEL.ping), 3)],
          [],
        )
    })

    it('InvalidPolicy: built-ins with a policy or data, non-contracts, non-IPolicyV2, bad level', async () => {
      const f = await fresh()
      const s = scope(ANY)
      const cases = [
        { ...allow(s), policy: f.cpA },
        { ...deny(s), data: '0x01' },
        { ...policy(s, ZeroAddress) },
        { ...policy(s, ethers.Wallet.createRandom().address) },
        { ...policy(s, await (await ethers.deployContract('EngineBadPolicy', [0])).getAddress()) },
        { ...policy(s, await (await ethers.deployContract('EngineBadPolicy', [1])).getAddress()) },
        { ...policy(s, f.t) }, // a contract whose fallback answers nothing
      ]
      for (const c of cases) {
        await expectRevert(
          f.engine.connect(f.asSafe).configureImmediately([c], []),
          f.engine,
          'InvalidPolicy',
          [c.policy],
        )
      }
    })

    it('PolicyConfigurationFailed: configure reverted or returned no word', async () => {
      const f = await fresh()
      const s = scope(ANY)
      const bad = { ...policy(s, f.cpA), data: '0x01' } // MockPolicyV2 cannot decode it
      await expectRevert(
        f.engine.connect(f.asSafe).configureImmediately([bad], []),
        f.engine,
        'PolicyConfigurationFailed',
        [f.cpA, '0x'],
      )
      const noWord = await (await ethers.deployContract('EngineBadPolicy', [2])).getAddress()
      await expectRevert(
        f.engine.connect(f.asSafe).configureImmediately([policy(s, noWord)], []),
        f.engine,
        'PolicyConfigurationFailed',
        [noWord, '0x'],
      )
    })

    it('DelayBelowTimelock: a floor above DELAY at ANY/OWNERS scopes only (D1)', async () => {
      const f = await fresh()
      const over = TIMING.delay + 1n
      for (const actor of [ANY, OWNERS]) {
        await expectRevert(
          f.engine.connect(f.asSafe).configureImmediately([policy(scope(actor), f.cpA, 0, 0, over)], []),
          f.engine,
          'DelayBelowTimelock',
          [TIMING.delay, over],
        )
      }
      await f.engine
        .connect(f.asSafe)
        .configureImmediately([policy(scope(OWNERS), f.cpA, 0, 0, TIMING.delay)], [])
      // Another actor's timelock is not bounded by DELAY.
      await f.engine.connect(f.asSafe).configureImmediately([policy(scope(f.t), f.cpA, 0, 0, over * 10n)], [])
    })

    it('TooManyAttachments: 4 per scope', async () => {
      const f = await fresh()
      const s = scope(ANY)
      const policies = await Promise.all(
        Array.from({ length: 3 }, async () =>
          (await ethers.deployContract('MockPolicyV2', [Level.CALL])).getAddress(),
        ),
      )
      const changes = [allow(s), deny(s), ...policies.slice(0, 2).map((p) => policy(s, p))]
      await f.engine.connect(f.asSafe).configureImmediately(changes, [])
      await expectRevert(
        f.engine.connect(f.asSafe).configureImmediately([policy(s, policies[2])], []),
        f.engine,
        'TooManyAttachments',
        [scopeKey(s)],
      )
      // An update of an existing attachment does not count.
      await f.engine.connect(f.asSafe).configureImmediately([policy(s, policies[0], Behaviour.REVERT, 3)], [])
      const [, view] = await f.engine.getAttachment(f.address, attachmentId(s, Kind.POLICY, policies[0]))
      expect(view.opMask).to.equal(3n)
      expect((await f.engine.getScopeAttachments(f.address, scopeKey(s))).length).to.equal(4)
    })

    it('detach: NotAttached, swap-and-pop, scope list, no policy call', async () => {
      const f = await fresh()
      const s = scope(ANY)
      const s2 = scope(OWNERS, CallMatch.TO, f.t)
      await expectRevert(
        f.engine.connect(f.asSafe).configureImmediately([detach(s, Kind.ALLOW)], []),
        f.engine,
        'NotAttached',
        [attachmentId(s, Kind.ALLOW)],
      )
      await f.engine
        .connect(f.asSafe)
        .configureImmediately([allow(s), deny(s), policy(s, f.cpA), allow(s2)], [])
      let [keys] = await f.engine.getScopes(f.address)
      expect([...keys]).to.deep.equal([scopeKey(s), scopeKey(s2)])
      const tx = await f.engine.connect(f.asSafe).configureImmediately([detach(s, Kind.ALLOW)], [])
      await expectEvent(tx, f.engine, 'Detached', [f.address, attachmentId(s, Kind.ALLOW), scopeKey(s)])
      const left = await f.engine.getScopeAttachments(f.address, scopeKey(s))
      expect(left.map((v) => v.attachmentId)).to.deep.equal([
        attachmentId(s, Kind.POLICY, f.cpA), // moved into slot 0
        attachmentId(s, Kind.DENY),
      ])
      // The moved attachment's position was updated: detaching it works.
      await f.engine
        .connect(f.asSafe)
        .configureImmediately([detach(s, Kind.POLICY, f.cpA), detach(s, Kind.DENY)], [])
      ;[keys] = await f.engine.getScopes(f.address)
      expect([...keys]).to.deep.equal([scopeKey(s2)])
      const [exists] = await f.engine.getAttachment(f.address, attachmentId(s, Kind.DENY))
      expect(exists).to.equal(false)
      expect(Number(await f.engine.levelsUsed(f.address))).to.equal(1 << 5)
      // The policy was configured once (attach) and never called on detach.
      expect(
        await f.cp.configured(await f.engine.getAddress(), f.address, attachmentId(s, Kind.POLICY, f.cpA)),
      ).to.equal(1n)
    })

    it('roles: idempotent, RoleSet only on change, at most 8, no zero account', async () => {
      const f = await fresh()
      const acc = (i: number) => ethers.zeroPadValue(ethers.toBeHex(i + 100), 20)
      const add = (i: number, role = 0) => ({ role, account: acc(i), enabled: true })
      const tx = await f.engine.connect(f.asSafe).configureImmediately([], [add(0), add(0)])
      expect((await eventsOf(tx, f.engine, 'RoleSet')).length).to.equal(1)
      await f.engine.connect(f.asSafe).configureImmediately(
        [],
        [1, 2, 3, 4, 5, 6, 7].map((i) => add(i)),
      )
      await expectRevert(
        f.engine.connect(f.asSafe).configureImmediately([], [add(8)]),
        f.engine,
        'TooManyRoleMembers',
        [0],
      )
      await f.engine.connect(f.asSafe).configureImmediately([], [add(8, 1)]) // lifters are separate
      await f.engine
        .connect(f.asSafe)
        .configureImmediately([], [{ role: 0, account: acc(3), enabled: false }])
      const members = await f.engine.getRoleMembers(f.address, 0)
      expect(members.length).to.equal(7)
      expect(members.map((m) => m.toLowerCase())).to.not.include(acc(3))
      expect(await f.engine.isGuardian(f.address, acc(3))).to.equal(false)
      expect(await f.engine.isGuardian(f.address, acc(7))).to.equal(true)
      expect(await f.engine.isLifter(f.address, acc(8))).to.equal(true)
      const tx2 = await f.engine
        .connect(f.asSafe)
        .configureImmediately([], [{ role: 0, account: acc(3), enabled: false }])
      expect((await eventsOf(tx2, f.engine, 'RoleSet')).length).to.equal(0)
      await expectRevert(
        f.engine
          .connect(f.asSafe)
          .configureImmediately([], [{ role: 0, account: ZeroAddress, enabled: true }]),
        f.engine,
        'InvalidActor',
        [ZeroAddress],
      )
    })
  })

  describe('delayed path (request / apply / invalidate)', () => {
    it('request → pending → apply → applied, through the guard on the owner path', async () => {
      const f = await setup()
      const changes = [allow(scope(OWNERS))]
      const root = await f.engine.configurationRoot(changes, [])
      // No ALLOW at all: the configuration path still works (a Safe never locks itself out).
      const req = await execOwner(
        f.safe,
        f.engineAddr,
        f.engine.interface.encodeFunctionData('requestConfiguration', [root]),
      )
      const now = BigInt(await time.latest())
      await expectEvent(req, f.engine, 'ConfigRequested', [f.safeAddr, root, now + TIMING.delay])
      expect(await f.engine.rootConfigured(f.safeAddr, root)).to.equal(now + TIMING.delay)
      await expectRevert(
        f.engine.connect(f.asSafe).applyConfiguration(changes, []),
        f.engine,
        'RootPending',
        [root, now + TIMING.delay],
      )
      await expectRevert(
        f.engine.connect(f.asSafe).requestConfiguration(root),
        f.engine,
        'RootAlreadyRequested',
        [root],
      )
      await time.increase(TIMING.delay)
      const apply = await execOwner(
        f.safe,
        f.engineAddr,
        f.engine.interface.encodeFunctionData('applyConfiguration', [changes, []]),
      )
      await expectEvent(apply, f.engine, 'ConfigApplied', [f.safeAddr, root])
      expect(await f.engine.rootConfigured(f.safeAddr, root)).to.equal(0n)
      await execOwner(f.safe, f.targetAddr, SEL.ping)
      await expectRevert(
        f.engine.connect(f.asSafe).applyConfiguration(changes, []),
        f.engine,
        'RootNotRequested',
        [root],
      )
    })

    it('expiry: a matured root dies after EXPIRY and can then be requested again', async () => {
      const f = await fresh()
      const changes = [allow(scope(ANY))]
      const root = await f.engine.configurationRoot(changes, [])
      await f.engine.connect(f.asSafe).requestConfiguration(root)
      await time.increase(TIMING.delay + TIMING.expiry)
      await expectRevert(
        f.engine.connect(f.asSafe).applyConfiguration(changes, []),
        f.engine,
        'RootExpired',
        [root],
      )
      await f.engine.connect(f.asSafe).requestConfiguration(root)
      await time.increase(TIMING.delay)
      await f.engine.connect(f.asSafe).applyConfiguration(changes, [])
    })

    it('invalidate: any state; RootNotRequested when absent', async () => {
      const f = await fresh()
      const root = ethers.id('r')
      await expectRevert(f.engine.connect(f.asSafe).invalidateRoot(root), f.engine, 'RootNotRequested', [
        root,
      ])
      await f.engine.connect(f.asSafe).requestConfiguration(root)
      const tx = await f.engine.connect(f.asSafe).invalidateRoot(root)
      await expectEvent(tx, f.engine, 'ConfigInvalidated', [f.address, root])
      expect(await f.engine.rootConfigured(f.address, root)).to.equal(0n)
    })

    it('a failing change reverts the whole apply and keeps the request', async () => {
      const f = await fresh()
      const changes = [allow(scope(ANY)), allow(scope(ANY), 9)]
      const root = await f.engine.configurationRoot(changes, [])
      await f.engine.connect(f.asSafe).requestConfiguration(root)
      await time.increase(TIMING.delay)
      await expectRevert(
        f.engine.connect(f.asSafe).applyConfiguration(changes, []),
        f.engine,
        'InvalidOpMask',
        [9],
      )
      expect(await f.engine.rootConfigured(f.address, root)).to.not.equal(0n)
      expect(Number(await f.engine.levelsUsed(f.address))).to.equal(0)
    })

    it('module path: every configuration selector is ModuleConfigurationDenied', async () => {
      const [, module] = await ethers.getSigners()
      const f = await setup([allow(scope(module.address))])
      for (const data of [
        f.engine.interface.encodeFunctionData('requestConfiguration', [ethers.ZeroHash]),
        f.engine.interface.encodeFunctionData('invalidateRoot', [ethers.ZeroHash]),
        f.engine.interface.encodeFunctionData('applyConfiguration', [[], []]),
      ]) {
        await expectRevert(
          execModule(f.safe, f.module, f.engineAddr, data),
          f.engine,
          'ModuleConfigurationDenied',
        )
      }
    })

    it('owner path: a configuration call that is not a top-level zero-value CALL is GuardTargetDenied', async () => {
      const f = await setup([allow(scope(OWNERS))])
      const data = f.engine.interface.encodeFunctionData('requestConfiguration', [ethers.ZeroHash])
      await expectRevert(execOwner(f.safe, f.engineAddr, data, Op.CALL, 1n), f.engine, 'GuardTargetDenied')
      await expectRevert(
        execOwner(f.safe, f.engineAddr, data, Op.DELEGATECALL),
        f.engine,
        'GuardTargetDenied',
      )
    })
  })
})
