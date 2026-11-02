import { useState } from 'react'
import { type Hex, getAddress, isAddress } from 'viem'
import { TOKENS } from '../../config/contracts'
import { useSandbox } from '../../context'
import {
  ANY,
  type AttachmentChange,
  CallMatch,
  type LabelContext,
  OP_ALL,
  OP_CALL,
  OP_DELEGATECALL,
  OWNERS,
  PERIOD_PRESETS,
  POLICY_INFO,
  type PolicyName,
  SELECTORS,
  TIMELOCK_PRESETS,
  type V2Deployment,
  allowChange,
  deployedPolicies,
  denyChange,
  describeChange,
  namesSelector,
  namesTo,
  policyChange,
} from '../../lib/v2'
import { parseSelectorInput } from '../../lib/validation'
import { rolesStore } from '../../store'
import { AddressShortcuts } from '../AddressShortcuts'
import { InfoTip } from '../Tooltip'
import { Card, Field, Notice } from '../ui'
import { NATIVE, type RawSettings, buildSettings, initialRaw } from './settingsForm'
import { TemplatePicker } from './TemplatePicker'

type Kind = 'allow' | 'deny' | PolicyName

const CALL_MATCHES = [
  { value: CallMatch.ANY, label: 'Any call' },
  { value: CallMatch.TO, label: 'Any function on a contract' },
  { value: CallMatch.SELECTOR, label: 'One function on any contract' },
  { value: CallMatch.TO_SELECTOR, label: 'One function on a contract' },
] as const

const KNOWN_FUNCTIONS = [
  'transfer',
  'approve',
  'transferFrom',
  'swapOwner',
  'addOwnerWithThreshold',
  'signCowOrder',
  'signPermit',
] as const satisfies readonly (keyof typeof SELECTORS)[]

const POLICY_HELP: Record<Kind, string> = {
  allow: 'Grants the calls (CALL only unless DELEGATECALL is ticked, which needs one actor on one function).',
  deny: 'Denies the calls, whoever else allows them.',
  freeze: "Denies while the guardian's freeze is active (Safe-wide and/or this actor's kill switch).",
  timelock: 'The transaction must be scheduled first and wait the delay.',
  recipients: 'Payments and approvals only to listed addresses (native value included).',
  limit: 'A transfer budget per period: transfers, approvals, native value and CoW orders count.',
  args: 'A constraint on a static argument of a function.',
  coSigner: 'A co-signature from this address, on both paths.',
  safenet: 'A Safenet attestation, on both paths.',
  quorum: 'More owner signatures than the threshold (owner path only).',
}

const tokenOptions = [
  ...Object.values(TOKENS).map((t) => ({ value: t.address as string, label: t.symbol })),
  { value: NATIVE, label: 'ETH (native)' },
]

