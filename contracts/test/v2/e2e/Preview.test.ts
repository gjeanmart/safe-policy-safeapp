import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { getAddress } from 'ethers'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { type MetaTx, multiSendTx } from '../fixtures/safe'
import {
  OWNERS,
  addr,
  call,
  cowOrder,
  deployOrg,
  execModule,
  execOwners,
  revertDataOf,
  signCowOrderCall,
  swapOwnerCall,
  tokenApprove,
  tokenTransfer,
  usdc,
  type World,
} from './world'

/**
 * Story: `preview` on the real engine, decoded by the app's own code (`src/lib/v2/preview.ts`).
 * For each scenario the real execution's revert must be the gate the app calls deciding, and an
 * allowed preview must execute. Covers each tie-break of the app's `decidingDeny`: engine rule,
 * `NotGranted` before call-level policies, call-level policy order, call order in a batch, then
 * transaction-level order.
 *
 * The app lib is ESM TypeScript in the root package; it is transpiled to CommonJS into the
 * gitignored `contracts/cache` at load time. Without the root dependencies (viem), a hand port of
 * the same rule is the only oracle.
 */

const GateKindN = { DENY: 1, POLICY: 2, RULE: 3 } as const
const VERDICT_DENY = 2
const TX_INDEX_N = 65535

type Gate = {
  callIndex: number
  txLevel: boolean
  kind: number
  policy: string
  verdict: number
  reason: string
  error?: { name: string }
}
type Outcome = { allowed: boolean; deciding?: Gate; needs?: string[]; onlyNeeds?: boolean }
type PreviewLib = {
  decodePreviewRevert: (data: string) => Gate[] | undefined
  previewOutcome: (gates: readonly Gate[]) => Outcome
  recoveryStillPasses: (o: Outcome) => boolean
}

const APP_LIB = path.resolve(__dirname, '../../../../src/lib/v2')

function loadApp(): PreviewLib | undefined {
  try {
    require.resolve('viem', { paths: [APP_LIB] })
  } catch {
    return undefined
  }
  const out = path.resolve(__dirname, '../../../cache/e2e-app-lib')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}')
  for (const file of fs.readdirSync(APP_LIB).filter((f) => f.endsWith('.ts'))) {
    const { outputText } = ts.transpileModule(fs.readFileSync(path.join(APP_LIB, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    })
    fs.writeFileSync(path.join(out, file.slice(0, -3) + '.js'), outputText)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(out, 'preview.js')) as PreviewLib
}
const app = loadApp()

/** Hand port of the app's `decidingDeny` (preview.ts), from the raw `Preview(gates)` revert. */
function handOutcome(w: World, data: string): Outcome {
  const parsed = w.engine.interface.parseError(data)
  expect(parsed?.name).to.equal('Preview')
  const policies = [w.timelock, w.freeze, w.limit, w.recipients, w.cosignerPolicy, w.safenet]
  const gates: Gate[] = (parsed!.args[0] as unknown[]).map((raw) => {
    const [callIndex, , kind, , policy, verdict, reason] = raw as [
      bigint,
      bigint,
      bigint,
      string,
      string,
      bigint,
      string,
    ]
    const e =
      reason === '0x'
        ? undefined
        : (w.engine.interface.parseError(reason) ??
          policies.map((c) => c.interface.parseError(reason)).find((x) => x))
    return {
      callIndex: Number(callIndex),
      txLevel: Number(callIndex) === TX_INDEX_N,
      kind: Number(kind),
      policy,
      verdict: Number(verdict),
      reason,
      error: e ? { name: e.name } : undefined,
    }
  })
  const denies = gates.filter((g) => g.verdict === VERDICT_DENY)
  const notGranted = (g: Gate) => g.kind === GateKindN.RULE && g.error?.name === 'NotGranted'
  const indexes = [...new Set(gates.filter((g) => !g.txLevel).map((g) => g.callIndex))].sort((a, b) => a - b)
  let deciding: Gate | undefined
  for (const i of indexes) {
    const own = denies.filter((g) => g.callIndex === i && !g.txLevel)
    deciding =
      own.find((g) => g.kind === GateKindN.RULE && !notGranted(g)) ??
      own.find((g) => g.kind === GateKindN.DENY) ??
      own.find(notGranted) ??
      own.find((g) => g.kind === GateKindN.POLICY)
    if (deciding) break
  }
  deciding ??= denies.find((g) => g.txLevel)
  return { allowed: denies.length === 0, deciding }
}

