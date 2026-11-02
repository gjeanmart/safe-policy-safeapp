import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { AbiCoder, type Interface, TypedDataEncoder, ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import {
  EIP1271_MAGIC_VALUE,
  type MetaTx,
  execAsModule,
  execAsOwners,
  guardsOf,
  isValidSignature,
  multiSendTx,
  signHashOffchain,
} from '../fixtures/safe'
import {
  DAY,
  DELAY,
  MONTH,
  OWNERS,
  SEL,
  T,
  addr,
  allow,
  applyConfig,
  attach,
  call,
  cosign,
  cosignerSettings,
  deployWorld,
  execModule,
  execOwners,
  expectError,
  expectPolicyDenied,
  freezeSettings,
  guardianRole,
  install,
  limitSettings,
  moduleCallHash,
  recipientsSettings,
  requestConfig,
  revertDataOf,
  safeCall,
  scheduleModule,
  scope,
  swapOwnerCall,
  timelockSettings,
  tokenApprove,
  tokenTransfer,
  usdc,
  type World,
} from '../e2e/world'
import { type V1Safe, deployV1, deployV1Policies, recipientList, v1Fallback, v1Rule } from './v1'

/** Module-path co-signature deadline far past any time the test advances to. */
const PROOF_DEADLINE = 2n ** 40n

/**
 * V1 vs V2, side by side, on real Safes 1.5.0: every row of the design doc's §1 table ("what V1
 * cannot express") that is testable on-chain, plus the ERC-1271 gap (§7) and the batch and
 * configuration-delay rows of §4. Each `it` runs the same scenario on the vendored V1
 * `SafePolicyGuard` (71b9cb0) and on `SafePolicyGuardV2`, and asserts both outcomes. The results
 * are tabulated in contracts/contracts/v2/COMPARISON.md.
 */

const coder = AbiCoder.defaultAbiCoder()

async function deploy() {
  const w = await deployWorld()
  const v1p = await deployV1Policies()
  return { ...w, v1p }
}
type W = Awaited<ReturnType<typeof deploy>>

/** V1 executes `tx` as the owners on its own Safe. */
const v1Owners = (w: World, v1: V1Safe, tx: MetaTx) => execAsOwners(v1.safe, tx, w.quorum2)
const v1Module = (w: World, v1: V1Safe, module: typeof w.ops, tx: MetaTx) => execAsModule(v1.safe, module, tx)
/** The same call aimed at the V1 Safe (a call to "the Safe itself" must name that Safe). */
const onV1 = (v1: V1Safe, tx: MetaTx): MetaTx => ({ ...tx, to: v1.safeAddress })

/** Asserts the V1 guard denied with PolicyReverted(policy, reason) whose reason is `name`. */
async function expectV1PolicyReverted(
  action: Promise<unknown>,
  v1: V1Safe,
  policy: { interface: Interface },
  name: string,
) {
  let data: string | undefined
  try {
    await action
  } catch (e) {
    data = revertDataOf(e)
  }
  expect(data, 'V1 should revert').to.not.equal(undefined)
  const outer = v1.guard.interface.parseError(data!)
  expect(outer?.name).to.equal('PolicyReverted')
  expect(policy.interface.parseError(outer!.args.reason)?.name).to.equal(name)
}

describe('V1 vs V2 (design doc §1, on real Safes 1.5.0)', () => {
  describe('§1 row 1 — a narrow rule hides the fallback timelock (WA-4014)', () => {
    it('setGuard(0) under an exact Allow rule: V1 executes at once, V2 delayed (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const setGuardSel = w.safe.interface.getFunction('setGuard')!.selector
      const v1 = await deployV1Hiding(w, setGuardSel)
      await v1Owners(w, v1, onV1(v1, safeCall(w, 'setGuard', [ZeroAddress])))
      expect((await guardsOf(v1.safe)).guard).to.equal(ZeroAddress)

      await installV2Owners(w, [allow(scope(OWNERS, w.safeAddress, setGuardSel))])
      await expectPolicyDenied(
        execOwners(w, safeCall(w, 'setGuard', [ZeroAddress])),
        w.engine,
        w.timelock,
        'NotScheduled',
      )
    })

    it('addOwnerWithThreshold under an exact Allow rule: V1 executes at once, V2 delayed (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const sel = w.safe.interface.getFunction('addOwnerWithThreshold')!.selector
      const v1 = await deployV1Hiding(w, sel)
      await v1Owners(w, v1, onV1(v1, safeCall(w, 'addOwnerWithThreshold', [w.attacker.address, 1])))
      expect(await v1.safe.isOwner(w.attacker.address)).to.equal(true)

      await installV2Owners(w, [allow(scope(OWNERS, w.safeAddress, sel))])
      await expectPolicyDenied(
        execOwners(w, safeCall(w, 'addOwnerWithThreshold', [w.attacker.address, 1])),
        w.engine,
        w.timelock,
        'NotScheduled',
      )
    })

    it('a payment with no rule of its own: V1 delayed (fallback timelock), V2 delayed (NotScheduled)', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1Hiding(w, w.safe.interface.getFunction('setGuard')!.selector)
      await expectV1PolicyReverted(
        v1Owners(w, v1, tokenTransfer(w, w.attacker.address, 1n)),
        v1,
        w.v1p.timelock,
        'NotScheduled',
      )

      await installV2Owners(w, [])
      await expectPolicyDenied(
        execOwners(w, tokenTransfer(w, w.attacker.address, 1n)),
        w.engine,
        w.timelock,
        'NotScheduled',
      )
    })
  })

  describe('§1 row 2 — every caller shares one rule table (WA-4016)', () => {
    it("recovery's swapOwner next to a payment allowlist: V1 denied (AccessDenied), V2 executes after R", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(
        w,
        [v1Rule(w.tokenAddress, SEL.transfer, addr(w.v1p.transfer), recipientList([w.vendorA.address]))],
        [w.recovery.address],
      )
      const v1Swap = onV1(v1, await swapOwnerCall(w, w.o1.address, w.newOwner1.address))
      await expectError(v1Module(w, v1, w.recovery, v1Swap), v1.guard, 'AccessDenied', [ZeroAddress])

      await install(
        w,
        [
          allow(scope(OWNERS, w.tokenAddress, SEL.transfer)),
          attach(
            scope(OWNERS, w.tokenAddress, SEL.transfer),
            addr(w.recipients),
            recipientsSettings({ recipients: [w.vendorA.address] }),
          ),
          attach(scope(w.recovery.address), addr(w.timelock), timelockSettings(3n * DAY)),
          allow(scope(w.recovery.address, w.safeAddress, SEL.swapOwner)),
        ],
        [],
        { modules: [w.recovery.address] },
      )
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      await scheduleModule(w, w.recovery, swap)
      await time.increase(3n * DAY)
      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
    })

    it("granting recovery's swapOwner: V1 grants every module (ops swaps owners), V2 only recovery (NotGranted)", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, (self) => [v1Rule(self, SEL.swapOwner, addr(w.v1p.allow))], [
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

      await install(w, [allow(scope(w.recovery.address, w.safeAddress, SEL.swapOwner))], [], {
        modules: [w.recovery.address, w.ops.address],
      })
      await expectError(
        execModule(w, w.ops, safeCall(w, 'swapOwner', [OWNERS, w.o1.address, w.attacker.address])),
        w.engine,
        'NotGranted',
      )
    })
  })

  describe('§1 row 3 — Co-signer and Safenet only protect the multisig path', () => {
    it('a global Co-signer and a module transaction: V1 reverts (ModulePathUnsupported), V2 executes with a pushed co-signature', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(
        w,
        [v1Fallback(addr(w.v1p.cosigner), coder.encode(['address'], [w.cosigner.address]))],
        [w.recovery.address],
      )
      const v1Swap = onV1(v1, await swapOwnerCall(w, w.o1.address, w.newOwner1.address))
      await expectV1PolicyReverted(
        v1Module(w, v1, w.recovery, v1Swap),
        v1,
        w.v1p.cosigner,
        'ModulePathUnsupported',
      )

      await install(
        w,
        [
          attach(scope(ZeroAddress), addr(w.cosignerPolicy), cosignerSettings(w.cosigner.address)),
          allow(scope(w.recovery.address, w.safeAddress, SEL.swapOwner)),
        ],
        [],
        { modules: [w.recovery.address] },
      )
      const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
      const callHash = await moduleCallHash(w, w.recovery.address, swap)
      const digest = await w.cosignerPolicy.moduleTxDigest(
        w.engineAddress,
        w.safeAddress,
        callHash,
        PROOF_DEADLINE,
      )
      await w.cosignerPolicy.cosign(
        w.engineAddress,
        w.safeAddress,
        callHash,
        w.cosigner.address,
        PROOF_DEADLINE,
        cosign(w, digest),
      )
      await execModule(w, w.recovery, swap)
      expect(await w.safe.isOwner(w.newOwner1.address)).to.equal(true)
    })
  })

  describe('§1 row 4 — a freeze cannot cover configuration changes', () => {
    it('a pending malicious configuration under a deny-everything fallback: V1 applies it, V2 ConfigFrozen', async () => {
      const w = await loadFixture(deploy)
      // V1: everything is already denied (the strongest "freeze" V1 has), yet configuration passes.
      const v1 = await deployV1(w, [v1Fallback(addr(w.v1p.deny))])
      const malicious = [v1Fallback(addr(w.v1p.allow))]
      const root = ethers.keccak256(
        coder.encode(
          ['tuple(address target, bytes4 selector, uint8 operation, address policy, bytes data)[]'],
          [malicious.map((c) => [c.target, c.selector, c.operation, c.policy, c.data])],
        ),
      )
      await expectV1PolicyReverted(
        v1Owners(w, v1, tokenTransfer(w, w.attacker.address, 1n)),
        v1,
        w.v1p.deny,
        'Denied',
      )
      await v1Owners(
        w,
        v1,
        call(v1.guardAddress, v1.guard.interface.encodeFunctionData('requestConfiguration', [root])),
      )
      await time.increase(DAY)
      await v1Owners(
        w,
        v1,
        call(v1.guardAddress, v1.guard.interface.encodeFunctionData('applyConfiguration', [malicious])),
      )
      await v1Owners(w, v1, tokenTransfer(w, w.attacker.address, usdc(100_000)))
      expect(await w.token.balanceOf(v1.safeAddress)).to.equal(0n)

      await install(
        w,
        [allow(scope(OWNERS)), attach(scope(OWNERS), addr(w.freeze), freezeSettings(true, false))],
        [guardianRole(w.guardian.address)],
      )
      const drop = [guardianRole(w.guardian.address, false)]
      await requestConfig(w, [], drop)
      await w.engine.connect(w.guardian).freeze([w.safeAddress])
      await time.increase(DELAY)
      await expectError(applyConfig(w, [], drop), w.engine, 'ConfigFrozen')
    })

    it('stopping the Safe: V1 a new deny rule waits DELAY (RootConfigurationPending), V2 the guardian freezes at once', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [v1Fallback(addr(w.v1p.allow))])
      const stop = [v1Fallback(addr(w.v1p.deny))]
      const root = ethers.keccak256(
        coder.encode(
          ['tuple(address target, bytes4 selector, uint8 operation, address policy, bytes data)[]'],
          [stop.map((c) => [c.target, c.selector, c.operation, c.policy, c.data])],
        ),
      )
      await v1Owners(
        w,
        v1,
        call(v1.guardAddress, v1.guard.interface.encodeFunctionData('requestConfiguration', [root])),
      )
      await expectError(
        v1Owners(
          w,
          v1,
          call(v1.guardAddress, v1.guard.interface.encodeFunctionData('applyConfiguration', [stop])),
        ),
        v1.guard,
        'RootConfigurationPending',
      )
      await v1Owners(w, v1, tokenTransfer(w, w.attacker.address, 1n)) // still open

      await install(
        w,
        [allow(scope(OWNERS)), attach(scope(OWNERS), addr(w.freeze), freezeSettings(true, false))],
        [guardianRole(w.guardian.address)],
      )
      await w.engine.connect(w.guardian).freeze([w.safeAddress])
      await expectPolicyDenied(
        execOwners(w, tokenTransfer(w, w.attacker.address, 1n)),
        w.engine,
        w.freeze,
        'Frozen',
      )
    })
  })

  describe('§1 row 5 — the guard conflicts with the existing modules', () => {
    it("a spending module paying its own payee next to the owners' allowlist: V1 denied, V2 executes (per actor)", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(
        w,
        [v1Rule(w.tokenAddress, SEL.transfer, addr(w.v1p.transfer), recipientList([w.vendorA.address]))],
        [w.ops.address],
      )
      await expectV1PolicyReverted(
        v1Module(w, v1, w.ops, tokenTransfer(w, w.vendorB.address, usdc(10))),
        v1,
        w.v1p.transfer,
        'Unauthorized',
      )

      await install(
        w,
        [
          allow(scope(OWNERS, w.tokenAddress, SEL.transfer)),
          attach(scope(OWNERS), addr(w.recipients), recipientsSettings({ recipients: [w.vendorA.address] })),
          allow(scope(w.ops.address, w.tokenAddress, SEL.transfer)),
          attach(
            scope(w.ops.address),
            addr(w.limit),
            limitSettings([{ token: w.tokenAddress, amount: usdc(100), period: DAY }]),
          ),
          attach(
            scope(w.ops.address),
            addr(w.recipients),
            recipientsSettings({ recipients: [w.vendorB.address] }),
          ),
        ],
        [],
        { modules: [w.ops.address] },
      )
      await execModule(w, w.ops, tokenTransfer(w, w.vendorB.address, usdc(10)))
      expect(await w.token.balanceOf(w.vendorB.address)).to.equal(usdc(10))
    })
  })

  describe('§1 row 6 — spending limits only cover transfers', () => {
    async function v1WithTransferLimit(w: W) {
      // The usual V1 set-up: a transfer limit, and a fallback Allow so everything else works.
      return deployV1(w, [
        v1Rule(
          w.tokenAddress,
          SEL.transfer,
          addr(w.v1p.spendingLimit),
          coder.encode(['uint256', 'uint256'], [usdc(5_000), MONTH]),
        ),
        v1Fallback(addr(w.v1p.allow)),
      ])
    }
    async function v2WithLimit(w: W) {
      await install(w, [
        allow(scope(OWNERS)),
        attach(
          scope(OWNERS),
          addr(w.limit),
          limitSettings([
            { token: w.tokenAddress, amount: usdc(5_000), period: MONTH },
            { token: ZeroAddress, amount: ethers.parseEther('1'), period: MONTH },
          ]),
        ),
      ])
    }

    it('approve(attacker, 100,000) under a 5,000 limit: V1 executes (unlimited allowance), V2 LimitExceeded', async () => {
      const w = await loadFixture(deploy)
      const v1 = await v1WithTransferLimit(w)
      await expectV1PolicyReverted(
        v1Owners(w, v1, tokenTransfer(w, w.attacker.address, usdc(5_001))),
        v1,
        w.v1p.spendingLimit,
        'LimitExceeded',
      )
      await v1Owners(w, v1, tokenApprove(w, w.attacker.address, usdc(100_000)))
      await w.token.connect(w.attacker).transferFrom(v1.safeAddress, w.attacker.address, usdc(100_000))

      await v2WithLimit(w)
      await expectPolicyDenied(
        execOwners(w, tokenApprove(w, w.attacker.address, usdc(100_000))),
        w.engine,
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
        w.engine,
        w.limit,
        'LimitExceeded',
      )
    })

    it('transfers inside a MultiSend: V1 (71b9cb0) lets an allowed batch through unchecked, V2 checks every sub-call', async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [
        v1Rule(
          w.tokenAddress,
          SEL.transfer,
          addr(w.v1p.spendingLimit),
          coder.encode(['uint256', 'uint256'], [usdc(5_000), MONTH]),
        ),
        v1Rule(await w.infra.multiSendCallOnly.getAddress(), '0x8d80ff0a', addr(w.v1p.allow), '0x', 1),
      ])
      const drain = [
        tokenTransfer(w, w.attacker.address, usdc(50_000)),
        tokenTransfer(w, w.attacker.address, usdc(50_000)),
      ]
      await v1Owners(w, v1, multiSendTx(await w.infra.multiSendCallOnly.getAddress(), drain))
      expect(await w.token.balanceOf(v1.safeAddress)).to.equal(0n)

      await v2WithLimit(w)
      await expectPolicyDenied(
        execOwners(w, multiSendTx(await w.infra.multiSendCallOnly.getAddress(), drain)),
        w.engine,
        w.limit,
        'LimitExceeded',
        undefined,
        0n,
      )
    })
  })

  describe('§7 gap 1 — ERC-1271 signatures bypass the guard', () => {
    it("an off-chain owner signature on a permit (Tim's attack): V1 valid (drain), V2 INVALID", async () => {
      const w = await loadFixture(deploy)
      const v1 = await deployV1(w, [
        v1Rule(w.tokenAddress, SEL.transfer, addr(w.v1p.transfer), recipientList([w.vendorA.address])),
      ])
      await install(w, [allow(scope(OWNERS))])
      const { chainId } = await ethers.provider.getNetwork()
      const deadline = BigInt(await time.latest()) + 3600n
      const digestFor = async (owner: string) =>
        TypedDataEncoder.hash(
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
      const v1Digest = await digestFor(v1.safeAddress)
      expect(
        await isValidSignature(v1.safe, v1Digest, await signHashOffchain(v1.safe, v1Digest, w.quorum2)),
      ).to.equal(EIP1271_MAGIC_VALUE)
      const v2Digest = await digestFor(w.safeAddress)
      expect(
        await isValidSignature(w.safe, v2Digest, await signHashOffchain(w.safe, v2Digest, w.quorum2)),
      ).to.equal('0xffffffff')
    })
  })
})

/** V1: the owners' fallback is a 24h timelock, and someone wrote an Allow rule for one Safe function. */
const deployV1Hiding = (w: W, selector: string) =>
  deployV1(w, (self) => [
    v1Fallback(addr(w.v1p.timelock), coder.encode(['uint256'], [T])),
    v1Rule(self, selector, addr(w.v1p.allow)),
  ])

/** V2: (Owners, *) Allow + Timelock 24h, plus `extra`. */
async function installV2Owners(w: W, extra: ReturnType<typeof allow>[]) {
  await install(w, [
    allow(scope(OWNERS)),
    attach(scope(OWNERS), addr(w.timelock), timelockSettings(T)),
    ...extra,
  ])
}
