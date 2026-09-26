import { type ReactNode, useState } from 'react'
import { type Address, isAddressEqual } from 'viem'
import { guardAbi } from '../../abi'
import { publicClient } from '../../config/client'
import { ADDRESS_BOOK, POLICIES, TOKENS } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { useGuardTiming } from '../../hooks/useGuardTiming'
import { useNow } from '../../hooks/useNow'
import {
  type Configuration,
  Operation,
  Permission,
  SELECTOR_LABELS,
  configurationRoot,
  describeConfigurationData,
  templates,
} from '../../lib/configurations'
import { formatDuration } from '../../lib/format'
import { isModuleEnabled, safeTxs, type SafeTx } from '../../lib/safe'
import { fieldError, parseAddressInput, parseAddressList, parseSelectorInput } from '../../lib/validation'
import { draftStore, guardPaths, pendingStore, rolesStore, settingsStore } from '../../store'
import { AddressShortcuts } from '../AddressShortcuts'
import { ProposeButton } from '../ProposeButton'
import { ConfirmIconButton } from '../ConfirmIconButton'
import { InfoTip, Tooltip } from '../Tooltip'
import { AddressView, Card, Field, Notice, Tag } from '../ui'

const ROOT_REFRESH_MS = 5_000

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

/** Adds `address` to a comma-separated list, unless it is already in it. */
function appendAddress(list: string, address: Address): string {
  const parts = list.split(/[\s,]+/).filter(Boolean)
  if (parts.some((p) => p.toLowerCase() === address.toLowerCase())) return list
  return [...parts, address].join(', ')
}

/**
 * Form for one template; calls `onAdd` with the configurations it produces. Each field is
 * validated on its own (see lib/validation); empty required fields are only flagged after a
 * submit attempt.
 */
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
  const [submitted, setSubmitted] = useState(false)

  const needsToken = template === 'erc20Transfer' || template === 'cowSwap'
  const needsRecipients = template === 'erc20Transfer' || template === 'nativeTransfer'
  const needsTarget = !needsToken && template !== 'nativeTransfer'
  const needsRole = template === 'cowSwap' || template === 'allowedModule'
  const needsOperation = template === 'allow' || template === 'deny' || template === 'remove'

  const fields = {
    recipients: parseAddressList(recipients),
    target: parseAddressInput(target, 'contract address'),
    selector: parseSelectorInput(selector),
    role: parseAddressInput(role, 'role'),
  }
  const roleMissingMessage = roles.length === 0 ? 'Create a role first (Roles tab).' : 'Pick a role.'
  const errors = {
    recipients: needsRecipients ? fieldError(fields.recipients, submitted) : undefined,
    target: needsTarget ? fieldError(fields.target, submitted) : undefined,
    selector: needsTarget ? fieldError(fields.selector, submitted) : undefined,
    role: needsRole && !fields.role.ok && submitted ? roleMissingMessage : undefined,
  }

  /** The configurations, or undefined while a required field is missing or invalid. */
  const build = (): Configuration[] | undefined => {
    const { recipients: list, target: to, selector: sel, role: module } = fields
    switch (template) {
      case 'erc20Transfer':
        return list.ok
          ? [
              templates.erc20Transfer(
                token as Address,
                list.value.map((account) => ({ account, permission })),
              ),
            ]
          : undefined
      case 'nativeTransfer':
        return list.ok ? list.value.map((r) => templates.nativeTransfer(r)) : undefined
      case 'cowSwap':
        return module.ok ? templates.cowSwap(token as Address, module.value) : undefined
      case 'allowedModule':
        return to.ok && sel.ok && module.ok
          ? [templates.allowedModule(to.value, sel.value, module.value)]
          : undefined
      case 'allow':
      case 'deny':
      case 'remove':
        return to.ok && sel.ok ? [templates[template](to.value, sel.value, operation)] : undefined
    }
  }

  const submit = () => {
    const configs = build()
    if (!configs) {
      setSubmitted(true)
      return
    }
    onAdd(configs)
    setRecipients('')
    setTarget('')
    setSelector('')
    setSubmitted(false)
  }

  return (
    <div className="stack">
      <Field label="Template">
        <select
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value as TemplateKey)
            setSubmitted(false)
          }}
        >
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
          <Field
            label="Recipients"
            error={errors.recipients}
            info="One or more addresses, comma or space separated. The links under the field add an address to the list."
            after={
              <AddressShortcuts
                onPick={(address) => setRecipients((current) => appendAddress(current, address))}
              />
            }
          >
            <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="0x…" />
          </Field>
        )}
        {template === 'erc20Transfer' && (
          <Field
            label="Permission"
            info="always: can be used any number of times. once: spent by the first transfer that uses it. none: revokes the recipient."
          >
            <select value={permission} onChange={(e) => setPermission(Number(e.target.value) as Permission)}>
              <option value={Permission.ALWAYS}>always</option>
              <option value={Permission.ONCE}>once</option>
              <option value={Permission.NONE}>none (revoke)</option>
            </select>
          </Field>
        )}
        {needsTarget && (
          <Field label="Target contract" error={errors.target}>
            <input value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" />
          </Field>
        )}
        {needsTarget && (
          <Field
            label="Function"
            error={errors.selector}
            info="A 4-byte selector (0x…) or a signature such as transfer(address,uint256). Leave empty for calls without calldata (e.g. plain ETH transfers)."
          >
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
          <Field label="Role (module)" error={errors.role}>
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
          title="Add the configuration(s) from this template to the draft below"
          onClick={submit}
        >
          Add to draft
        </button>
      </div>
    </div>
  )
}

