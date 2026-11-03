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
import { GLOSSARY } from './Term'
import { InfoTip, Tooltip } from './Tooltip'
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
    <Notice tone="warn" title={`${plain} role key${plain > 1 ? 's are' : ' is'} stored unencrypted`}>
      <div className="row wrap notice-row">
        <span>{plain > 1 ? 'They were' : 'It was'} created before passwords were required.</span>
        <AsyncButton onClick={unlockForSession}>Create a password</AsyncButton>
      </div>
    </Notice>
  )
}

/** One table row: a local role, a signer (owner) of the Safe, or both. */
type RoleEntry = { address: Address; role?: Role; signer?: number }

/** The Safe's signers first (merged with their local role, if any), then the other roles. */
function roleEntries(roles: readonly Role[], owners: readonly Address[]): RoleEntry[] {
  const isOwner = (a: Address) => owners.some((o) => isAddressEqual(o, a))
  return [
    ...owners.map((address, signer) => ({
      address,
      signer,
      role: roles.find((r) => isAddressEqual(r.address, address)),
    })),
    ...roles.filter((r) => !isOwner(r.address)).map((role) => ({ address: role.address, role })),
  ]
}

export function RolesPanel() {
  const roles = rolesStore.use()
  const { state, reloadState } = useSandbox()
  const balances = useBalances(roles.map((r) => r.address))
  const [adding, setAdding] = useState(false)
  const entries = roleEntries(roles, state?.owners ?? [])
  const localSigners = entries.filter(
    (e) => e.signer !== undefined && e.role && roleKind(e.role) === 'eoa',
  ).length

  return (
    <>
      <SafeStatus />

      <Card
        title={
          <span className="row">
            Roles
            <InfoTip>
              Signers own the Safe: an owner (multisig) transaction needs{' '}
              {state?.threshold ?? 'the threshold'} of their signatures. Module roles (a local EOA, another
              Safe, a contract) act on their own, bounded by the policies. A relayer only pays gas to send
              what others signed.
            </InfoTip>
          </span>
        }
        actions={
          <>
            {state && (
              <span className="muted small">
                {state.threshold}-of-{state.owners.length} multisig · {localSigners} local signer key
                {localSigners === 1 ? '' : 's'}
              </span>
            )}
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

        {entries.length > 0 && (
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
                {entries.map((e) =>
                  e.role ? (
                    <RoleRow
                      key={e.address}
                      role={e.role}
                      signer={e.signer}
                      eth={balances.data?.[e.address]?.eth}
                      enabled={state ? isModuleEnabled(state, e.address) : undefined}
                    />
                  ) : (
                    <SignerRow key={e.address} address={e.address} index={e.signer!} />
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        {roles.length === 0 && (
          <Notice
            title="No roles yet"
            more={
              <>
                Roles are stored in this browser for this address of the app ({window.location.origin}). Roles
                made on another address (another deployment or preview) are not here: export them there, then
                import the file here.
              </>
            }
          >
            Add one (a new or imported EOA, a relayer, a Safe or a contract), then enable it as a module or
            make it a signer.
          </Notice>
        )}
      </Card>
    </>
  )
}

/** "Signer · multisig": an owner of the Safe, part of the owners' (multisig) path. */
const SignerBadge = () => (
  <Tooltip content={GLOSSARY.signer}>
    <Badge tone="ok">Signer · multisig</Badge>
  </Tooltip>
)

/** A signer with no key in this browser: it signs in Safe{Wallet}, there is nothing to do here. */
function SignerRow({ address, index }: { address: Address; index: number }) {
  return (
    <tr>
      <td>
        <div className="row">
          <strong>Signer {index + 1}</strong>
          <SignerBadge />
        </div>
        <AddressView address={address} name="" full />
        <div className="muted small">Signs in Safe{'{Wallet}'}</div>
      </td>
      <td>
        <span className="muted">-</span>
      </td>
      <td>
        <span className="muted">-</span>
      </td>
      <td colSpan={5} />
    </tr>
  )
}

function RoleRow({
  role,
  signer,
  eth,
  enabled,
}: {
  role: Role
  /** Index among the Safe's owners, when the role is one. */
  signer?: number
  eth?: bigint
  enabled?: boolean
}) {
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
  const isSigner = signer !== undefined

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
          {isSigner && <SignerBadge />}
        </div>
        <AddressView address={role.address} name="" full />
        {!keyed && executor.data && <ExecutorNote executor={executor.data} />}
        {relayer && <div className="muted small">Only pays gas to send what others signed.</div>}
        {isSigner && kind === 'eoa' && <div className="muted small">Signs owner transactions here</div>}
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
