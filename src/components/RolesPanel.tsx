import { useState } from 'react'
import { type Hex, parseEther } from 'viem'
import { useSandbox } from '../context'
import { useAsync } from '../hooks/useAsync'
import { useBalances } from '../hooks/useBalances'
import { formatAmount } from '../lib/format'
import { isModuleEnabled, safeTxs } from '../lib/safe'
import { type Executor, resolveExecutor } from '../lib/roleExec'
import { UNLOCK_CANCELLED, revealKey, unlockForSession, useVaultUnlocked, vaultStore } from '../lib/vault'
import { type Role, type RoleKind, roleKind, rolesStore } from '../store'
import { AddRoleDialog } from './AddRoleDialog'
import { ConfirmIconButton } from './ConfirmIconButton'
import { EyeIcon, EyeOffIcon } from './icons'
import { ProposeButton } from './ProposeButton'
import { SafeStatus } from './setup/SafeStatus'
import { RefreshButton } from './RefreshButton'
import { InfoTip } from './Tooltip'
import { AddressView, AsyncButton, Badge, Card, CopyButton, Notice, Tag } from './ui'

const TOP_UP = parseEther('0.01')

const KIND_LABELS: Record<RoleKind, string> = { eoa: 'EOA', safe: 'Safe', contract: 'Contract' }

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
  const [adding, setAdding] = useState(false)

  return (
    <>
      <SafeStatus />

      <Card
        title={
          <span className="row">
            Roles
            <InfoTip>
              A role is an address enabled as a module on this Safe: a local EOA, another Safe, or a contract.
              What it may do is bounded by the policies.
            </InfoTip>
          </span>
        }
        actions={
          <>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              Add role
            </button>
            <RefreshButton
              title="Refresh balances and module status"
              busy={balances.loading}
              onClick={() => {
                balances.reload()
                reloadState()
              }}
            />
          </>
        }
      >
        <LegacyKeysNotice />
        {adding && <AddRoleDialog onClose={() => setAdding(false)} />}

        {roles.length === 0 ? (
          <p className="muted">
            No roles yet. Add one (a new or imported EOA, a Safe or a contract), then enable it as a module.
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

  const kind = roleKind(role)
  const executor = useAsync(() => resolveExecutor(role), `${role.address}:${kind}`)

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
        <div className="row">
          <strong>{role.label}</strong>
          <Tag tone={kind === 'eoa' ? 'neutral' : 'info'}>{KIND_LABELS[kind]}</Tag>
        </div>
        <AddressView address={role.address} name="" full />
        {kind !== 'eoa' && executor.data && <ExecutorNote executor={executor.data} />}
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
        {kind !== 'eoa' ? (
          <span className="muted">—</span>
        ) : (
          <>
            {eth === undefined ? '…' : `${formatAmount(eth, 18)} ETH`}{' '}
            {eth === 0n && <Badge tone="warn">needs gas</Badge>}
          </>
        )}
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
        {kind === 'eoa' && (
          <ProposeButton
            label="Top up 0.01 ETH from Safe"
            title="Propose a 0.01 ETH transfer from the Safe to this role, to pay for gas"
            variant="secondary"
            preview={false}
            txs={[safeTxs.sendEth(role.address, TOP_UP)]}
          />
        )}
      </td>
      <td>
        {kind === 'eoa' && (
          <button
            type="button"
            className="link icon"
            aria-label={showKey ? 'Hide key' : 'Show key'}
            onClick={toggleKey}
          >
            {showKey ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </td>
      <td>
        <ConfirmIconButton
          title={
            kind === 'eoa'
              ? "Delete this role's key from the browser. It stays enabled as a module until disabled."
              : 'Remove this role from the browser. It stays enabled as a module until disabled.'
          }
          onConfirm={() => rolesStore.set((roles) => roles.filter((r) => r.address !== role.address))}
        />
      </td>
    </tr>
  )
}

/** How a Safe / contract role acts from this app (see resolveExecutor). */
function ExecutorNote({ executor }: { executor: Executor }) {
  const threshold = executor.kind !== 'eoa' && executor.info
  return (
    <div className="muted small">
      {threshold && `${executor.info!.threshold}-of-${executor.info!.owners.length} Safe · `}
      {executor.kind === 'safe-owner'
        ? `executes via its owner ${executor.signer.label} (gas paid by it)`
        : executor.kind === 'manual'
          ? 'simulate here, execute from elsewhere'
          : null}
    </div>
  )
}
