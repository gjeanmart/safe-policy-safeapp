import { useState } from 'react'
import { type Hex, isAddressEqual, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { TOKENS } from '../config/contracts'
import { useSandbox } from '../context'
import { useBalances } from '../hooks/useBalances'
import { formatAmount } from '../lib/format'
import { isModuleEnabled, safeTxs } from '../lib/safe'
import { parsePrivateKeyInput } from '../lib/validation'
import { type Role, rolesStore } from '../store'
import { ConfirmIconButton } from './ConfirmIconButton'
import { EyeIcon, EyeOffIcon } from './icons'
import { ProposeButton } from './ProposeButton'
import { RefreshButton } from './RefreshButton'
import { Tooltip } from './Tooltip'
import { AddressView, Badge, Card, CopyButton, Notice } from './ui'

const TOP_UP = parseEther('0.01')

function addRole(label: string, privateKey: Hex) {
  const { address } = privateKeyToAccount(privateKey)
  rolesStore.set((roles) =>
    roles.some((r) => isAddressEqual(r.address, address))
      ? roles
      : [
          ...roles,
          { address, privateKey, label: label || `Role ${roles.length + 1}`, createdAt: Date.now() },
        ],
  )
}

export function RolesPanel() {
  const roles = rolesStore.use()
  const { safe, state, reloadState } = useSandbox()
  const balances = useBalances([safe, ...roles.map((r) => r.address)])
  const [label, setLabel] = useState('')
  const [importKey, setImportKey] = useState('')
  const [importError, setImportError] = useState<string>()

  const safeBalance = balances.data?.[safe]

  return (
    <>
      <Card title="Safe">
        <div className="row wrap">
          <AddressView address={safe} name="" full />
          {safeBalance && (
            <span className="muted">
              {formatAmount(safeBalance.eth, 18)} ETH ·{' '}
              {formatAmount(safeBalance.usdc, TOKENS.USDC.decimals, 2)} USDC ·{' '}
              {formatAmount(safeBalance.weth, 18)} WETH
            </span>
          )}
        </div>
      </Card>

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
        <Notice tone="warn">
          Private keys are stored unencrypted in this browser&apos;s localStorage. Sepolia / PoC use only.
        </Notice>
        <div className="row wrap">
          <input
            placeholder="Label, e.g. Trader bot"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            title="Create a new EOA with a random private key, stored in this browser"
            onClick={() => {
              addRole(label, generatePrivateKey())
              setLabel('')
            }}
          >
            Generate role
          </button>
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
          <button
            type="button"
            className="btn"
            title="Add an existing EOA from its private key (e.g. a role created in another browser/origin)"
            disabled={!importKey}
            onClick={() => {
              const parsed = parsePrivateKeyInput(importKey)
              if (!parsed.ok) return setImportError(parsed.error)
              const { address } = privateKeyToAccount(parsed.value)
              if (roles.some((r) => isAddressEqual(r.address, address))) {
                return setImportError('This key is already imported (' + address + ').')
              }
              addRole(label, parsed.value)
              setImportKey('')
            }}
          >
            Import
          </button>
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
  const [showKey, setShowKey] = useState(false)

  return (
    <tr>
      <td>
        <div>
          <strong>{role.label}</strong>
        </div>
        <AddressView address={role.address} name="" full />
        {showKey && (
          // Truncated so the revealed key never widens the column; copy still yields the full key.
          <div className="secret" title={role.privateKey}>
            <span className="secret-label">Private key</span>
            <span className="mono">
              {role.privateKey.slice(0, 10)}…{role.privateKey.slice(-8)}
            </span>
            <CopyButton value={role.privateKey} />
          </div>
        )}
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
        <Tooltip
          content={showKey ? 'Hide the private key' : 'Reveal the private key (e.g. to import it elsewhere)'}
        >
          <button
            type="button"
            className="link icon"
            aria-label={showKey ? 'Hide key' : 'Show key'}
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </Tooltip>
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
