import { useState } from 'react'
import type { Hex } from 'viem'
import { V2_ENGINES } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { describeError } from '../../lib/errors'
import {
  type AttachmentChange,
  type ChangeSet,
  type FreezeRole,
  combineChangeSets,
  detachChange,
  lint,
  mergeChange,
  projectAttachments,
} from '../../lib/v2'
import { SafeStatus } from '../setup/SafeStatus'
import { Card, Notice } from '../ui'
import { DraftPanel } from './DraftPanel'
import { Erc1271Notice } from './Erc1271Notice'
import { FreezePanel } from './FreezePanel'
import { OrgChart, diffAttachments } from './OrgChart'
import { PendingV2Configs } from './PendingV2Configs'
import { ScopeBuilder } from './ScopeBuilder'
import { TimelockQueue } from './TimelockQueue'
import { readFallbackHandler } from './ownerCalls'
import { useV2, useV2Draft } from './useV2'

/** Roles after the draft's role changes (pure). */
function projectRoles(
  roles: { guardians: readonly Hex[]; lifters: readonly Hex[] },
  changes: ChangeSet['roles'],
): { guardians: Hex[]; lifters: Hex[] } {
  const members: Record<FreezeRole, Hex[]> = { 0: [...roles.guardians], 1: [...roles.lifters] }
  for (const c of changes) {
    const list = members[c.role].filter((m) => m.toLowerCase() !== c.account.toLowerCase())
    members[c.role] = c.enabled ? [...list, c.account] : list
  }
  return { guardians: members[0], lifters: members[1] }
}

function V2Screens() {
  const { safe, state, v2Installed } = useSandbox()
  const view = useV2()
  const [draft, setDraft] = useV2Draft()
  const [preview, setPreview] = useState<AttachmentChange>()
  const { deployment } = view.engine
  const handler = useAsync(() => readFallbackHandler(safe), `${safe}:handler`, 30_000)

  if (view.error !== undefined && !view.model)
    return <Notice tone="bad">Could not read the V2 engine: {describeError(view.error)}</Notice>
  if (!view.model || !state) return <Card title="Policy Engine V2">Loading…</Card>
  const model = view.model

  const isAttached = (id: Hex) => model.attachments.some((a) => a.attachmentId === id)
  const projected = projectAttachments(model.attachments, draft.changes, deployment)
  // The builder's change, shown as a dashed chip (only when it is not already in the draft).
  const previewed = preview ? projectAttachments([], [preview], deployment) : []
  const items = diffAttachments(model.attachments, projected, previewed)
  const roles = projectRoles(model.roles, draft.roles)
  const findings = view.info
    ? lint({
        safe,
        deployment,
        attachments: projected,
        roles,
        owners: state.owners,
        modules: state.modules,
        engine: { delay: view.info.delay, maxFreeze: view.info.maxFreeze },
        fallbackHandler: v2Installed ? handler.data : undefined,
        ctx: view.ctx,
      })
    : []
  const freezes = new Map(model.actors.flatMap((a) => (a.freeze ? [[a.actor, a.freeze] as const] : [])))

  return (
    <>
      {v2Installed ? (
        <Erc1271Notice handler={handler.data} policyHandler={deployment.fallbackHandler} />
      ) : (
        <Notice>
          V2 is not installed on this Safe yet. Build the configuration below (start with the Owners
          template), then propose the install batch: configureImmediately, the PolicyFallbackHandler, the
          module guard, the guard last. Note: once installed, the owners&apos; off-chain signatures (messages,
          permits, CoW orders) are refused.
        </Notice>
      )}
      <FreezePanel
        deployment={deployment}
        info={view.info}
        model={model}
        draft={draft}
        setDraft={setDraft}
        ctx={view.ctx}
      />
      <OrgChart
        deployment={deployment}
        current={model.attachments}
        items={items}
        freezeSafe={model.freeze}
        freezes={freezes}
        guardians={model.roles.guardians}
        ctx={view.ctx}
        onDetach={(a) =>
          setDraft({ ...draft, changes: mergeChange(draft.changes, detachChange(a), isAttached) })
        }
      />
      <ScopeBuilder
        deployment={deployment}
        ctx={view.ctx}
        onPreview={setPreview}
        onAdd={(change) => setDraft({ ...draft, changes: mergeChange(draft.changes, change, isAttached) })}
        onAddSet={(set) => setDraft(combineChangeSets([draft, set], isAttached))}
      />
      <DraftPanel
        deployment={deployment}
        info={view.info}
        model={model}
        draft={draft}
        setDraft={setDraft}
        findings={findings}
        ctx={view.ctx}
      />
      {v2Installed && (
        <PendingV2Configs deployment={deployment} info={view.info} freeze={model.freeze} ctx={view.ctx} />
      )}
      {v2Installed && <TimelockQueue engine={view.engine} model={model} ctx={view.ctx} />}
    </>
  )
}

/** The V2 setup tab: Safe status, then the V2 screens if V2 is deployed here and the Safe can run it. */
export function V2SetupPanel() {
  const { v2 } = useSandbox()
  return (
    <>
      <SafeStatus />
      {v2 ? (
        <V2Screens />
      ) : (
        <Card title="Policy Engine V2">
          <Notice tone="warn">
            V2 not deployed on this chain: the {V2_ENGINES.length} engines in src/config/contracts.ts still
            have placeholder (zero) addresses. Run <code>pnpm deploy:v2:sepolia</code> in{' '}
            <code>contracts/</code> and paste the printed JSON blocks there.
          </Notice>
        </Card>
      )}
    </>
  )
}
