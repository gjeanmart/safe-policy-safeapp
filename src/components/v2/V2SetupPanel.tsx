import { useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { describeError } from '../../lib/errors'
import {
  type Change,
  changeAttachmentId,
  detachChange,
  lint,
  mergeChanges,
  projectAttachments,
  sortForApply,
} from '../../lib/v2'
import { SafeStatus } from '../setup/SafeStatus'
import { Card, Notice } from '../ui'
import { DraftPanel } from './DraftPanel'
import { OrgChart, diffAttachments } from './OrgChart'
import { ScopeBuilder } from './ScopeBuilder'
import { readFallbackHandler } from './ownerCalls'
import { useV2, useV2Draft } from './useV2'

function V2Screens() {
  const { safe, state, v2Installed } = useSandbox()
  const view = useV2()
  const [draft, setDraft] = useV2Draft()
  const [preview, setPreview] = useState<Change[]>()
  const chartRef = useRef<HTMLDivElement>(null)
  const { deployment } = view.engine
  const handler = useAsync(() => readFallbackHandler(safe), `${safe}:handler`, 30_000)

  if (view.error !== undefined && !view.model)
    return (
      <Notice tone="bad" title="Could not read the V2 engine">
        {describeError(view.error)}
      </Notice>
    )
  if (!view.model || !state) return <Card title="Policy Engine V2">Loading…</Card>
  const model = view.model

  const isAttached = (id: Hex) => model.attachments.some((a) => a.attachmentId === id)
  // Before install, the batch detaches leftovers the draft does not keep.
  const touched = new Set(draft.map(changeAttachmentId))
  const base = v2Installed ? model.attachments : model.attachments.filter((a) => touched.has(a.attachmentId))
  const projected = projectAttachments(base, sortForApply(draft), deployment)
  const previewed = preview ? projectAttachments([], preview, deployment) : []
  const items = diffAttachments(model.attachments, projected, previewed)
  const findings = lint({
    safe,
    deployment,
    attachments: projected,
    modules: state.modules,
    ctx: view.ctx,
    cooldown: view.freezeLimits?.cooldown,
  })
  const add = (changes: Change[]) => setDraft(mergeChanges(draft, changes, isAttached))

  return (
    <>
      {!v2Installed && (
        <Notice title="V2 is not installed on this Safe yet">
          Nothing checks the owners or the modules. Build the rules below (start with the Owners template),
          then propose the install batch from the draft.
        </Notice>
      )}
      <div ref={chartRef} className="scroll-target">
        <OrgChart
          deployment={deployment}
          items={items}
          ctx={view.ctx}
          onDetach={(list) => add(list.map(detachChange))}
        />
      </div>
      <ScopeBuilder
        deployment={deployment}
        ctx={view.ctx}
        context={{ safe, attachments: projected }}
        onPreview={(changes) => {
          setPreview(changes)
          // The chart sits above the builder, out of view: bring the dashed chips to the user.
          if (changes) chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
        onAdd={add}
      />
      <DraftPanel
        deployment={deployment}
        current={model.attachments}
        draft={draft}
        setDraft={setDraft}
        findings={findings}
        ctx={view.ctx}
        handler={handler.data}
      />
    </>
  )
}

/** The V2 setup tab: Safe status, then the V2 screens if V2 is deployed here. */
export function V2SetupPanel() {
  const { v2 } = useSandbox()
  return (
    <>
      <SafeStatus />
      {v2 ? (
        <V2Screens />
      ) : (
        <Card title="Policy Engine V2">
          <Notice tone="warn" title="V2 is not deployed on this chain">
            The rev 3 entry in src/config/contracts.ts still has placeholder (zero) addresses. Run{' '}
            <code>pnpm deploy:v2:sepolia</code> in <code>contracts/</code> and paste the printed entry there.
          </Notice>
        </Card>
      )}
    </>
  )
}
