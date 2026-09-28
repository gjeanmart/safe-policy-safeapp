import { lockVault, unlockForSession, useVaultUnlocked, vaultStore } from '../lib/vault'
import { LockIcon, UnlockIcon } from './icons'
import { Tooltip } from './Tooltip'

/**
 * Lock state of the role keys, in the tab bar. Before any password exists, it offers to create
 * one (role keys are always encrypted).
 */
export function VaultLockButton() {
  const vault = vaultStore.use()
  const unlocked = useVaultUnlocked()

  return (
    <Tooltip
      content={
        !vault
          ? 'No password yet. Role keys are always encrypted: click to create the password.'
          : unlocked
            ? 'Role keys are unlocked for this session. Click to lock them.'
            : 'Role keys are encrypted and locked: the password is asked to reveal a key or sign. Click to unlock.'
      }
    >
      <button
        type="button"
        className={unlocked ? 'tab tab-icon tab-unlocked' : 'tab tab-icon'}
        aria-label={!vault ? 'Create a password' : unlocked ? 'Lock role keys' : 'Unlock role keys'}
        onClick={() => (unlocked ? lockVault() : unlockForSession())}
      >
        {unlocked ? <UnlockIcon /> : <LockIcon />}
      </button>
    </Tooltip>
  )
}
