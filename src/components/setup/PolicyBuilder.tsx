import { type ReactNode, useState } from 'react'
import {
  type Address,
  type Hex,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  toFunctionSelector,
} from 'viem'
import { ADDRESS_BOOK, POLICIES, TOKENS } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useGuardTiming } from '../../hooks/useGuardTiming'
import {
  type Configuration,
  Operation,
  Permission,
  SELECTORS,
  SELECTOR_LABELS,
  configurationRoot,
  describeConfigurationData,
  templates,
} from '../../lib/configurations'
import { isModuleEnabled, safeTxs, type SafeTx } from '../../lib/safe'
import { draftStore, pendingStore, rolesStore, settingsStore } from '../../store'
import { ProposeButton } from '../ProposeButton'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { AddressView, Card, Field, Notice } from '../ui'

const TEMPLATE_OPTIONS = {
  erc20Transfer: 'ERC-20 transfer to allowlisted recipients',
  nativeTransfer: 'Native ETH transfer to a recipient',
  cowSwap: 'CoW swap (approve VaultRelayer + pre-sign orders)',
  allowedModule: 'Any call to a function, only from a given role',
  allow: 'Allow a function for everyone (AllowPolicy)',
  deny: 'Deny a function (DenyPolicy)',
  remove: 'Remove a binding (policy = 0x0)',
} as const

type TemplateKey = keyof typeof TEMPLATE_OPTIONS

/** Accepts `0x12345678`, a signature like `transfer(address,uint256)`, or empty (no selector). */
function parseSelector(input: string): Hex | undefined {
  const value = input.trim()
  if (value === '') return SELECTORS.none
  if (isHex(value) && value.length === 10) return value
  try {
    return toFunctionSelector(value)
  } catch {
    return undefined
  }
}

const parseAddresses = (input: string): Address[] | undefined => {
  const parts = input.split(/[\s,]+/).filter(Boolean)
  return parts.length > 0 && parts.every((p) => isAddress(p)) ? parts.map((p) => getAddress(p)) : undefined
}

