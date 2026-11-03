import type { Address, Hash, Hex } from 'viem'
import { DEFAULT_GUARD } from '../config/contracts'
import type { Configuration } from '../lib/configurations'
import type { ConfirmedPolicy } from '../lib/policyEvents'
import type { Change } from '../lib/v2/changes'
import type { SafeTransaction } from '../lib/v2/identity'
import { persisted } from './persisted'

/** AES-GCM ciphertext and its IV, base64-encoded (see lib/vault). */
export type Encrypted = { iv: string; data: string }

/**
 * What a role is, which decides how it acts:
 * - `eoa`: a local key signs and sends execTransactionFromModule (default, and roles saved before
 *   kinds existed).
 * - `safe`: another Safe is the module; it acts through its own transactions (nested call).
 * - `contract`: any other contract; the app can only simulate its calls.
 * - `relayer`: a local key that only pays gas to send what others signed (schedule, execute,
 *   cancel). Never a module nor a signer, so it gains no power from the key being in a browser.
 *
 * A local key is either encrypted with the vault password (`encryptedKey`) or, before a password
 * is set, stored in plain text (`privateKey`). Never both.
 */
export type RoleKind = 'eoa' | 'safe' | 'contract' | 'relayer'

export type Role = {
  kind?: RoleKind
  address: Address
  label: string
  createdAt: number
  privateKey?: Hex
  encryptedKey?: Encrypted
}

export const roleKind = (role: Role): RoleKind => role.kind ?? 'eoa'

/** A key held in this browser that can send transactions (an EOA role or a relayer). */
export const hasLocalKey = (role: Role) => roleKind(role) === 'eoa' || roleKind(role) === 'relayer'

/** Roles that can be an actor (module) or a signer: everything but relayers. */
export const canAct = (role: Role) => roleKind(role) !== 'relayer'

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
  /** Engine to set up when no guard is installed yet (an installed guard always decides). */
  engineVersion?: 'v1' | 'v2'
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

/**
 * V2 draft: the configuration changes being assembled in the scope builder, per engine and Safe
 * (rev 3 shape; the key changed with it so rev 2 drafts are not read back).
 */
export const v2DraftStore = persisted<Record<string, Change[]>>('v2-draft-rev3', {})

/**
 * Owner transactions scheduled from this browser with locally collected signatures, by Safe
 * transaction hash, so they can be executed (relayed) once the Timelock has passed.
 */
export type V2OwnerTx = {
  safe: Address
  engine: Address
  tx: SafeTransaction
  signatures: Hex
}

export const v2OwnerTxStore = persisted<Record<string, V2OwnerTx>>('v2-owner-txs', {})

/**
 * Owner transactions this app proposed in Safe{Wallet} (or that were added by hash), per Safe
 * (lowercase address): the Queue follows each one from signatures to execution.
 */
export type TrackedOwnerTx = {
  hash: Hex
  label?: string
  addedAt: number
  /** Executed by a relayer from this app (Safe{Wallet} reports it too, when the app runs inside it). */
  executed?: boolean
}

export const v2TrackedStore = persisted<Record<string, TrackedOwnerTx[]>>('v2-tracked', {})

export const trackOwnerTx = (safe: Address, hash: Hex, label?: string) =>
  v2TrackedStore.set((all) => {
    const key = safe.toLowerCase()
    const list = all[key] ?? []
    if (list.some((t) => t.hash.toLowerCase() === hash.toLowerCase())) return all
    return { ...all, [key]: [{ hash, label, addedAt: Date.now() }, ...list] }
  })

export const untrackOwnerTx = (safe: Address, hash: Hex) =>
  v2TrackedStore.set((all) => {
    const key = safe.toLowerCase()
    return { ...all, [key]: (all[key] ?? []).filter((t) => t.hash.toLowerCase() !== hash.toLowerCase()) }
  })

export const markOwnerTxExecuted = (safe: Address, hash: Hex) =>
  v2TrackedStore.set((all) => {
    const key = safe.toLowerCase()
    const list = all[key] ?? []
    return {
      ...all,
      [key]: list.map((t) => (t.hash.toLowerCase() === hash.toLowerCase() ? { ...t, executed: true } : t)),
    }
  })

/** Who relays (pays gas) and whether fully signed tracked transactions are scheduled on sight. */
export type RelaySettings = { relayer?: Address; autoSchedule: boolean }

export const relayStore = persisted<RelaySettings>('v2-relay', { autoSchedule: false })
