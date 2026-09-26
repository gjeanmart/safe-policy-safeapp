import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  type Hex,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
  decodeErrorResult,
} from 'viem'
import { policyErrorsAbi } from '../abi'
import { ADDRESS_BOOK } from '../config/contracts'

/** Safe `GSxxx` revert codes that are relevant for module execution. */
const SAFE_ERROR_CODES: Record<string, string> = {
  GS013: 'Safe transaction failed',
  GS031: 'Method can only be called from this contract',
  GS101: 'Invalid module address provided',
  GS102: 'Module has already been added',
  GS103: 'Invalid prevModule, module pair provided',
  GS104: 'Method can only be called from an enabled module',
  GS300: 'Guard does not implement IERC165',
  GS301: 'Module guard does not implement IERC165',
}

const nameOf = (address: string): string => ADDRESS_BOOK[address.toLowerCase()] ?? address

/** Decodes raw revert data against the policy error set, unwrapping `PolicyReverted` recursively. */
export function describeRevertData(data: Hex): string {
  if (data === '0x') return 'reverted without data'
  try {
    // Also decodes the built-in Error(string), which Safe uses for its GSxxx codes.
    const { errorName, args } = decodeErrorResult({ abi: policyErrorsAbi, data })
    if ((errorName as string) === 'Error') {
      const code = String(args[0])
      return SAFE_ERROR_CODES[code] ? `${code}: ${SAFE_ERROR_CODES[code]}` : code
    }
    if (errorName === 'PolicyReverted') {
      const [policy, reason] = args as readonly [string, Hex]
      return `PolicyReverted by ${nameOf(policy)} → ${describeRevertData(reason)}`
    }
    if (errorName === 'AccessDenied') {
      const [policy] = args as readonly [string]
      return /^0x0+$/.test(policy)
        ? 'AccessDenied: no policy configured for this access selector (and no fallback)'
        : `AccessDenied by ${nameOf(policy)}`
    }
    return args?.length ? `${errorName}(${args.map(String).join(', ')})` : errorName
  } catch {
    return `unknown revert ${data.slice(0, 74)}`
  }
}

/** Best-effort human description for anything thrown by viem (or elsewhere). */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    // Infrastructure failures first: these are not policy decisions and read badly verbatim.
    if (error.walk((e) => e instanceof InsufficientFundsError)) {
      return 'Not enough Sepolia ETH to pay for gas on the sending account.'
    }
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return 'Rejected in the wallet.'
    if (error.walk((e) => e instanceof TimeoutError))
      return 'The RPC did not answer in time. Try again or change it in Settings.'
    if (error.walk((e) => e instanceof HttpRequestError)) {
      return 'Could not reach the RPC endpoint. Check your connection or change it in Settings.'
    }
    if (error.walk((e) => e instanceof ChainMismatchError)) return 'The RPC endpoint is not on Sepolia.'

    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError && reverted.raw) {
      return describeRevertData(reverted.raw)
    }
    // Some RPCs return revert data on a nested `data` field instead.
    const withData = error.walk((e) => typeof (e as { data?: unknown }).data === 'string')
    const data = (withData as { data?: unknown } | null)?.data
    if (typeof data === 'string' && data.startsWith('0x')) return describeRevertData(data as Hex)
    return error.shortMessage
  }
  return error instanceof Error ? error.message : String(error)
}