/** Form for one template; calls `onAdd` with the configurations it produces. */
function TemplateForm({ onAdd }: { onAdd: (configs: Configuration[]) => void }) {
  const roles = rolesStore.use()
  const [template, setTemplate] = useState<TemplateKey>('erc20Transfer')
  const [token, setToken] = useState<string>(TOKENS.USDC.address)
  const [recipients, setRecipients] = useState('')
  const [permission, setPermission] = useState<Permission>(Permission.ALWAYS)
  const [target, setTarget] = useState('')
  const [selector, setSelector] = useState('')
  const [operation, setOperation] = useState<Operation>(Operation.CALL)
  const [role, setRole] = useState<string>(roles[0]?.address ?? '')

  const build = (): Configuration[] | string => {
    const selectorHex = parseSelector(selector)
    switch (template) {
      case 'erc20Transfer': {
        const list = parseAddresses(recipients)
        if (!isAddress(token)) return 'Invalid token address'
        if (!list) return 'Enter one or more recipient addresses'
        return [
          templates.erc20Transfer(
            token,
            list.map((account) => ({ account, permission })),
          ),
        ]
      }
      case 'nativeTransfer': {
        const list = parseAddresses(recipients)
        if (!list) return 'Enter one or more recipient addresses'
        return list.map((r) => templates.nativeTransfer(r))
      }
      case 'cowSwap':
        if (!isAddress(token)) return 'Invalid sell token'
        if (!isAddress(role)) return 'Pick a role'
        return templates.cowSwap(token, role)
      case 'allowedModule':
        if (!isAddress(target)) return 'Invalid target'
        if (!selectorHex) return 'Invalid selector'
        if (!isAddress(role)) return 'Pick a role'
        return [templates.allowedModule(getAddress(target), selectorHex, role)]
      case 'allow':
      case 'deny':
      case 'remove':
        if (!isAddress(target)) return 'Invalid target'
        if (!selectorHex) return 'Invalid selector'
        return [templates[template](getAddress(target), selectorHex, operation)]
    }
  }

  const result = build()
  const needsToken = template === 'erc20Transfer' || template === 'cowSwap'
  const needsRecipients = template === 'erc20Transfer' || template === 'nativeTransfer'
  const needsTarget = !needsToken && template !== 'nativeTransfer'
  const needsRole = template === 'cowSwap' || template === 'allowedModule'
  const needsOperation = template === 'allow' || template === 'deny' || template === 'remove'

  return (
    <div className="stack">
      <Field label="Template">
        <select value={template} onChange={(e) => setTemplate(e.target.value as TemplateKey)}>
          {Object.entries(TEMPLATE_OPTIONS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        {needsToken && (
          <Field label={template === 'cowSwap' ? 'Sell token' : 'Token'}>
            <select value={token} onChange={(e) => setToken(e.target.value)}>
              {Object.values(TOKENS).map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol} — {t.address}
                </option>
              ))}
            </select>
          </Field>
        )}
        {needsRecipients && (
          <Field label="Recipients" hint="Comma or space separated">
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="0x…" />
          </Field>
        )}
        {template === 'erc20Transfer' && (
          <Field label="Permission" hint="'once' is spent by the first transfer that uses it">
            <select value={permission} onChange={(e) => setPermission(Number(e.target.value) as Permission)}>
              <option value={Permission.ALWAYS}>always</option>
              <option value={Permission.ONCE}>once</option>
              <option value={Permission.NONE}>none (revoke)</option>
            </select>
          </Field>
        )}
        {needsTarget && (
          <Field label="Target contract">
            <input value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" />
          </Field>
        )}
        {needsTarget && (
          <Field label="Function" hint="Selector (0x…) or signature, empty = no selector">
            <input
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder="transfer(address,uint256)"
            />
          </Field>
        )}
        {needsOperation && (
          <Field label="Operation">
            <select value={operation} onChange={(e) => setOperation(Number(e.target.value) as Operation)}>
              <option value={Operation.CALL}>CALL</option>
              <option value={Operation.DELEGATECALL}>DELEGATECALL</option>
            </select>
          </Field>
        )}
        {needsRole && (
          <Field label="Role (module)">
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">—</option>
              {roles.map((r) => (
                <option key={r.address} value={r.address}>
                  {r.label} — {r.address}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {template === 'cowSwap' && (
        <Notice tone="warn">
          No deployed policy can inspect a CoW order: the role can pre-sign an order with <em>any</em>{' '}
          receiver. This shows the plumbing, not a safe swap-only permission.
        </Notice>
      )}
      {template === 'allowedModule' && (
        <Notice>
          AllowedModulePolicy keeps one allowlist per Safe, not per function: allowing a role here allows it
          on every selector bound to AllowedModulePolicy.
        </Notice>
      )}

      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={typeof result === 'string'}
          title="Add the configuration(s) from this template to the draft below"
          onClick={() => typeof result !== 'string' && onAdd(result)}
        >
          Add to draft
        </button>
        {typeof result === 'string' && <span className="muted">{result}</span>}
      </div>
    </div>
  )
}

const ADDRESS_PATTERN = /(0x[a-fA-F0-9]{40})/

/** Renders a config summary with each embedded address shortened and labelled (known contract or role). */
function ConfigSummary({ text }: { text: string }) {
  const roles = rolesStore.use()
  return (
    <>
      {text
        .split(ADDRESS_PATTERN)
        .map((part, i) =>
          i % 2 === 1 ? (
            <AddressView
              key={i}
              address={part}
              name={roles.find((r) => isAddressEqual(r.address, part as Address))?.label}
            />
          ) : (
            part
          ),
        )}
    </>
  )
}

export function ConfigurationTable({
  configurations,
  onRemove,
  removeTitle = 'Remove this entry from the draft',
  renderConfig,
}: {
  configurations: readonly Configuration[]
  onRemove?: (index: number) => void
  removeTitle?: string
  /** Replaces the default summary in the Config cell (e.g. with live on-chain state). */
  renderConfig?: (configuration: Configuration) => ReactNode
}) {
  return (
    <div className="table-scroll">
      <table className="config-table">
        <thead>
          <tr>
            <th>Target</th>
            <th>Function</th>
            <th>Op</th>
            <th>Policy</th>
            <th>Config</th>
            {onRemove && <th />}
          </tr>
        </thead>
        <tbody>
          {configurations.map((c, i) => (
            <tr key={i}>
              <td>
                <AddressView address={c.target} />
              </td>
              <td className="mono small">{SELECTOR_LABELS[c.selector.toLowerCase()] ?? c.selector}</td>
              <td>{c.operation === Operation.CALL ? 'CALL' : 'DELEGATECALL'}</td>
              <td>{ADDRESS_BOOK[c.policy.toLowerCase()] ?? <AddressView address={c.policy} />}</td>
              <td className="small">
                {renderConfig?.(c) ?? <ConfigSummary text={describeConfigurationData(c)} />}
              </td>
              {onRemove && (
                <td>
                  <ConfirmIconButton title={removeTitle} onConfirm={() => onRemove(i)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PolicyBuilder() {
  const { safe, state, guard, guardInstalled } = useSandbox()
  const draft = draftStore.use()
  const roles = rolesStore.use()
  const settings = settingsStore.use()
  const timing = useGuardTiming(guard)
  const [bootstrapRoles, setBootstrapRoles] = useState<Address[]>([])

  const root = configurationRoot(draft)
  const rememberPending = () =>
    pendingStore.set((list) => [
      ...list.filter((p) => p.root !== root),
      { root, safe, guard, configurations: draft, createdAt: Date.now() },
    ])

  const usesAllowedModule = draft.some((c) => isAddressEqual(c.policy, POLICIES.allowedModule))
  const disabledRoles = state ? roles.filter((r) => !isModuleEnabled(state, r.address)) : []

  let action: { label: string; txs: SafeTx[]; onProposed: () => void; help: string }
  if (!guardInstalled) {
    action = {
      label: 'Propose bootstrap batch',
      help:
        'No guard yet: policies are set instantly with configureImmediately, then the guard is installed in the ' +
        'same batch so there is no unguarded window.',
      txs: [
        ...(draft.length ? [safeTxs.configureImmediately(guard, draft)] : []),
        ...bootstrapRoles.map((r) => safeTxs.enableModule(safe, r)),
        safeTxs.setModuleGuard(safe, guard),
        ...(settings.guardOwnerPath ? [safeTxs.setGuard(safe, guard)] : []),
      ],
      onProposed: () => draftStore.set([]),
    }
  } else if (timing.data?.delay === 0n) {
    action = {
      label: 'Propose request + apply',
      help: 'This guard has no delay, so the request and the apply can be batched.',
      txs: [safeTxs.requestConfiguration(guard, root), safeTxs.applyConfiguration(guard, draft)],
      onProposed: () => draftStore.set([]),
    }
  } else {
    action = {
      label: 'Propose configuration request',
      help:
        'The guard is installed, so changes go through the delay: request the root now, then apply the same ' +
        'configurations from “Pending configurations” once it matures.',
      txs: [safeTxs.requestConfiguration(guard, root)],
      onProposed: () => {
        rememberPending()
        draftStore.set([])
      },
    }
  }

  return (
    <Card title="Policy builder">
      <TemplateForm onAdd={(configs) => draftStore.set((d) => [...d, ...configs])} />

      <h3>Draft ({draft.length})</h3>
      {draft.length === 0 ? (
        <p className="muted">Add configurations from a template above.</p>
      ) : (
        <>
          <ConfigurationTable
            configurations={draft}
            onRemove={(index) => draftStore.set((d) => d.filter((_, i) => i !== index))}
          />
          <p className="muted small">
            Root <span className="mono">{root}</span>
          </p>
        </>
      )}

      {!guardInstalled && disabledRoles.length > 0 && (
        // A plain group, not <Field>: that renders a <label>, which must not contain the checkbox labels.
        <div className="field">
          <span className="field-label">Also make these roles modules (enableModule) in this batch</span>
          <div className="checklist">
            {disabledRoles.map((r) => (
              <label key={r.address} className="row">
                <input
                  type="checkbox"
                  checked={bootstrapRoles.includes(r.address)}
                  onChange={(e) =>
                    setBootstrapRoles((list) =>
                      e.target.checked ? [...list, r.address] : list.filter((a) => a !== r.address),
                    )
                  }
                />
                <strong>{r.label}</strong> <span className="mono muted">{r.address}</span>
              </label>
            ))}
          </div>
          <span className="field-hint">
            This only decides which EOAs become modules, not which policies apply to them: every enabled
            module is checked against the same policies. Enabling in the guard-install batch means the role is
            never unrestricted.
          </span>
        </div>
      )}

      {usesAllowedModule && disabledRoles.length > 0 && guardInstalled && (
        <Notice>
          Remember to enable the role as a module (Roles tab) — policies alone don&apos;t make it a module.
        </Notice>
      )}

      <p className="muted">{action.help}</p>
      <ProposeButton
        label={action.label}
        title={action.help}
        txs={guardInstalled && draft.length === 0 ? [] : action.txs}
        onProposed={action.onProposed}
      />
    </Card>
  )
}
