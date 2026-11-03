import { useState } from 'react'
import { type Address, getAddress, isAddress, parseUnits } from 'viem'
import { COW, TOKENS } from '../../config/contracts'
import { useSandbox } from '../../context'
import {
  type Change,
  DAY,
  type LabelContext,
  MONTH,
  OWNERS,
  PERIOD_PRESETS,
  type PolicyName,
  TIMELOCK_PRESETS,
  type TemplateContext,
  type TemplateId,
  type V2Deployment,
  deployedPolicies,
  describeChange,
  templates,
} from '../../lib/v2'
import { parseAddressList } from '../../lib/validation'
import { canAct, rolesStore } from '../../store'
import { AddressShortcuts } from '../AddressShortcuts'
import { Field, Notice } from '../ui'

type Values = Record<string, string>

type FieldDef = {
  key: string
  label: string
  kind: 'actor' | 'addresses' | 'token' | 'text' | 'delay' | 'period' | 'bool'
  initial?: string
  info?: string
}

type TemplateForm = {
  id: TemplateId
  needs: PolicyName[]
  fields: FieldDef[]
  /** The changes, or the first problem. */
  build: (deployment: V2Deployment, v: Values, context: TemplateContext) => Change[] | string
}

const tokenOf = (address: string) =>
  Object.values(TOKENS).find((t) => t.address.toLowerCase() === address.toLowerCase())

type Err = { error: string }
const isErr = (x: unknown): x is Err => typeof x === 'object' && x !== null && 'error' in x
const address = (v: string, what: string): Address | Err =>
  isAddress(v.trim(), { strict: false }) ? getAddress(v.trim()) : { error: `Pick ${what}` }
const list = (v: string, what: string, required = false): Address[] | Err => {
  if (!v.trim()) return required ? { error: `Enter ${what}` } : []
  const parsed = parseAddressList(v)
  return parsed.ok ? parsed.value : { error: `${what}: ${parsed.error}` }
}
const units = (v: string, token: string): bigint | Err => {
  try {
    return parseUnits(v.trim(), tokenOf(token)?.decimals ?? 18)
  } catch {
    return { error: 'Enter an amount' }
  }
}
const firstError = (...values: unknown[]): string | undefined => values.find(isErr)?.error

const payments = (actorLabel: string, amount: string): FieldDef[] => [
  { key: 'actor', label: actorLabel, kind: 'actor' },
  { key: 'token', label: 'Token', kind: 'token', initial: TOKENS.USDC.address },
  { key: 'recipients', label: 'Recipients', kind: 'addresses' },
  { key: 'amount', label: 'Budget', kind: 'text', initial: amount },
  { key: 'period', label: 'Period', kind: 'period', initial: String(MONTH) },
  { key: 'guardians', label: 'Guardians (optional)', kind: 'addresses', info: KILL_SWITCH_INFO },
]

const buildPayments =
  (id: 'opsPayments' | 'committee') => (d: V2Deployment, v: Values, context: TemplateContext) => {
    const actor = address(v.actor!, 'the actor')
    const recipients = list(v.recipients!, 'the recipients', true)
    const amount = units(v.amount!, v.token!)
    const guardians = list(v.guardians!, 'guardians')
    const error = firstError(actor, recipients, amount, guardians)
    if (error) return error
    const params = {
      token: v.token as Address,
      recipients: recipients as Address[],
      amount: amount as bigint,
      period: BigInt(v.period!),
      guardians: guardians as Address[],
    }
    return id === 'committee'
      ? templates.committee.build(d, { committee: actor as Address, ...params }, context)
      : templates.opsPayments.build(d, { ops: actor as Address, ...params }, context)
  }

export const GUARDIANS_INFO =
  'Can freeze this actor at once: nothing it scheduled executes while frozen. A freeze lasts at most F, then a cooldown C before a new one. Pick people or devices that are not this actor.'
export const LIFTERS_INFO =
  'Can end a freeze early, but cannot start one. Typical: the recovery module, so a stuck freeze never blocks recovery.'
export const CANCELLERS_INFO =
  "Can cancel a transaction while it waits in the queue (a veto), as often as they like. They cannot cancel the owners' configuration changes. Listed here, they can veto every call this Timelock delays; to veto only some calls (e.g. USDC transfers), add a Timelock on that narrower scope in One rule."
const KILL_SWITCH_INFO =
  'Can freeze this actor at once (a kill switch: a Timelock with no delay). Leave empty for no kill switch.'

