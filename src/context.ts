import { createContext, useContext } from 'react'
import type { Address } from 'viem'
import type { SafeState, SafeTx } from './lib/safe'

export type Sandbox = {
  safe: Address
  state: SafeState | undefined
  reloadState: () => void
  /** Guard installed on the Safe, or the one selected for bootstrap. */
  guard: Address
  /** Whether `guard` is installed in either guard slot. */
  guardInstalled: boolean
  /** Proposes a batch to the Safe owners; undefined outside Safe{Wallet}. */
  propose?: (txs: SafeTx[]) => Promise<string>
}

export const SandboxContext = createContext<Sandbox | null>(null)

export function useSandbox(): Sandbox {
  const sandbox = useContext(SandboxContext)
  if (!sandbox) throw new Error('useSandbox must be used inside SandboxContext')
  return sandbox
}
