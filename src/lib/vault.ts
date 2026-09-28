import type { Hex } from 'viem'
import { type Encrypted, type Role, rolesStore } from '../store'
import { ephemeral, persisted } from '../store/persisted'

/**
 * Password protection for role keys, with the browser's Web Crypto only:
 * PBKDF2-SHA-256 derives an AES-GCM key from the password, and each role key is encrypted with it.
 * The derived key is non-extractable and kept in memory for the session (until reload or lock).
 *
 * PoC hardening: it protects keys at rest in localStorage, not against code running in the page.
 */

/** OWASP (2023) recommendation for PBKDF2-HMAC-SHA256. */
const ITERATIONS = 600_000
const CHECK_PLAINTEXT = 'safe-policy-sandbox vault v1'

/** Salt plus an encrypted known value, used to tell a wrong password apart. */
export type VaultMeta = { salt: string; check: Encrypted }

export const vaultStore = persisted<VaultMeta | undefined>('vault', undefined)

/** The unlocked session key; `undefined` while locked. */
const sessionKeyStore = ephemeral<CryptoKey | undefined>(undefined)

export const useVaultUnlocked = () => sessionKeyStore.use() !== undefined
export const isVaultEnabled = () => vaultStore.get() !== undefined

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<Encrypted> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
}

async function decrypt(key: CryptoKey, { iv, data }: Encrypted): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) as BufferSource },
    key,
    fromBase64(data) as BufferSource,
  )
  return new TextDecoder().decode(plaintext)
}

export const MIN_PASSWORD_LENGTH = 8

/** Creates the vault and encrypts every plain-text role key with it. */
export async function enableVault(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt)
  const roles = await Promise.all(
    rolesStore.get().map(async (role): Promise<Role> => {
      if (!role.privateKey) return role
      const { privateKey, ...rest } = role
      return { ...rest, encryptedKey: await encrypt(key, privateKey) }
    }),
  )
  vaultStore.set({ salt: toBase64(salt), check: await encrypt(key, CHECK_PLAINTEXT) })
  rolesStore.set(roles)
  sessionKeyStore.set(key)
}

/**
 * Re-encrypts every role key under a new password (and a fresh salt). All keys are decrypted and
 * re-encrypted first, then saved together, so a failure leaves the old password in place.
 */
export async function changeVaultPassword(current: string, next: string): Promise<void> {
  const meta = vaultStore.get()
  if (!meta) throw new Error('No password is set.')
  if (next.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  const oldKey = await deriveKey(current, fromBase64(meta.salt))
  try {
    if ((await decrypt(oldKey, meta.check)) !== CHECK_PLAINTEXT) throw new Error()
  } catch {
    throw new Error('The current password is wrong.')
  }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const newKey = await deriveKey(next, salt)
  const roles = await Promise.all(
    rolesStore.get().map(async (role): Promise<Role> => {
      // Plain-text keys from before passwords were required get encrypted on the way.
      const privateKey = role.encryptedKey ? await decrypt(oldKey, role.encryptedKey) : role.privateKey
      if (!privateKey) return role
      return { ...role, privateKey: undefined, encryptedKey: await encrypt(newKey, privateKey) }
    }),
  )
  const check = await encrypt(newKey, CHECK_PLAINTEXT)
  rolesStore.set(roles)
  vaultStore.set({ salt: toBase64(salt), check })
  sessionKeyStore.set(newKey)
}

export async function unlockVault(password: string): Promise<void> {
  const meta = vaultStore.get()
  if (!meta) throw new Error('No password is set.')
  const key = await deriveKey(password, fromBase64(meta.salt))
  try {
    if ((await decrypt(key, meta.check)) !== CHECK_PLAINTEXT) throw new Error()
  } catch {
    throw new Error('Wrong password.')
  }
  sessionKeyStore.set(key)
}

export const lockVault = () => sessionKeyStore.set(undefined)

/**
 * A pending "enter your password" request, answered by the UnlockDialog. Lets any action that
 * needs a key (reveal, sign) ask for the password inline instead of failing.
 */
export type UnlockRequest = { reason: string; resolve: () => void; reject: (error: Error) => void }
export const unlockRequestStore = ephemeral<UnlockRequest | undefined>(undefined)

/** Rejection message when the user closes the unlock / create-password dialog. */
export const UNLOCK_CANCELLED = 'Unlock cancelled.'

/**
 * A pending "create a password" request, answered by the SetPasswordDialog. Role keys are always
 * encrypted, so the first action that needs one (adding a role, the lock icon) creates the vault.
 */
export type SetupRequest = { reason: string; resolve: () => void; reject: (error: Error) => void }
export const setupRequestStore = ephemeral<SetupRequest | undefined>(undefined)

/** Asks the user to create the vault password; resolves once it is set (and unlocked). */
export const requestPasswordSetup = (reason: string) =>
  new Promise<void>((resolve, reject) => setupRequestStore.set({ reason, resolve, reject }))

async function ensureUnlocked(reason: string, setupReason = reason): Promise<CryptoKey> {
  const current = sessionKeyStore.get()
  if (current) return current
  if (!isVaultEnabled()) await requestPasswordSetup(setupReason)
  else await new Promise<void>((resolve, reject) => unlockRequestStore.set({ reason, resolve, reject }))
  const key = sessionKeyStore.get()
  if (!key) throw new Error('The vault is locked.')
  return key
}

/** Unlocks without a pending action (the "Unlock" button); cancelling is not an error there. */
export async function unlockForSession(): Promise<void> {
  try {
    await ensureUnlocked(
      'Unlock your role keys for this session.',
      'Role keys are always encrypted in this browser. Create the password that protects them.',
    )
  } catch (error) {
    if ((error as Error).message !== UNLOCK_CANCELLED) throw error
  }
}

/** Encrypts a new role key, creating the password first if there is none yet. */
export async function protectKey(privateKey: Hex): Promise<Pick<Role, 'encryptedKey'>> {
  const key = await ensureUnlocked(
    'Enter your password to add a role.',
    'Role keys are always encrypted in this browser. Create a password to add your first role.',
  )
  return { encryptedKey: await encrypt(key, privateKey) }
}

/** The role's private key, asking for the password first if the vault is locked. */
export async function revealKey(role: Role, reason: string): Promise<Hex> {
  if (role.privateKey) return role.privateKey
  if (!role.encryptedKey) throw new Error(`No key stored for ${role.label}.`)
  const key = await ensureUnlocked(reason)
  return (await decrypt(key, role.encryptedKey)) as Hex
}
