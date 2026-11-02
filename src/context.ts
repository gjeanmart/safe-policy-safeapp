import { createContext, useContext } from 'react'
import type { Address } from 'viem'
import type { QueuedSafeTx } from './hooks/useSafeApp'
import type { SafeState, SafeTx } from './lib/safe'
import type { V2Engine } from './config/contracts'

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
  /** Reads a transaction (and its signatures) from the Safe{Wallet} queue; undefined outside it. */
  getQueuedTx?: (safeTxHash: string) => Promise<QueuedSafeTx>
  /**
   * Which engine the setup screens drive: the installed guard's `supportsInterface` decides; with
   * no guard installed, the user's choice in the setup tab.
   */
  engineVersion: 'v1' | 'v2'
  /** The V2 engine (installed, or picked for install); undefined when V2 is not deployed here. */
  v2?: V2Engine
  /** A V2 engine is installed as guard or module guard. */
  v2Installed: boolean
}

export const SandboxContext = createContext<Sandbox | null>(null)

export function useSandbox(): Sandbox {
  const sandbox = useContext(SandboxContext)
  if (!sandbox) throw new Error('useSandbox must be used inside SandboxContext')
  return sandbox
}
