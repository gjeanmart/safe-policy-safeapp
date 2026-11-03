import { useState } from 'react'
import { type Hex, getAddress, isAddress } from 'viem'
import { COW, TOKENS } from '../../config/contracts'
import { useSandbox } from '../../context'
import {
  ANY,
  ARGS_PRESETS,
  ArgsOp,
  ArgsTarget,
  CallMatch,
  type Change,
  HUMAN_LEVEL_LABELS,
  type LabelContext,
  NO_SELECTOR,
  OP_ALL,
  OP_CALL,
  OP_DELEGATECALL,
  OWNERS,
  PERIOD_PRESETS,
  POLICY_INFO,
  type PolicyName,
  SELECTORS,
  TIMELOCK_PRESETS,
  type TemplateContext,
  type V2Deployment,
  allowChange,
  argsLabel,
  changeAttachmentId,
  deployedPolicies,
  denyChange,
  describeChange,
  humanLevel,
  levelOf,
  namesSelector,
  namesTo,
  policyChange,
} from '../../lib/v2'
import { parseSelectorInput } from '../../lib/validation'
import { rolesStore } from '../../store'
import { AddressShortcuts } from '../AddressShortcuts'
import { InfoTip } from '../Tooltip'
import { Card, Field, Notice } from '../ui'
import { NATIVE, type RawSettings, buildConditions, buildSettings, initialRaw } from './settingsForm'
import { TemplatePicker } from './TemplatePicker'

type Kind = 'allow' | 'deny' | PolicyName

const WHAT = [
  { value: CallMatch.ANY, label: 'Any call' },
  { value: CallMatch.CONTRACT, label: 'Any function of a contract' },
  { value: CallMatch.FUNCTION, label: 'One function of a contract' },
] as const

const KNOWN_FUNCTIONS = [
  'transfer',
  'approve',
  'transferFrom',
  'setPreSignature',
  'swapOwner',
  'addOwnerWithThreshold',
  'configure',
] as const satisfies readonly (keyof typeof SELECTORS)[]

