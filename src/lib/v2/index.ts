/**
 * # Policy Engine V2: app data layer
 *
 * Pure TypeScript (viem only) over the V2 engine and policies, for the Safe App V2 screens (WP9)
 * and the `safe-role` agent (WP10). Nothing here imports app config or React: read functions take
 * a viem `PublicClient`, and contract addresses come from a `V2Deployment`. The normative spec is
 * `contracts/contracts/v2/SPEC.md`; section numbers below refer to it.
 *
 * | File             | What                                                                                   |
 * | ---------------- | -------------------------------------------------------------------------------------- |
 * | `abi.ts`         | Generated ABIs (frozen, WP0)                                                           |
 * | `scopes.ts`      | Sentinels, enums, levels, scope keys, attachment ids, config root, labels (§2–3, WP0)  |
 * | `policies.ts`    | `V2Deployment`, policy registry (name → level, ABI, label), known selectors            |
 * | `settings.ts`    | Encode / decode / validate per-policy settings (§8), chip labels                       |
 * | `attachments.ts` | Engine enumeration views → org-chart model (Everyone band + actor cards), freeze state |
 * | `changes.ts`     | AttachmentChange / RoleChange builders, draft merge, local apply checks, root,         |
 * |                  | request / apply / invalidate / freeze calldata, MultiSend batching, sentences (§5)     |
 * | `templates.ts`   | Ready-made set-ups (owners timelock, ops payments, agent, recovery, freeze, ...)       |
 * | `preview.ts`     | `preview` call + `Preview(gates)` decoding, reasons, needs, deciding gate (§6.7)       |
 * | `lint.ts`        | Configuration lint rules (PLAN §5), `block` / `warn`                                   |
 * | `identity.ts`    | Safe tx hash, module callHash, proof digests, Timelock / Co-signer / Safenet calls (§7) |
 *
 * Typical flow in the builder:
 *
 * ```ts
 * const model = await loadSafeModel(client, deployment, safe, { modules })
 * const set = combineChangeSets([draft, templates.opsPayments.build(deployment, params)], (id) =>
 *   model.attachments.some((a) => a.attachmentId === id),
 * )
 * const next = projectAttachments(model.attachments, set.changes, deployment)
 * const problems = validateChangeSet(model.attachments, set, { deployment, delay, roles: model.roles })
 * const findings = lint({ safe, deployment, attachments: next, roles: model.roles, owners, modules, engine })
 * const request = engineCalls.requestConfiguration(deployment.engine, changeSetRoot(set))
 * ```
 *
 * The app has no unit test runner; functions are pure where possible and carry worked examples in
 * their JSDoc.
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
