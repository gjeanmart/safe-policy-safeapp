import { useState } from 'react'
import { type Address, type Hex, encodeFunctionData, isAddressEqual } from 'viem'
import { cowSettlementAbi, erc20Abi } from '../../abi'
import { publicClient } from '../../config/client'
import { COW, TOKENS, type Token } from '../../config/contracts'
import { useSandbox } from '../../context'
import { Operation } from '../../lib/configurations'
import {
  type CowOrder,
  type CowQuote,
  buildOrder,
  getQuote,
  orderUid,
  orderUrl,
  postPresignOrder,
} from '../../lib/cow'
import { formatAmount } from '../../lib/format'
import type { Step } from '../../lib/runner'
import { fieldError, parseAddressInput, parseAmountInput } from '../../lib/validation'
import type { Role } from '../../store'
import { AsyncButton, Field, Notice } from '../ui'
import { SafeBalance } from './SafeBalance'
import { StepRunner } from './StepRunner'

const tokenList = Object.values(TOKENS) as Token[]
const tokenBy = (address: string) => tokenList.find((t) => isAddressEqual(t.address, address as Address))!

/** Pending order: built from the quote, with its UID computed locally. */
type Draft = { quote: CowQuote; order: CowOrder; uid: Hex; steps: Step[] }

/**
 * CoW swap from the Safe, driven by a module:
 * 1. quote, then build the order and compute its UID locally,
 * 2. module tx `approve(VaultRelayer)` on the sell token if the allowance is too low,
 * 3. module tx `setPreSignature(uid, true)` on GPv2Settlement, which makes the order live.
 * Steps 2-3 can be simulated right away; the order is posted to the order book only on execute.
 */
export function CowSwap({ role }: { role: Role }) {
  const { safe } = useSandbox()
  const [sell, setSell] = useState<string>(TOKENS.USDC.address)
  const [buy, setBuy] = useState<string>(TOKENS.WETH.address)
  const [amount, setAmount] = useState('25')
  const [receiver, setReceiver] = useState<string>(safe)
  const [slippageBps, setSlippageBps] = useState(100)
  const [draft, setDraft] = useState<Draft>()
  const [posted, setPosted] = useState<Hex>()
  const [submitted, setSubmitted] = useState(false)

  const sellToken = tokenBy(sell)
  const buyToken = tokenBy(buy)
  const fields = {
    amount: parseAmountInput(amount, sellToken.decimals),
    receiver: parseAddressInput(receiver, 'receiver address'),
  }
  const amountError =
    fieldError(fields.amount, submitted) ??
    (fields.amount.ok && fields.amount.value === 0n ? 'Enter an amount greater than 0.' : undefined)
  const receiverError = fieldError(fields.receiver, submitted)
  const foreignReceiver = fields.receiver.ok && !isAddressEqual(fields.receiver.value, safe)

  const reset = () => {
    setDraft(undefined)
    setPosted(undefined)
  }

  const fetchQuote = async () => {
    reset()
    if (!fields.amount.ok || fields.amount.value === 0n || !fields.receiver.ok) {
      setSubmitted(true)
      return
    }
    if (isAddressEqual(sellToken.address, buyToken.address))
      throw new Error('Sell and buy tokens must differ.')
    const quote = await getQuote({
      from: safe,
      receiver: fields.receiver.value,
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount: fields.amount.value,
    })
    const order = buildOrder(quote, slippageBps)
    const uid = orderUid(order, safe)
    const allowance = await publicClient.readContract({
      address: sellToken.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [safe, COW.vaultRelayer],
    })

    const steps: Step[] = []
    if (allowance < order.sellAmount) {
      steps.push({
        label: `approve VaultRelayer ${formatAmount(order.sellAmount, sellToken.decimals)} ${sellToken.symbol}`,
        tx: {
          to: sellToken.address,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [COW.vaultRelayer, order.sellAmount],
          }),
          operation: Operation.CALL,
        },
      })
    }
    steps.push({
      label: 'setPreSignature(order, true)',
      tx: {
        to: COW.settlement,
        value: 0n,
        data: encodeFunctionData({
          abi: cowSettlementAbi,
          functionName: 'setPreSignature',
          args: [uid, true],
        }),
        operation: Operation.CALL,
      },
    })
    setDraft({ quote, order, uid, steps })
  }

  /** Posts the order before the first send; the API must return the UID we pre-sign. */
  const postOrder = async () => {
    if (!draft || posted) return
    const uid = await postPresignOrder(draft.order, draft.quote, safe)
    if (uid.toLowerCase() !== draft.uid.toLowerCase()) {
      throw new Error(`Order UID mismatch: API returned ${uid}, expected ${draft.uid}`)
    }
    setPosted(uid)
  }

  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Sell">
          <select
            value={sell}
            onChange={(e) => {
              setSell(e.target.value)
              reset()
            }}
          >
            {tokenList.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buy">
          <select
            value={buy}
            onChange={(e) => {
              setBuy(e.target.value)
              reset()
            }}
          >
            {tokenList.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={`Amount (${sellToken.symbol})`}
          info="Sepolia liquidity is thin: around 20 USDC or more usually gets a quote. The fee is included in the amount."
          error={amountError}
          hint={
            <>
              <SafeBalance
                token={sellToken}
                onMax={(value) => {
                  setAmount(value)
                  reset()
                }}
              />
            </>
          }
        >
          <input
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
              reset()
            }}
          />
        </Field>
        <Field label="Slippage (bps)">
          <input
            type="number"
            value={slippageBps}
            onChange={(e) => {
              setSlippageBps(Math.max(0, Math.min(5000, Number(e.target.value))))
              reset()
            }}
          />
        </Field>
        <Field
          label="Receiver"
          error={receiverError}
          info="Who receives the bought tokens. Defaults to the Safe; set another address to see that no deployed policy can stop it."
        >
          <input
            value={receiver}
            onChange={(e) => {
              setReceiver(e.target.value.trim())
              reset()
            }}
          />
        </Field>
      </div>

      {foreignReceiver && (
        <Notice tone="bad">
          Receiver is not the Safe. The swap proceeds would leave the Safe, and AllowedModulePolicy on
          setPreSignature will still let it through: the order UID is opaque to every deployed policy.
        </Notice>
      )}

      <div className="row">
        <AsyncButton
          onClick={fetchQuote}
          title="Ask the CoW order book for a quote and build the order (nothing is posted yet)"
        >
          {draft ? 'Refresh quote' : 'Get quote'}
        </AsyncButton>
      </div>

      {draft && (
        <>
          <p className="small">
            Sell {formatAmount(draft.order.sellAmount, sellToken.decimals)} {sellToken.symbol} (incl.{' '}
            {formatAmount(BigInt(draft.quote.feeAmount), sellToken.decimals)} fee) for ≥{' '}
            {formatAmount(draft.order.buyAmount, buyToken.decimals, 6)} {buyToken.symbol} (after {slippageBps}{' '}
            bps slippage)
          </p>
          <p className="small">
            Order UID <span className="mono break">{draft.uid}</span>
            {posted ? (
              <>
                {' · '}
                <a href={orderUrl(posted)} target="_blank" rel="noreferrer">
                  posted, view on CoW Explorer
                </a>
              </>
            ) : (
              <span className="muted"> · computed locally, posted to CoW on execute</span>
            )}
          </p>
          <StepRunner role={role} steps={draft.steps} beforeSend={postOrder} />
        </>
      )}
    </div>
  )
}