/** DELEGATECALL runs foreign code in the Safe's own context, so it is flagged. */
function OperationTag({ operation }: { operation: Operation }) {
  return operation === Operation.CALL ? (
    <Tag caps>call</Tag>
  ) : (
    <Tag tone="bad" caps>
      delegatecall
    </Tag>
  )
}

/** Policy name as a tag, coloured by effect: allow, deny, or a conditional check. */
function PolicyTag({ policy }: { policy: Address }) {
  const name = ADDRESS_BOOK[policy.toLowerCase()]
  if (!name) return <AddressView address={policy} />
  const tone = isAddressEqual(policy, POLICIES.allow)
    ? 'ok'
    : isAddressEqual(policy, POLICIES.deny)
      ? 'bad'
      : 'info'
  return (
    <Tooltip content={`${name} · ${policy}`}>
      <Tag tone={tone}>{name}</Tag>
    </Tooltip>
  )
}

const ADDRESS_PATTERN = /(0x[a-fA-F0-9]{40})/

/** Renders a config summary with each embedded address shortened and labelled (known contract or role). */
function ConfigSummary({ text }: { text: string }) {
  return (
    <>
      {text
        .split(ADDRESS_PATTERN)
        .map((part, i) => (i % 2 === 1 ? <AddressView key={i} address={part} /> : part))}
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
              <td>
                <OperationTag operation={c.operation} />
              </td>
              <td>
                <PolicyTag policy={c.policy} />
              </td>
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
  const now = useNow()
  const [bootstrapRoles, setBootstrapRoles] = useState<Address[]>([])
  const paths = guardPaths(settings)
  const installGuard = paths.module || paths.multisig

  const root = configurationRoot(draft)
  // Re-building a configuration gives the same root; requesting it again while it is pending
  // reverts (RootAlreadyConfigured), so detect it and offer to apply instead.
  const requested = useAsync(
    () =>
      draft.length
        ? publicClient.readContract({
            address: guard,
            abi: guardAbi,
            functionName: 'rootConfigured',
            args: [safe, root],
          })
        : Promise.resolve(0n),
    `${guard}:${safe}:${root}`,
    ROOT_REFRESH_MS,
  )
  const validFrom = Number(requested.data ?? 0n)
  const expiry = Number(timing.data?.expiry ?? 0n)
  const rootStatus =
    validFrom === 0 || !timing.data
      ? 'none'
      : now < validFrom
        ? 'pending'
        : now < validFrom + expiry
          ? 'ready'
          : 'expired'
  const forgetPending = () => pendingStore.set((list) => list.filter((p) => p.root !== root))
  const rememberPending = () =>
    pendingStore.set((list) => [
      ...list.filter((p) => p.root !== root),
      { root, safe, guard, configurations: draft, createdAt: Date.now() },
    ])

  const usesAllowedModule = draft.some((c) => isAddressEqual(c.policy, POLICIES.allowedModule))
  const disabledRoles = state ? roles.filter((r) => !isModuleEnabled(state, r.address)) : []

  let action: { label: string; txs: SafeTx[]; onProposed: () => void; help: string }
  if (draft.length && rootStatus === 'pending') {
    action = {
      label: 'Already requested',
      help: `This exact configuration was already requested; it can be applied in ${formatDuration(validFrom - now)}.`,
      txs: [],
      onProposed: () => undefined,
    }
  } else if (draft.length && rootStatus === 'ready') {
    action = {
      label: 'Propose apply',
      help:
        'This exact configuration was already requested and has matured: apply it (works whether or not the ' +
        'guard is installed).',
      txs: [safeTxs.applyConfiguration(guard, draft)],
      onProposed: () => {
        forgetPending()
        draftStore.set([])
      },
    }
  } else if (!guardInstalled && !installGuard) {
    action = {
      label: 'Propose configureImmediately',
      help:
        'No guard installed: the configurations are written instantly and the guard stays uninstalled ' +
        '(e.g. to clean up policies after removing it). Nothing is enforced until a guard is installed.',
      txs: draft.length ? [safeTxs.configureImmediately(guard, draft)] : [],
      onProposed: () => draftStore.set([]),
    }
  } else if (!guardInstalled) {
    action = {
      label: 'Propose bootstrap batch',
      help:
        'No guard yet: policies are set instantly with configureImmediately, then the guard is installed in the ' +
        'same batch so there is no unguarded window.',
      txs: [
        ...(draft.length ? [safeTxs.configureImmediately(guard, draft)] : []),
        ...bootstrapRoles.map((r) => safeTxs.enableModule(safe, r)),
        ...(paths.module ? [safeTxs.setModuleGuard(safe, guard)] : []),
        ...(paths.multisig ? [safeTxs.setGuard(safe, guard)] : []),
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
        'configurations from “Pending policy changes” once it matures.',
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

      {!guardInstalled && paths.module && disabledRoles.length > 0 && (
        // A plain group, not <Field>: that renders a <label>, which must not contain the checkbox labels.
        <div className="field">
          <span className="field-label">
            Also make these roles modules (enableModule) in this batch
            <InfoTip>
              This only decides which EOAs become modules, not which policies apply to them: every enabled
              module is checked against the same policies. Enabling in the guard-install batch means the role
              is never unrestricted.
            </InfoTip>
          </span>
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
        </div>
      )}

      {usesAllowedModule && disabledRoles.length > 0 && guardInstalled && (
        <Notice>
          Remember to enable the role as a module (Roles tab) — policies alone don&apos;t make it a module.
        </Notice>
      )}

      {rootStatus === 'pending' || rootStatus === 'ready' ? <Notice>{action.help}</Notice> : null}
      <div className="builder-actions">
        <ProposeButton
          info={rootStatus === 'pending' || rootStatus === 'ready' ? undefined : action.help}
          label={action.label}
          title={action.help}
          txs={
            // Never install the multisig-path guard alone: modules would bypass every policy.
            (!guardInstalled && paths.multisig && !paths.module) ||
            ((guardInstalled || !installGuard) && draft.length === 0)
              ? []
              : action.txs
          }
          onProposed={action.onProposed}
        />
      </div>
    </Card>
  )
}
