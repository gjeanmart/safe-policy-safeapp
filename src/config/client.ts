import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { persisted } from '../store/persisted'

export const chain = sepolia

/**
 * Public Sepolia RPCs known to work from the browser for this app: CORS enabled and
 * `eth_getLogs` over a 50k-block range with an address filter (needed to rebuild policies).
 */
export const RPC_PRESETS = [
  { label: 'PublicNode', url: 'https://ethereum-sepolia-rpc.publicnode.com' },
  { label: 'Tenderly (public gateway)', url: 'https://sepolia.gateway.tenderly.co' },
] as const

export const DEFAULT_RPC_URL: string = RPC_PRESETS[0].url

/** User-chosen RPC URL (Settings tab); `undefined` means the default. */
export const rpcUrlStore = persisted<string | undefined>('rpc-url', undefined)

export const rpcUrl = (): string => rpcUrlStore.get() ?? DEFAULT_RPC_URL

const createClient = (url: string) =>
  createPublicClient({ chain, transport: http(url), batch: { multicall: true } })

/**
 * Shared read client. Module transactions are sent from local EOAs through the same RPC.
 * A `let` export: ES modules share the live binding, so importers see the client rebuilt below.
 */
export let publicClient = createClient(rpcUrl())

rpcUrlStore.subscribe(() => {
  publicClient = createClient(rpcUrl())
})

/** Most public Sepolia RPCs cap `eth_getLogs` at 50k blocks. */
export const LOGS_BLOCK_RANGE = 49_999n
