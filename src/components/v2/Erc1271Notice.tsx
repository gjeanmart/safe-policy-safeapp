import { type Address, isAddressEqual } from 'viem'
import { Notice } from '../ui'

/**
 * Where owners sign messages or permits: under V2 the PolicyFallbackHandler rejects every off-chain
 * owner signature (any non-empty signature), so only messages the Safe approved on-chain, through a
 * checked transaction, are valid. Without it, a Permit or CoW order signed off-chain bypasses every
 * policy (Tim's attack).
 */
export function Erc1271Notice({ handler, policyHandler }: { handler?: Address; policyHandler: Address }) {
  if (handler && !isAddressEqual(handler, policyHandler))
    return (
      <Notice tone="bad">
        <strong>ERC-1271 bypass:</strong> this Safe&apos;s fallback handler accepts off-chain owner
        signatures. A Permit, Permit2 or CoW order signed by the owners in Safe{'{Wallet}'} moves funds
        without any policy running. Switch it to PolicyFallbackHandler: setFallbackHandler is an owner
        transaction like any other (Allow + the owners' Timelock).
      </Notice>
    )
  return (
    <Notice tone="warn">
      <strong>Off-chain signatures are refused.</strong> PolicyFallbackHandler rejects every off-chain owner
      signature: signing a message, a Permit or a CoW order in Safe{'{Wallet}'} (Sign-In with Ethereum,
      gasless approvals, off-chain orders) returns &quot;invalid&quot;. Approve them on-chain instead, as a
      Safe transaction that the policies check (PolicySignLib signPermit / signCowOrder; a raw signMessage
      needs an exact-scope Allow).
    </Notice>
  )
}
