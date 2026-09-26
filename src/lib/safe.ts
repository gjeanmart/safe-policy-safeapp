import { type Address, type Hex, encodeFunctionData, getAddress, isAddressEqual, zeroAddress } from 'viem'
import { guardAbi, safeAbi } from '../abi'
import { publicClient } from '../config/client'
import { GUARDS, GUARD_STORAGE_SLOT, MODULE_GUARD_STORAGE_SLOT, SENTINEL } from '../config/contracts'
import type { Configuration } from './configurations'

export type SafeState = {
  address: Address
  version: string
  owners: Address[]
  threshold: number
  modules: Address[]
  /** Transaction guard (owner path, `setGuard`). */
  guard: Address
  /** Module guard (module path, `setModuleGuard`, Safe >= 1.5.0). */
  moduleGuard: Address
}

/** A Safe transaction the owners are asked to sign (always a `CALL` with no value unless stated). */
export type SafeTx = { to: Address; value?: bigint; data: Hex; description: string }

const slotToAddress = (word: Hex | undefined): Address =>
  word ? getAddress(`0x${word.slice(-40)}`) : zeroAddress

export async function fetchSafeState(safe: Address): Promise<SafeState> {
  const [version, owners, threshold, [modules], guardWord, moduleGuardWord] = await Promise.all([
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'VERSION' }),
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }),
    publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' }),
    publicClient.readContract({
      address: safe,
      abi: safeAbi,
      functionName: 'getModulesPaginated',
      args: [SENTINEL, 100n],
    }),
    publicClient.getStorageAt({ address: safe, slot: GUARD_STORAGE_SLOT }),
    publicClient.getStorageAt({ address: safe, slot: MODULE_GUARD_STORAGE_SLOT }),
  ])
  return {
    address: safe,
    version,
    owners: [...owners],
    threshold: Number(threshold),
    modules: [...modules],
    guard: slotToAddress(guardWord),
    moduleGuard: slotToAddress(moduleGuardWord),
  }
}

export const isKnownGuard = (address: Address): boolean =>
  GUARDS.some((guard) => isAddressEqual(guard.address, address))

/** The policy guard in use, preferring the module guard since that is what scopes modules. */
export const activeGuard = (state: SafeState): Address | undefined =>
  [state.moduleGuard, state.guard].find((address) => address !== zeroAddress && isKnownGuard(address))

export const isModuleEnabled = (state: SafeState, module: Address): boolean =>
  state.modules.some((m) => isAddressEqual(m, module))

/** Builders for the owner (multisig) transactions this app proposes. */
export const safeTxs = {
  enableModule: (safe: Address, module: Address): SafeTx => ({
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }),
    description: `enableModule(${module})`,
  }),

  disableModule: (state: SafeState, module: Address): SafeTx => {
    // Modules form a linked list starting at SENTINEL; `getModulesPaginated` returns it in order.
    const index = state.modules.findIndex((m) => isAddressEqual(m, module))
    const prev = index > 0 ? state.modules[index - 1]! : SENTINEL
    return {
      to: state.address,
      data: encodeFunctionData({ abi: safeAbi, functionName: 'disableModule', args: [prev, module] }),
      description: `disableModule(${module})`,
    }
  },

  setModuleGuard: (safe: Address, guard: Address): SafeTx => ({
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'setModuleGuard', args: [guard] }),
    description: `setModuleGuard(${guard})`,
  }),

  setGuard: (safe: Address, guard: Address): SafeTx => ({
    to: safe,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'setGuard', args: [guard] }),
    description: `setGuard(${guard})`,
  }),

  configureImmediately: (guard: Address, configurations: readonly Configuration[]): SafeTx => ({
    to: guard,
    data: encodeFunctionData({ abi: guardAbi, functionName: 'configureImmediately', args: [configurations] }),
    description: `configureImmediately(${configurations.length} configurations)`,
  }),

  requestConfiguration: (guard: Address, root: Hex): SafeTx => ({
    to: guard,
    data: encodeFunctionData({ abi: guardAbi, functionName: 'requestConfiguration', args: [root] }),
    description: `requestConfiguration(${root})`,
  }),

  applyConfiguration: (guard: Address, configurations: readonly Configuration[]): SafeTx => ({
    to: guard,
    data: encodeFunctionData({ abi: guardAbi, functionName: 'applyConfiguration', args: [configurations] }),
    description: `applyConfiguration(${configurations.length} configurations)`,
  }),

  invalidateRoot: (guard: Address, root: Hex): SafeTx => ({
    to: guard,
    data: encodeFunctionData({ abi: guardAbi, functionName: 'invalidateRoot', args: [root] }),
    description: `invalidateRoot(${root})`,
  }),

  sendEth: (to: Address, value: bigint): SafeTx => ({
    to,
    value,
    data: '0x',
    description: `send ${value} wei to ${to}`,
  }),
}
