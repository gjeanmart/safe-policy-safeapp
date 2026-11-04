import { type Address, isAddressEqual } from 'viem'
import { useSandbox } from '../context'
import { rolesStore } from '../store'
import { Tooltip } from './Tooltip'

/** One-click links for the addresses you usually target: the Safe, its owners and the local roles. */
export function AddressShortcuts({ onPick }: { onPick: (address: Address) => void }) {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  const shortcuts: { label: string; address: Address }[] = [
    { label: 'Safe', address: safe },
    // A signer that is also a local role shows once, under the role's name.
    ...(state?.owners ?? [])
      .map((address, i) => ({ label: `Signer ${i + 1}`, address }))
      .filter((o) => !roles.some((r) => isAddressEqual(r.address, o.address))),
    ...roles.map((r) => ({ label: r.label, address: r.address })),
  ]
  return (
    <span className="row wrap small">
      {shortcuts.map((s) => (
        <Tooltip content={s.address}>
          <button
            key={`${s.label}${s.address}`}
            type="button"
            className="link"
            onClick={() => onPick(s.address)}
          >
            {s.label}
          </button>
        </Tooltip>
      ))}
    </span>
  )
}
