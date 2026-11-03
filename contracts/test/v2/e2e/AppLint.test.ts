import { expect } from 'chai'
import { Wallet, getAddress } from 'ethers'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * The app's lint, templates and Timelock status (`src/lib/v2`) for the review fixes of batch B:
 * the configuration path (D-19), raw message approvals (D-22), contracts that trust the Safe
 * (review L-6), 6 attachments per scope (D-26), re-configured Timelocks (D-20). The app lib is ESM
 * TypeScript in the root package, transpiled to CommonJS into the gitignored `contracts/cache` at
 * load time (as `Preview.test.ts`); skipped when the root dependencies (viem) are not installed.
 */

type Hex = `0x${string}`
type Scope = { actor: string; to: string; selector: Hex; callMatch: number }
type Change = { scope: Scope; kind: number; policy: string; opMask: number; data: Hex; changeType: number }
type Finding = { rule: string; severity: 'block' | 'warn'; message: string }
type Deployment = {
  engine: string
  signLib: string
  fallbackHandler: string
  trustedBatches: string[]
  policies: Record<string, string>
}
type App = {
  lint: {
    lint: (input: Record<string, unknown>) => Finding[]
  }
  changes: {
    allowChange: (scope: Scope, opMask?: number) => Change
    denyChange: (scope: Scope, opMask?: number) => Change
    policyChange: (deployment: Deployment, scope: Scope, value: unknown, opMask?: number) => Change
    projectAttachments: (current: unknown[], changes: Change[], deployment: Deployment) => unknown[]
    validateChangeSet: (
      current: unknown[],
      set: { changes: Change[]; roles: unknown[] },
      context: Record<string, unknown>,
    ) => { message: string }[]
    describeChange: (change: Change, deployment: Deployment, ctx: unknown, attached: boolean) => string
  }
  templates: {
    templates: Record<string, { build: (d: Deployment, p: Record<string, unknown>) => { changes: Change[] } }>
  }
  identity: {
    scheduleStatus: (
      s: { scheduledAt: bigint; epoch: bigint; frozenAtSchedule: boolean },
      current: Record<string, unknown>,
    ) => { status: string; readyAt: bigint; expiresAt?: bigint }
  }
  policies: { SELECTORS: Record<string, Hex>; AUTHORITY_TARGETS: { address: string; name: string }[] }
}

const APP_LIB = path.resolve(__dirname, '../../../../src/lib/v2')

function loadApp(): App | undefined {
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
  const load = (name: string) => require(path.join(out, `${name}.js`))
  return {
    lint: load('lint'),
    changes: load('changes'),
    templates: load('templates'),
    identity: load('identity'),
    policies: load('policies'),
  }
}

const app = loadApp()
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const ANY = getAddress('0x0000000000000000000000000000000000000000')
const random = () => getAddress(Wallet.createRandom().address)

