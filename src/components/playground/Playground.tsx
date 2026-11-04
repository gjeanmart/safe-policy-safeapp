import { useState } from 'react'
import { encodeFunctionData } from 'viem'
import { erc20Abi } from '../../abi'
import { TOKENS, type Token } from '../../config/contracts'
import { useSandbox } from '../../context'
import { Operation } from '../../lib/configurations'
import type { Step } from '../../lib/runner'
import { isModuleEnabled, safeTxs } from '../../lib/safe'
import { fieldError, parseAddressInput, parseAmountInput, parseHexInput } from '../../lib/validation'
import { type Role, canAct, rolesStore } from '../../store'
import { Card, Field, Notice } from '../ui'
import { CowSwap } from './CowSwap'
import { ETH, SafeBalance } from './SafeBalance'
import { StepRunner } from './StepRunner'
import { OwnerAction } from '../v2/OwnerAction'
import { AddressShortcuts } from '../AddressShortcuts'
import { ProposeButton } from '../ProposeButton'
import { Term } from '../Term'

const ACTIONS = {
  erc20: 'ERC-20 transfer',
  native: 'Native ETH transfer',
  cow: 'CoW swap',
  custom: 'Custom call',
} as const
type ActionKey = keyof typeof ACTIONS

const tokenList = Object.values(TOKENS) as Token[]

/** Recipient input with shortcuts to the Safe, its owners and the local roles. */
function RecipientInput({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  return (
    <Field label="Recipient" error={error} after={<AddressShortcuts onPick={onChange} />}>
      <input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="0x…" />
    </Field>
  )
}

/** Form + runner for the single-step actions (transfers and custom calls). */
/** `role` undefined = the owners (multisig path): the step goes through {@link OwnerAction}. */
function SimpleAction({ action, role }: { action: Exclude<ActionKey, 'cow'>; role?: Role }) {
  const [token, setToken] = useState<string>(TOKENS.USDC.address)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1')
  const [data, setData] = useState('0x')
  const [operation, setOperation] = useState<Operation>(Operation.CALL)

  const tokenInfo = tokenList.find((t) => t.address === token)!
  const decimals = action === 'erc20' ? tokenInfo.decimals : 18

  // Invalid input is flagged under its field; there is no submit, so a missing value only
  // shows as a prompt where the action buttons would be.
  const fields = {
    recipient: parseAddressInput(recipient, action === 'custom' ? 'target address' : 'address'),
    amount: parseAmountInput(amount, decimals, { required: action === 'erc20' }),
    data: action === 'custom' ? parseHexInput(data) : ({ ok: true, value: '0x' } as const),
  }
  const firstMissing = Object.values(fields).find((f) => !f.ok && f.missing)

  let step: Step | undefined
  if (fields.recipient.ok && fields.amount.ok && fields.data.ok) {
    const to = fields.recipient.value
    const value = fields.amount.value
    step =
      action === 'erc20'
        ? {
            label: `transfer ${amount} ${tokenInfo.symbol} to ${to}`,
            tx: {
              to: tokenInfo.address,
              value: 0n,
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, value] }),
              operation: Operation.CALL,
            },
          }
        : {
            label:
              action === 'native' ? `send ${amount || 0} ETH to ${to}` : `call ${to} (${data.slice(0, 10)})`,
            tx: {
              to,
              value,
              data: fields.data.value,
              operation: action === 'custom' ? operation : Operation.CALL,
            },
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
          <Field label="Target" error={fieldError(fields.recipient, false)}>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder="0x…"
            />
          </Field>
        ) : (
          <RecipientInput
            value={recipient}
            onChange={setRecipient}
            error={fieldError(fields.recipient, false)}
          />
        )}
        <Field
          label={action === 'erc20' ? `Amount (${tokenInfo.symbol})` : 'Value (ETH)'}
          error={fieldError(fields.amount, false)}
          hint={<SafeBalance token={action === 'erc20' ? tokenInfo : ETH} onMax={setAmount} />}
        >
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {action === 'custom' && (
          <>
            <Field label="Calldata" error={fieldError(fields.data, false)}>
              <input value={data} onChange={(e) => setData(e.target.value.trim())} className="mono" />
            </Field>
            {role && (
              <Field label="Operation">
                <select value={operation} onChange={(e) => setOperation(Number(e.target.value) as Operation)}>
                  <option value={Operation.CALL}>CALL</option>
                  <option value={Operation.DELEGATECALL}>DELEGATECALL</option>
                </select>
              </Field>
            )}
          </>
        )}
      </div>
      {step && !role ? (
        <OwnerAction
          key={`${step.tx.to}:${step.tx.value}:${step.tx.data}`}
          call={{ ...step.tx, operation: Operation.CALL, description: step.label }}
        />
      ) : step && role ? (
        <StepRunner role={role} steps={[step]} />
      ) : (
        firstMissing && !firstMissing.ok && <p className="muted">{firstMissing.error}</p>
      )}
    </div>
  )
}

