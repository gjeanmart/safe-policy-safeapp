import { type Address, isAddressEqual, zeroAddress } from 'viem'
import { GUARDS } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useGuardTiming } from '../../hooks/useGuardTiming'
import { formatDuration, shortAddress } from '../../lib/format'
import { type SafeTx, isKnownGuard, safeTxs } from '../../lib/safe'
import { guardPaths, rolesStore, settingsStore } from '../../store'
import { ProposeIconButton } from '../ProposeIconButton'
import { InfoTip } from '../Tooltip'
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
    <>
      <span className="field-label">{label}</span>
      <span className="kv-value">
        {address === zeroAddress ? (
          <Badge>not set</Badge>
        ) : (
          <>
            <AddressView address={address} />
            {isKnownGuard(address) ? (
              <GuardTiming guard={address} />
            ) : (
              <Badge tone="warn">unknown guard</Badge>
            )}
            <ProposeIconButton txs={[removeTx]} title={removeTitle} />
          </>
        )}
      </span>
    </>
  )
}

export function SafeStatus() {
  const { state, guard, guardInstalled } = useSandbox()
  const settings = settingsStore.use()
  const paths = guardPaths(settings)
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
        {/* Label / value pairs in two aligned columns. */}
        <div className="kv-list">
          <span className="field-label">Version</span>
          <span className="kv-value">
            {state.version}
            {supportsModuleGuard ? (
              <Badge tone="ok">module guard supported</Badge>
            ) : (
              <Badge tone="bad">needs 1.5.0</Badge>
            )}
          </span>
          <span className="field-label">Multisig</span>
          <span className="kv-value">
            {state.threshold}-of-{state.owners.length}
          </span>
          <GuardSlot
            label="Multisig path (guard)"
            address={state.guard}
            removeTx={safeTxs.setGuard(state.address, zeroAddress)}
            removeTitle={`Remove the multisig-path guard: proposes setGuard(0x0).${ownerPathNote}`}
          />
          <GuardSlot
            label="Module path (guard)"
            address={state.moduleGuard}
            removeTx={safeTxs.setModuleGuard(state.address, zeroAddress)}
            removeTitle={`Remove the module-path guard: proposes setModuleGuard(0x0).${moduleWarning}${ownerPathNote}`}
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
                    title={`Disable module ${roleLabel(m) ?? shortAddress(m)}: proposes disableModule to the owners.`}
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
          <span className="row">
            Enforce on:
            <label className="row">
              <input
                type="checkbox"
                checked={paths.module}
                onChange={(e) => settingsStore.set((s) => ({ ...s, guardModulePath: e.target.checked }))}
              />
              module path
              <InfoTip>
                Installs the guard as module guard (setModuleGuard): transactions from enabled modules
                (execTransactionFromModule) go through the policies.
              </InfoTip>
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={paths.multisig}
                onChange={(e) => settingsStore.set((s) => ({ ...s, guardOwnerPath: e.target.checked }))}
              />
              multisig path
              <InfoTip>
                Installs the guard as transaction guard (setGuard): multisig transactions (execTransaction) go
                through the same default-deny policies, and removing a guard then needs a delayed AllowPolicy.
              </InfoTip>
            </label>
          </span>
        </div>
      )}

      {!guardInstalled && paths.multisig && !paths.module && (
        <Notice tone="bad">
          The multisig path alone is not allowed: every enabled module would then run completely unchecked,
          and could even remove the guard. Also enforce on the module path.
        </Notice>
      )}
      {!guardInstalled && paths.multisig && paths.module && (
        <Notice tone="warn">
          With the multisig path enforced, owner transactions are default-denied too: the multisig can then
          only request/apply/invalidate configurations until policies allow more. Safe{'{Wallet}'} batches are
          a DELEGATECALL to MultiSendCallOnly and need a MultiSendPolicy binding as well.
        </Notice>
      )}
      {!guardInstalled && !paths.multisig && !paths.module && (
        <Notice>
          No path selected: the Policy builder only writes configurations (configureImmediately) and installs
          no guard, e.g. to clean up stored policies.
        </Notice>
      )}
    </Card>
  )
}