/** Inputs for one policy's settings; `raw` holds every policy's fields. */
function SettingsFields({
  policy,
  raw,
  set,
}: {
  policy: PolicyName
  raw: RawSettings
  set: (patch: Partial<RawSettings>) => void
}) {
  const text = (key: keyof RawSettings, label: string, info?: string, placeholder?: string) => (
    <Field label={label} info={info}>
      <input
        value={raw[key] as string}
        placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value } as Partial<RawSettings>)}
      />
    </Field>
  )
  const check = (key: keyof RawSettings, label: string, info?: string) => (
    <label className="row">
      <input
        type="checkbox"
        checked={raw[key] as boolean}
        onChange={(e) => set({ [key]: e.target.checked } as Partial<RawSettings>)}
      />
      {label}
      {info && <InfoTip>{info}</InfoTip>}
    </label>
  )
  const token = (key: 'token' | 'tierToken') => (
    <Field label="Token">
      <select value={raw[key]} onChange={(e) => set({ [key]: e.target.value })}>
        {tokenOptions.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </Field>
  )
  switch (policy) {
    case 'freeze':
      return (
        <div className="row wrap">
          {check('safeWide', 'Reads the Safe-wide freeze')}
          {check(
            'actorFreeze',
            "Reads this actor's own freeze (kill switch)",
            'Owners are only frozen Safe-wide.',
          )}
        </div>
      )
    case 'timelock':
      return (
        <div className="grid-2">
          <Field label="Delay (seconds)">
            <input value={raw.delay} onChange={(e) => set({ delay: e.target.value })} />
            <span className="preset-links small">
              {TIMELOCK_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="link"
                  onClick={() => set({ delay: String(p.seconds) })}
                >
                  {p.label}
                </button>
              ))}
            </span>
          </Field>
          {text(
            'window',
            'Execution window (seconds, 0 = none)',
            'A ready schedule expires after this window.',
          )}
          {text(
            'cancellers',
            'Cancellers',
            'Addresses that may cancel a queued call (e.g. another Safe).',
            '0x…, 0x…',
          )}
          {check('clearOnFreeze', 'A freeze clears the queue', 'True for owners; false for Recovery.')}
        </div>
      )
    case 'recipients':
      return (
        <div className="grid-2">
          {text('recipients', 'Recipients', 'Payees of transfer / transferFrom / native value.', '0x…, 0x…')}
          {text('spenders', 'Spenders', 'Who may be approved.', '0x…, 0x…')}
          {text('maxApproval', 'Max approval (base units, empty = unlimited)')}
          {check('strict', 'Deny calls that are not payments or approvals')}
        </div>
      )
    case 'limit':
      return (
        <div className="grid-2">
          {token('token')}
          {text('amount', 'Budget (token units)')}
          <Field label="Period">
            <select value={raw.period} onChange={(e) => set({ period: e.target.value })}>
              {PERIOD_PRESETS.map((p) => (
                <option key={p.label} value={String(p.seconds)}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {check(
            'passUnpriced',
            'Unpriced calls pass',
            'By default the budget denies any call it cannot price (e.g. a swap). Tick it for owners.',
          )}
        </div>
      )
    case 'args':
      return (
        <div className="grid-2">
          {text('argSelector', 'Function', undefined, 'deposit(uint256,address)')}
          {text('argIndex', 'Argument index (0-based, static args)')}
          <Field label="Comparison">
            <select value={raw.argOp} onChange={(e) => set({ argOp: e.target.value })}>
              {['==', '!=', 'in', 'not in', '≤', '≥', '== the Safe'].map((label, i) => (
                <option key={label} value={String(i)}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {text('argValues', 'Values (numbers or addresses)', undefined, '0x…, 100')}
          {check('strict', 'Deny functions without a constraint')}
        </div>
      )
    case 'coSigner':
      return <div className="grid-2">{text('cosigner', 'Co-signer address')}</div>
    case 'safenet':
      return <p className="muted small">No settings.</p>
    case 'quorum':
      return (
        <div className="grid-2">
          {text('required', 'Signatures required')}
          {token('tierToken')}
          {text('tierAbove', 'Tier: above this amount (empty = no tier)')}
          {text('tierRequired', 'Tier: signatures required')}
        </div>
      )
  }
}

/** Who the scope is for: Everyone, Owners, a module, a local role or any address. */
function useActorOptions() {
  const { state } = useSandbox()
  const roles = rolesStore.use()
  const options: { value: string; label: string }[] = [
    { value: ANY, label: 'Everyone (every actor, owners included)' },
    { value: OWNERS, label: 'Owners (multisig path)' },
  ]
  for (const m of state?.modules ?? [])
    options.push({ value: m, label: `${roles.find((r) => r.address === m)?.label ?? 'Module'} — ${m}` })
  for (const r of roles)
    if (!options.some((o) => o.value === r.address))
      options.push({ value: r.address, label: `${r.label} — ${r.address}` })
  return options
}

/**
 * Who → Doing what → Policy + settings, with a live sentence. `onPreview` shows the change on the
 * org chart before it is added; `onAdd` merges it into the draft.
 */
export function ScopeBuilder({
  deployment,
  ctx,
  onPreview,
  onAdd,
  onAddSet,
}: {
  deployment: V2Deployment
  ctx: LabelContext
  onPreview: (change: AttachmentChange | undefined) => void
  onAdd: (change: AttachmentChange) => void
  onAddSet: Parameters<typeof TemplatePicker>[0]['onAdd']
}) {
  const actors = useActorOptions()
  const [mode, setMode] = useState<'template' | 'custom'>('template')
  const [actor, setActor] = useState<string>(OWNERS)
  const [customActor, setCustomActor] = useState('')
  const [callMatch, setCallMatch] = useState<CallMatch>(CallMatch.ANY)
  const [target, setTarget] = useState('')
  const [fn, setFn] = useState('')
  const [kind, setKind] = useState<Kind>('allow')
  const [delegate, setDelegate] = useState(false)
  const [raw, setRaw] = useState<RawSettings>(initialRaw)
  const policies = deployedPolicies(deployment)

  const who = actor === 'custom' ? customActor.trim() : actor
  const problems: string[] = []
  if (!isAddress(who, { strict: false })) problems.push('Pick who the scope is for')
  if (namesTo(callMatch) && !isAddress(target.trim(), { strict: false })) problems.push('Enter the contract')
  const selector = parseSelectorInput(fn)
  if (namesSelector(callMatch) && (!selector.ok || !fn.trim()))
    problems.push(selector.ok ? 'Enter the function' : selector.error)

  const opMask = kind === 'allow' ? (delegate ? OP_CALL | OP_DELEGATECALL : OP_CALL) : OP_ALL
  const settings = kind === 'allow' || kind === 'deny' ? undefined : buildSettings(kind, raw)
  if (settings?.error) problems.push(settings.error)

  let change: AttachmentChange | undefined
  if (problems.length === 0) {
    const scope = {
      actor: getAddress(who),
      to: namesTo(callMatch) ? getAddress(target.trim()) : ANY,
      selector: (namesSelector(callMatch) && selector.ok ? selector.value : '0x00000000') as Hex,
      callMatch,
    }
    change =
      kind === 'allow'
        ? allowChange(scope, opMask)
        : kind === 'deny'
          ? denyChange(scope)
          : policyChange(deployment, scope, settings!.value!)
  }
  const sentence = change ? describeChange(change, deployment, ctx) : undefined

  const reset = () => onPreview(undefined)
  return (
    <Card
      title="Scope builder"
      actions={
        <div className="tabs" role="group" aria-label="Builder mode">
          {(['template', 'custom'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'tab active' : 'tab'}
              onClick={() => setMode(m)}
            >
              {m === 'template' ? 'From a template' : 'One attachment'}
            </button>
          ))}
        </div>
      }
    >
      {mode === 'template' ? (
        <TemplatePicker deployment={deployment} onAdd={onAddSet} />
      ) : (
        <div className="stack">
          <h3>1 · Who</h3>
          <div className="grid-2">
            <Field label="Actor">
              <select value={actor} onChange={(e) => setActor(e.target.value)}>
                {actors.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                <option value="custom">Another address…</option>
              </select>
            </Field>
            {actor === 'custom' && (
              <Field label="Address" after={<AddressShortcuts onPick={setCustomActor} />}>
                <input
                  value={customActor}
                  onChange={(e) => setCustomActor(e.target.value)}
                  placeholder="0x…"
                />
              </Field>
            )}
          </div>

          <h3>2 · Doing what</h3>
          <div className="grid-2">
            <Field label="Calls">
              <select value={callMatch} onChange={(e) => setCallMatch(Number(e.target.value) as CallMatch)}>
                {CALL_MATCHES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            {namesTo(callMatch) && (
              <Field
                label="Contract"
                after={
                  <span className="row wrap small">
                    {Object.values(TOKENS).map((t) => (
                      <button
                        key={t.address}
                        type="button"
                        className="link"
                        onClick={() => setTarget(t.address)}
                      >
                        {t.symbol}
                      </button>
                    ))}
                    <button type="button" className="link" onClick={() => setTarget(deployment.signLib)}>
                      PolicySignLib
                    </button>
                    <AddressShortcuts onPick={setTarget} />
                  </span>
                }
              >
                <input value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="0x…" />
              </Field>
            )}
            {namesSelector(callMatch) && (
              <Field
                label="Function"
                info="A selector (0x…) or a signature such as transfer(address,uint256)."
                after={
                  <span className="row wrap small">
                    {KNOWN_FUNCTIONS.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="link"
                        onClick={() => setFn(SELECTORS[name])}
                      >
                        {name}
                      </button>
                    ))}
                  </span>
                }
              >
                <input
                  value={fn}
                  onChange={(e) => setFn(e.target.value)}
                  placeholder="transfer(address,uint256)"
                />
              </Field>
            )}
          </div>

          <h3>3 · Policy</h3>
          <div className="grid-2">
            <Field label="Attach" hint={POLICY_HELP[kind]}>
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
                {policies.map((p) => (
                  <option key={p} value={p}>
                    {POLICY_INFO[p].label}
                  </option>
                ))}
              </select>
            </Field>
            {kind === 'allow' && (
              <label className="row">
                <input type="checkbox" checked={delegate} onChange={(e) => setDelegate(e.target.checked)} />
                DELEGATECALL too
                <InfoTip>
                  The target then runs with the Safe&apos;s storage. Only accepted for one actor on one
                  function of one contract.
                </InfoTip>
              </label>
            )}
          </div>
          {kind !== 'allow' && kind !== 'deny' && (
            <SettingsFields policy={kind} raw={raw} set={(patch) => setRaw((r) => ({ ...r, ...patch }))} />
          )}

          {sentence ? (
            <Notice>
              <strong>{sentence}</strong>
            </Notice>
          ) : (
            <p className="muted small">{problems[0]}</p>
          )}
          <div className="row">
            <button type="button" className="btn" disabled={!change} onClick={() => onPreview(change)}>
              Preview on the chart
            </button>
            <button type="button" className="link" onClick={reset}>
              clear preview
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!change}
              onClick={() => {
                onAdd(change!)
                reset()
              }}
            >
              Add to draft
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}
