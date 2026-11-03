import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import { eventsOf } from '../helpers'
import {
  C,
  DAY,
  F,
  HOUR,
  Kind,
  Mask,
  OWNERS,
  SEL,
  T,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  attachmentId,
  call,
  configureCall,
  cosignerSettings,
  deployWorld,
  detach,
  execModule,
  execOwners,
  expectConfigurationFailed,
  expectPolicyDenied,
  expectPolicyError,
  install,
  moduleCallHash,
  onContract,
  onFunction,
  recipientsPreset,
  scheduleOwners,
  timelockSettings,
  transfer,
} from './world'

/**
 * Story: the four findings of the external review of rev 3 (PR #14), reproduced end to end on
 * the real engine and a real Safe as the reviewer did, now failing closed (rev 4). Unit tests of
 * each fix: `policies/Args.test.ts` (VALUE_TO), `policies/CoSigner.test.ts` (revisions),
 * `policies/Timelock.test.ts` (covering rule), `stories/Freeze.test.ts` (per-actor window).
 */
describe('Story: the rev 3 review findings fail closed (rev 4)', () => {
  it('A1: an owner-wide Allow + non-strict Recipients: ETH to a stranger is denied whatever the calldata', async () => {
    const w = await loadFixture(deployWorld)
    await install(w, [
      allow(anyCall(OWNERS)),
      attach(anyCall(OWNERS), w.args, argsSettings(recipientsPreset([w.vendorA.address]), false)),
    ])
    const eth = ethers.parseEther('1')
    for (const data of ['0x', '0xdeadbeef'])
      await expectPolicyDenied(
        execOwners(w, call(w.attacker.address, data, eth)),
        w,
        w.args,
        'ConstraintFailed',
      )
    await execOwners(w, call(w.vendorA.address, '0xdeadbeef', eth))
    // No value: not judged (non-strict), and tokens are judged by transfer / transferFrom.
    await execOwners(w, call(w.attacker.address, '0xdeadbeef', 0n))
    await execOwners(w, transfer(w, w.vendorA.address, 1n))
    await expectPolicyDenied(
      execOwners(w, transfer(w, w.attacker.address, 1n)),
      w,
      w.args,
      'ConstraintFailed',
    )
  })

  it('A2: a revoke before the relayer pushes the signature voids it (InvalidSignature)', async () => {
    const w = await loadFixture(deployWorld)
    await install(
      w,
      [
        allow(onFunction(w.agent.address, w.tokenAddress, SEL.transfer)),
        attach(anyCall(w.agent.address), w.cosigner, cosignerSettings([w.cosignerKey.address], 1)),
      ],
      { modules: [w.agent.address] },
    )
    const tx = transfer(w, w.vendorA.address, 1n)
    const txHash = moduleCallHash(w, w.agent.address, tx)
    const validUntil = BigInt(await time.latest()) + DAY
    const { chainId } = await ethers.provider.getNetwork()
    const approver = w.cosignerKey.address
    const sign = async () =>
      w.cosignerKey.signTypedData(
        { name: 'CoSignerPolicy', version: '1', chainId, verifyingContract: addrOf(w.cosigner) },
        {
          Approval: [
            { name: 'engine', type: 'address' },
            { name: 'safe', type: 'address' },
            { name: 'txHash', type: 'bytes32' },
            { name: 'approver', type: 'address' },
            { name: 'useCount', type: 'uint256' },
            { name: 'revision', type: 'uint256' },
            { name: 'validUntil', type: 'uint64' },
          ],
        },
        {
          engine: w.engineAddress,
          safe: w.safeAddress,
          txHash,
          approver,
          useCount: await w.cosigner.useCount(w.engineAddress, w.safeAddress, txHash),
          revision: await w.cosigner.revision(w.engineAddress, w.safeAddress, txHash, approver),
          validUntil,
        },
      )
    const push = (signature: string) =>
      w.cosigner
        .connect(w.stranger)
        .approveWithSig(w.engineAddress, w.safeAddress, txHash, approver, validUntil, signature)
    const stale = await sign()
    await w.cosigner.connect(w.cosignerKey).revoke(w.engineAddress, w.safeAddress, txHash)
    await expectPolicyError(push(stale), w.cosigner, 'InvalidSignature', [approver])
    await expectPolicyDenied(execModule(w, w.agent, tx), w, w.cosigner, 'MissingApprovals')
    // A fresh signature (revision 1) works.
    await push(await sign())
    await execModule(w, w.agent, tx)
  })

  it('A3a: one configure that attaches a cover, a narrow delay, then detaches the cover is refused', async () => {
    const w = await loadFixture(deployWorld)
    await install(w, [allow(anyCall(OWNERS))])
    await expectConfigurationFailed(
      execOwners(
        w,
        configureCall(w, [
          attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T })),
          attach(onContract(OWNERS, w.tokenAddress), w.timelock, timelockSettings({ delay: T })),
          detach(anyCall(OWNERS), Kind.POLICY, w.timelock),
        ]),
      ),
      w,
      w.timelock,
      'TimelockNotCoveringConfiguration',
      [ZeroAddress, '0x00000000', Mask.DELEGATECALL, T],
    )
  })

  it('A3b: lowering the owner-wide delay under a longer narrow one is refused', async () => {
    const w = await loadFixture(deployWorld)
    const narrow = onFunction(OWNERS, w.tokenAddress, SEL.transfer)
    await install(w, [
      allow(anyCall(OWNERS)),
      attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: 3n * T })),
      attach(narrow, w.timelock, timelockSettings({ delay: 3n * T })),
    ])
    const lower = configureCall(w, [attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: HOUR }))])
    await scheduleOwners(w, lower)
    await time.increase(3n * T)
    await expectConfigurationFailed(execOwners(w, lower), w, w.timelock, 'TimelockNotCoveringConfiguration', [
      ZeroAddress,
      '0x00000000',
      Mask.DELEGATECALL,
      3n * T,
    ])
  })

  it('A4: two guardians alternating over two owner attachments: the owners configure runs at F', async () => {
    const w = await loadFixture(deployWorld)
    const guardians = [w.guardian.address, w.guardian2.address]
    const cfg = onFunction(OWNERS, w.engineAddress, SEL.configure)
    const settings = timelockSettings({ delay: T, guardians })
    await install(w, [
      allow(anyCall(OWNERS)),
      attach(anyCall(OWNERS), w.timelock, settings),
      attach(cfg, w.timelock, settings),
    ])
    const X = attachmentId(anyCall(OWNERS), Kind.POLICY, addrOf(w.timelock))
    const Y = attachmentId(cfg, Kind.POLICY, addrOf(w.timelock))
    const fix = configureCall(w, [
      attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T })),
      attach(cfg, w.timelock, timelockSettings({ delay: T })),
    ])
    await scheduleOwners(w, fix)
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [X])
    const t0 = BigInt(await time.latest())
    await time.increaseTo(t0 + F - HOUR)
    const [joined] = await eventsOf(
      await w.timelock.connect(w.guardian2).freeze(w.engineAddress, w.safeAddress, [Y]),
      w.timelock,
      'Frozen',
    )
    expect(joined.args.until).to.equal(t0 + F)
    await time.increaseTo(t0 + F)
    const skipped = await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [X, Y])
    expect(await eventsOf(skipped, w.timelock, 'Frozen')).to.have.length(0)
    await execOwners(w, fix)
    expect(BigInt(await time.latest()) < t0 + F + C).to.equal(true)
  })
})
