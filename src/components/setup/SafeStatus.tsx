import { type Address, isAddressEqual, zeroAddress } from 'viem'
import { GUARDS } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useGuardTiming } from '../../hooks/useGuardTiming'
import { formatDuration } from '../../lib/format'
import { type SafeTx, isKnownGuard, safeTxs } from '../../lib/safe'
import { rolesStore, settingsStore } from '../../store'
import { ProposeIconButton } from '../ProposeIconButton'
import { AddressView, Badge, Card, Notice } from '../ui'

/** A guard slot, with a trash icon proposing its removal (`setModuleGuard(0)` / `setGuard(0)`). */
function GuardTiming({ guard }: { guard: Address }) {
  const timing = useGuardTiming(guard)
  if (!timing.data) return null
  return (
    <span className="muted small">
      delay {formatDuration(timing.data.delay)} · expiry {formatDuration(timing.data.expiry)}
    </span>
  )
}

function GuardSlot({
  label,
  address,
  removeTx,
  removeTitle,
}: {
  label: string
  address: Address
  removeTx: SafeTx
  removeTitle: string
}) {
  return (
    <div>
      <span className="field-label">{label}</span>{' '}
      {address === zeroAddress ? (
        <Badge>not set</Badge>
      ) : (
        <>
          <AddressView address={address} />{' '}
          {isKnownGuard(address) ? <GuardTiming guard={address} /> : <Badge tone="warn">unknown guard</Badge>}{' '}
          <ProposeIconButton txs={[removeTx]} title={removeTitle} />
        </>
      )}
    </div>
  )
}

export function SafeStatus() {
  const { state, guard, guardInstalled } = useSandbox()
  const settings = settingsStore.use()
  const roles = rolesStore.use()

  if (!state) return <Card title="Safe status">Loading…</Card>

  const supportsModuleGuard = state.version.startsWith('1.5')
  const moduleWarning = state.modules.length
    ? ` Warning: the ${state.modules.length} enabled module(s) become unrestricted — disable them first.`
    : ''
  // With the transaction guard set, removing either guard is itself a checked owner transaction.
  const ownerPathNote =
    state.guard !== zeroAddress
      ? ' Needs an AllowPolicy on this selector applied through the delay, since the transaction guard is set.'
      : ''
  const roleLabel = (module: Address) => roles.find((r) => isAddressEqual(r.address, module))?.label

  return (
    <Card title="Safe status">
      <div className="grid-2 status-grid">
        <div>
          <div>
            <span className="field-label">Version</span> {state.version}{' '}
            {supportsModuleGuard ? (
              <Badge tone="ok">module guard supported</Badge>
            ) : (
              <Badge tone="bad">needs 1.5.0</Badge>
            )}
          </div>
          <div>
            <span className="field-label">Multisig</span> {state.threshold}-of-{state.owners.length}
          </div>
          <GuardSlot
            label="Module guard"
            address={state.moduleGuard}
            removeTx={safeTxs.setModuleGuard(state.address, zeroAddress)}
            removeTitle={`Remove the module guard: proposes setModuleGuard(0x0).${moduleWarning}${ownerPathNote}`}
          />
          <GuardSlot
            label="Transaction guard"
            address={state.guard}
            removeTx={safeTxs.setGuard(state.address, zeroAddress)}
            removeTitle={`Remove the transaction guard: proposes setGuard(0x0).${ownerPathNote}`}
          />
        </div>
        <div>
          <span className="field-label">Enabled modules</span>
          {state.modules.length === 0 ? (
            <div className="muted">none</div>
          ) : (
            <ul className="plain">
              {state.modules.map((m) => (
                <li key={m}>
                  <AddressView address={m} /> {roleLabel(m) && <Badge tone="ok">{roleLabel(m)}</Badge>}{' '}
                  <ProposeIconButton
                    txs={[safeTxs.disableModule(state, m)]}
                    title={`Disable module ${m}: proposes disableModule to the owners`}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {!supportsModuleGuard && (
        <Notice tone="bad">
          Safe {state.version} has no module guard: module transactions would bypass every policy. Use a 1.5.0
          Safe.
        </Notice>
      )}

      {/* Once installed, the guard slots above already show it; only offer the choice before. */}
      {!guardInstalled && <h3>Policy guard to install</h3>}
      {!guardInstalled && (
        <div className="row wrap">
          <label className="row">
            Guard to install
            <select
              value={guard}
              onChange={(e) => settingsStore.set((s) => ({ ...s, guard: e.target.value as Address }))}
            >
              {GUARDS.map((g) => (
                <option key={g.address} value={g.address}>
                  delay {g.label} — {g.address}
                </option>
              ))}
            </select>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={settings.guardOwnerPath}
              onChange={(e) => settingsStore.set((s) => ({ ...s, guardOwnerPath: e.target.checked }))}
            />
            Also guard the owner path (setGuard)
          </label>
        </div>
      )}

      {!guardInstalled && settings.guardOwnerPath && (
        <Notice tone="warn">
          With the transaction guard set, owner transactions are default-denied too: the multisig can then
          only request/apply/invalidate configurations until policies allow more. Safe{'{Wallet}'} batches are
          a DELEGATECALL to MultiSendCallOnly and need a MultiSendPolicy binding as well.
        </Notice>
      )}
    </Card>
  )
}
