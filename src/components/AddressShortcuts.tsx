import type { Address } from 'viem'
import { useSandbox } from '../context'
import { rolesStore } from '../store'
import { Tooltip } from './Tooltip'

/** One-click links for the addresses you usually target: the Safe, its owners and the local roles. */
export function AddressShortcuts({ onPick }: { onPick: (address: Address) => void }) {
  const { safe, state } = useSandbox()
  const roles = rolesStore.use()
  const shortcuts: { label: string; address: Address }[] = [
    { label: 'Safe', address: safe },
    ...(state?.owners ?? []).map((address, i) => ({ label: `Owner ${i + 1}`, address })),
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