/** Runs `preview`; decides with the app's code when loaded (cross-checked with the hand port). */
async function preview(w: World, actor: string, tx: MetaTx): Promise<Outcome> {
  let data: string | undefined
  try {
    await w.engine.preview.staticCall(
      w.safeAddress,
      actor,
      tx.to,
      tx.value ?? 0n,
      tx.data ?? '0x',
      tx.operation ?? 0,
      { gasLimit: 15_000_000 },
    )
  } catch (e) {
    data = revertDataOf(e)
  }
  expect(data, 'preview reverts with data').to.not.equal(undefined)
  const hand = handOutcome(w, data!)
  if (!app) return hand
  const gates = app.decodePreviewRevert(data!)
  expect(gates, 'Preview(gates) revert').to.not.equal(undefined)
  const outcome = app.previewOutcome(gates!)
  expect(outcome.allowed).to.equal(hand.allowed)
  if (!hand.allowed) {
    expect(outcome.deciding?.reason).to.equal(hand.deciding?.reason)
    expect(outcome.deciding?.callIndex).to.equal(hand.deciding?.callIndex)
  }
  return outcome
}

/** The real execution's revert data, or undefined if it executed. */
async function execute(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action
    return undefined
  } catch (e) {
    const data = revertDataOf(e)
    if (data === undefined) throw e
    return data
  }
}

/** Asserts the deciding gate is the revert of the real check (or that an allowed tx executed). */
function sameDecision(w: World, outcome: Outcome, revert: string | undefined) {
  if (outcome.allowed) {
    expect(revert, 'allowed preview, but the execution reverted').to.equal(undefined)
    return
  }
  expect(revert, 'denied preview, but the execution passed').to.not.equal(undefined)
  const g = outcome.deciding!
  if (g.kind === GateKindN.POLICY) {
    const parsed = w.engine.interface.parseError(revert!)
    expect(parsed?.name).to.equal('PolicyDenied')
    expect(Number(parsed!.args.callIndex)).to.equal(g.callIndex)
    expect(getAddress(parsed!.args.policy)).to.equal(getAddress(g.policy))
    expect(parsed!.args.reason).to.equal(g.reason)
  } else {
    expect(revert).to.equal(g.reason)
  }
}

