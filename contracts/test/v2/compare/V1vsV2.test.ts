import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { AbiCoder, type Interface, TypedDataEncoder, ZeroAddress, dataSlice, getAddress, id } from 'ethers'
import { ethers } from 'hardhat'
import {
  type MetaTx,
  execAsModule,
  execAsOwners,
  guardsOf,
  multiSendTx,
  signHashOffchain,
} from '../fixtures/safe'
import { revertData } from '../helpers'
import {
  DAY,
  Kind,
  MONTH,
  OWNERS,
  R,
  SEL,
  T,
  ANY,
  addrOf,
  allow,
  anyCall,
  approve,
  argsSettings,
  attach,
  attachmentId,
  call,
  coApprove,
  configureCall,
  cosignerSettings,
  deployWorld,
  detach,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  install,
  limitSettings,
  moduleCallHash,
  onFunction,
  recipientsPreset,
  safeCall,
  scheduleModule,
  scheduleOwners,
  swapOwnerCall,
  timelockSettings,
  transfer,
  usdc,
  type World,
} from '../stories/world'
import {
  type V1Safe,
  V1_DELAY,
  deployV1,
  deployV1Policies,
  recipientList,
  v1Fallback,
  v1Root,
  v1Rule,
} from './v1'

/**
 * V1 vs V2 rev 3, side by side, on real Safes 1.5.0: every row of the design doc's §1 table ("what
 * V1 cannot express") that rev 3 still covers, plus the batch row of §4. Each `it` runs the same
 * scenario on the vendored V1 `SafePolicyGuard` (71b9cb0) and on the rev 3 engine, and asserts
 * both outcomes. The results are tabulated in contracts/contracts/v2/COMPARISON.md. Rev 3 has no
 * ERC-1271 handler and its install sets Safe's `TokenCallbackHandler`; the last test keeps the gap
 * visible for a Safe that keeps an ERC-1271 handler.
 */

const coder = AbiCoder.defaultAbiCoder()
/** Safe's `FallbackManager` slot: `keccak256("fallback_manager.handler.address")`. */
const FALLBACK_HANDLER_SLOT = id('fallback_manager.handler.address')

async function deploy() {
  const w = await deployWorld()
  const v1p = await deployV1Policies()
  return { ...w, v1p }
}
type W = Awaited<ReturnType<typeof deploy>>

const v1Owners = (w: World, v1: V1Safe, tx: MetaTx) => execAsOwners(v1.safe, tx, w.quorum)
const v1Module = (w: World, v1: V1Safe, module: typeof w.ops, tx: MetaTx) => execAsModule(v1.safe, module, tx)
/** The same call aimed at the V1 Safe (a call to "the Safe itself" must name that Safe). */
const onV1 = (v1: V1Safe, tx: MetaTx): MetaTx => ({ ...tx, to: v1.safeAddress })

/** Asserts the V1 guard reverted with `name` (and, for `PolicyReverted`, the inner policy error). */
async function expectV1(
  action: Promise<unknown>,
  v1: V1Safe,
  name: string,
  policy?: { interface: Interface },
  inner?: string,
) {
  let data: string | undefined
  try {
    await action
  } catch (e) {
    data = revertData(e)
  }
  expect(data, 'V1 should revert').to.not.equal(undefined)
  const outer = v1.guard.interface.parseError(data!)
  expect(outer?.name).to.equal(name)
  if (policy && inner) expect(policy.interface.parseError(outer!.args.reason)?.name).to.equal(inner)
}

/** V1: the owners' fallback is a 24h timelock, and someone wrote an Allow rule for one Safe function. */
const deployV1Hiding = (w: W, selector: string) =>
  deployV1(w, (self) => [
    v1Fallback(addrOf(w.v1p.timelock), coder.encode(['uint256'], [T])),
    v1Rule(self, selector, addrOf(w.v1p.allow)),
  ])

/** V2: (Owners, *) Allow + Timelock 24h, plus `extra`. */
const installV2Owners = (w: W, extra: ReturnType<typeof allow>[] = []) =>
  install(w, [
    allow(anyCall(OWNERS)),
    attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T })),
    ...extra,
  ])

