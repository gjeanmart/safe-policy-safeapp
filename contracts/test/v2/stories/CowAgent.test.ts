import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { concat, randomBytes, toBeHex } from 'ethers'
import { ethers } from 'hardhat'
import type { StoryCowSettlement, StoryCowVaultRelayer } from '../../../typechain-types'
import {
  ArgsOp,
  DAY,
  F,
  Kind,
  OWNERS,
  SEL,
  WEEK,
  type World,
  addrOf,
  allow,
  anyCall,
  approve,
  argsSettings,
  attach,
  attachmentId,
  call,
  coApprove,
  coApproveWithSig,
  cosignerSettings,
  deployWorld,
  execModule,
  execOwners,
  expectPolicyDenied,
  expectPolicyError,
  install,
  limitSettings,
  moduleCallHash,
  onFunction,
  onWord,
  sel,
  timelockSettings,
  transfer,
  usdc,
} from './world'
import type { MetaTx } from '../fixtures/safe'

/**
 * Story: an AI agent trades on CoW Protocol (COOKBOOK "CoW agent"). The agent (a module key)
 * approves the CoW vault relayer, capped, and pre-signs orders with `setPreSignature`. Every agent
 * transaction needs the co-signer service's approval, consumed on use; the guardian's kill switch
 * stops the agent and nobody else. A pre-signed order can sell any token the Safe has approved to
 * the vault relayer: the bound is every allowance to the relayer, the owners' own included, not
 * only the agent's budget.
 *
 * Agent: Timelock(0, guardian G), Limit 50,000 USDC a week (passUnpriced), CoSigner 1-of-1 at
 * `(Agent, *)`; Allow `USDC.approve` + Args (spender EQ relayer, amount LTE 20,000); Allow
 * `Settlement.setPreSignature`.
 */

const CAP = usdc(20_000)
const BUDGET = usdc(50_000)
const PRESIGN = sel('setPreSignature(bytes,bool)')

async function world() {
  const w = await deployWorld()
  const settlement = (await ethers.deployContract('StoryCowSettlement')) as unknown as StoryCowSettlement
  const settlementAddress = addrOf(settlement)
  const relayerAddress = await settlement.vaultRelayer()
  const relayer = (await ethers.getContractAt(
    'StoryCowVaultRelayer',
    relayerAddress,
  )) as unknown as StoryCowVaultRelayer
  const agent = w.agent.address
  const approveScope = onFunction(agent, w.tokenAddress, SEL.approve)
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      allow(onFunction(w.ops.address, w.tokenAddress, SEL.transfer)),
      // Order matters only for which denial is reported first: the kill switch, the budget, the co-signer.
      attach(anyCall(agent), w.timelock, timelockSettings({ delay: 0, guardians: [w.guardian.address] })),
      attach(
        anyCall(agent),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: BUDGET, period: WEEK }], true),
      ),
      attach(anyCall(agent), w.cosigner, cosignerSettings([w.cosignerKey.address], 1)),
      allow(approveScope),
      attach(
        approveScope,
        w.args,
        argsSettings([
          onWord(SEL.approve, 0, ArgsOp.EQ, [relayerAddress]),
          onWord(SEL.approve, 1, ArgsOp.LTE, [CAP]),
        ]),
      ),
      allow(onFunction(agent, settlementAddress, PRESIGN)),
    ],
    { modules: [agent, w.ops.address] },
  )
  return { ...w, settlement, settlementAddress, relayer, relayerAddress }
}
type W = World & Awaited<ReturnType<typeof world>>

/** A CoW order uid: digest ‖ owner ‖ validTo. The digest (sell/buy amounts, receiver) is opaque. */
const orderUid = (w: W) => concat([randomBytes(32), w.safeAddress, toBeHex(2n ** 32n - 1n, 4)])
const preSign = (w: W, uid: string): MetaTx =>
  call(w.settlementAddress, w.settlement.interface.encodeFunctionData('setPreSignature', [uid, true]))

