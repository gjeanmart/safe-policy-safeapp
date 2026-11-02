import { useCallback, useMemo } from 'react'
import { type Address, getAddress, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { ADDRESS_BOOK, TOKENS, type V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import {
  type ChangeSet,
  type EngineInfo,
  type LabelContext,
  type SafeV2Model,
  type TokenInfo,
  deploymentNames,
  emptyChangeSet,
  loadSafeModel,
  readEngineInfo,
} from '../../lib/v2'
import { rolesStore, v2DraftStore } from '../../store'

const MODEL_REFRESH_MS = 15_000

const tokens = Object.values(TOKENS)

/**
 * Names for the V2 screens, most specific first: local roles, the Safe, its owners, the V2
 * deployment's own contracts, then the static address book; token metadata for amounts.
 */
export function useLabelContext(engine?: V2Engine): LabelContext {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  return useMemo(() => {
    const deploymentName = engine ? deploymentNames(engine.deployment) : () => undefined
    const nameOf = (address: Address): string | undefined => {
      const role = roles.find((r) => isAddressEqual(r.address, address))
      if (role) return role.label
      if (isAddressEqual(address, safe)) return 'Safe'
      const owner = state?.owners.findIndex((o) => isAddressEqual(o, address)) ?? -1
      if (owner >= 0) return `Owner ${owner + 1}`
      return deploymentName(address) ?? ADDRESS_BOOK[address.toLowerCase()]
    }
    const tokenOf = (token: Address): TokenInfo | undefined =>
      tokens.find((t) => isAddressEqual(t.address, token))
    return { nameOf, tokenOf }
  }, [engine, roles, safe, state?.owners])
}

export type V2View = {
  engine: V2Engine
  info: EngineInfo | undefined
  model: SafeV2Model | undefined
  error: unknown
  loading: boolean
  reload: () => void
  ctx: LabelContext
}

/**
 * The selected V2 engine, its immutables and the Safe's configuration as an org-chart model,
 * refreshed periodically. Only call it when `sandbox.v2` is set.
 */
export function useV2(): V2View {
  const { safe, state, v2: selected } = useSandbox()
  // Callers render the V2 screens only when an engine is deployed (V2Gate).
  const v2 = selected!
  const { engine } = v2.deployment
  const info = useAsync(() => readEngineInfo(publicClient, engine), engine)
  const modules = state?.modules ?? []
  const model = useAsync(
    () => loadSafeModel(publicClient, v2.deployment, safe, { modules }),
    `${engine}:${safe}:${modules.join(',')}`,
    MODEL_REFRESH_MS,
  )
  const ctx = useLabelContext(v2)
  const reloadModel = model.reload
  const reloadInfo = info.reload
  const reload = useCallback(() => {
    reloadModel()
    reloadInfo()
  }, [reloadModel, reloadInfo])
  return {
    engine: v2,
    info: info.data,
    model: model.data,
    error: model.error ?? info.error,
    loading: model.loading,
    reload,
    ctx,
  }
}

const draftKey = (engine: Address, safe: Address) => `${getAddress(engine)}:${getAddress(safe)}`

/** The scope builder's draft for this engine and Safe. */
export function useV2Draft(): [ChangeSet, (next: ChangeSet | ((previous: ChangeSet) => ChangeSet)) => void] {
  const { safe, v2 } = useSandbox()
  const all = v2DraftStore.use()
  const key = v2 ? draftKey(v2.deployment.engine, safe) : ''
  const draft = all[key] ?? emptyChangeSet()
  const setDraft = useCallback(
    (next: ChangeSet | ((previous: ChangeSet) => ChangeSet)) =>
      v2DraftStore.set((drafts) => {
        const previous = drafts[key] ?? emptyChangeSet()
        return { ...drafts, [key]: typeof next === 'function' ? next(previous) : next }
      }),
    [key],
  )
  return [draft, setDraft]
}
