import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  Kind,
  OWNERS,
  Op,
  SEL,
  T,
  type World,
  addrOf,
  allow,
  anyCall,
  approve,
  argsSettings,
  attach,
  attachmentId,
  batchTx,
  deployWorld,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  install,
  onFunction,
  recipientsPreset,
  scheduleOwners,
  timelockSettings,
  transfer,
  usdc,
} from './world'
import { multiSendData, multiSendTx } from '../fixtures/safe'

/**
 * Story: batches (COOKBOOK "Batches"). A DELEGATECALL to a trusted MultiSendCallOnly is
 * transparent: the wrapper is not matched, each sub-call is checked as if sent alone, and every
 * policy runs once per transaction with all the sub-calls it matched.
 */

async function world() {
  const w = await deployWorld()
  const ops = w.ops.address
  const transferScope = onFunction(ops, w.tokenAddress, SEL.transfer)
  await install(
    w,
    [
      allow(onFunction(OWNERS, w.tokenAddress, SEL.transfer)),
      allow(transferScope),
      attach(transferScope, w.args, argsSettings(recipientsPreset([w.vendorA.address, w.vendorB.address]))),
    ],
    { modules: [ops] },
  )
  return w
}

/** Owners: Allow (Owners, *) + Timelock T. */
async function timelocked() {
  const w = await deployWorld()
  await install(w, [
    allow(anyCall(OWNERS)),
    attach(anyCall(OWNERS), w.timelock, timelockSettings({ delay: T })),
  ])
  return w
}

const pay = (w: World, n: number, to = w.vendorA.address) => Array(n).fill(transfer(w, to, usdc(1)))

describe('Story: batches through MultiSendCallOnly', () => {
  it('the wrapper is transparent: no Allow on MultiSend, the sub-calls are granted one by one', async () => {
    const w = await loadFixture(world)
    await execOwners(w, batchTx(w, pay(w, 3)))
    await execModule(w, w.ops, batchTx(w, [...pay(w, 1), ...pay(w, 1, w.vendorB.address)]))
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(4))
  })

  it('a sub-call without its own Allow denies the batch (NotGranted names the sub-call)', async () => {
    const w = await loadFixture(world)
    await expectEngineError(
      execOwners(w, batchTx(w, [...pay(w, 1), approve(w, w.attacker.address, 1n)])),
      w,
      'NotGranted',
      [1, w.tokenAddress, SEL.approve, 0],
    )
  })

  it('built-in gates run for every call before any policy: NotGranted at call 1 wins over an Args failure at call 0', async () => {
    const w = await loadFixture(world)
    const calls = [transfer(w, w.attacker.address, 1n), approve(w, w.attacker.address, 1n)]
    await expectEngineError(execModule(w, w.ops, batchTx(w, calls)), w, 'NotGranted', [
      1,
      w.tokenAddress,
      SEL.approve,
      0,
    ])
    // Without the ungranted call, the policy denial shows, naming its call.
    const argsId = attachmentId(
      onFunction(w.ops.address, w.tokenAddress, SEL.transfer),
      Kind.POLICY,
      addrOf(w.args),
    )
    await expectPolicyDenied(
      execModule(w, w.ops, batchTx(w, [...pay(w, 2), transfer(w, w.attacker.address, 1n)])),
      w,
      w.args,
      'ConstraintFailed',
      [2, argsId, 0],
    )
  })

  it('nesting is denied: a sub-call DELEGATECALLing the trusted batch (NestedBatch)', async () => {
    const w = await loadFixture(world)
    const inner = { to: w.batch, data: multiSendData(pay(w, 1)), operation: Op.DELEGATECALL }
    await expectEngineError(execOwners(w, batchTx(w, [...pay(w, 1), inner])), w, 'NestedBatch', [1])
  })

  it('caps a batch at 8 calls: 8 pass, 9 are BatchTooLarge', async () => {
    const w = await loadFixture(world)
    await execOwners(w, batchTx(w, pay(w, 8)))
    await expectEngineError(execOwners(w, batchTx(w, pay(w, 9))), w, 'BatchTooLarge')
  })

  it('an empty batch or a batch with value is MalformedBatch', async () => {
    const w = await loadFixture(world)
    await expectEngineError(execOwners(w, batchTx(w, [])), w, 'MalformedBatch')
    await expectEngineError(execOwners(w, { ...batchTx(w, pay(w, 1)), value: 1n }), w, 'MalformedBatch')
  })

  it('an untrusted batch contract (full MultiSend) is an ordinary DELEGATECALL: NotGranted', async () => {
    const w = await loadFixture(world)
    const multiSend = await w.infra.multiSend.getAddress()
    await expectEngineError(execOwners(w, multiSendTx(multiSend, pay(w, 1))), w, 'NotGranted')
  })

  it('one Timelock schedule per batch: the owners schedule the batch once and execute it after T', async () => {
    const w = await loadFixture(timelocked)
    const tx = batchTx(w, [...pay(w, 4), approve(w, w.vendorB.address, 5n)])
    await expectPolicyDenied(execOwners(w, tx), w, w.timelock, 'NotScheduled')
    await scheduleOwners(w, tx)
    await time.increase(T)
    await execOwners(w, tx)
    expect(await w.token.balanceOf(w.vendorA.address)).to.equal(usdc(4))
  })
})
