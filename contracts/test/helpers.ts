import { AbiCoder, getAddress, id } from 'ethers'

export const Operation = { CALL: 0, DELEGATECALL: 1 } as const
export const Permission = { NONE: 0, ONCE: 1, ALWAYS: 2 } as const

export const TRANSFER = id('transfer(address,uint256)').slice(0, 10)
export const TRANSFER_FROM = id('transferFrom(address,address,uint256)').slice(0, 10)

export const DAY = 24 * 60 * 60

const coder = AbiCoder.defaultAbiCoder()

/** Packs `(target, selector, operation)` like `AccessSelector.create`: `ssss o ……… tttt…`. */
export function accessSelector(target: string, selector: string, operation: number): string {
  const packed = (BigInt(selector) << 224n) | (BigInt(operation) << 216n) | BigInt(getAddress(target))
  return '0x' + packed.toString(16).padStart(64, '0')
}

export const transferData = (to: string, amount: bigint): string =>
  TRANSFER + coder.encode(['address', 'uint256'], [to, amount]).slice(2)

/** SpendingLimitPolicy configuration: `(amount, period)`; period 0 = one-time budget. */
export const spendingLimitConfig = (amount: bigint, period: number | bigint): string =>
  coder.encode(['uint256', 'uint256'], [amount, period])

/** ERC20TransferPolicy configuration: `RecipientData[]`. */
export const recipientsConfig = (entries: { recipient: string; permission: number }[]): string =>
  coder.encode(
    ['tuple(address recipient, uint8 permission)[]'],
    [entries.map((e) => [e.recipient, e.permission])],
  )

/** AllOfPolicy configuration: `(address[] policies, bytes[] configurations)`. */
export const allOfConfig = (entries: { policy: string; data: string }[]): string =>
  coder.encode(['address[]', 'bytes[]'], [entries.map((e) => e.policy), entries.map((e) => e.data)])