const FORMS: TemplateForm[] = [
  {
    id: 'owners',
    needs: ['timelock'],
    fields: [
      { key: 'actor', label: 'Actor', kind: 'actor', initial: OWNERS },
      { key: 'delay', label: 'Delay (T)', kind: 'delay', initial: String(DAY) },
      {
        key: 'guardians',
        label: 'Guardians',
        kind: 'addresses',
        info: GUARDIANS_INFO,
      },
      { key: 'lifters', label: 'Lifters (optional)', kind: 'addresses', info: LIFTERS_INFO },
      { key: 'cancellers', label: 'Cancellers (optional)', kind: 'addresses', info: CANCELLERS_INFO },
    ],
    build: (d, v, context) => {
      const actor = address(v.actor!, 'the actor')
      const guardians = list(v.guardians!, 'the guardians', true)
      const lifters = list(v.lifters!, 'lifters')
      const cancellers = list(v.cancellers!, 'cancellers')
      const error = firstError(actor, guardians, lifters, cancellers)
      if (error) return error
      return templates.owners.build(
        d,
        {
          actor: actor as Address,
          delay: Number(v.delay),
          guardians: guardians as Address[],
          lifters: lifters as Address[],
          cancellers: cancellers as Address[],
        },
        context,
      )
    },
  },
  {
    id: 'everyone',
    needs: ['timelock'],
    fields: [
      { key: 'delay', label: 'Delay (T)', kind: 'delay', initial: String(DAY) },
      { key: 'cancellers', label: 'Cancellers (optional)', kind: 'addresses', info: CANCELLERS_INFO },
    ],
    build: (d, v, context) => {
      const cancellers = list(v.cancellers!, 'cancellers')
      if (isErr(cancellers)) return cancellers.error
      return templates.everyone.build(d, { delay: Number(v.delay), cancellers }, context)
    },
  },
  {
    id: 'opsPayments',
    needs: ['args', 'limit'],
    fields: payments('Actor', '5000'),
    build: buildPayments('opsPayments'),
  },
  {
    id: 'agentCow',
    needs: ['args', 'limit', 'coSigner', 'timelock'],
    fields: [
      { key: 'agent', label: 'Actor', kind: 'actor' },
      { key: 'token', label: 'Sell token', kind: 'token', initial: TOKENS.WETH.address },
      { key: 'amount', label: 'Budget (approval cap too)', kind: 'text', initial: '1' },
      { key: 'period', label: 'Period', kind: 'period', initial: String(DAY) },
      { key: 'approvers', label: 'Co-signer(s)', kind: 'addresses' },
      { key: 'guardians', label: 'Guardians', kind: 'addresses', info: KILL_SWITCH_INFO },
    ],
    build: (d, v, context) => {
      const agent = address(v.agent!, 'the agent')
      const approvers = list(v.approvers!, 'a co-signer', true)
      const guardians = list(v.guardians!, 'a guardian', true)
      const amount = units(v.amount!, v.token!)
      const error = firstError(agent, approvers, guardians, amount)
      if (error) return error
      return templates.agentCow.build(
        d,
        {
          agent: agent as Address,
          approvers: approvers as Address[],
          guardians: guardians as Address[],
          vaultRelayer: COW.vaultRelayer,
          settlement: COW.settlement,
          budgets: [{ token: v.token as Address, amount: amount as bigint, period: BigInt(v.period!) }],
        },
        context,
      )
    },
  },
  {
    id: 'recovery',
    needs: ['timelock'],
    fields: [
      { key: 'recovery', label: 'Actor (the recovery module)', kind: 'actor' },
      { key: 'delay', label: 'Recovery timelock (R > T)', kind: 'delay', initial: String(3 * DAY) },
      {
        key: 'configure',
        label: 'May also call engine.configure (the way back)',
        kind: 'bool',
        initial: 'true',
      },
      {
        key: 'lifter',
        label: "Lifter of the owners' Timelock",
        kind: 'bool',
        initial: 'true',
        info: "Adds it to the lifters of the owners' (Owners, *) Timelock, if there is one (re-configures it).",
      },
    ],
    build: (d, v, context) => {
      const recovery = address(v.recovery!, 'the recovery actor')
      if (isErr(recovery)) return recovery.error
      return templates.recovery.build(
        d,
        { recovery, delay: Number(v.delay), configure: v.configure === 'true', lifter: v.lifter === 'true' },
        context,
      )
    },
  },
]