const HELP: Record<Kind, string> = {
  allow:
    'Grants the calls to this actor (only an Allow grants; deny by default). Add conditions to pin arguments.',
  deny: 'Denies the calls, whatever else allows them.',
  timelock:
    'Delay (schedule first, wait), freeze by guardians (at most F, then a cooldown C), cancel by cancellers. Delay 0 = a kill switch only.',
  args: 'Conditions on the static arguments, target or value of every matched call.',
  limit: 'A budget per token and period: transfers, approvals (in full) and native value count.',
  coSigner: 'M-of-N approvals pushed on-chain before execution, on both paths.',
  safenet: 'A Safenet attestation pushed on-chain before execution, on both paths.',
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
  const text = (
    key: keyof RawSettings,
    label: string,
    info?: string,
    placeholder?: string,
    shortcuts = false,
  ) => (
    <Field
      label={label}
      info={info}
      after={
        shortcuts ? (
          <AddressShortcuts
            onPick={(a) =>
              set({ [key]: (raw[key] as string).trim() ? `${raw[key]}, ${a}` : a } as Partial<RawSettings>)
            }
          />
        ) : undefined
      }
    >
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
  switch (policy) {
    case 'timelock':
      return (
        <div className="grid-2">
          <Field label="Delay (seconds, 0 = kill switch only)">
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
            'guardians',
            'Guardians',
            'May freeze (and lift) this attachment. Not at Everyone.',
            '0x…, 0x…',
            true,
          )}
          {text('lifters', 'Lifters', 'May lift a freeze only (e.g. the recovery module).', '0x…', true)}
          {text(
            'cancellers',
            'Cancellers',
            "May cancel a schedule this attachment matched (e.g. another Safe), without limit; never an owners' engine.configure.",
            '0x…',
            true,
          )}
        </div>
      )
    case 'limit':
      return (
        <div className="grid-2">
          <Field label="Token">
            <select value={raw.token} onChange={(e) => set({ token: e.target.value })}>
              {tokenOptions.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
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
            'Other calls pass (passUnpriced)',
            'By default the budget denies any call it cannot price (a protocol call, a DELEGATECALL). A spend of an unlisted token is always denied.',
          )}
        </div>
      )
    case 'coSigner':
      return (
        <div className="grid-2">
          {text('approvers', 'Approvers', 'EOAs or ERC-1271 contracts; never the Safe.', '0x…, 0x…', true)}
          {text('required', 'Required approvals')}
        </div>
      )
    case 'args':
      return (
        <div className="grid-2">
          {text('argSelector', 'Function (empty = any call)', undefined, 'deposit(uint256,address)')}
          <Field label="Reads">
            <select value={raw.argTarget} onChange={(e) => set({ argTarget: e.target.value })}>
              <option value={String(ArgsTarget.WORD)}>an argument</option>
              <option value={String(ArgsTarget.CALL_TO)}>the target</option>
              <option value={String(ArgsTarget.VALUE)}>the native value</option>
            </select>
          </Field>
          {Number(raw.argTarget) === ArgsTarget.WORD &&
            text('argIndex', 'Argument index (0-based, static head word)')}
          <Field label="Comparison">
            <select value={raw.argOp} onChange={(e) => set({ argOp: e.target.value })}>
              {Object.entries({
                '=': ArgsOp.EQ,
                '≠': ArgsOp.NEQ,
                in: ArgsOp.IN,
                'not in': ArgsOp.NOT_IN,
                '≤': ArgsOp.LTE,
                '≥': ArgsOp.GTE,
                'is the Safe': ArgsOp.EQ_SAFE,
              }).map(([label, op]) => (
                <option key={label} value={String(op)}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {Number(raw.argOp) !== ArgsOp.EQ_SAFE &&
            text('argValues', 'Values (numbers or addresses)', undefined, '0x…, 100')}
          {check('strict', 'Deny calls no condition applies to')}
        </div>
      )
    case 'safenet':
      return <p className="muted small">No settings.</p>
  }
}

/** The Allow row's optional conditions (ArgsPolicy at the same scope), with the three presets. */
function ConditionsFields({
  raw,
  set,
  hasFunction,
}: {
  raw: RawSettings
  set: (patch: Partial<RawSettings>) => void
  hasFunction: boolean
}) {
  return (
    <div className="stack">
      <Field
        label="Conditions"
        hint={raw.conditions === 'none' ? undefined : ARGS_PRESETS[raw.conditions].help}
      >
        <select
          value={raw.conditions}
          onChange={(e) => set({ conditions: e.target.value as RawSettings['conditions'] })}
        >
          <option value="none">None</option>
          {(Object.keys(ARGS_PRESETS) as (keyof typeof ARGS_PRESETS)[]).map((p) => (
            <option key={p} value={p} disabled={p === 'receiverIsSafe' && !hasFunction}>
              {ARGS_PRESETS[p].label}
            </option>
          ))}
        </select>
      </Field>
      {(raw.conditions === 'recipients' || raw.conditions === 'spenders') && (
        <div className="grid-2">
          <Field
            label={raw.conditions === 'recipients' ? 'Recipients' : 'Spenders'}
            after={
              <span className="row wrap small">
                {raw.conditions === 'spenders' && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => set({ condAddresses: COW.vaultRelayer })}
                  >
                    CoW VaultRelayer
                  </button>
                )}
                <AddressShortcuts
                  onPick={(a) =>
                    set({ condAddresses: raw.condAddresses.trim() ? `${raw.condAddresses}, ${a}` : a })
                  }
                />
              </span>
            }
          >
            <input
              value={raw.condAddresses}
              onChange={(e) => set({ condAddresses: e.target.value })}
              placeholder="0x…, 0x…"
            />
          </Field>
          {raw.conditions === 'spenders' && (
            <Field label="Cap per approval (base units, empty = none)">
              <input value={raw.condCap} onChange={(e) => set({ condCap: e.target.value })} />
            </Field>
          )}
        </div>
      )}
      {raw.conditions === 'receiverIsSafe' && (
        <Field
          label="Receiver argument index (0-based)"
          info="E.g. Aave supply onBehalfOf = 2, Uniswap exactInputSingle recipient = 3."
        >
          <input value={raw.condIndex} onChange={(e) => set({ condIndex: e.target.value })} />
        </Field>
      )}
    </div>
  )
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

type OpChoice = 'default' | 'call' | 'delegatecall' | 'both'
const OP_MASKS: Record<Exclude<OpChoice, 'default'>, number> = {
  call: OP_CALL,
  delegatecall: OP_DELEGATECALL,
  both: OP_ALL,
}

/**
 * Who (Everyone / an actor) × What (any call / a contract / one function) × Op, then Allow (with
 * optional conditions), Deny or a policy with its settings, and a live sentence. `onPreview` shows
 * the changes on the org chart before they are added; `onAdd` merges them into the draft.
 */
