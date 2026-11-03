import { type Address, isAddressEqual, zeroAddress } from 'viem'
import { SAFE_HANDLERS } from '../../lib/v2'
import { AddressView, Notice } from '../ui'

/**
 * The policies only see transactions. A fallback handler that implements ERC-1271 (Safe's
 * CompatibilityFallbackHandler, the Safe{Wallet} default) makes the owners' off-chain signatures
 * valid for the Safe: a Permit, Permit2 or CoW order signed in Safe{Wallet} then moves funds with no
 * policy running (SPEC.md §6, decision 12). The install batch switches to TokenCallbackHandler unless
 * the owners opt out; this notice says where the Safe stands.
 */
export function Erc1271Notice({ handler, installed }: { handler?: Address; installed: boolean }) {
  const none = handler !== undefined && isAddressEqual(handler, zeroAddress)
  const token = handler !== undefined && isAddressEqual(handler, SAFE_HANDLERS.tokenCallback)
  if (none || token)
    return (
      <Notice tone="info">
        <strong>Off-chain owner signatures cannot bypass the policies.</strong>{' '}
        {token ? (
          <>
            This Safe uses Safe&apos;s TokenCallbackHandler (receives ERC-721 / ERC-1155, no ERC-1271): a
            Permit, Permit2 or CoW order the owners sign off-chain is not valid for it.
          </>
        ) : (
          <>This Safe has no fallback handler: off-chain signatures are not valid for it.</>
        )}
      </Notice>
    )
  return (
    <Notice tone="warn">
      <strong>Off-chain owner signatures bypass the policies.</strong> The engine checks transactions only. If
      this Safe&apos;s fallback handler implements ERC-1271 (CompatibilityFallbackHandler, the default), a
      Permit, Permit2 or CoW order the owners sign off-chain is valid for the Safe and can move its funds
      without any policy running: the owners&apos; Timelock, the guardians&apos; freeze and recovery do not
      bound a key compromise.{' '}
      {installed ? (
        <>
          Switch to Safe&apos;s <strong>TokenCallbackHandler</strong> (receives ERC-721 / ERC-1155, no
          ERC-1271) with an owner transaction to <code>setFallbackHandler</code> (it goes through the
          owners&apos; Allow and Timelock like any other).
        </>
      ) : (
        <>
          The install batch sets Safe&apos;s <strong>TokenCallbackHandler</strong> (receives ERC-721 /
          ERC-1155, no ERC-1271) unless you opt out.
        </>
      )}{' '}
      {handler !== undefined && (
        <>
          Current handler: <AddressView address={handler} />
          {isAddressEqual(handler, SAFE_HANDLERS.compatibility) && ' (CompatibilityFallbackHandler 1.5.0)'}.
        </>
      )}
    </Notice>
  )
}