const initialValues = (form: TemplateForm): Values =>
  Object.fromEntries(form.fields.map((f) => [f.key, f.initial ?? '']))

/** Actors offered in the forms: the Safe's modules and the local roles. */
function useActors() {
  const { state } = useSandbox()
  const roles = rolesStore.use().filter(canAct)
  const actors: { value: string; label: string }[] = [{ value: OWNERS, label: 'Owners (multisig)' }]
  for (const m of state?.modules ?? [])
    actors.push({ value: m, label: roles.find((r) => r.address === m)?.label ?? m })
  for (const r of roles)
    if (!actors.some((a) => a.value === r.address)) actors.push({ value: r.address, label: r.label })
  return actors
}

const DELAYS = [...TIMELOCK_PRESETS, { label: '6d', seconds: 6 * DAY }]

function TemplateFieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: string
  onChange: (v: string) => void
}) {
  const actors = useActors()
  switch (field.kind) {
    case 'actor':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {actors.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      )
    case 'token':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {Object.values(TOKENS).map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
            </option>
          ))}
        </select>
      )
    case 'delay':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {DELAYS.map((p) => (
            <option key={p.seconds} value={String(p.seconds)}>
              {p.label}
            </option>
          ))}
          {!DELAYS.some((p) => String(p.seconds) === value) && <option value={value}>{value}s</option>}
        </select>
      )
    case 'period':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {PERIOD_PRESETS.map((p) => (
            <option key={p.label} value={String(p.seconds)}>
              {p.label}
            </option>
          ))}
        </select>
      )
    case 'bool':
      return (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(String(e.target.checked))}
        />
      )
    default:
      return (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.kind === 'text' ? '' : '0x…, 0x…'}
        />
      )
  }
}

/** Ready-made set-ups (src/lib/v2/templates.ts), merged into the draft. */
export function TemplatePicker({
  deployment,
  context,
  ctx,
  onAdd,
}: {
  deployment: V2Deployment
  context: TemplateContext
  ctx: LabelContext
  onAdd: (changes: Change[]) => void
}) {
  const deployed = deployedPolicies(deployment)
  const [id, setId] = useState<TemplateId>('owners')
  const form = FORMS.find((f) => f.id === id)!
  const [values, setValues] = useState<Record<string, Values>>({})
  const v = values[id] ?? initialValues(form)
  const missing = form.needs.filter((p) => !deployed.includes(p))
  const result = form.build(deployment, v, context)
  const template = templates[id]
  const set = (key: string, next: string) => setValues((all) => ({ ...all, [id]: { ...v, [key]: next } }))

  return (
    <div className="stack">
      <Field label="Template">
        <select value={id} onChange={(e) => setId(e.target.value as TemplateId)}>
          {FORMS.map((f) => (
            <option key={f.id} value={f.id}>
              {templates[f.id].title}
            </option>
          ))}
        </select>
      </Field>
      <p className="small">{template.summary}</p>
      <div className="grid-2">
        {form.fields.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            info={field.info}
            after={
              field.kind === 'addresses' ? (
                <AddressShortcuts
                  onPick={(a) => set(field.key, v[field.key]?.trim() ? `${v[field.key]}, ${a}` : a)}
                />
              ) : undefined
            }
          >
            <TemplateFieldInput
              field={field}
              value={v[field.key] ?? ''}
              onChange={(next) => set(field.key, next)}
            />
          </Field>
        ))}
      </div>
      {id === 'recovery' && (
        <p className="muted small">
          Timeline: the owners&apos; T must be shorter than R (they can detach a rogue recovery in time), and
          R shorter than the guardians&apos; maximum freeze F (recovery replaces compromised owners before a
          freeze ends). Recovery has no guardian: a freeze of the owners never stops it.
        </p>
      )}
      {missing.length > 0 && (
        <Notice tone="warn">
          Not deployed on this chain: {missing.join(', ')}. This template is unavailable.
        </Notice>
      )}
      {typeof result === 'string' ? (
        <p className="muted small">{result}</p>
      ) : (
        <ul className="plain small">
          {result.map((c, i) => (
            <li key={i}>{describeChange(c, deployment, ctx)}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={typeof result === 'string' || missing.length > 0}
          onClick={() => typeof result !== 'string' && onAdd(result)}
        >
          Add to draft
        </button>
      </div>
    </div>
  )
}