describe('App lint and templates for the batch B review fixes (src/lib/v2)', function () {
  before(function () {
    if (!app) this.skip()
  })

  const deployment: Deployment = {
    engine: random(),
    signLib: random(),
    fallbackHandler: random(),
    trustedBatches: [random()],
    policies: Object.fromEntries(
      ['freeze', 'timelock', 'recipients', 'limit', 'args', 'coSigner', 'safenet', 'quorum'].map((n) => [
        n,
        random(),
      ]),
    ),
  }
  const safe = random()
  const agent = random()
  const otherModule = random()
  const anyCall = (actor: string): Scope => ({ actor, to: ANY, selector: '0x00000000', callMatch: 0 })
  const onContract = (actor: string, to: string): Scope => ({
    actor,
    to,
    selector: '0x00000000',
    callMatch: 1,
  })
  const exact = (actor: string, to: string, selector: Hex): Scope => ({ actor, to, selector, callMatch: 3 })

  function findings(changes: Change[]): Finding[] {
    const { lint } = app!.lint
    return lint({
      safe,
      deployment,
      attachments: app!.changes.projectAttachments([], changes, deployment),
      roles: { guardians: [], lifters: [] },
      owners: [],
      modules: [agent, otherModule],
      engine: { delay: 86_400n, maxFreeze: 7n * 86_400n },
    })
  }
  const rules = (list: Finding[]) => list.map((f) => `${f.rule}:${f.severity}`)

  describe('configuration path (D-19)', () => {
    it('warns when a Co-signer guards the owners but not their configuration', () => {
      const { allowChange, policyChange } = app!.changes
      const sel = app!.policies.SELECTORS
      const cosigner = (scope: Scope) =>
        policyChange(deployment, scope, { policy: 'coSigner', settings: { cosigner: random() } })
      const base = [allowChange(anyCall(OWNERS)), cosigner(anyCall(OWNERS))]
      expect(rules(findings(base))).to.include('config-path-unprotected:warn')
      const covered = [
        ...base,
        cosigner(exact(OWNERS, deployment.engine, sel.requestConfiguration)),
        cosigner(exact(OWNERS, deployment.engine, sel.applyConfiguration)),
      ]
      expect(rules(findings(covered))).to.not.include('config-path-unprotected:warn')
    })

    it('the Quorum template covers the configuration selectors, and lints clean on them', () => {
      const set = app!.templates.templates.quorumLargeTransfers.build(deployment, { required: 3, tiers: [] })
      const sel = app!.policies.SELECTORS
      expect(set.changes.map((c) => [c.scope.callMatch, c.scope.to, c.scope.selector])).to.deep.equal([
        [0, ANY, '0x00000000'],
        [3, deployment.engine, sel.requestConfiguration],
        [3, deployment.engine, sel.applyConfiguration],
      ])
      const list = rules(findings([app!.changes.allowChange(anyCall(OWNERS)), ...set.changes]))
      expect(list).to.not.include('config-path-unprotected:warn')
      expect(list).to.not.include('global-policy:block')
    })

    it('blocks a Freeze and flags a Deny at a configuration selector', () => {
      const { denyChange, policyChange } = app!.changes
      const scope = exact(OWNERS, deployment.engine, app!.policies.SELECTORS.applyConfiguration)
      const list = rules(
        findings([
          policyChange(deployment, scope, { policy: 'freeze', settings: { safeWide: true, actor: false } }),
          denyChange(exact(OWNERS, deployment.engine, app!.policies.SELECTORS.invalidateRoot)),
        ]),
      )
      expect(list).to.include('config-path-freeze:block')
      expect(list).to.include('config-path-deny:warn')
    })
  })

  describe('raw message approvals (D-22)', () => {
    it("blocks a module's Allow that reaches PolicySignLib.signMessage; the typed entries stay fine", () => {
      const { allowChange } = app!.changes
      const sel = app!.policies.SELECTORS
      for (const scope of [
        onContract(agent, deployment.signLib),
        exact(agent, deployment.signLib, sel.signMessage),
        { actor: agent, to: ANY, selector: sel.signMessage, callMatch: 2 },
      ])
        expect(rules(findings([allowChange(scope)]))).to.include('raw-message-approval:block')
      expect(
        rules(findings([allowChange(exact(agent, deployment.signLib, sel.signCowOrder))])),
      ).to.not.include('raw-message-approval:block')
    })

    it("warns that the owners' budget does not see their raw approvals", () => {
      const { allowChange, policyChange } = app!.changes
      const limit = policyChange(deployment, anyCall(OWNERS), {
        policy: 'limit',
        settings: { limits: [{ token: random(), amount: 1n, period: 0n }], passUnpriced: true },
      })
      expect(rules(findings([allowChange(anyCall(OWNERS)), limit]))).to.include('raw-message-approval:warn')
      expect(rules(findings([allowChange(anyCall(OWNERS))]))).to.not.include('raw-message-approval:warn')
    })
  })

  describe('contracts that trust the Safe (review L-6)', () => {
    it('warns on a module Allow over all of Permit2, GPv2Settlement or another module', () => {
      const { allowChange } = app!.changes
      const [permit2, settlement] = app!.policies.AUTHORITY_TARGETS.map((t) => t.address)
      for (const to of [permit2, settlement, otherModule])
        expect(rules(findings([allowChange(onContract(agent, to))]))).to.include(
          'authority-target-allow:warn',
        )
      expect(rules(findings([allowChange(onContract(agent, random()))]))).to.not.include(
        'authority-target-allow:warn',
      )
      expect(rules(findings([allowChange(onContract(OWNERS, permit2))]))).to.not.include(
        'authority-target-allow:warn',
      )
    })
  })

  it('6 attachments per scope (D-26): the draft validation refuses the 7th', () => {
    const { allowChange, policyChange, validateChangeSet } = app!.changes
    const scope = anyCall(agent)
    const changes = [
      allowChange(scope),
      ...['freeze', 'timelock', 'limit', 'coSigner', 'safenet'].map((policy) =>
        policyChange(deployment, scope, {
          policy,
          settings: {
            freeze: { safeWide: true, actor: true },
            timelock: { delay: 60, window: 0, clearOnFreeze: false, cancellers: [] },
            limit: { limits: [{ token: random(), amount: 1n, period: 0n }], passUnpriced: false },
            coSigner: { cosigner: random() },
            safenet: {},
          }[policy],
        }),
      ),
    ]
    const context = { deployment, delay: 86_400n, roles: { guardians: [], lifters: [] } }
    expect(validateChangeSet([], { changes, roles: [] }, context)).to.deep.equal([])
    const seventh = policyChange(deployment, scope, {
      policy: 'recipients',
      settings: { recipients: [], spenders: [], maxApproval: 0n, strict: false },
    })
    expect(
      validateChangeSet([], { changes: [...changes, seventh], roles: [] }, context).map((p) => p.message),
    ).to.deep.equal(['At most 6 attachments per scope'])
  })

  it('a re-configured Timelock: the draft says pending calls wait again, the queue counts from it (D-20)', () => {
    const { policyChange, describeChange } = app!.changes
    const change = policyChange(deployment, anyCall(agent), {
      policy: 'timelock',
      settings: { delay: 3600, window: 0, clearOnFreeze: false, cancellers: [] },
    })
    expect(describeChange(change, deployment, {}, true)).to.match(/wait the full delay again/)
    const status = app!.identity.scheduleStatus(
      { scheduledAt: 1_000n, epoch: 0n, frozenAtSchedule: false },
      { now: 5_000n, delay: 3_600n, window: 0n, clearOnFreeze: false, freezeEpoch: 0n, configuredAt: 4_000n },
    )
    expect(status).to.deep.include({ status: 'waiting', readyAt: 7_600n })
  })
})
