import { type Address, isAddressEqual, zeroAddress } from 'viem'
import { useSandbox } from '../../context'
import { SAFE_HANDLERS, safeCalls } from '../../lib/v2'
import { ProposeButton } from '../ProposeButton'
import { Term } from '../Term'
import { AddressView, Badge, Notice } from '../ui'
import { toSafeTxs } from './ownerCalls'

export type HandlerKind = 'none' | 'tokenCallback' | 'compatibility' | 'unknown'

export function handlerKind(handler: Address): HandlerKind {
  if (isAddressEqual(handler, zeroAddress)) return 'none'
  if (isAddressEqual(handler, SAFE_HANDLERS.tokenCallback)) return 'tokenCallback'
  if (isAddressEqual(handler, SAFE_HANDLERS.compatibility)) return 'compatibility'
  return 'unknown'
}

/** Only these two are known to have no ERC-1271: an unknown handler may well implement it. */
export const acceptsOffchainSignatures = (handler: Address) =>
  !['none', 'tokenCallback'].includes(handlerKind(handler))

/** The Safe status value: the handler's name, a badge saying whether it has ERC-1271, its address. */
export function FallbackHandlerValue({ handler }: { handler: Address }) {
  const kind = handlerKind(handler)
  if (kind === 'none') return <Badge>none</Badge>
  return (
    <>
      {kind === 'tokenCallback' && <strong>TokenCallbackHandler</strong>}
      {kind === 'compatibility' && <strong>CompatibilityFallbackHandler</strong>}
      {kind === 'unknown' && <Badge tone="warn">unknown handler</Badge>}
      <AddressView address={handler} name="" />
      {kind === 'tokenCallback' ? <Badge tone="ok">no ERC-1271</Badge> : <Badge tone="warn">ERC-1271</Badge>}
    </>
  )
}

/**
 * The policies only see transactions. A fallback handler that implements ERC-1271 (Safe's
 * CompatibilityFallbackHandler, the Safe{Wallet} default) makes the owners' off-chain signatures
 * valid for the Safe: a Permit, Permit2 or CoW order then moves funds with no policy running
 * (SPEC.md §6, decision 12). The V2 install batch switches to TokenCallbackHandler unless the
 * owners opt out; this notice says where the Safe stands.
 */
export function Erc1271Notice({ handler }: { handler: Address }) {
  const { safe, v2Installed } = useSandbox()
  if (!acceptsOffchainSignatures(handler))
    return (
      <Notice tone="ok" title="Off-chain owner signatures cannot bypass the policies">
        The fallback handler has no <Term k="erc1271">ERC-1271</Term>.
      </Notice>
    )
  return (
    <Notice
      tone="warn"
      title="Off-chain owner signatures can bypass the policies"
      more={
        <>
          The policies check transactions only. With this handler, a Permit, Permit2 or CoW order the owners
          sign off-chain is valid for the Safe and moves its funds with no policy running: the owners&apos;
          Timelock, the guardians&apos; freeze and recovery do not bound a key compromise. Safe&apos;s
          TokenCallbackHandler still receives ERC-721 and ERC-1155 tokens, without ERC-1271.
        </>
      }
    >
      The fallback handler {handlerKind(handler) === 'unknown' ? 'may implement' : 'implements'}{' '}
      <Term k="erc1271">ERC-1271</Term>.{' '}
      {v2Installed
        ? 'Switch it to TokenCallbackHandler (an owner transaction).'
        : 'The V2 install batch switches it to TokenCallbackHandler unless you opt out.'}
      {v2Installed && (
        <ProposeButton
          label="Switch to TokenCallbackHandler"
          variant="secondary"
          preview={false}
          title="Proposes setFallbackHandler(TokenCallbackHandler); it shows in the Queue"
          txs={toSafeTxs([safeCalls.setFallbackHandler(safe, SAFE_HANDLERS.tokenCallback)])}
        />
      )}
    </Notice>
  )
}
