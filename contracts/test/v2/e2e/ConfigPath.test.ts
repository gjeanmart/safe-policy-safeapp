import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { type MetaTx, safeTxHash } from '../fixtures/safe'
import {
  DELAY,
  Kind,
  OWNERS,
  Op,
  TX_INDEX,
  Verdict,
  addr,
  allow,
  attach,
  coSignatures,
  cosign,
  cosignerSettings,
  deny,
  deployWorld,
  engineCall,
  execModule,
  execOwners,
  expectError,
  expectPolicyDenied,
  install,
  policyContextTail,
  revertDataOf,
  scope,
  type Change,
  type World,
} from './world'

/**
 * Story (review M-2, SPEC §5.1, §14 D-19): a Co-signer (or Safenet, or Quorum) guarding the owners
 * used to have no say over configuration: two owners could request a root that detaches it, wait
 * DELAY and apply. Policies attached at the exact scopes of the configuration selectors,
 * `(Owners | Everyone, engine.requestConfiguration / applyConfiguration / invalidateRoot)`, now run
 * on the configuration path; nothing else does, no ALLOW is needed and a DENY there never applies,
 * so the owners can never lock themselves out unless such a policy denies forever.
 */
describe('E2E story: owner-side policies on the configuration path', () => {
  const selectorOf = (w: World, fn: 'requestConfiguration' | 'applyConfiguration' | 'invalidateRoot') =>
    w.engine.interface.getFunction(fn)!.selector
  const configScope = (w: World, fn: 'requestConfiguration' | 'applyConfiguration' | 'invalidateRoot') =>
    scope(OWNERS, w.engineAddress, selectorOf(w, fn))

  /** Allow + Co-signer at (Owners, *), and the Co-signer again at request and apply. */
  async function deploy() {
    const w = await deployWorld()
    const cosigner = (s: ReturnType<typeof scope>) =>
      attach(s, addr(w.cosignerPolicy), cosignerSettings(w.cosigner.address))
    await install(w, [
      allow(scope(OWNERS)),
      cosigner(scope(OWNERS)),
      cosigner(configScope(w, 'requestConfiguration')),
      cosigner(configScope(w, 'applyConfiguration')),
      deny(configScope(w, 'invalidateRoot')),
    ])
    return w
  }

  /** The owners' policy context with the co-signer's signature over `tx`'s Safe transaction hash. */
  const coSigned = async (w: World, tx: MetaTx) =>
    policyContextTail([
      {
        policy: addr(w.cosignerPolicy),
        data: coSignatures([[w.cosigner.address, cosign(w, await safeTxHash(w.safe, tx))]]),
      },
    ])

  /** The change the review's scenario requests: detach the owners' Co-signer. */
  const detachCosigner = (w: World): Change[] => [
    { ...attach(scope(OWNERS), addr(w.cosignerPolicy), '0x'), changeType: 1, data: '0x' },
  ]

  it('denied without the co-signature: requesting a root that detaches the Co-signer (M-2)', async () => {
    const w = await loadFixture(deploy)
    const root = await w.engine.configurationRoot(detachCosigner(w), [])
    await expectPolicyDenied(
      execOwners(w, engineCall(w, 'requestConfiguration', [root])),
      w.engine,
      w.cosignerPolicy,
      'MissingCoSignature',
      [w.cosigner.address],
      TX_INDEX,
    )
    expect(await w.engine.rootConfigured(w.safeAddress, root)).to.equal(0n)
  })

  it('co-signed: request, wait DELAY, apply (each co-signed); the Co-signer is gone', async () => {
    const w = await loadFixture(deploy)
    const changes = detachCosigner(w)
    const request = engineCall(w, 'requestConfiguration', [await w.engine.configurationRoot(changes, [])])
    await execOwners(w, request, w.quorum2, await coSigned(w, request))
    await time.increase(DELAY)
    const apply = engineCall(w, 'applyConfiguration', [changes, []])
    await expectPolicyDenied(execOwners(w, apply), w.engine, w.cosignerPolicy, 'MissingCoSignature')
    await execOwners(w, apply, w.quorum2, await coSigned(w, apply))
    const [exists] = await w.engine.getAttachment(
      w.safeAddress,
      await w.engine.attachmentId(
        await w.engine.scopeKey(scope(OWNERS)),
        Kind.POLICY,
        addr(w.cosignerPolicy),
      ),
    )
    expect(exists).to.equal(false)
  })

  it('only the exact scopes run: a Co-signer at (Owners, *) alone does not cover configuration', async () => {
    const w = await deployWorld()
    await install(w, [
      allow(scope(OWNERS)),
      attach(scope(OWNERS), addr(w.cosignerPolicy), cosignerSettings(w.cosigner.address)),
    ])
    const root = await w.engine.configurationRoot(detachCosigner(w), [])
    await execOwners(w, engineCall(w, 'requestConfiguration', [root]))
    expect(await w.engine.rootConfigured(w.safeAddress, root)).to.not.equal(0n)
  })

  it('no lock-out: no ALLOW needed, and a DENY at a configuration selector never applies', async () => {
    const w = await deployWorld()
    // No Allow at all, a DENY on invalidateRoot: configuration still works.
    await install(w, [deny(configScope(w, 'invalidateRoot'))])
    const root = await w.engine.configurationRoot([], [])
    await execOwners(w, engineCall(w, 'requestConfiguration', [root]))
    await execOwners(w, engineCall(w, 'invalidateRoot', [root]))
    expect(await w.engine.rootConfigured(w.safeAddress, root)).to.equal(0n)
  })

  it('the module path stays ModuleConfigurationDenied, whatever is attached', async () => {
    const w = await deployWorld()
    await install(
      w,
      [allow(scope(w.ops.address, w.engineAddress, selectorOf(w, 'requestConfiguration')))],
      [],
      {
        modules: [w.ops.address],
      },
    )
    await expectError(
      execModule(w, w.ops, engineCall(w, 'requestConfiguration', [await w.engine.configurationRoot([], [])])),
      w.engine,
      'ModuleConfigurationDenied',
    )
  })

  it('preview and getMatchingAttachments show the configuration path as the guard checks it', async () => {
    const w = await loadFixture(deploy)
    const request = engineCall(w, 'requestConfiguration', [await w.engine.configurationRoot([], [])])
    const matches = await w.engine.getMatchingAttachments(
      w.safeAddress,
      OWNERS,
      request.to,
      0n,
      request.data!,
      Op.CALL,
      '0x0000000000000000000000000000000000000000',
    )
    // The exact-scope Co-signer only: not the Allow, not the (Owners, *) Co-signer.
    expect(matches.map((m) => [Number(m.scopeLevel), m.attachment.policy])).to.deep.equal([
      [7, addr(w.cosignerPolicy)],
    ])
    let data = '0x'
    try {
      await w.engine.preview.staticCall(w.safeAddress, OWNERS, request.to, 0n, request.data!, Op.CALL)
    } catch (e) {
      data = revertDataOf(e) ?? '0x'
    }
    const gates = w.engine.interface.parseError(data)!.args[0] as { verdict: bigint; policy: string }[]
    expect(gates.map((g) => [Number(g.verdict), g.policy])).to.deep.equal([
      [Verdict.DENY, addr(w.cosignerPolicy)],
    ])
  })
})
