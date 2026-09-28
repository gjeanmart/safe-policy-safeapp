import { useState } from 'react'
import { type Hex, isAddressEqual, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSandbox } from '../context'
import { useBalances } from '../hooks/useBalances'
import { formatAmount } from '../lib/format'
import { isModuleEnabled, safeTxs } from '../lib/safe'
import { parsePrivateKeyInput } from '../lib/validation'
import {
  UNLOCK_CANCELLED,
  protectKey,
  revealKey,
  unlockForSession,
  useVaultUnlocked,
  vaultStore,
} from '../lib/vault'
import { type Role, rolesStore } from '../store'
import { ConfirmIconButton } from './ConfirmIconButton'
import { EyeIcon, EyeOffIcon } from './icons'
import { ProposeButton } from './ProposeButton'
import { SafeStatus } from './setup/SafeStatus'
import { RefreshButton } from './RefreshButton'
import { Tooltip } from './Tooltip'
import { AddressView, AsyncButton, Badge, Card, CopyButton, Notice } from './ui'

const TOP_UP = parseEther('0.01')

async function addRole(label: string, privateKey: Hex) {
  const { address } = privateKeyToAccount(privateKey)
  const key = await protectKey(privateKey)
  rolesStore.set((roles) =>
    roles.some((r) => isAddressEqual(r.address, address))
      ? roles
      : [...roles, { address, ...key, label: label || `Role ${roles.length + 1}`, createdAt: Date.now() }],
  )
}

/**
 * Keys created before passwords were required are still plain text: offer to encrypt them.
 * Nothing is shown otherwise (new keys are always encrypted).
 */
function LegacyKeysNotice() {
  const vault = vaultStore.use()
  const plain = rolesStore.use().filter((r) => r.privateKey).length
  if (vault || plain === 0) return null
  return (
    <Notice tone="warn">
      <div className="row wrap notice-row">
        <span>
          {plain} role key{plain > 1 ? 's' : ''} from before passwords were required{' '}
          {plain > 1 ? 'are' : 'is'} stored <strong>unencrypted</strong>.
        </span>
        <AsyncButton onClick={unlockForSession}>Create a password</AsyncButton>
      </div>
    </Notice>
  )
}

