import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { Interface, dataSlice, getAddress } from 'ethers'
import { ethers } from 'hardhat'
import { type MetaTx, type SafeTx } from '../fixtures/safe'
import { revertData } from '../helpers'
import {
  Kind,
  MONTH,
  Op,
  OWNERS,
  R,
  SEL,
  type Actor,
  type World,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  attachmentId,
  batchTx,
  call,
  coApprove,
  configureCall,
  cosignerSettings,
  deny,
  deployWorld,
  execModule,
  execOwners,
  install,
  limitSettings,
  moduleCallHash,
  onFunction,
  ownerTxHash,
  recipientsPreset,
  safeCall,
  scheduleModule,
  swapOwnerCall,
  timelockSettings,
  transfer,
  approve,
  usdc,
} from './world'

/**
 * Story: the app's preview (SPEC §3.5). `engine.matches` gives the calls, every matched
 * attachment and the built-in verdict; then each distinct policy's `check` is `eth_call`ed from
 * the engine address, in first-match order, with its own matches. The verdict (exact revert bytes,
 * or a pass) must equal the real transaction's, on both paths, with no matching logic in TS.
 */

const POLICY_ABI = new Interface([
  'function check((address safe, address actor, bytes32 txHash) ctx, (address to, uint256 value, bytes data, uint8 operation)[] calls, (uint16 callIndex, uint8 level, bytes32 attachmentId)[] matches) returns (bytes4)',
])
const CHECK_SELECTOR = POLICY_ABI.getFunction('check')!.selector
const MAX_REASON_LENGTH = 512

/** The verdict the preview predicts: '0x' for a pass, else the revert data the hook would raise. */
async function preview(w: World, actor: string, tx: MetaTx, txHash: string): Promise<string> {
  const [calls, found, engineError] = await w.engine.matches(
    w.safeAddress,
    actor,
    tx.to,
    tx.value ?? 0n,
    tx.data ?? '0x',
    tx.operation ?? 0,
  )
  if (engineError !== '0x') return engineError
  const order: string[] = []
  const byPolicy = new Map<string, [number, number, string][]>()
  for (const m of found) {
    if (Number(m.kind) !== Kind.POLICY) continue
    const p = getAddress(m.policy)
    if (!byPolicy.has(p)) {
      byPolicy.set(p, [])
      order.push(p)
    }
    byPolicy.get(p)!.push([Number(m.callIndex), Number(m.level), m.attachmentId])
  }
  const plainCalls = calls.map((c) => [c.to, c.value, c.data, Number(c.operation)])
  for (const policy of order) {
    const data = POLICY_ABI.encodeFunctionData('check', [
      [w.safeAddress, actor, txHash],
      plainCalls,
      byPolicy.get(policy),
    ])
    let reason: string | undefined
    try {
      const ret = await ethers.provider.call({ from: w.engineAddress, to: policy, data })
      if (ret.length !== 66 || dataSlice(ret, 0, 4) !== CHECK_SELECTOR) reason = '0x'
    } catch (e) {
      reason = revertData(e) ?? '0x'
      if ((reason.length - 2) / 2 > MAX_REASON_LENGTH) reason = dataSlice(reason, 0, MAX_REASON_LENGTH)
    }
    if (reason !== undefined) return w.engine.interface.encodeErrorResult('PolicyDenied', [policy, reason])
  }
  return '0x'
}

/** The real verdict: '0x' if the transaction executed, else its revert data. */
async function real(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
    return '0x'
  } catch (e) {
    const data = revertData(e)
    if (data === undefined) throw e
    return data
  }
}

/** Preview, then execute: both verdicts must match; returns the decoded error name (or 'pass'). */
async function owners(w: World, tx: SafeTx): Promise<string> {
  const predicted = await preview(w, OWNERS, tx, await ownerTxHash(w, tx))
  const actual = await real(() => execOwners(w, tx))
  expect(predicted).to.equal(actual)
  return nameOf(w, actual)
}

