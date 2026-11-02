import { useState } from 'react'
import { type Address, getAddress, isAddress, parseUnits } from 'viem'
import { COW, TOKENS } from '../../config/contracts'
import { useSandbox } from '../../context'
import {
  type ChangeSet,
  DAY,
  HOUR,
  MONTH,
  OWNERS,
  PERIOD_PRESETS,
  type PolicyName,
  TIMELOCK_PRESETS,
  type TemplateId,
  type V2Deployment,
  deployedPolicies,
  templates,
} from '../../lib/v2'
import { parseAddressList, parseSelectorInput } from '../../lib/validation'
import { rolesStore } from '../../store'
import { Field, Notice } from '../ui'

type Values = Record<string, string>

type FieldDef = {
  key: string
  label: string
  kind: 'actor' | 'address' | 'addresses' | 'token' | 'text' | 'delay' | 'period' | 'bool' | 'actors'
  initial?: string
  info?: string
}

type TemplateForm = {
  id: TemplateId
  needs: PolicyName[]
  fields: FieldDef[]
  /** The change set, or the first problem. */
  build: (deployment: V2Deployment, v: Values, safe: Address) => ChangeSet | string
}

const tokenOf = (address: string) =>
  Object.values(TOKENS).find((t) => t.address.toLowerCase() === address.toLowerCase())

type Err = { error: string }
const isErr = (x: unknown): x is Err => typeof x === 'object' && x !== null && 'error' in x
const address = (v: string, what: string): Address | Err =>
  isAddress(v.trim(), { strict: false }) ? getAddress(v.trim()) : { error: `Enter ${what}` }
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

