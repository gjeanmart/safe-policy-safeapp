import type { Address, Hash, Hex } from 'viem'
import { DEFAULT_GUARD } from '../config/contracts'
import type { Configuration } from '../lib/configurations'
import type { ConfirmedPolicy } from '../lib/policyEvents'
import { persisted } from './persisted'

/** AES-GCM ciphertext and its IV, base64-encoded (see lib/vault). */
export type Encrypted = { iv: string; data: string }

/**
 * A role is a locally generated EOA meant to be enabled as a Safe module. Its key is either
 * encrypted with the vault password (`encryptedKey`) or, before a password is set, stored in
 * plain text (`privateKey`). Never both.
 */
export type Role = {
  address: Address
  label: string
  createdAt: number
  privateKey?: Hex
  encryptedKey?: Encrypted
}

export const rolesStore = persisted<Role[]>('roles', [])

export type Settings = {
  /** Safe address used when the app runs outside Safe{Wallet}. */
  standaloneSafe?: Address
  /** Guard to install when bootstrapping (the installed one always takes precedence). */
  guard: Address
  /** Install the guard as module guard (`setModuleGuard`): policies apply to modules. Default on. */
  guardModulePath?: boolean
  /** Install the guard as transaction guard (`setGuard`): policies apply to the multisig too. */
  guardOwnerPath: boolean
}

export const settingsStore = persisted<Settings>('settings', { guard: DEFAULT_GUARD, guardOwnerPath: false })

/** Which guard slots the bootstrap batch installs; settings saved before `guardModulePath` default to on. */
export const guardPaths = (settings: Settings) => ({
  module: settings.guardModulePath ?? true,
  multisig: settings.guardOwnerPath,
})

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
  /** failed: could not run at all (gas, RPC, CoW API…), as opposed to a policy decision (denied). */
  status: 'allowed' | 'denied' | 'sent' | 'confirmed' | 'reverted' | 'failed' | 'info'
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