async function module(w: World, actor: Actor, tx: MetaTx): Promise<string> {
  const predicted = await preview(w, actor.address, tx, moduleCallHash(w, actor.address, tx))
  const actual = await real(() => execModule(w, actor, tx))
  expect(predicted).to.equal(actual)
  return nameOf(w, actual)
}

function nameOf(w: World, data: string): string {
  if (data === '0x') return 'pass'
  const outer = w.engine.interface.parseError(data)!
  if (outer.name !== 'PolicyDenied') return outer.name
  const policies = [w.timelock, w.args, w.limit, w.cosigner]
  const p = policies.find((c) => addrOf(c) === getAddress(outer.args.policy))!
  return `PolicyDenied/${p.interface.parseError(outer.args.reason)!.name}`
}

async function world() {
  const w = await deployWorld()
  const ops = w.ops.address
  const agent = w.agent.address
  const recovery = w.recovery.address
  const transferScope = onFunction(OWNERS, w.tokenAddress, SEL.transfer)
  const opsTransfer = onFunction(ops, w.tokenAddress, SEL.transfer)
  const setFallbackHandler = (w.safe.interface as Interface).getFunction('setFallbackHandler')!.selector
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      deny(onFunction(ANY_ACTOR, w.safeAddress, setFallbackHandler)),
      attach(transferScope, w.args, argsSettings(recipientsPreset([w.vendorA.address, w.vendorB.address]))),
      allow(opsTransfer),
      attach(opsTransfer, w.args, argsSettings(recipientsPreset([w.vendorA.address]))),
      attach(
        anyCall(ops),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(1_000), period: MONTH }]),
      ),
      allow(anyCall(agent)),
      attach(anyCall(agent), w.timelock, timelockSettings({ delay: 0, guardians: [w.guardian.address] })),
      attach(anyCall(agent), w.cosigner, cosignerSettings([w.cosignerKey.address], 1)),
      allow(onFunction(recovery, w.safeAddress, SEL.swapOwner)),
      attach(anyCall(recovery), w.timelock, timelockSettings({ delay: R, window: 7n * 86400n })),
    ],
    { modules: [ops, agent, recovery] },
  )
  return w
}
const ANY_ACTOR = '0x0000000000000000000000000000000000000000'