const FORMS: TemplateForm[] = [
  {
    id: 'ownersTimelock',
    needs: ['timelock', 'freeze'],
    fields: [
      { key: 'delay', label: 'Owners timelock', kind: 'delay', initial: String(DAY) },
      { key: 'cancellers', label: 'Extra cancellers (optional)', kind: 'addresses' },
    ],
    build: (d, v) => {
      const cancellers = list(v.cancellers!, 'cancellers')
      if (isErr(cancellers)) return cancellers.error
      return templates.ownersTimelock.build(d, { delay: Number(v.delay), cancellers })
    },
  },
  {
    id: 'opsPayments',
    needs: ['recipients', 'limit', 'freeze'],
    fields: [
      { key: 'ops', label: 'Ops actor', kind: 'actor' },
      { key: 'token', label: 'Token', kind: 'token', initial: TOKENS.USDC.address },
      { key: 'recipients', label: 'Vendors (recipients)', kind: 'addresses' },
      { key: 'amount', label: 'Budget', kind: 'text', initial: '5000' },
      { key: 'period', label: 'Period', kind: 'period', initial: String(MONTH) },
    ],
    build: (d, v) => {
      const ops = address(v.ops!, 'the ops actor')
      const recipients = list(v.recipients!, 'the recipients', true)
      const amount = units(v.amount!, v.token!)
      const error = firstError(ops, recipients, amount)
      if (error) return error
      return templates.opsPayments.build(d, {
        ops: ops as Address,
        token: v.token as Address,
        recipients: recipients as Address[],
        amount: amount as bigint,
        period: BigInt(v.period!),
      })
    },
  },
  {
    id: 'agentCow',
    needs: ['recipients', 'limit', 'coSigner', 'freeze'],
    fields: [
      { key: 'agent', label: 'Agent actor', kind: 'actor' },
      { key: 'token', label: 'Sell token', kind: 'token', initial: TOKENS.WETH.address },
      { key: 'amount', label: 'Budget', kind: 'text', initial: '1' },
      { key: 'period', label: 'Period', kind: 'period', initial: String(DAY) },
      { key: 'cosigner', label: 'Co-signer', kind: 'address' },
    ],
    build: (d, v) => {
      const agent = address(v.agent!, 'the agent')
      const cosigner = address(v.cosigner!, 'the co-signer')
      const amount = units(v.amount!, v.token!)
      const error = firstError(agent, cosigner, amount)
      if (error) return error
      return templates.agentCow.build(d, {
        agent: agent as Address,
        cosigner: cosigner as Address,
        vaultRelayer: COW.vaultRelayer,
        budgets: [{ token: v.token as Address, amount: amount as bigint, period: BigInt(v.period!) }],
      })
    },
  },
  {
    id: 'recovery',
    needs: ['timelock'],
    fields: [
      { key: 'recovery', label: 'Recovery actor', kind: 'actor' },
      { key: 'delay', label: 'Recovery timelock (R)', kind: 'delay', initial: String(3 * DAY) },
      { key: 'lifter', label: 'Recovery may lift a freeze', kind: 'bool', initial: 'true' },
    ],
    build: (d, v, safe) => {
      const recovery = address(v.recovery!, 'the recovery actor')
      if (isErr(recovery)) return recovery.error
      return templates.recovery.build(d, {
        safe,
        recovery,
        delay: Number(v.delay),
        lifter: v.lifter === 'true',
      })
    },
  },
  {
    id: 'guardianFreeze',
    needs: ['freeze'],
    fields: [
      { key: 'guardians', label: 'Guardians', kind: 'addresses' },
      { key: 'lifters', label: 'Lifters (optional)', kind: 'addresses' },
      { key: 'actors', label: 'Covers', kind: 'actors', initial: OWNERS },
    ],
    build: (d, v) => {
      const guardians = list(v.guardians!, 'the guardians', true)
      const lifters = list(v.lifters!, 'the lifters')
      const error = firstError(guardians, lifters)
      if (error) return error
      const actors = (v.actors ?? '').split(',').filter(Boolean) as Address[]
      return templates.guardianFreeze.build(d, {
        guardians: guardians as Address[],
        lifters: lifters as Address[],
        actors,
      })
    },
  },
  {
    id: 'cancellableTimelock',
    needs: ['timelock'],
    fields: [
      { key: 'actor', label: 'Actor', kind: 'actor', initial: OWNERS },
      { key: 'target', label: 'Contract', kind: 'address' },
      { key: 'fn', label: 'Function (optional)', kind: 'text', info: 'Empty: any function on the contract.' },
      { key: 'delay', label: 'Delay', kind: 'delay', initial: String(DAY) },
      { key: 'cancellers', label: 'Cancellers (e.g. another Safe)', kind: 'addresses' },
      { key: 'allow', label: 'Also allow the call', kind: 'bool', initial: 'false' },
    ],
    build: (d, v) => {
      const actor = address(v.actor!, 'the actor')
      const target = address(v.target!, 'the contract')
      const cancellers = list(v.cancellers!, 'the cancellers', true)
      const selector = v.fn!.trim() ? parseSelectorInput(v.fn!) : undefined
      const error =
        firstError(actor, target, cancellers) ?? (selector && !selector.ok ? selector.error : undefined)
      if (error) return error
      return templates.cancellableTimelock.build(d, {
        actor: actor as Address,
        target: target as Address,
        selector: selector?.ok ? selector.value : undefined,
        delay: Number(v.delay),
        cancellers: cancellers as Address[],
        allow: v.allow === 'true',
      })
    },
  },
  {
    id: 'quorumLargeTransfers',
    needs: ['quorum'],
    fields: [
      { key: 'required', label: 'Signatures for any owner transaction', kind: 'text', initial: '2' },
      { key: 'token', label: 'Tier token', kind: 'token', initial: TOKENS.USDC.address },
      { key: 'above', label: 'Above this amount', kind: 'text', initial: '10000' },
      { key: 'tierRequired', label: 'Signatures above it', kind: 'text', initial: '3' },
    ],
    build: (d, v) => {
      const above = units(v.above!, v.token!)
      if (isErr(above)) return above.error
      const required = Number(v.required)
      const tierRequired = Number(v.tierRequired)
      if (!Number.isInteger(required) || !Number.isInteger(tierRequired))
        return 'Signatures are whole numbers'
      return templates.quorumLargeTransfers.build(d, {
        required,
        tiers: [{ token: v.token as Address, above, required: tierRequired }],
      })
    },
  },
]