describe('E2E story: preview on the real engine matches the real check (app decoder)', () => {
  it(`decodes with ${app ? 'the app lib (src/lib/v2/preview.ts), cross-checked by the hand port' : 'the hand port only (viem not installed)'}`, () => {
    expect(app === undefined || typeof app.previewOutcome === 'function').to.equal(true)
  })

  it('owners, unscheduled: the Timelock decides ("needs a schedule")', async () => {
    const w = await loadFixture(deployOrg)
    const tx = tokenTransfer(w, w.vendorA.address, usdc(1))
    const o = await preview(w, OWNERS, tx)
    expect(o.deciding?.error?.name).to.equal('NotScheduled')
    if (app) expect([o.needs, o.onlyNeeds]).to.deep.equal([['schedule'], true])
    sameDecision(w, o, await execute(execOwners(w, tx)))
  })

  it('owners, frozen and unscheduled: the first transaction-level deny (Freeze) decides', async () => {
    const w = await loadFixture(deployOrg)
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    const tx = tokenTransfer(w, w.vendorA.address, usdc(1))
    const o = await preview(w, OWNERS, tx)
    expect(o.deciding?.error?.name).to.equal('Frozen')
    if (app) expect(o.onlyNeeds).to.equal(false)
    sameDecision(w, o, await execute(execOwners(w, tx)))
  })

  it('ops, unlisted and over budget: the first call-level policy in match order (Limit) decides', async () => {
    const w = await loadFixture(deployOrg)
    const tx = tokenTransfer(w, w.attacker.address, usdc(6_000))
    const o = await preview(w, w.ops.address, tx)
    expect(o.deciding?.error?.name).to.equal('LimitExceeded')
    sameDecision(w, o, await execute(execModule(w, w.ops, tx)))
  })

  it('ops, ungranted and over budget: NotGranted decides before the call-level policies', async () => {
    const w = await loadFixture(deployOrg)
    const tx = tokenApprove(w, w.attacker.address, usdc(6_000))
    const o = await preview(w, w.ops.address, tx)
    expect(o.deciding?.error?.name).to.equal('NotGranted')
    sameDecision(w, o, await execute(execModule(w, w.ops, tx)))
  })

  it('ops batch: call 0 denied by a policy, call 1 not granted: the first call decides', async () => {
    const w = await loadFixture(deployOrg)
    const tx = multiSendTx(await w.infra.multiSendCallOnly.getAddress(), [
      tokenTransfer(w, w.attacker.address, usdc(1)),
      tokenApprove(w, w.attacker.address, 1n),
    ])
    const o = await preview(w, w.ops.address, tx)
    expect(o.deciding?.callIndex).to.equal(0)
    expect(o.deciding?.error?.name).to.equal('RecipientNotAllowed')
    sameDecision(w, o, await execute(execModule(w, w.ops, tx)))
  })

  it('ops batch with a nested batch: the engine rule decides', async () => {
    const w = await loadFixture(deployOrg)
    const inner = multiSendTx(await w.infra.multiSendCallOnly.getAddress(), [
      tokenTransfer(w, w.vendorA.address, 1n),
    ])
    const tx = multiSendTx(await w.infra.multiSend.getAddress(), [
      tokenTransfer(w, w.vendorA.address, 1n),
      inner,
    ])
    const o = await preview(w, w.ops.address, tx)
    expect(o.deciding?.error?.name).to.equal('NestedBatch')
    sameDecision(w, o, await execute(execModule(w, w.ops, tx)))
  })

  it('agent without a co-signature: the transaction-level Co-signer decides ("needs a co-signature")', async () => {
    const w = await loadFixture(deployOrg)
    const tx = signCowOrderCall(w, await cowOrder(w, usdc(10)))
    const o = await preview(w, w.agent.address, tx)
    expect(o.deciding?.error?.name).to.equal('MissingCoSignature')
    if (app) expect(o.needs).to.deep.equal(['cosignature'])
    sameDecision(w, o, await execute(execModule(w, w.agent, tx)))
  })

  it('a module calling the engine configuration path: the engine rule decides', async () => {
    const w = await loadFixture(deployOrg)
    const root = '0x' + 'ab'.repeat(32)
    const tx = call(w.engineAddress, w.engine.interface.encodeFunctionData('requestConfiguration', [root]))
    const o = await preview(w, w.ops.address, tx)
    expect(o.deciding?.error?.name).to.equal('ModuleConfigurationDenied')
    sameDecision(w, o, await execute(execModule(w, w.ops, tx)))
  })

  it('ops, within policy: allowed, and it executes', async () => {
    const w = await loadFixture(deployOrg)
    const tx = tokenTransfer(w, w.vendorA.address, usdc(1))
    const o = await preview(w, w.ops.address, tx)
    expect(o.allowed).to.equal(true)
    sameDecision(w, o, await execute(execModule(w, w.ops, tx)))
  })

  it('recovery during a freeze: it only needs its schedule (recoveryStillPasses)', async () => {
    const w = await loadFixture(deployOrg)
    await w.engine.connect(w.guardian).freeze([w.safeAddress])
    const swap = await swapOwnerCall(w, w.o1.address, w.newOwner1.address)
    const o = await preview(w, w.recovery.address, swap)
    if (app) expect(app.recoveryStillPasses(o)).to.equal(true)
    expect(o.deciding?.policy).to.equal(addr(w.timelock))
    sameDecision(w, o, await execute(execModule(w, w.recovery, swap)))
  })
})