describe('Story: preview (matches + eth_call of each policy) equals the real check', () => {
  it('owner path: a pass (transfer to a listed vendor)', async () => {
    const w = await loadFixture(world)
    expect(await owners(w, transfer(w, w.vendorA.address, usdc(10)))).to.equal('pass')
  })

  it('owner path: a built-in DENY (setFallbackHandler, Denied)', async () => {
    const w = await loadFixture(world)
    expect(await owners(w, safeCall(w, 'setFallbackHandler', [w.attacker.address]))).to.equal('Denied')
  })

  it('owner path: 1 to 3 bytes of calldata (InvalidSelector)', async () => {
    const w = await loadFixture(world)
    expect(await owners(w, call(w.tokenAddress, '0x1234'))).to.equal('InvalidSelector')
  })

  it('owner path: another engine function, and configure with value (GuardTargetDenied)', async () => {
    const w = await loadFixture(world)
    const levels = w.engine.interface.encodeFunctionData('levelsUsed', [w.safeAddress])
    expect(await owners(w, call(w.engineAddress, levels))).to.equal('GuardTargetDenied')
    expect(await owners(w, { ...configureCall(w, []), value: 1n })).to.equal('GuardTargetDenied')
  })

  it('owner path: a batch inside a batch (NestedBatch)', async () => {
    const w = await loadFixture(world)
    const inner = { ...batchTx(w, [transfer(w, w.vendorA.address, 1n)]), value: 0n }
    expect(await owners(w, batchTx(w, [transfer(w, w.vendorA.address, 1n), inner]))).to.equal('NestedBatch')
  })

  it('owner path: Args (ConstraintFailed) on a transfer to an unlisted address', async () => {
    const w = await loadFixture(world)
    expect(await owners(w, transfer(w, w.attacker.address, 1n))).to.equal('PolicyDenied/ConstraintFailed')
  })

  it('owner path: a batch of 3 that passes, then one whose second call fails Args', async () => {
    const w = await loadFixture(world)
    const ok = [
      transfer(w, w.vendorA.address, 1n),
      transfer(w, w.vendorB.address, 2n),
      approve(w, w.vendorA.address, 0n),
    ]
    expect(await owners(w, batchTx(w, ok))).to.equal('pass')
    const bad = [transfer(w, w.vendorA.address, 1n), transfer(w, w.attacker.address, 2n)]
    expect(await owners(w, batchTx(w, bad))).to.equal('PolicyDenied/ConstraintFailed')
  })

  it('module path: no Allow (NotGranted)', async () => {
    const w = await loadFixture(world)
    expect(await module(w, w.ops, approve(w, w.vendorA.address, 1n))).to.equal('NotGranted')
  })

  it('module path: a pass, then over the budget (LimitExceeded), then a batch over the budget', async () => {
    const w = await loadFixture(world)
    expect(await module(w, w.ops, transfer(w, w.vendorA.address, usdc(600)))).to.equal('pass')
    expect(await module(w, w.ops, transfer(w, w.vendorA.address, usdc(500)))).to.equal(
      'PolicyDenied/LimitExceeded',
    )
    const two = batchTx(w, [
      transfer(w, w.vendorA.address, usdc(200)),
      transfer(w, w.vendorA.address, usdc(201)),
    ])
    expect(await module(w, w.ops, two)).to.equal('PolicyDenied/LimitExceeded')
  })

  it('module path: the recovery Timelock (NotScheduled, then NotReady after a schedule)', async () => {
    const w = await loadFixture(world)
    const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
    expect(await module(w, w.recovery, swap)).to.equal('PolicyDenied/NotScheduled')
    await scheduleModule(w, w.recovery, swap)
    expect(await module(w, w.recovery, swap)).to.equal('PolicyDenied/NotReady')
  })

  it('module path: the co-signer (MissingApprovals, then a pass once approved)', async () => {
    const w = await loadFixture(world)
    const tx = transfer(w, w.vendorB.address, usdc(5))
    expect(await module(w, w.agent, tx)).to.equal('PolicyDenied/MissingApprovals')
    await coApprove(w, moduleCallHash(w, w.agent.address, tx))
    expect(await module(w, w.agent, tx)).to.equal('pass')
    // The approval was consumed by the pass: the same call needs a new one.
    expect(await module(w, w.agent, tx)).to.equal('PolicyDenied/MissingApprovals')
  })

  it('module path: a frozen kill switch (AttachmentFrozen) wins over the missing approval', async () => {
    const w = await loadFixture(world)
    const id = attachmentId(anyCall(w.agent.address), Kind.POLICY, addrOf(w.timelock))
    await w.timelock.connect(w.guardian).freeze(w.engineAddress, w.safeAddress, [id])
    expect(await module(w, w.agent, transfer(w, w.vendorB.address, 1n))).to.equal(
      'PolicyDenied/AttachmentFrozen',
    )
  })

  it('module path: configure needs an exact Allow (NotGranted), and the owners configure freely (pass)', async () => {
    const w = await loadFixture(world)
    const change = allow(onFunction(w.ops.address, w.tokenAddress, SEL.approve))
    expect(await module(w, w.agent, configureCall(w, [change]))).to.equal('NotGranted')
    expect(await owners(w, configureCall(w, [change]))).to.equal('pass')
  })

  it('a DELEGATECALL outside a trusted batch is not granted by a CALL Allow (NotGranted)', async () => {
    const w = await loadFixture(world)
    const tx = { ...transfer(w, w.vendorA.address, 1n), operation: Op.DELEGATECALL }
    expect(await owners(w, tx)).to.equal('NotGranted')
  })
})
