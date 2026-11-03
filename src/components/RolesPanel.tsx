import { useState } from 'react'
import { type Address, type Hex, isAddressEqual, parseEther } from 'viem'
import { useSandbox } from '../context'
import { useAsync } from '../hooks/useAsync'
import { useBalances } from '../hooks/useBalances'
import { formatAmount } from '../lib/format'
import { isModuleEnabled, safeTxs } from '../lib/safe'
import { type Executor, resolveExecutor } from '../lib/roleExec'
import { UNLOCK_CANCELLED, revealKey, unlockForSession, useVaultUnlocked, vaultStore } from '../lib/vault'
import { type Role, type RoleKind, hasLocalKey, roleKind, rolesStore } from '../store'
import { AddRoleDialog } from './AddRoleDialog'
import { RolesBackupButtons } from './RolesBackup'
import { ConfirmIconButton } from './ConfirmIconButton'
import { EyeIcon, EyeOffIcon } from './icons'
import { ProposeButton } from './ProposeButton'
import { SafeStatus } from './setup/SafeStatus'
import { RefreshButton } from './RefreshButton'
import { InfoTip } from './Tooltip'
import { AddressView, AsyncButton, Badge, Card, CopyButton, Notice, Tag } from './ui'

const TOP_UP = parseEther('0.01')

const KIND_LABELS: Record<RoleKind, string> = {
  eoa: 'EOA',
  safe: 'Safe',
  contract: 'Contract',
  relayer: 'Relayer',
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
  const [adding, setAdding] = useState(false)

  return (
    <>
      <SafeStatus />
      <SignersCard roles={roles} />

      <Card
        title={
          <span className="row">
            Roles
            <InfoTip>
              A role is an address enabled as a module on this Safe: a local EOA, another Safe, or a contract.
              What it may do is bounded by the policies. A relayer only pays gas to send transactions others
              signed.
            </InfoTip>
          </span>
        }
        actions={
          <>
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              Add role
            </button>
            <RolesBackupButtons />
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
          <div className="stack">
            <p className="muted">
              No roles yet. Add one (a new or imported EOA, a relayer, a Safe or a contract), then enable it
              as a module.
            </p>
            <Notice>
              Roles are stored in this browser for this address of the app ({window.location.origin}). Roles
              made on another address (another deployment or preview) are not here: export them there, then
              import the file here.
            </Notice>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="roles-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Gas balance</th>
                  <th>Module</th>
                  <th colSpan={5}>Actions</th>
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
  const relayer = kind === 'relayer'
  const keyed = hasLocalKey(role)
  const executor = useAsync(() => resolveExecutor(role), `${role.address}:${kind}`)
  const isSigner = !!state?.owners.some((o) => isAddressEqual(o, role.address))

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
          {relayer && <Badge>relayer</Badge>}
        </div>
        <AddressView address={role.address} name="" full />
        {!keyed && executor.data && <ExecutorNote executor={executor.data} />}
        {relayer && <div className="muted small">Only pays gas to send what others signed.</div>}
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
        {!keyed ? (
          <span className="muted">-</span>
        ) : (
          <>
            {eth === undefined ? '…' : `${formatAmount(eth, 18)} ETH`}{' '}
            {eth === 0n && <Badge tone="warn">needs gas</Badge>}
          </>
        )}
      </td>
      <td>
        {relayer && !enabled ? (
          <span className="muted">-</span>
        ) : enabled === undefined ? (
          '…'
        ) : enabled ? (
          <Badge tone="ok">enabled</Badge>
        ) : (
          <Badge>not enabled</Badge>
        )}
        {isSigner && (
          <>
            {' '}
            <Badge tone="ok">signer</Badge>
          </>
        )}
      </td>
      {/* One cell per action so buttons line up across rows. */}
      <td>
        {state &&
          !(relayer && !enabled) &&
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
        {keyed && (
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
        {kind === 'eoa' && state && !isSigner && (
          <ProposeButton
            label="Make signer"
            title={`Propose addOwnerWithThreshold: ${role.label} becomes a signer of this Safe (threshold stays ${state.threshold}), so this app can sign owner transactions with its key`}
            variant="secondary"
            preview={false}
            txs={[safeTxs.addOwner(state, role.address)]}
          />
        )}
      </td>
      <td>
        {keyed && (
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
            keyed
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

/** Display name of a signer: its local role, else "Signer N". */
export function signerName(owner: Address, index: number, roles: readonly Role[]): string {
  return roles.find((r) => isAddressEqual(r.address, owner))?.label ?? `Signer ${index + 1}`
}

/**
 * The Safe's signers (owners): the multisig path. A signer whose key is a local role can sign owner
 * transactions in this app (Act as a role → Owners, the Queue); the others sign in Safe{Wallet}.
 */
function SignersCard({ roles }: { roles: readonly Role[] }) {
  const { state } = useSandbox()
  if (!state) return null
  const local = state.owners.filter((o) =>
    roles.some((r) => roleKind(r) === 'eoa' && isAddressEqual(r.address, o)),
  ).length
  return (
    <Card
      title={
        <span className="row">
          Signers
          <InfoTip>
            The owners of this Safe: together they form the multisig path ({state.threshold} signature
            {state.threshold === 1 ? '' : 's'} needed). A signer whose key is a local role signs here; the
            others sign in Safe{'{Wallet}'}. To test the owner path from this app, add an EOA role and click
            Make signer.
          </InfoTip>
        </span>
      }
      actions={
        <span className="muted small">
          {state.threshold}-of-{state.owners.length} · {local} local key{local === 1 ? '' : 's'}
        </span>
      }
    >
      <ul className="plain stack">
        {state.owners.map((owner, i) => {
          const role = roles.find((r) => roleKind(r) === 'eoa' && isAddressEqual(r.address, owner))
          return (
            <li key={owner} className="row wrap">
              <strong>{signerName(owner, i, roles)}</strong>
              <AddressView address={owner} name="" full />
              {role ? (
                <Badge tone="ok">local key: signs here</Badge>
              ) : (
                <Badge>signs in Safe{'{Wallet}'}</Badge>
              )}
            </li>
          )
        })}
      </ul>
      {local < state.threshold && (
        <p className="muted small">
          This app holds {local} of the {state.threshold} signature{state.threshold === 1 ? '' : 's'} needed:
          owner transactions go through Safe{'{Wallet}'}. Make signer on an EOA role lets the app sign too.
        </p>
      )}
    </Card>
  )
}