const OWNERS_PATH = 'owners'

export function Playground() {
  const { state, v2Installed } = useSandbox()
  const roles = rolesStore.use().filter(canAct)
  const [roleAddress, setRoleAddress] = useState<string>(roles[0]?.address ?? OWNERS_PATH)
  const [action, setAction] = useState<ActionKey>('erc20')
  const owners = roleAddress === OWNERS_PATH
  const role = roles.find((r) => r.address === roleAddress)
  const actions = (Object.keys(ACTIONS) as ActionKey[]).filter((k) => !(owners && k === 'cow'))
  const current = owners && action === 'cow' ? 'erc20' : action

  return (
    <Card title="Act as a role">
      <div className="stack">
        <div className="row wrap align-end">
          <Field label="Role">
            <select value={roleAddress} onChange={(e) => setRoleAddress(e.target.value)}>
              <option value={OWNERS_PATH}>
                Owners (multisig){state ? ` · ${state.threshold}-of-${state.owners.length} signers` : ''}
              </option>
              {roles.map((r) => (
                <option key={r.address} value={r.address}>
                  {r.label} (module) · {r.address}
                </option>
              ))}
            </select>
          </Field>
          <div className="field action-picker">
            <span className="field-label" id="action-label">
              Action
            </span>
            <div className="tabs" role="group" aria-labelledby="action-label">
              {actions.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={key === current ? 'tab active' : 'tab'}
                  onClick={() => setAction(key)}
                >
                  {ACTIONS[key]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {owners && (
          <p className="muted small">
            An owner transaction, signed by the <Term k="signer">signers</Term>: local signer keys sign here,
            the others in Safe{'{Wallet}'}.
          </p>
        )}

        {role && state && !isModuleEnabled(state, role.address) && (
          <Notice tone="warn" title={`${role.label} is not a module yet`}>
            <div className="row wrap notice-row">
              <span>The Safe rejects its calls (GS104) before any policy runs.</span>
              <ProposeButton
                label="Enable as module"
                variant="secondary"
                preview={false}
                title="Proposes enableModule as an owner transaction (it shows in the Queue)"
                txs={[safeTxs.enableModule(state.address, role.address)]}
              />
            </div>
          </Notice>
        )}

        {current === 'cow' && v2Installed && (
          <Notice
            tone="warn"
            title="A budget cannot price a CoW order"
            more={
              <>
                setPreSignature carries only the order hash, so the spend is the approval to the vault relayer
                (CoW swaps template: a capped approval and a budget with &quot;other calls pass&quot;).
                Off-chain order signatures by the owners bypass the policies when the fallback handler has
                ERC-1271 (see Safe status).
              </>
            }
          >
            Cap the approval to the vault relayer instead.
          </Notice>
        )}

        {current === 'cow' && role ? (
          <CowSwap key={role.address} role={role} />
        ) : (
          current !== 'cow' && <SimpleAction key={`${current}:${roleAddress}`} action={current} role={role} />
        )}
      </div>
    </Card>
  )
}
