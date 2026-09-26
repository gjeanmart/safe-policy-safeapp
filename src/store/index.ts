import type { Address, Hash, Hex } from 'viem'
import { DEFAULT_GUARD } from '../config/contracts'
import type { Configuration } from '../lib/configurations'
import type { ConfirmedPolicy } from '../lib/policyEvents'
import { persisted } from './persisted'

/**
 * A role is a locally generated EOA meant to be enabled as a Safe module.
 * PoC only: the private key lives in plain localStorage.
 */
export type Role = { address: Address; privateKey: Hex; label: string; createdAt: number }

export const rolesStore = persisted<Role[]>('roles', [])

export type Settings = {
  /** Safe address used when the app runs outside Safe{Wallet}. */
  standaloneSafe?: Address
  /** Guard to install when bootstrapping (the installed one always takes precedence). */
  guard: Address
  /** Also install the guard as transaction guard, i.e. policies apply to owners too. */
  guardOwnerPath: boolean
}

export const settingsStore = persisted<Settings>('settings', { guard: DEFAULT_GUARD, guardOwnerPath: false })

/**
 * A configuration set whose root was (or is about to be) requested. The guard only stores the
 * root, so the full list must be kept to call `applyConfiguration` later.
 */
export type PendingConfiguration = {
  root: Hex
  safe: Address
  guard: Address
  configurations: Configuration[]
  createdAt: number
}

export const pendingStore = persisted<PendingConfiguration[]>('pending', [])

/** Draft configuration being assembled in the policy builder. */
export const draftStore = persisted<Configuration[]>('draft', [])

/** How an action was run; shown as a tag in the activity log. */
export type ActivityMode = 'simulate' | 'execute' | 'force'

export type Activity = {
  id: string
  at: number
  role: Address
  /** Optional: entries logged before this field existed carry the mode as a label prefix. */
  mode?: ActivityMode
  label: string
  status: 'allowed' | 'denied' | 'sent' | 'confirmed' | 'reverted' | 'info'
  detail?: string
  txHash?: Hash
  link?: string
}

export const activityStore = persisted<Activity[]>('activity', [])

export const logActivity = (entry: Omit<Activity, 'id' | 'at'>): string => {
  const id = crypto.randomUUID()
  activityStore.set((list) => [{ ...entry, id, at: Date.now() }, ...list].slice(0, 100))
  return id
}

export const updateActivity = (id: string, patch: Partial<Activity>) =>
  activityStore.set((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)))

/** Cached `PolicyConfirmed` history per `guard:safe`, with the last scanned block. */
export type PolicyHistory = { events: ConfirmedPolicy[]; scannedTo: string }

export const policyHistoryStore = persisted<Record<string, PolicyHistory>>('policy-history', {})

export const historyKey = (guard: Address, safe: Address) => `${guard.toLowerCase()}:${safe.toLowerCase()}`
