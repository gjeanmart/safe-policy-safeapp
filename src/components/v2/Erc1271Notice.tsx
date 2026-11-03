import { type Address, zeroAddress } from 'viem'
import { AddressView, Notice } from '../ui'

/**
 * The policies only see transactions. A fallback handler that implements ERC-1271 (Safe's
 * CompatibilityFallbackHandler, the Safe{Wallet} default) makes the owners' off-chain signatures
 * valid for the Safe: a Permit, Permit2 or CoW order signed in Safe{Wallet} then moves funds with no
 * policy running (SPEC.md §6, decision 12). Install leaves the handler alone; this notice says what
 * to do about it.
 */
export function Erc1271Notice({ handler }: { handler?: Address }) {
  const none = handler !== undefined && handler === zeroAddress
  return (
    <Notice tone={none ? 'info' : 'warn'}>
      <strong>Off-chain owner signatures bypass the policies.</strong> The engine checks transactions only. If
      this Safe&apos;s fallback handler implements ERC-1271 (CompatibilityFallbackHandler, the default), a
      Permit, Permit2 or CoW order the owners sign off-chain is valid for the Safe and can move its funds
      without any policy running. Recommended: switch to Safe&apos;s <strong>TokenCallbackHandler</strong>{' '}
      (receives ERC-721 / ERC-1155, no ERC-1271), with an owner transaction to <code>setFallbackHandler</code>{' '}
      (it goes through the owners&apos; Allow and Timelock like any other).{' '}
      {handler !== undefined &&
        (none ? (
          <>This Safe has no fallback handler: off-chain signatures are not valid for it.</>
        ) : (
          <>
            Current handler: <AddressView address={handler} />.
          </>
        ))}
    </Notice>
  )
}