/** The agent sends `tx` after the co-signer approved its module call hash. */
async function agentDoes(w: W, tx: MetaTx, viaRelayer = false) {
  const hash = moduleCallHash(w, w.agent.address, tx)
  if (viaRelayer) await coApproveWithSig(w, hash)
  else await coApprove(w, hash)
  return execModule(w, w.agent, tx)
}

const cosignerId = (w: W) => attachmentId(anyCall(w.agent.address), Kind.POLICY, addrOf(w.cosigner))
const killId = (w: W) => attachmentId(anyCall(w.agent.address), Kind.POLICY, addrOf(w.timelock))

describe('Story: a CoW Protocol agent with a co-signer and a kill switch', () => {
  it('approves the vault relayer and pre-signs an order, each approved by the co-signer', async () => {
    const w = await loadFixture(world)
    // The co-signer service signs off-chain; anyone pushes the signature (approveWithSig).
    await agentDoes(w, approve(w, w.relayerAddress, CAP), true)
    const uid = orderUid(w)
    await agentDoes(w, preSign(w, uid))
    expect(await w.token.allowance(w.safeAddress, w.relayerAddress)).to.equal(CAP)
    expect(await w.settlement.preSignature(uid)).to.equal(2n ** 256n - 1n)
  })

  it('denies an agent transaction without the co-signer approval (MissingApprovals)', async () => {
    const w = await loadFixture(world)
    await expectPolicyDenied(
      execModule(w, w.agent, preSign(w, orderUid(w))),
      w,
      w.cosigner,
      'MissingApprovals',
      [cosignerId(w), 1, 0],
    )
  })

  it('consumes the approval: the same call needs a new one; an approval of another call does not count', async () => {
    const w = await loadFixture(world)
    const tx = approve(w, w.relayerAddress, usdc(1_000))
    await agentDoes(w, tx)
    await expectPolicyDenied(execModule(w, w.agent, tx), w, w.cosigner, 'MissingApprovals')
    await coApprove(w, moduleCallHash(w, w.agent.address, approve(w, w.relayerAddress, usdc(999))))
    await expectPolicyDenied(execModule(w, w.agent, tx), w, w.cosigner, 'MissingApprovals')
    await agentDoes(w, tx)
  })

  it('an approval by someone who is not a listed approver does not count', async () => {
    const w = await loadFixture(world)
    const tx = preSign(w, orderUid(w))
    await coApprove(w, moduleCallHash(w, w.agent.address, tx), w.attacker)
    await expectPolicyDenied(execModule(w, w.agent, tx), w, w.cosigner, 'MissingApprovals')
  })

  it('caps the approval: only the vault relayer, at most 20,000 (Args), even when co-signed', async () => {
    const w = await loadFixture(world)
    const argsId = attachmentId(
      onFunction(w.agent.address, w.tokenAddress, SEL.approve),
      Kind.POLICY,
      addrOf(w.args),
    )
    const tooMuch = approve(w, w.relayerAddress, CAP + 1n)
    await coApprove(w, moduleCallHash(w, w.agent.address, tooMuch))
    await expectPolicyDenied(execModule(w, w.agent, tooMuch), w, w.args, 'ConstraintFailed', [0, argsId, 1])
    const otherSpender = approve(w, w.attacker.address, 1n)
    await coApprove(w, moduleCallHash(w, w.agent.address, otherSpender))
    await expectPolicyDenied(execModule(w, w.agent, otherSpender), w, w.args, 'ConstraintFailed', [
      0,
      argsId,
      0,
    ])
  })

  it('the weekly budget bounds the approvals: the third 20,000 approval in a week is denied', async () => {
    const w = await loadFixture(world)
    await agentDoes(w, approve(w, w.relayerAddress, CAP))
    await agentDoes(w, approve(w, w.relayerAddress, CAP - 1n)) // re-approving counts in full
    await expectPolicyDenied(agentDoes(w, approve(w, w.relayerAddress, CAP)), w, w.limit, 'LimitExceeded')
    await time.increase(WEEK)
    await agentDoes(w, approve(w, w.relayerAddress, CAP))
  })

  it('the guardian freezes the agent at once; ops and the owners keep working; the freeze ends after F', async () => {
    const w = await loadFixture(world)
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [killId(w)])
    const tx = preSign(w, orderUid(w))
    await coApprove(w, moduleCallHash(w, w.agent.address, tx))
    await expectPolicyDenied(execModule(w, w.agent, tx), w, w.timelock, 'AttachmentFrozen')
    await execModule(w, w.ops, transfer(w, w.vendorA.address, 1n))
    await execOwners(w, transfer(w, w.vendorA.address, 1n))
    await time.increase(F)
    await agentDoes(w, tx) // the earlier approval has expired by now (valid a day): a fresh one
  })

  it('only a guardian of the agent attachment can freeze it (NotGuardian)', async () => {
    const w = await loadFixture(world)
    await expectPolicyError(
      w.timelock.connect(w.agent).freeze(w.engineAddress, w.safeAddress, [killId(w)]),
      w.timelock,
      'NotGuardian',
      [killId(w)],
    )
  })

  describe('what the policies cannot see', () => {
    it('the order contents: a pre-signature of an order paying the attacker passes; the allowance to the relayer is the bound', async () => {
      const w = await loadFixture(world)
      await agentDoes(w, approve(w, w.relayerAddress, usdc(5_000)))
      // The uid hides sell amount, buy amount and receiver: the policies see only `setPreSignature(uid, true)`.
      await agentDoes(w, preSign(w, orderUid(w)))
      // Settlement pulls through the approval to whatever receiver the order names, up to the approval.
      await w.relayer.settle(w.tokenAddress, w.safeAddress, w.attacker.address, usdc(5_000))
      expect(await w.token.balanceOf(w.attacker.address)).to.equal(usdc(5_000))
      let pulledMore = true
      try {
        await w.relayer.settle(w.tokenAddress, w.safeAddress, w.attacker.address, 1n)
      } catch {
        pulledMore = false
      }
      expect(pulledMore).to.equal(false)
    })

    it("the bound is every allowance to the vault relayer, whoever gave it: the owners' own approval is in the agent's reach", async () => {
      const w = await loadFixture(world)
      // The owners trade on CoW Swap themselves and approve the relayer for 80,000: no agent budget sees it.
      await execOwners(w, approve(w, w.relayerAddress, usdc(80_000)))
      // The agent spends nothing of its budget: it only pre-signs an order selling all of it to the attacker.
      await agentDoes(w, preSign(w, orderUid(w)))
      await w.relayer.settle(w.tokenAddress, w.safeAddress, w.attacker.address, usdc(80_000))
      expect(await w.token.balanceOf(w.attacker.address)).to.equal(usdc(80_000))
      const limitId = attachmentId(anyCall(w.agent.address), Kind.POLICY, addrOf(w.limit))
      expect(
        (await w.limit.remaining(w.engineAddress, w.safeAddress, limitId, w.tokenAddress)).spent,
      ).to.equal(0n)
    })

    it('the reviewed transaction: the co-signer approves a hash; it must decode the call itself', async () => {
      const w = await loadFixture(world)
      const tx = preSign(w, orderUid(w))
      const hash = moduleCallHash(w, w.agent.address, tx)
      // On chain, the policy stores nothing but (txHash, approver, validUntil).
      await coApprove(w, hash)
      const until = await w.cosigner.approvedUntil(
        w.engineAddress,
        w.safeAddress,
        hash,
        w.cosignerKey.address,
      )
      expect(Number(until)).to.be.greaterThan(await time.latest())
      expect(Number(until)).to.be.at.most((await time.latest()) + Number(DAY))
    })
  })
})
