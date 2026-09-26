import { useContext } from 'react'
import { isAddressEqual } from 'viem'
import { ADDRESS_BOOK } from '../config/contracts'
import { SandboxContext } from '../context'
import { rolesStore } from '../store'

/**
 * Human-readable name for an address, most specific first: a local role, the Safe itself, one of
 * its owners, then the static address book (policies, guards, tokens, CoW contracts).
 * Works outside the sandbox context too (then only roles and the address book are known).
 */
export function useAddressName(address: string): string | undefined {
  const sandbox = useContext(SandboxContext)
  const roles = rolesStore.use()
  const lower = address.toLowerCase()

  const role = roles.find((r) => r.address.toLowerCase() === lower)
  if (role) return role.label
  if (sandbox) {
    if (sandbox.safe.toLowerCase() === lower) return 'Safe'
    const owner = sandbox.state?.owners.findIndex((o) => isAddressEqual(o, address as `0x${string}`)) ?? -1
    if (owner >= 0) return `Owner ${owner + 1}`
  }
  return ADDRESS_BOOK[lower]
}
