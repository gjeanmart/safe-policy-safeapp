import type { ReactNode } from 'react'
import { InfoTip } from './Tooltip'

/** Short explanations of the concepts the screens rely on, shown behind an ⓘ. */
export const GLOSSARY = {
  timelock:
    'A Timelock delays a transaction: it must be scheduled first, and can only execute once the delay has passed. Until then a canceller or the owners can cancel it, and a guardian can freeze it.',
  schedule:
    'Scheduling records the exact signed transaction in the Timelock and starts its countdown. It carries the owners’ signatures, so anyone can send it.',
  relayer:
    'A key in this browser that only pays gas: it sends schedules and executions that already carry the owners’ signatures, and gains no power by doing so.',
  nonce:
    'Owner signatures are bound to one Safe nonce. Owner transactions execute in nonce order: if another one takes this nonce first, this one can never execute.',
  guardian:
    'A guardian can freeze a Timelock: nothing it covers can execute until the freeze ends or is lifted.',
  freeze:
    'A freeze blocks every transaction a Timelock covers for a fixed time, then a cooldown starts during which no new freeze is possible.',
  erc1271:
    'ERC-1271 lets a contract (here the Safe, through its fallback handler) accept off-chain signatures. A Permit, Permit2 or CoW order signed by the owners then moves funds without any transaction, so no policy runs.',
  signer:
    'An owner of the Safe. Owner (multisig) transactions need the threshold of their signatures; local keys sign here, the others in Safe{Wallet}.',
} as const

export type TermKey = keyof typeof GLOSSARY

/** A word followed by an ⓘ that explains it. */
export function Term({ k, children }: { k: TermKey; children: ReactNode }) {
  return (
    <span className="term">
      {children}
      <InfoTip>{GLOSSARY[k]}</InfoTip>
    </span>
  )
}
