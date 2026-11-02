import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { TypedDataEncoder, ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import { EIP1271_MAGIC_VALUE, Operation, deploySafe, execAsOwners, isValidSignature } from '../fixtures/safe'
import {
  AGENT_BUDGET,
  DELAY,
  ANY,
  OPS_BUDGET,
  OWNERS,
  R,
  SEL,
  T,
  TX_INDEX,
  allow,
  applyConfig,
  attach,
  call,
  cosign,
  cowOrder,
  deployOrg,
  deployWorld,
  execModule,
  execOwners,
  execOwnersAfter,
  expectError,
  expectPolicyDenied,
  freezeSettings,
  guardianRole,
  install,
  moduleCallHash,
  orgChanges,
  orgRoles,
  requestConfig,
  safeCall,
  scheduleModule,
  scheduleOwners,
  scope,
  signCowOrderCall,
  swapOwnerCall,
  tokenApprove,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/** Module-path proof deadline (CoSigner, Safenet) far past any time the story advances to. */
const PROOF_DEADLINE = 2n ** 40n

/**
 * Story: the design doc's example organisation (§3 table) on a real Safe 1.5.0 with the real
 * engine. Owners act after 24h, Ops pays two vendors within a monthly budget, an AI agent signs
 * CoW orders within a daily budget with a co-signer, Recovery replaces owners after 72h, and a
 * guardian freezes everyone but Recovery. Each actor: what it can do, and what it cannot.
 */
describe('E2E story: the example organisation (design doc §3)', () => {
  /** Co-signs `tx` for the agent (anyone relays the co-signer's signature), then executes it. */
  async function agentExec(w: World, tx: Awaited<ReturnType<typeof signCowOrderCall>>) {
    const callHash = await moduleCallHash(w, w.agent.address, tx)
    const digest = await w.cosignerPolicy.moduleTxDigest(
      w.engineAddress,
      w.safeAddress,
      callHash,
      PROOF_DEADLINE,
    )
    await w.cosignerPolicy
      .connect(w.outsider)
      .cosign(w.engineAddress, w.safeAddress, callHash, w.cosigner.address, PROOF_DEADLINE, cosign(w, digest))
    return execModule(w, w.agent, tx)
  }

  it('installs: the engine is guard and module guard, the policy handler serves ERC-1271', async () => {
    const w = await loadFixture(deployOrg)
    const slot = (s: string) => w.safe.getStorageAt(s, 1).then((v) => ethers.getAddress('0x' + v.slice(26)))
    expect(await slot('0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8')).to.equal(
      w.engineAddress,
    )
    expect(await slot('0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947')).to.equal(
      w.engineAddress,
    )
    expect(await slot('0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5')).to.equal(
      await w.handler.getAddress(),
    )
    expect(await w.engine.getAttachments(w.safeAddress)).to.have.length(orgChanges(w).length)
    expect(await w.engine.isGuardian(w.safeAddress, w.guardian.address)).to.equal(true)
    expect(await w.engine.isLifter(w.safeAddress, w.recovery.address)).to.equal(true)
  })

  describe('Owners: Allow + Timelock 24h + Freeze at (Owners, *)', () => {
    it('happy: schedule a payment with the executing signatures, execute it 24h later', async () => {
      const w = await loadFixture(deployOrg)
      const pay = tokenTransfer(w, w.vendorA.address, usdc(10_000))
      const hash = await scheduleOwners(w, pay)
      const s = await w.timelock.getSchedule(w.engineAddress, w.safeAddress, hash)
      expect(s.actor).to.equal(OWNERS)
      await time.increaseTo(s.scheduledAt + T)
      await execOwners(w, pay)
      expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(10_000))
    })

    it('deny: not scheduled (NotScheduled), or before the 24h (NotReady)', async () => {
      const w = await loadFixture(deployOrg)
      const pay = tokenTransfer(w, w.vendorA.address, usdc(1))
      await expectPolicyDenied(execOwners(w, pay), w.engine, w.timelock, 'NotScheduled', undefined, TX_INDEX)
      const hash = await scheduleOwners(w, pay)
      const readyAt = (await w.timelock.getSchedule(w.engineAddress, w.safeAddress, hash)).scheduledAt + T
      await time.increaseTo(readyAt - 10n)
      await expectPolicyDenied(execOwners(w, pay), w.engine, w.timelock, 'NotReady', [hash, readyAt])
    })
  })

  describe('Ops: Limit 5,000 USDC / month at (Ops, *); Allow + Recipients at (Ops, USDC.transfer)', () => {
    it('happy: pays the listed vendors at once, within the monthly budget', async () => {
      const w = await loadFixture(deployOrg)
      await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, usdc(3_000)))
      await execModule(w, w.ops, tokenTransfer(w, w.vendorB.address, usdc(2_000)))
      expect(await w.token.balanceOf(w.vendorB.address)).to.equal(usdc(2_000))
      const id = await w.engine.attachmentId(
        await w.engine.scopeKey(scope(w.ops.address)),
        2,
        await w.limit.getAddress(),
      )
      const left = await w.limit.remaining(w.engineAddress, w.safeAddress, id, w.tokenAddress)
      expect(left.available).to.equal(0n)
      expect(left.amount).to.equal(OPS_BUDGET)
    })

    it('deny: an unlisted recipient, over budget, any other function, and native value', async () => {
      const w = await loadFixture(deployOrg)
      await expectPolicyDenied(
        execModule(w, w.ops, tokenTransfer(w, w.attacker.address, usdc(1))),
        w.engine,
        w.recipients,
        'RecipientNotAllowed',
        [w.attacker.address],
        0n,
      )
      await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, usdc(4_000)))
      await expectPolicyDenied(
        execModule(w, w.ops, tokenTransfer(w, w.vendorB.address, usdc(1_001))),
        w.engine,
        w.limit,
        'LimitExceeded',
      )
      await expectError(
        execModule(w, w.ops, tokenApprove(w, w.vendorA.address, 1n)),
        w.engine,
        'NotGranted',
        [0n, w.tokenAddress, SEL.approve, Operation.CALL],
      )
      await expectError(execModule(w, w.ops, call(w.vendorA.address, '0x', 1n)), w.engine, 'NotGranted')
    })

    it('the budget refills on the next monthly window', async () => {
      const w = await loadFixture(deployOrg)
      await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, OPS_BUDGET))
      await time.increase(30n * 24n * 3600n)
      await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, OPS_BUDGET))
      expect(await w.token.balanceOf(w.vendorA.address)).to.equal(2n * OPS_BUDGET)
    })
  })

  describe('Agent: Limit 1,000 / day + Co-signer at (Agent, *); Allow CoW orders', () => {
    it('happy: signs a co-signed CoW order on-chain, priced by its budget; the settlement can verify it', async () => {
      const w = await loadFixture(deployOrg)
      const order = await cowOrder(w, usdc(600), usdc(5))
      await agentExec(w, signCowOrderCall(w, order))

      const { chainId } = await ethers.provider.getNetwork()
      const digest = TypedDataEncoder.hash(
        { name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: await w.cow.getAddress() },
        {
          Order: [
            { name: 'sellToken', type: 'address' },
            { name: 'buyToken', type: 'address' },
            { name: 'receiver', type: 'address' },
            { name: 'sellAmount', type: 'uint256' },
            { name: 'buyAmount', type: 'uint256' },
            { name: 'validTo', type: 'uint32' },
            { name: 'appData', type: 'bytes32' },
            { name: 'feeAmount', type: 'uint256' },
            { name: 'kind', type: 'string' },
            { name: 'partiallyFillable', type: 'bool' },
            { name: 'sellTokenBalance', type: 'string' },
            { name: 'buyTokenBalance', type: 'string' },
          ],
        },
        { ...order, kind: 'sell', sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' },
      )
      expect(await isValidSignature(w.safe, digest, '0x')).to.equal(EIP1271_MAGIC_VALUE)

      const id = await w.engine.attachmentId(
        await w.engine.scopeKey(scope(w.agent.address)),
        2,
        await w.limit.getAddress(),
      )
      const left = await w.limit.remaining(w.engineAddress, w.safeAddress, id, w.tokenAddress)
      expect(left.available).to.equal(AGENT_BUDGET - usdc(605))
    })

    it('deny: without the co-signature, over the daily budget, and anything but a CoW order', async () => {
      const w = await loadFixture(deployOrg)
      await expectPolicyDenied(
        execModule(w, w.agent, signCowOrderCall(w, await cowOrder(w, usdc(10)))),
        w.engine,
        w.cosignerPolicy,
        'MissingCoSignature',
        [w.cosigner.address],
        TX_INDEX,
      )
      await agentExec(w, signCowOrderCall(w, await cowOrder(w, usdc(900))))
      await expectPolicyDenied(
        agentExec(w, signCowOrderCall(w, await cowOrder(w, usdc(101)))),
        w.engine,
        w.limit,
        'LimitExceeded',
      )
      // Paying directly is not granted, co-signed or not.
      await expectError(agentExec(w, tokenTransfer(w, w.agent.address, usdc(1))), w.engine, 'NotGranted')
      // The next day the budget is back.
      await time.increase(24n * 3600n)
      await agentExec(w, signCowOrderCall(w, await cowOrder(w, usdc(1_000))))
    })
  })

  describe('Recovery: Timelock 72h at (Recovery, *); Allow at (Recovery, Safe.swapOwner)', () => {
    it('happy: replaces an owner 72h after scheduling it', async () => {
      const w = await loadFixture(deployOrg)
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      const hash = await scheduleModule(w, w.recovery, swap)
      await expectPolicyDenied(execModule(w, w.recovery, swap), w.engine, w.timelock, 'NotReady')
      await time.increaseTo(
        (await w.timelock.getSchedule(w.engineAddress, w.safeAddress, hash)).scheduledAt + R,
      )
      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
      expect(await w.safe.isOwner(w.o1.address)).to.equal(false)
    })

    it('deny: nothing but swapOwner, not even another Safe-management call (exact scope, F5)', async () => {
      const w = await loadFixture(deployOrg)
      const setGuard = safeCall(w, 'setGuard', [ZeroAddress])
      await scheduleModule(w, w.recovery, setGuard)
      await time.increase(R)
      await expectError(execModule(w, w.recovery, setGuard), w.engine, 'NotGranted')
      await expectError(
        execModule(w, w.recovery, tokenTransfer(w, w.recovery.address, 1n)),
        w.engine,
        'NotGranted',
      )
    })
  })

  describe('Guardian: freezes instantly; everyone but Recovery stops', () => {
    it('freezes Owners, Ops and Agent; Recovery still replaces an owner, then lifts the freeze', async () => {
      const w = await loadFixture(deployOrg)
      const pay = tokenTransfer(w, w.vendorA.address, usdc(1))
      await scheduleOwners(w, pay)
      const swap = await swapOwnerCall(w, w.o2.address, w.newOwner2.address)
      await scheduleModule(w, w.recovery, swap)
      await time.increase(R)

      await w.engine.connect(w.guardian).freeze([w.safeAddress])
      const until = (await w.engine.getFreezeState(w.safeAddress, ANY)).frozenUntil
      await expectPolicyDenied(execOwners(w, pay), w.engine, w.freeze, 'Frozen', [w.safeAddress, ANY, until])
      await expectPolicyDenied(execModule(w, w.ops, pay), w.engine, w.freeze, 'Frozen')
      await expectPolicyDenied(
        agentExec(w, signCowOrderCall(w, await cowOrder(w, usdc(1)))),
        w.engine,
        w.freeze,
        'Frozen',
      )

      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner2.address)).to.equal(true)
      await w.engine.connect(w.recovery).lift(w.safeAddress, ANY)
      await execModule(w, w.ops, pay)
    })

    it('a guardian that is itself a V2-guarded Safe freezes through its own transaction (engine target rule)', async () => {
      const w = await loadFixture(deployOrg)
      const council = await deploySafe([w.sparkOwner], 1, { infra: w.infra })
      const councilAddress = await council.getAddress()
      const freezeSel = w.engine.interface.getFunction('freeze')!.selector
      const asCouncil = (data: string, to = councilAddress) =>
        execAsOwners(council, call(to, data), [w.sparkOwner])
      // The council Safe uses the same engine: owners may call engine.freeze, nothing else.
      await asCouncil(
        w.engine.interface.encodeFunctionData('configureImmediately', [
          [allow(scope(OWNERS, w.engineAddress, freezeSel))],
          [],
        ]),
        w.engineAddress,
      )
      await asCouncil(council.interface.encodeFunctionData('setGuard', [w.engineAddress]))
      // Made a guardian of the org Safe by the org's owners (configuration, DELAY).
      const roles = [guardianRole(councilAddress)]
      await requestConfig(w, [], roles)
      await time.increase(DELAY)
      await applyConfig(w, [], roles)

      await asCouncil(w.engine.interface.encodeFunctionData('freeze', [[w.safeAddress]]), w.engineAddress)
      expect((await w.engine.freezeStatus(w.safeAddress, OWNERS)).safeFrozen).to.equal(true)
      await expectError(
        asCouncil(w.engine.interface.encodeFunctionData('lift', [w.safeAddress, ANY]), w.engineAddress),
        w.engine,
        'NotGranted',
      )
    })

    it('an actor freeze stops only that actor (the agent), the others keep working', async () => {
      const w = await loadFixture(deployOrg)
      await w.engine.connect(w.guardian).freezeActor(w.safeAddress, w.agent.address)
      await expectPolicyDenied(
        agentExec(w, signCowOrderCall(w, await cowOrder(w, usdc(1)))),
        w.engine,
        w.freeze,
        'Frozen',
      )
      await execModule(w, w.ops, tokenTransfer(w, w.vendorA.address, usdc(1)))
      await execOwnersAfter(w, tokenTransfer(w, w.vendorA.address, usdc(1)))
      expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(2))
    })

    it('why the Freeze is placed per actor: a Freeze at (*, *) would also stop the fire exit', async () => {
      const w = await deployWorld()
      await install(
        w,
        [...orgChanges(w), attach(scope(ANY), w.freeze.target as string, freezeSettings(true, false))],
        orgRoles(w),
        {
          modules: [w.ops.address, w.agent.address, w.recovery.address],
        },
      )
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      await scheduleModule(w, w.recovery, swap)
      await time.increase(R)
      await w.engine.connect(w.guardian).freeze([w.safeAddress])
      await expectPolicyDenied(execModule(w, w.recovery, swap), w.engine, w.freeze, 'Frozen')
    })
  })
})
