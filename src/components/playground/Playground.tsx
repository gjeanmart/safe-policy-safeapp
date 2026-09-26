import { useState } from 'react'
import { type Hex, encodeFunctionData, getAddress, isAddress, isHex, parseUnits } from 'viem'
import { erc20Abi } from '../../abi'
import { TOKENS, type Token } from '../../config/contracts'
import { useSandbox } from '../../context'
import { Operation } from '../../lib/configurations'
import type { Step } from '../../lib/runner'
import { isModuleEnabled } from '../../lib/safe'
import { type Role, rolesStore } from '../../store'
import { Card, Field, Notice } from '../ui'
import { ActivityLog } from './ActivityLog'
import { CowSwap } from './CowSwap'
import { ETH, SafeBalance } from './SafeBalance'
import { StepRunner } from './StepRunner'
import { AddressShortcuts } from '../AddressShortcuts'

const ACTIONS = {
  erc20: 'ERC-20 transfer',
  native: 'Native ETH transfer',
  cow: 'CoW swap',
  custom: 'Custom call',
} as const
type ActionKey = keyof typeof ACTIONS

const tokenList = Object.values(TOKENS) as Token[]

/** Recipient input with shortcuts to the Safe, its owners and the local roles. */
function RecipientInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field label="Recipient">
      <input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="0x…" />
      <AddressShortcuts onPick={onChange} />
    </Field>
  )
}

function parseAmount(value: string, decimals: number): bigint | undefined {
  try {
    return parseUnits(value, decimals)
  } catch {
    return undefined
  }
}

/** Form + runner for the single-step actions (transfers and custom calls). */
function SimpleAction({ action, role }: { action: Exclude<ActionKey, 'cow'>; role: Role }) {
  const [token, setToken] = useState<string>(TOKENS.USDC.address)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1')
  const [data, setData] = useState('0x')
  const [operation, setOperation] = useState<Operation>(Operation.CALL)

  const tokenInfo = tokenList.find((t) => t.address === token)!
  let step: Step | string
  if (!isAddress(recipient)) {
    step = action === 'custom' ? 'Enter a target address' : 'Enter a recipient'
  } else if (action === 'erc20') {
    const value = parseAmount(amount, tokenInfo.decimals)
    step =
      value === undefined
        ? 'Invalid amount'
        : {
            label: `transfer ${amount} ${tokenInfo.symbol} to ${recipient}`,
            tx: {
              to: tokenInfo.address,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [getAddress(recipient), value],
              }),
              operation: Operation.CALL,
            },
          }
  } else {
    const value = parseAmount(amount || '0', 18)
    if (value === undefined) step = 'Invalid amount'
    else if (action === 'custom' && !isHex(data)) step = 'Calldata must be hex'
    else {
      step = {
        label:
          action === 'native'
            ? `send ${amount} ETH to ${recipient}`
            : `call ${recipient} (${data.slice(0, 10)})`,
        tx: {
          to: getAddress(recipient),
          value,
          data: action === 'custom' ? (data as Hex) : '0x',
          operation: action === 'custom' ? operation : Operation.CALL,
        },
      }
    }
  }

  return (
    <div className="stack">
      <div className="grid-2">
        {action === 'erc20' && (
          <Field label="Token">
            <select value={token} onChange={(e) => setToken(e.target.value)}>
              {tokenList.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </Field>
        )}
        {action === 'custom' ? (
          <Field label="Target">
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder="0x…"
            />
          </Field>
        ) : (
          <RecipientInput value={recipient} onChange={setRecipient} />
        )}
        <Field
          label={action === 'erc20' ? `Amount (${tokenInfo.symbol})` : 'Value (ETH)'}
          hint={<SafeBalance token={action === 'erc20' ? tokenInfo : ETH} onMax={setAmount} />}
        >
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {action === 'custom' && (
          <>
            <Field label="Calldata">
              <input value={data} onChange={(e) => setData(e.target.value.trim())} className="mono" />
            </Field>
            <Field label="Operation">
              <select value={operation} onChange={(e) => setOperation(Number(e.target.value) as Operation)}>
                <option value={Operation.CALL}>CALL</option>
                <option value={Operation.DELEGATECALL}>DELEGATECALL</option>
              </select>
            </Field>
          </>
        )}
      </div>
      {typeof step === 'string' ? <p className="muted">{step}</p> : <StepRunner role={role} steps={[step]} />}
    </div>
  )
}

export function Playground() {
  const { state } = useSandbox()
  const roles = rolesStore.use()
  const [roleAddress, setRoleAddress] = useState<string>(roles[0]?.address ?? '')
  const [action, setAction] = useState<ActionKey>('erc20')
  const role = roles.find((r) => r.address === roleAddress)

  return (
    <>
      <Card title="Act as a role">
        {roles.length === 0 ? (
          <Notice>Create a role first (Roles tab).</Notice>
        ) : (
          <div className="stack">
            <div className="row wrap align-end">
              <Field label="Role">
                <select value={roleAddress} onChange={(e) => setRoleAddress(e.target.value)}>
                  {roles.map((r) => (
                    <option key={r.address} value={r.address}>
                      {r.label} — {r.address}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="tabs">
                {(Object.keys(ACTIONS) as ActionKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={key === action ? 'tab active' : 'tab'}
                    onClick={() => setAction(key)}
                  >
                    {ACTIONS[key]}
                  </button>
                ))}
              </div>
            </div>

            {role && state && !isModuleEnabled(state, role.address) && (
              <Notice tone="warn">
                {role.label} is not an enabled module: the Safe itself rejects it (GS104) before any policy
                runs.
              </Notice>
            )}

            {role &&
              (action === 'cow' ? (
                <CowSwap key={role.address} role={role} />
              ) : (
                <SimpleAction key={action} action={action} role={role} />
              ))}
          </div>
        )}
      </Card>
      <ActivityLog />
    </>
  )
}
