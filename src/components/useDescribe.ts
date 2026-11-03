import { useCallback, useMemo } from 'react'
import type { Address, Hex } from 'viem'
import { useSandbox } from '../context'
import { type Call, type DescribeContext, type TxSummary, describeCalls } from '../lib/describeTx'
import type { SafeTx } from '../lib/safe'
import { logActivity } from '../store'
import { useLabelContext } from './v2/useV2'

/** Names (roles, signers, V2 contracts, tokens) and the V2 deployment, to describe calls. */
export function useDescribeContext(isAttached?: (id: Hex) => boolean): DescribeContext {
  const { v2 } = useSandbox()
  const ctx = useLabelContext(v2)
  return useMemo(() => ({ ...ctx, deployment: v2?.deployment, isAttached }), [ctx, v2, isAttached])
}

/** Logs an owner transaction proposed in Safe{Wallet}, decoded, under the Safe's name. */
export function useLogProposal(): (txs: readonly SafeTx[], safeTxHash: string, nonce?: bigint) => TxSummary {
  const { safe } = useSandbox()
  const ctx = useDescribeContext()
  return useCallback(
    (txs, safeTxHash, nonce) => {
      const summary = describeCalls(txs as readonly Call[], ctx)
      logActivity({
        role: safe as Address,
        mode: 'propose',
        label: summary.title,
        status: 'proposed',
        safeTxHash: safeTxHash as Hex,
        nonce,
        lines: summary.lines,
      })
      return summary
    },
    [safe, ctx],
  )
}