export function ScopeBuilder({
  deployment,
  ctx,
  context,
  onPreview,
  onAdd,
}: {
  deployment: V2Deployment
  ctx: LabelContext
  context: TemplateContext
  onPreview: (changes: Change[] | undefined) => void
  onAdd: (changes: Change[]) => void
}) {
  const actors = useActorOptions()
  const [mode, setMode] = useState<'template' | 'custom'>('template')
  const [actor, setActor] = useState<string>(OWNERS)
  const [customActor, setCustomActor] = useState('')
  const [callMatch, setCallMatch] = useState<CallMatch>(CallMatch.ANY)
  const [target, setTarget] = useState('')
  const [fn, setFn] = useState('')
  const [kind, setKind] = useState<Kind>('allow')
  const [op, setOp] = useState<OpChoice>('default')
  const [raw, setRaw] = useState<RawSettings>(initialRaw)
  const set = (patch: Partial<RawSettings>) => setRaw((r) => ({ ...r, ...patch }))
  const policies = deployedPolicies(deployment)

  const who = actor === 'custom' ? customActor.trim() : actor
  const problems: string[] = []
  if (!isAddress(who, { strict: false })) problems.push('Pick who the scope is for')
  if (namesTo(callMatch) && !isAddress(target.trim(), { strict: false })) problems.push('Enter the contract')
  const selector = parseSelectorInput(fn)
  if (namesSelector(callMatch) && (!selector.ok || !fn.trim()))
    problems.push(selector.ok ? 'Enter the function' : selector.error)
  const selectorValue = namesSelector(callMatch) && selector.ok ? (selector.value as Hex) : undefined

  const opMask = op === 'default' ? 0 : OP_MASKS[op]
  const settingsContext = {
    safe: context.safe,
    actor: isAddress(who, { strict: false }) ? getAddress(who) : ANY,
  }
  const settings = kind === 'allow' || kind === 'deny' ? undefined : buildSettings(kind, raw, settingsContext)
  if (settings?.error) problems.push(settings.error)
  const conditions = kind === 'allow' ? buildConditions(raw, selectorValue) : undefined
  if (conditions?.error) problems.push(conditions.error)

  let changes: Change[] | undefined
  if (problems.length === 0) {
    const scope = {
      actor: getAddress(who),
      to: namesTo(callMatch) ? getAddress(target.trim()) : ANY,
      selector: selectorValue ?? NO_SELECTOR,
      callMatch,
    }
    changes =
      kind === 'allow'
        ? [
            allowChange(scope, opMask || OP_CALL),
            ...(conditions?.value
              ? [policyChange(deployment, scope, { policy: 'args', settings: conditions.value })]
              : []),
          ]
        : kind === 'deny'
          ? [denyChange(scope, opMask || OP_ALL)]
          : [policyChange(deployment, scope, settings!.value!, opMask || OP_ALL)]
  }
  const isAttached = (c: Change) => context.attachments.some((a) => a.attachmentId === changeAttachmentId(c))
  const sentence = changes
    ? kind === 'allow' && conditions?.value
      ? `${describeChange(changes[0]!, deployment, ctx)}, with conditions: ${argsLabel(conditions.value, ctx)}`
      : describeChange(changes[0]!, deployment, ctx, isAttached(changes[0]!))
    : undefined
  const level = isAddress(who, { strict: false }) ? levelOf({ actor: getAddress(who), callMatch }) : undefined

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
              {m === 'template' ? 'From a template' : 'One rule'}
            </button>
          ))}
        </div>
      }
    >
      {mode === 'template' ? (
        <TemplatePicker deployment={deployment} context={context} ctx={ctx} onAdd={onAdd} />
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

          <h3>2 · What</h3>
          <div className="grid-2">
            <Field
              label="Calls"
              hint={level !== undefined ? `Level: ${HUMAN_LEVEL_LABELS[humanLevel(level)]}` : undefined}
            >
              <select value={callMatch} onChange={(e) => setCallMatch(Number(e.target.value) as CallMatch)}>
                {WHAT.map((c) => (
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
                    <button type="button" className="link" onClick={() => setTarget(COW.settlement)}>
                      CoW Settlement
                    </button>
                    <button type="button" className="link" onClick={() => setTarget(deployment.engine)}>
                      Policy engine
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
                info="A selector (0x…) or a signature such as transfer(address,uint256). 0x00000000 = empty calldata (plain native transfer)."
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
            <Field
              label="Operation"
              info="A mask on the attachment, not part of the scope. Default: CALL for an Allow, both for a Deny or a policy (so a granted DELEGATECALL is still checked). DELEGATECALL can only be allowed for one actor on one function."
            >
              <select value={op} onChange={(e) => setOp(e.target.value as OpChoice)}>
                <option value="default">Default ({kind === 'allow' ? 'CALL' : 'CALL + DELEGATECALL'})</option>
                <option value="call">CALL</option>
                <option value="delegatecall">DELEGATECALL</option>
                <option value="both">CALL + DELEGATECALL</option>
              </select>
            </Field>
          </div>

          <h3>3 · Rule</h3>
          <div className="grid-2">
            <Field label="Attach" hint={HELP[kind]}>
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
                {policies.map((p) => (
                  <option key={p} value={p}>
                    {POLICY_INFO[p].label} ({POLICY_INFO[p].contract})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {kind === 'allow' && policies.includes('args') && (
            <ConditionsFields raw={raw} set={set} hasFunction={selectorValue !== undefined} />
          )}
          {kind !== 'allow' && kind !== 'deny' && <SettingsFields policy={kind} raw={raw} set={set} />}

          {sentence ? (
            <Notice>
              <strong>{sentence}</strong>
            </Notice>
          ) : (
            <p className="muted small">{problems[0]}</p>
          )}
          <div className="row">
            <button type="button" className="btn" disabled={!changes} onClick={() => onPreview(changes)}>
              Preview on the chart
            </button>
            <button type="button" className="link" onClick={() => onPreview(undefined)}>
              clear preview
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!changes}
              onClick={() => {
                onAdd(changes!)
                onPreview(undefined)
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
