import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'

export const chain = sepolia

export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

/** Shared read client. Module transactions are sent from local EOAs through the same RPC. */
export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL),
  batch: { multicall: true },
})

/** Most public Sepolia RPCs cap `eth_getLogs` at 50k blocks. */
export const LOGS_BLOCK_RANGE = 49_999n
