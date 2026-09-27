import { lockVault, unlockForSession, useVaultUnlocked, vaultStore } from '../lib/vault'
import { LockIcon, UnlockIcon } from './icons'
import { Tooltip } from './Tooltip'

/**
 * Lock state of the role keys, in the tab bar. Only shown once a password is set (without one
 * the keys are plain text, which the Roles tab warns about).
 */
export function VaultLockButton() {
  const vault = vaultStore.use()
  const unlocked = useVaultUnlocked()
  if (!vault) return null

  return (
    <Tooltip
      content={
        unlocked
          ? 'Role keys are unlocked for this session. Click to lock them.'
          : 'Role keys are encrypted and locked: the password is asked to reveal a key or sign. Click to unlock.'
      }
    >
      <button
        type="button"
        className={unlocked ? 'tab tab-icon tab-unlocked' : 'tab tab-icon'}
        aria-label={unlocked ? 'Lock role keys' : 'Unlock role keys'}
        onClick={() => (unlocked ? lockVault() : unlockForSession())}
      >
        {unlocked ? <UnlockIcon /> : <LockIcon />}
      </button>
    </Tooltip>
  )
}