describe('V1 vs V2 (design doc §1, on real Safes 1.5.0)', () => {
  describe('§1 row 1: a narrow rule hides the fallback timelock (WA-4014)', () => {
    it('setGuard(0) under an exact Allow rule: V1 executes at once, V2 delayed (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1Hiding(w, SEL.setGuard)
      await v1Owners(w, v1, onV1(v1, safeCall(w, 'setGuard', [ZeroAddress])))
      expect((await guardsOf(v1.safe)).guard).to.equal(ZeroAddress)

      await installV2Owners(w, [allow(onFunction(OWNERS, w.safeAddress, SEL.setGuard))])
      await expectPolicyDenied(
        execOwners(w, safeCall(w, 'setGuard', [ZeroAddress])),
        w,
        w.timelock,
        'NotScheduled',
      )
    })

    it('addOwnerWithThreshold under an exact Allow rule: V1 executes at once, V2 delayed (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1Hiding(w, SEL.addOwnerWithThreshold)
      await v1Owners(w, v1, onV1(v1, safeCall(w, 'addOwnerWithThreshold', [w.attacker.address, 1])))
      expect(await v1.safe.isOwner(w.attacker.address)).to.equal(true)

      await installV2Owners(w, [allow(onFunction(OWNERS, w.safeAddress, SEL.addOwnerWithThreshold))])
      await expectPolicyDenied(
        execOwners(w, safeCall(w, 'addOwnerWithThreshold', [w.attacker.address, 1])),
        w,
        w.timelock,
        'NotScheduled',
      )
    })

    it('a payment with no rule of its own: V1 delayed (fallback timelock), V2 delayed (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1Hiding(w, SEL.setGuard)
      await expectV1(
        v1Owners(w, v1, transfer(w, w.attacker.address, 1n)),
        v1,
        'PolicyReverted',
        w.v1p.timelock,
        'NotScheduled',
      )

      await installV2Owners(w)
      await expectPolicyDenied(
        execOwners(w, transfer(w, w.attacker.address, 1n)),
        w,
        w.timelock,
        'NotScheduled',
      )
    })

    it('engine configuration under the owners timelock: V1 waits its own DELAY, V2 waits the same Timelock (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [v1Fallback(addrOf(w.v1p.allow))])
      const stop = [v1Fallback(addrOf(w.v1p.deny))]
      await v1Owners(
        w,
        v1,
        call(v1.guardAddress, v1.guard.interface.encodeFunctionData('requestConfiguration', [v1Root(stop)])),
      )
      await expectV1(
        v1Owners(
          w,
          v1,
          call(v1.guardAddress, v1.guard.interface.encodeFunctionData('applyConfiguration', [stop])),
        ),
        v1,
        'RootConfigurationPending',
      )

      await installV2Owners(w)
      const drop = configureCall(w, [detach(anyCall(OWNERS), Kind.POLICY, w.timelock)])
      await expectPolicyDenied(execOwners(w, drop), w, w.timelock, 'NotScheduled')
    })
  })

  describe('§1 row 2: every caller shares one rule table (WA-4016)', () => {
    it("recovery's swapOwner next to a payment allowlist: V1 denied (AccessDenied), V2 executes after R", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(
        w,
        [v1Rule(w.tokenAddress, SEL.transfer, addrOf(w.v1p.transfer), recipientList([w.vendorA.address]))],
        [w.recovery.address],
      )
      const v1Swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address, v1.safe)
      await expectV1(v1Module(w, v1, w.recovery, v1Swap), v1, 'AccessDenied')

      const transferScope = onFunction(OWNERS, w.tokenAddress, SEL.transfer)
      await install(
        w,
        [
          allow(transferScope),
          attach(transferScope, w.args, argsSettings(recipientsPreset([w.vendorA.address]))),
          attach(anyCall(w.recovery.address), w.timelock, timelockSettings({ delay: R })),
          allow(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner)),
        ],
        { modules: [w.recovery.address] },
      )
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      await scheduleModule(w, w.recovery, swap)
      await time.increase(R)
      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
    })

    it("granting recovery's swapOwner: V1 grants every module (ops swaps owners), V2 only recovery (NotGranted)", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, (self) => [v1Rule(self, SEL.swapOwner, addrOf(w.v1p.allow))], [
        w.recovery.address,
        w.ops.address,
      ])
      await v1Module(
        w,
        v1,
        w.ops,
        onV1(v1, safeCall(w, 'swapOwner', [OWNERS, w.o1.address, w.attacker.address])),
      )
      expect(await v1.safe.isOwner(w.attacker.address)).to.equal(true)

      await install(w, [allow(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner))], {
        modules: [w.recovery.address, w.ops.address],
      })
      await expectEngineError(
        execModule(w, w.ops, safeCall(w, 'swapOwner', [OWNERS, w.o1.address, w.attacker.address])),
        w,
        'NotGranted',
      )
    })
  })

  describe('§1 row 3: a co-signer only protects the multisig path', () => {
    it('a global co-signer and a module transaction: V1 reverts (ModulePathUnsupported), V2 executes with an on-chain approval', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(
        w,
        [v1Fallback(addrOf(w.v1p.cosigner), coder.encode(['address'], [w.cosignerKey.address]))],
        [w.recovery.address],
      )
      const v1Swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address, v1.safe)
      await expectV1(
        v1Module(w, v1, w.recovery, v1Swap),
        v1,
        'PolicyReverted',
        w.v1p.cosigner,
        'ModulePathUnsupported',
      )

      await install(
        w,
        [
          attach(anyCall(ANY), w.cosigner, cosignerSettings([w.cosignerKey.address], 1)),
          allow(onFunction(w.recovery.address, w.safeAddress, SEL.swapOwner)),
        ],
        { modules: [w.recovery.address] },
      )
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      await expectPolicyDenied(execModule(w, w.recovery, swap), w, w.cosigner, 'MissingApprovals')
      await coApprove(w, moduleCallHash(w, w.recovery.address, swap))
      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
    })
  })

  describe('§1 row 4: a freeze cannot cover configuration changes', () => {
    it('a pending malicious configuration under a deny-everything fallback: V1 applies it, V2 blocked by the freeze (AttachmentFrozen)', async () => {
      const w = await loadFixture(deploy)
      // V1: everything is already denied (the strongest "freeze" V1 has), yet configuration passes.
      const v1 = await deployV1(w, [v1Fallback(addrOf(w.v1p.deny))])
      const malicious = [v1Fallback(addrOf(w.v1p.allow))]
      await expectV1(
        v1Owners(w, v1, transfer(w, w.attacker.address, 1n)),
        v1,
        'PolicyReverted',
        w.v1p.deny,
        'Denied',
      )
      await v1Owners(
        w,
        v1,
        call(
          v1.guardAddress,
          v1.guard.interface.encodeFunctionData('requestConfiguration', [v1Root(malicious)]),
        ),
      )
      await time.increase(V1_DELAY)
      await v1Owners(
        w,
        v1,
        call(v1.guardAddress, v1.guard.interface.encodeFunctionData('applyConfiguration', [malicious])),
      )
      await v1Owners(w, v1, transfer(w, w.attacker.address, usdc(100_000)))
      expect(await w.token.balanceOf(v1.safeAddress)).to.equal(0n)

      // V2: the attacker (holding the owners' keys) schedules a configuration that drops the
      // guardian; the guardian freezes the owners' Timelock; the configuration cannot run.
      const owners = anyCall(OWNERS)
      await install(w, [
        allow(owners),
        attach(owners, w.timelock, timelockSettings({ delay: T, guardians: [w.guardian.address] })),
      ])
      const drop = configureCall(w, [attach(owners, w.timelock, timelockSettings({ delay: T }))])
      await scheduleOwners(w, drop)
      await w.timelock
        .connect(w.guardian)
        .freeze(w.engineAddress, w.safeAddress, [attachmentId(owners, Kind.POLICY, addrOf(w.timelock))])
      await time.increase(T)
      await expectPolicyDenied(execOwners(w, drop), w, w.timelock, 'AttachmentFrozen')
    })

    it('stopping the Safe: V1 a new deny rule waits DELAY (RootConfigurationPending), V2 the guardian freezes at once', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [v1Fallback(addrOf(w.v1p.allow))])
      const stop = [v1Fallback(addrOf(w.v1p.deny))]
      await v1Owners(
        w,
        v1,
        call(v1.guardAddress, v1.guard.interface.encodeFunctionData('requestConfiguration', [v1Root(stop)])),
      )
      await expectV1(
        v1Owners(
          w,
          v1,
          call(v1.guardAddress, v1.guard.interface.encodeFunctionData('applyConfiguration', [stop])),
        ),
        v1,
        'RootConfigurationPending',
      )
      await v1Owners(w, v1, transfer(w, w.attacker.address, 1n)) // still open

      const owners = anyCall(OWNERS)
      await install(w, [
        allow(owners),
        attach(owners, w.timelock, timelockSettings({ delay: 0, guardians: [w.guardian.address] })),
      ])
      await w.timelock
        .connect(w.guardian)
        .freeze(w.engineAddress, w.safeAddress, [attachmentId(owners, Kind.POLICY, addrOf(w.timelock))])
      await expectPolicyDenied(
        execOwners(w, transfer(w, w.attacker.address, 1n)),
        w,
        w.timelock,
        'AttachmentFrozen',
      )
    })
  })

  describe('§1 row 5: the guard conflicts with the existing modules', () => {
    it("a spending module paying its own payee next to the owners' allowlist: V1 denied, V2 executes (per actor)", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(
        w,
        [v1Rule(w.tokenAddress, SEL.transfer, addrOf(w.v1p.transfer), recipientList([w.vendorA.address]))],
        [w.ops.address],
      )
      await expectV1(
        v1Module(w, v1, w.ops, transfer(w, w.vendorB.address, usdc(10))),
        v1,
        'PolicyReverted',
        w.v1p.transfer,
        'Unauthorized',
      )

      const ownersTransfer = onFunction(OWNERS, w.tokenAddress, SEL.transfer)
      const opsTransfer = onFunction(w.ops.address, w.tokenAddress, SEL.transfer)
      await install(
        w,
        [
          allow(ownersTransfer),
          attach(ownersTransfer, w.args, argsSettings(recipientsPreset([w.vendorA.address]))),
          allow(opsTransfer),
          attach(opsTransfer, w.args, argsSettings(recipientsPreset([w.vendorB.address]))),
          attach(
            anyCall(w.ops.address),
            w.limit,
            limitSettings([{ token: w.tokenAddress, amount: usdc(100), period: DAY }]),
          ),
        ],
        { modules: [w.ops.address] },
      )
      await execModule(w, w.ops, transfer(w, w.vendorB.address, usdc(10)))
      expect(await w.token.balanceOf(w.vendorB.address)).to.equal(usdc(10))
    })
  })

  describe('§1 row 6: spending limits only cover transfers', () => {
    async function v1WithTransferLimit(w: W) {
      // The usual V1 set-up: a transfer limit, and a fallback Allow so everything else works.
      return deployV1(w, [
        v1Rule(
          w.tokenAddress,
          SEL.transfer,
          addrOf(w.v1p.spendingLimit),
          coder.encode(['uint256', 'uint256'], [usdc(5_000), MONTH]),
        ),
        v1Fallback(addrOf(w.v1p.allow)),
      ])
    }
    async function v2WithLimit(w: W) {
      await install(w, [
        allow(anyCall(OWNERS)),
        attach(
          anyCall(OWNERS),
          w.limit,
          limitSettings(
            [
              { token: w.tokenAddress, amount: usdc(5_000), period: MONTH },
              { token: ZeroAddress, amount: ethers.parseEther('1'), period: MONTH },
            ],
            true,
          ),
        ),
      ])
    }

    it('approve(attacker, 100,000) under a 5,000 limit: V1 executes (unlimited allowance), V2 LimitExceeded (full amount priced)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await v1WithTransferLimit(w)
      await expectV1(
        v1Owners(w, v1, transfer(w, w.attacker.address, usdc(5_001))),
        v1,
        'PolicyReverted',
        w.v1p.spendingLimit,
        'LimitExceeded',
      )
      await v1Owners(w, v1, approve(w, w.attacker.address, usdc(100_000)))
      await w.token.connect(w.attacker).transferFrom(v1.safeAddress, w.attacker.address, usdc(100_000))

      await v2WithLimit(w)
      await expectPolicyDenied(
        execOwners(w, approve(w, w.attacker.address, usdc(100_000))),
        w,
        w.limit,
        'LimitExceeded',
      )
    })

    it('10 ETH sent under a token limit: V1 executes, V2 LimitExceeded (native value counted)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await v1WithTransferLimit(w)
      await v1Owners(w, v1, call(w.attacker.address, '0x', ethers.parseEther('10')))

      await v2WithLimit(w)
      await expectPolicyDenied(
        execOwners(w, call(w.attacker.address, '0x', ethers.parseEther('10'))),
        w,
        w.limit,
        'LimitExceeded',
      )
    })

    it('transfers inside a MultiSend: V1 (71b9cb0) lets an allowed batch through unchecked, V2 checks every sub-call (LimitExceeded)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [
        v1Rule(
          w.tokenAddress,
          SEL.transfer,
          addrOf(w.v1p.spendingLimit),
          coder.encode(['uint256', 'uint256'], [usdc(5_000), MONTH]),
        ),
        v1Rule(w.batch, '0x8d80ff0a', addrOf(w.v1p.allow), '0x', 1),
      ])
      const drain = [
        transfer(w, w.attacker.address, usdc(50_000)),
        transfer(w, w.attacker.address, usdc(50_000)),
      ]
      await v1Owners(w, v1, multiSendTx(w.batch, drain))
      expect(await w.token.balanceOf(v1.safeAddress)).to.equal(0n)

      await v2WithLimit(w)
      await expectPolicyDenied(execOwners(w, multiSendTx(w.batch, drain)), w, w.limit, 'LimitExceeded')
    })
  })

  describe('ERC-1271: off-chain owner signatures (rev 3 decision 12)', () => {
    /** V1 and V2 Safes with the same rules; V2 installed with `fallbackHandler` (undefined: the default). */
    async function permitWorld(fallbackHandler?: null) {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [
        v1Rule(w.tokenAddress, SEL.transfer, addrOf(w.v1p.transfer), recipientList([w.vendorA.address])),
      ])
      // V2 with a tight budget and a recipients list on the owners: none of it sees a permit.
      const ownersTransfer = onFunction(OWNERS, w.tokenAddress, SEL.transfer)
      await install(
        w,
        [
          allow(anyCall(OWNERS)),
          attach(ownersTransfer, w.args, argsSettings(recipientsPreset([w.vendorA.address]))),
          attach(
            anyCall(OWNERS),
            w.limit,
            limitSettings([{ token: w.tokenAddress, amount: usdc(1), period: MONTH }], true),
          ),
        ],
        { fallbackHandler },
      )
      const { chainId } = await ethers.provider.getNetwork()
      const deadline = BigInt(await time.latest()) + 3600n
      /** The owners sign a permit of the whole balance to the attacker off-chain; the attacker uses it. */
      const drainWithPermit = async (safe: typeof w.safe) => {
        const owner = await safe.getAddress()
        const digest = TypedDataEncoder.hash(
          { name: 'USD Coin', version: '2', chainId, verifyingContract: w.tokenAddress },
          {
            Permit: [
              { name: 'owner', type: 'address' },
              { name: 'spender', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          { owner, spender: w.attacker.address, value: usdc(100_000), nonce: 0n, deadline },
        )
        const sig = await signHashOffchain(safe, digest, w.quorum)
        await w.token.connect(w.attacker).permit(owner, w.attacker.address, usdc(100_000), deadline, sig)
        await w.token.connect(w.attacker).transferFrom(owner, w.attacker.address, usdc(100_000))
      }
      return { w, v1, drainWithPermit }
    }

    it('an off-chain owner signature on a permit: V1 honours it, V2 refused (its install sets TokenCallbackHandler, no ERC-1271)', async () => {
      const { w, v1, drainWithPermit } = await permitWorld()
      // V1 keeps the CompatibilityFallbackHandler: it answers isValidSignature from the owners' signatures.
      await drainWithPermit(v1.safe)
      expect(await w.token.balanceOf(v1.safeAddress)).to.equal(0n)
      // V2's install replaced it with Safe's TokenCallbackHandler: nothing answers isValidSignature.
      const handler = await ethers.provider.getStorage(w.safeAddress, FALLBACK_HANDLER_SLOT)
      expect(getAddress(dataSlice(handler, 12))).to.equal(w.tokenCallbackHandler)
      let drained = true
      try {
        await drainWithPermit(w.safe)
      } catch (e) {
        drained = false
        expect(w.token.interface.parseError(revertData(e)!)?.name).to.equal('InvalidSignature')
      }
      expect(drained).to.equal(false)
      expect(await w.token.balanceOf(w.safeAddress)).to.equal(usdc(100_000))
    })

    it('the documented gap: V2 installed keeping the CompatibilityFallbackHandler honours the same permit', async () => {
      const { w, v1, drainWithPermit } = await permitWorld(null)
      await drainWithPermit(v1.safe)
      await drainWithPermit(w.safe)
      expect(await w.token.balanceOf(w.safeAddress)).to.equal(0n)
      // The same transfer as a Safe transaction is denied: only the off-chain path bypasses.
      await w.token.mint(w.safeAddress, usdc(10))
      await expectPolicyDenied(
        execOwners(w, transfer(w, w.attacker.address, usdc(10))),
        w,
        w.limit,
        'LimitExceeded',
      )
    })
  })
})
