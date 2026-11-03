import { useCallback, useMemo } from 'react'
import { type Address, getAddress, isAddressEqual } from 'viem'
import { publicClient } from '../../config/client'
import { ADDRESS_BOOK, TOKENS, type V2Engine } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import {
  type Change,
  type LabelContext,
  type SafeV2Model,
  type TokenInfo,
  deploymentNames,
  loadSafeModel,
  readFreezeLimits,
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
  model: SafeV2Model | undefined
  /** TimelockPolicy F and C. */
  freezeLimits: { maxFreeze: bigint; cooldown: bigint } | undefined
  error: unknown
  reload: () => void
  ctx: LabelContext
}

/** The V2 engine and the Safe's configuration as an org-chart model. Only call it when `sandbox.v2` is set. */
export function useV2(): V2View {
  const { safe, state, v2: selected } = useSandbox()
  const v2 = selected!
  const { deployment } = v2
  const modules = state?.modules ?? []
  const model = useAsync(
    () => loadSafeModel(publicClient, deployment, safe, { modules }),
    `${deployment.engine}:${safe}:${modules.join(',')}`,
    MODEL_REFRESH_MS,
  )
  const limits = useAsync(() => readFreezeLimits(publicClient, deployment), deployment.policies.timelock)
  const ctx = useLabelContext(v2)
  return {
    engine: v2,
    model: model.data,
    freezeLimits: limits.data,
    error: model.error,
    reload: model.reload,
    ctx,
  }
}

const draftKey = (engine: Address, safe: Address) => `${getAddress(engine)}:${getAddress(safe)}`

/** The scope builder's draft for this engine and Safe. */
export function useV2Draft(): [Change[], (next: Change[] | ((previous: Change[]) => Change[])) => void] {
  const { safe, v2 } = useSandbox()
  const all = v2DraftStore.use()
  const key = v2 ? draftKey(v2.deployment.engine, safe) : ''
  const draft = all[key] ?? []
  const setDraft = useCallback(
    (next: Change[] | ((previous: Change[]) => Change[])) =>
      v2DraftStore.set((drafts) => {
        const previous = drafts[key] ?? []
        return { ...drafts, [key]: typeof next === 'function' ? next(previous) : next }
      }),
    [key],
  )
  return [draft, setDraft]
}