const initialValues = (form: TemplateForm): Values =>
  Object.fromEntries(form.fields.map((f) => [f.key, f.initial ?? '']))

/** Actors offered in the forms: Owners, the Safe's modules and the local roles. */
function useActors() {
  const { state } = useSandbox()
  const roles = rolesStore.use()
  const actors = [{ value: OWNERS as string, label: 'Owners' }]
  for (const m of state?.modules ?? [])
    actors.push({ value: m, label: roles.find((r) => r.address === m)?.label ?? m })
  for (const r of roles)
    if (!actors.some((a) => a.value === r.address)) actors.push({ value: r.address, label: r.label })
  return actors
}

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
    case 'actors': {
      const selected = value.split(',').filter(Boolean)
      return (
        <span className="checklist">
          {actors.map((a) => (
            <label key={a.value} className="row">
              <input
                type="checkbox"
                checked={selected.includes(a.value)}
                onChange={(e) =>
                  onChange(
                    (e.target.checked ? [...selected, a.value] : selected.filter((s) => s !== a.value)).join(
                      ',',
                    ),
                  )
                }
              />
              {a.label}
            </label>
          ))}
        </span>
      )
    }
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
          {[
            { label: '5s (≤ the 5-second engine DELAY)', seconds: 5 },
            { label: '5m', seconds: 5 * 60 },
            ...TIMELOCK_PRESETS,
            { label: '72h', seconds: 3 * DAY },
            { label: '6d', seconds: 6 * DAY },
          ]
            .filter((p, i, all) => all.findIndex((q) => q.seconds === p.seconds) === i)
            .map((p) => (
              <option key={p.seconds} value={String(p.seconds)}>
                {p.label}
              </option>
            ))}
          {!['5', '300', String(HOUR), String(DAY), String(3 * DAY), String(6 * DAY)].includes(value) && (
            <option value={value}>{value}s</option>
          )}
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
          placeholder={field.kind === 'text' ? '' : '0x…'}
        />
      )
  }
}

/** Ready-made set-ups (src/lib/v2/templates.ts), merged into the draft. */
export function TemplatePicker({
  deployment,
  onAdd,
}: {
  deployment: V2Deployment
  onAdd: (set: ChangeSet, title: string) => void
}) {
  const { safe } = useSandbox()
  const deployed = deployedPolicies(deployment)
  const [id, setId] = useState<TemplateId>('ownersTimelock')
  const form = FORMS.find((f) => f.id === id)!
  const [values, setValues] = useState<Record<string, Values>>({})
  const v = values[id] ?? initialValues(form)
  const missing = form.needs.filter((p) => !deployed.includes(p))
  const result = form.build(deployment, v, safe)
  const template = templates[id]

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
      <p className="small">
        {template.summary} <span className="muted">Source: {template.source}.</span>
      </p>
      <div className="grid-2">
        {form.fields.map((field) => (
          <Field key={field.key} label={field.label} info={field.info}>
            <TemplateFieldInput
              field={field}
              value={v[field.key] ?? ''}
              onChange={(next) => setValues((all) => ({ ...all, [id]: { ...v, [field.key]: next } }))}
            />
          </Field>
        ))}
      </div>
      {missing.length > 0 && (
        <Notice tone="warn">
          Not deployed on this chain: {missing.join(', ')}. This template is unavailable.
        </Notice>
      )}
      {typeof result === 'string' && <p className="muted small">{result}</p>}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={typeof result === 'string' || missing.length > 0}
          onClick={() => typeof result !== 'string' && onAdd(result, template.title)}
        >
          Add to draft
        </button>
      </div>
    </div>
  )
}