export function RolesPanel() {
  const roles = rolesStore.use()
  const { state, reloadState } = useSandbox()
  const balances = useBalances(roles.map((r) => r.address))
  const [label, setLabel] = useState('')
  const [importKey, setImportKey] = useState('')
  const [importError, setImportError] = useState<string>()

  return (
    <>
      <SafeStatus />

      <Card
        title="Roles (EOAs to plug as modules)"
        actions={
          <RefreshButton
            title="Refresh balances and module status"
            busy={balances.loading}
            onClick={() => {
              balances.reload()
              reloadState()
            }}
          />
        }
      >
        <LegacyKeysNotice />
        <div className="row wrap">
          <input
            placeholder="Label, e.g. Trader bot"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Tooltip content="Create a new EOA with a random private key, stored in this browser">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                await addRole(label, generatePrivateKey()).catch(() => undefined)
                setLabel('')
              }}
            >
              Generate role
            </button>
          </Tooltip>
          <input
            placeholder="…or import a private key (0x…)"
            // Masked and kept out of autofill / spellcheck services.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={importKey}
            onChange={(e) => {
              setImportKey(e.target.value.trim())
              setImportError(undefined)
            }}
            className={importError ? 'grow input-invalid' : 'grow'}
            aria-invalid={importError !== undefined}
          />
          <Tooltip content="Add an existing EOA from its private key (e.g. a role created in another browser/origin)">
            <button
              type="button"
              className="btn"
              disabled={!importKey}
              onClick={() => {
                const parsed = parsePrivateKeyInput(importKey)
                if (!parsed.ok) return setImportError(parsed.error)
                const { address } = privateKeyToAccount(parsed.value)
                if (roles.some((r) => isAddressEqual(r.address, address))) {
                  return setImportError('This key is already imported (' + address + ').')
                }
                addRole(label, parsed.value)
                  .then(() => setImportKey(''))
                  .catch(
                    (error: Error) => error.message !== UNLOCK_CANCELLED && setImportError(error.message),
                  )
              }}
            >
              Import
            </button>
          </Tooltip>
        </div>
        {importError && <p className="field-error">{importError}</p>}

        {roles.length === 0 ? (
          <p className="muted">
            No roles yet. Generate one, fund it with a little Sepolia ETH for gas, then enable it.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="roles-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Gas balance</th>
                  <th>Module</th>
                  <th colSpan={4}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <RoleRow
                    key={role.address}
                    role={role}
                    eth={balances.data?.[role.address]?.eth}
                    enabled={state ? isModuleEnabled(state, role.address) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

function RoleRow({ role, eth, enabled }: { role: Role; eth?: bigint; enabled?: boolean }) {
  const { safe, state } = useSandbox()
  const [revealed, setRevealed] = useState<Hex>()
  const [revealError, setRevealError] = useState<string>()
  const unlocked = useVaultUnlocked()
  const key = role.privateKey ?? (unlocked ? revealed : undefined)
  const showKey = key !== undefined && revealed !== undefined

  const toggleKey = async () => {
    setRevealError(undefined)
    if (showKey) return setRevealed(undefined)
    try {
      setRevealed(await revealKey(role, `Enter your password to reveal the key of ${role.label}.`))
    } catch (error) {
      if ((error as Error).message !== UNLOCK_CANCELLED) setRevealError((error as Error).message)
    }
  }

  return (
    <tr>
      <td>
        <div>
          <strong>{role.label}</strong>
        </div>
        <AddressView address={role.address} name="" full />
        {showKey && key && (
          // Truncated so the revealed key never widens the column; copy still yields the full key.
          <div className="secret">
            <span className="secret-label">Private key</span>
            <span className="mono">
              {key.slice(0, 10)}…{key.slice(-8)}
            </span>
            <CopyButton value={key} />
          </div>
        )}
        {revealError && <div className="field-error">{revealError}</div>}
      </td>
      <td className="nowrap">
        {eth === undefined ? '…' : `${formatAmount(eth, 18)} ETH`}{' '}
        {eth === 0n && <Badge tone="warn">needs gas</Badge>}
      </td>
      <td>
        {enabled === undefined ? (
          '…'
        ) : enabled ? (
          <Badge tone="ok">enabled</Badge>
        ) : (
          <Badge>not enabled</Badge>
        )}
      </td>
      {/* One cell per action so buttons line up across rows. */}
      <td>
        {state &&
          (enabled ? (
            <ProposeButton
              label="Disable module"
              title="Propose disableModule: the role can no longer call execTransactionFromModule"
              variant="secondary"
              preview={false}
              txs={[safeTxs.disableModule(state, role.address)]}
            />
          ) : (
            <ProposeButton
              label="Enable as module"
              title="Propose enableModule: the role can then call execTransactionFromModule, within the policies"
              variant="secondary"
              preview={false}
              txs={[safeTxs.enableModule(safe, role.address)]}
            />
          ))}
      </td>
      <td>
        <ProposeButton
          label="Top up 0.01 ETH from Safe"
          title="Propose a 0.01 ETH transfer from the Safe to this role, to pay for gas"
          variant="secondary"
          preview={false}
          txs={[safeTxs.sendEth(role.address, TOP_UP)]}
        />
      </td>
      <td>
        <button
          type="button"
          className="link icon"
          aria-label={showKey ? 'Hide key' : 'Show key'}
          onClick={toggleKey}
        >
          {showKey ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </td>
      <td>
        <ConfirmIconButton
          title="Delete this role's key from the browser. It stays enabled as a module until disabled."
          onConfirm={() => rolesStore.set((roles) => roles.filter((r) => r.address !== role.address))}
        />
      </td>
    </tr>
  )
}
