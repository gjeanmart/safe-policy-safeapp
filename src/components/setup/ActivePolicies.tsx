import { useEffect, useState } from 'react'
import { type Address, decodeAbiParameters, isAddressEqual } from 'viem'
import { policyViewsAbi } from '../../abi'
import { LOGS_BLOCK_RANGE, publicClient } from '../../config/client'
import { POLICIES } from '../../config/contracts'
import { useSandbox } from '../../context'
import { useAsync } from '../../hooks/useAsync'
import { type Configuration, PERMISSION_LABELS, removalConfigurations } from '../../lib/configurations'
import { activePolicies, scanPolicyEvents } from '../../lib/policyEvents'
import { draftStore, historyKey, policyHistoryStore } from '../../store'
import { AddressView, AsyncButton, Badge, Card, Notice } from '../ui'
import { RefreshButton } from '../RefreshButton'
import { ConfigurationTable } from './PolicyBuilder'

/** Default look-back for the first scan (~4 weeks of Sepolia blocks). */
const DEFAULT_LOOKBACK = 4n * (LOGS_BLOCK_RANGE + 1n)

const PERMISSION_TONES = ['bad', 'warn', 'ok'] as const

const isAllowlistPolicy = (c: Configuration) =>
  isAddressEqual(c.policy, POLICIES.erc20Transfer) || isAddressEqual(c.policy, POLICIES.erc20Approve)

/**
 * Config cell for ERC-20 allowlist policies: each account with its live permission, read from the
 * policy contract. A "once" grant reads "none" after its first use, which is flagged as spent.
 */
function LiveAllowlist({ guard, safe, config }: { guard: Address; safe: Address; config: Configuration }) {
  const isTransfer = isAddressEqual(config.policy, POLICIES.erc20Transfer)
  const live = useAsync(async () => {
    const [entries] = decodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint8' }] }],
      config.data,
    )
    return Promise.all(
      entries.map(async ([account, configured]) => {
        const permission = await publicClient.readContract({
          address: config.policy,
          abi: policyViewsAbi,
          functionName: isTransfer ? 'getRecipientPermission' : 'getSpenderPermission',
          args: [guard, safe, config.target, account],
        })
        return { account, configured, permission }
      }),
    )
  }, `${guard}:${safe}:${config.policy}:${config.target}:${config.data}`)

  if (!live.data) return <span className="muted">…</span>
  return (
    <span className="live-list">
      {live.data.map(({ account, configured, permission }) => (
        <span key={account} className="live-entry">
          <AddressView address={account} />
          <Badge tone={PERMISSION_TONES[permission] ?? 'neutral'}>
            {configured === 1 && permission === 0
              ? 'once · spent'
              : (PERMISSION_LABELS[permission] ?? permission)}
          </Badge>
        </span>
      ))}
    </span>
  )
}

export function ActivePolicies() {
  const { safe, guard, guardInstalled } = useSandbox()
  const histories = policyHistoryStore.use()
  const key = historyKey(guard, safe)
  const history = histories[key]
  const [fromBlock, setFromBlock] = useState('')
  const [queued, setQueued] = useState(false)

  const scan = async (from?: bigint) => {
    const head = await publicClient.getBlockNumber()
    const start = from ?? (history ? BigInt(history.scannedTo) + 1n : head - DEFAULT_LOOKBACK)
    const events = await scanPolicyEvents(guard, safe, start, head)
    policyHistoryStore.set((all) => {
      // A rescan from an explicit block replaces the history; otherwise it appends.
      const previous = from === undefined ? (all[key]?.events ?? []) : []
      return { ...all, [key]: { events: [...previous, ...events], scannedTo: head.toString() } }
    })
  }

  // Keep the view fresh: an incremental scan is cheap once the history exists.
  useEffect(() => {
    if (!guardInstalled) return
    scan().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rescan when the target changes only
  }, [key, guardInstalled])

  const active = activePolicies(history?.events ?? [])

  return (
    <Card
      title={`Active policies (${active.length})`}
      actions={
        <RefreshButton onClick={() => scan()} title="Scan new PolicyConfirmed events since the last scan" />
      }
    >
      <p className="muted small">
        Rebuilt from PolicyConfirmed events (the guard has no enumeration getter). Scanned up to block{' '}
        {history?.scannedTo ?? '—'}. Anything not listed is denied for modules (no fallback configured).
      </p>
      {active.length === 0 ? (
        <Notice>No policy bindings found for this Safe on this guard.</Notice>
      ) : (
        <>
          <ConfigurationTable
            configurations={active}
            renderConfig={(c) =>
              isAllowlistPolicy(c) ? <LiveAllowlist guard={guard} safe={safe} config={c} /> : undefined
            }
            removeTitle="Queue a removal in the draft: revoke the policy's grants, then bind this selector to 0x0"
            onRemove={(index) => {
              draftStore.set((draft) => [...draft, ...removalConfigurations(active[index]!, active)])
              setQueued(true)
            }}
          />
          {queued && (
            <Notice>
              Removal added to the draft in the Policy builder below (grants revoked, then the binding set to
              0x0). Propose it from there; it goes through the guard delay like any change.
            </Notice>
          )}
        </>
      )}
      <details className="rescan">
        <summary>Rescan from a specific block</summary>
        <div className="row rescan-row">
          <input
            placeholder="From block"
            aria-label="From block"
            inputMode="numeric"
            value={fromBlock}
            onChange={(e) => setFromBlock(e.target.value.replace(/\D/g, ''))}
          />
          <AsyncButton
            disabled={!fromBlock}
            onClick={() => scan(BigInt(fromBlock))}
            title="Discard the cached history and rescan from this block"
          >
            Rescan
          </AsyncButton>
        </div>
      </details>
    </Card>
  )
}
