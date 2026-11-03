/**
 * # Policy Engine V2, rev 3: app data layer
 *
 * Pure TypeScript (viem only) over the rev 3 engine and policies, for the Safe App V2 screens and
 * the `safe-role` agent. Nothing here imports app config or React: read functions take a viem
 * `PublicClient`, contract addresses come from a `V2Deployment`. Normative spec:
 * `contracts/contracts/v2/SPEC.md`.
 *
 * | File             | What                                                                                  |
 * | ---------------- | ------------------------------------------------------------------------------------- |
 * | `abi.ts`         | ABIs generated from the compiled interfaces                                           |
 * | `rev3/types.ts`  | Frozen constants mirroring Types.sol / ScopeLib / Constants.sol                       |
 * | `scopes.ts`      | Scopes (6 keys, 4 human levels), keys, ids, op masks, module call hash, labels        |
 * | `policies.ts`    | `V2Deployment`, policy registry, known selectors                                      |
 * | `settings.ts`    | Encode / decode / validate per-policy settings, Args presets, labels                  |
 * | `attachments.ts` | Engine and policy reads, org-chart model                                              |
 * | `changes.ts`     | `Change[]` builders, draft merge, configure-rule validation, configure / install calls |
 * | `templates.ts`   | Owners, Ops payments, Agent CoW, Recovery, Committee                                  |
 * | `preview.ts`     | `matches` + `eth_call` of each policy's `check`: gates, reasons, deciding gate        |
 * | `lint.ts`        | ~12 configuration lint rules                                                          |
 * | `identity.ts`    | Safe tx hash, module call hash, CoSigner / Timelock / Safenet digests, direct calls   |
 * | `queue.ts`       | One Timelock queue from events, schedule status, nonce state, merge rule              |
 *
 * Typical flow in the builder:
 *
 * ```ts
 * const model = await loadSafeModel(client, deployment, safe, { modules })
 * const draft = mergeChanges([], templates.owners.build(deployment, { guardians: [g] }, context), isAttached)
 * const problems = validateChanges(model.attachments, draft, { deployment, safe })
 * const findings = lint({ safe, deployment, attachments: projectAttachments(model.attachments, draft, deployment), modules })
 * const tx = configureCall(deployment.engine, sortForApply(deployment, draft))
 * ```
 */

export * from './abi'
export * from './scopes'
export * from './policies'
export * from './settings'
export * from './attachments'
export * from './changes'
export * from './templates'
export * from './preview'
export * from './lint'
export * from './identity'
export * from './queue'
