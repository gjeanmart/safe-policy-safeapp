import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddressEqual,
  isHex,
  keccak256,
  maxUint256,
  parseAbi,
  parseUnits,
} from 'viem'
import { erc20Abi } from '../../src/abi'
import { GUARDS, TOKENS } from '../../src/config/contracts'
import { Operation } from '../../src/lib/configurations'
import type { ModuleTx } from '../../src/lib/moduleTx'
import {
  type Config,
  PLANS_DIR,
  type Resolved,
  label,
  nameAddress,
  resolveAddress,
  resolveToken,
  tokenByAddress,
} from './config'
import { CliError } from './output'
import { type CowAttachment, describePresign } from './swap'

const wethAbi = parseAbi(['function deposit() payable', 'function withdraw(uint256 amount)'])

/** A module transaction bound to one chain, Safe and role. Its `id` is a hash of exactly that. */
export type Plan = {
  id: string
  hash: Hex
  chainId: number
  safe: Address
  role: Address
  tx: { to: Address; value: string; data: Hex; operation: 0 }
  createdAt: string
  /** CoW swaps: the order behind a `setPreSignature` UID, checked by the signer. */
  cow?: CowAttachment
  /** Set by `simulate`. Informational only: the signer always re-simulates. */
  simulation?: { ok: boolean; reason?: string; block: string; at: string }
}

/**
 * What a transaction does, decoded from its bytes alone (never from how it was requested), so
 * the signer can show and check the real effect. `amount` is in base units of `symbol`.
 */
export type Intent = {
  kind: 'native' | 'transfer' | 'approve' | 'wrap' | 'unwrap' | 'swap' | 'presign' | 'call'
  text: string
  symbol?: string
  amount?: bigint
  decimals?: number
  /** Recipient, spender or swap receiver, named when known. */
  counterparty?: Resolved
  warnings: string[]
}

export const planTx = (plan: Plan): ModuleTx => ({
  to: plan.tx.to,
  value: BigInt(plan.tx.value),
  data: plan.tx.data,
  operation: Operation.CALL,
})

export function planHash(chainId: number, safe: Address, role: Address, tx: ModuleTx): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'uint8' },
      ],
      [BigInt(chainId), safe, role, tx.to, tx.value, tx.data, tx.operation],
    ),
  )
}

const weth = getAddress(TOKENS.WETH.address)

export function describeTx(config: Config, tx: ModuleTx, cow?: CowAttachment): Intent {
  const presign = describePresign(config, tx, cow)
  if (presign) return presign
  const warnings: string[] = []
  const fmt = (amount: bigint, decimals: number) => formatUnits(amount, decimals)
  if (tx.operation !== Operation.CALL) warnings.push('DELEGATECALL: runs foreign code as the Safe')
  if (isAddressEqual(tx.to, config.safe)) {
    warnings.push(
      'Calls the Safe itself (modules, guards, owners): denied unless a policy explicitly allows it',
    )
  }
  if (GUARDS.some((g) => isAddressEqual(g.address, tx.to))) {
    warnings.push('Calls the policy guard (configuration): denied for modules (ModuleConfigurationDenied)')
  }

  if (tx.data === '0x') {
    const counterparty = nameAddress(config, tx.to)
    return {
      kind: 'native',
      text: `send ${fmt(tx.value, 18)} ETH to ${label(counterparty)}`,
      symbol: 'ETH',
      amount: tx.value,
      decimals: 18,
      counterparty,
      warnings,
    }
  }

  const token = tokenByAddress(tx.to)
  if (token) {
    try {
      const { functionName, args } = decodeFunctionData({ abi: [...erc20Abi, ...wethAbi], data: tx.data })
      if (functionName === 'transfer') {
        const [to, amount] = args as readonly [Address, bigint]
        const counterparty = nameAddress(config, to)
        return {
          kind: 'transfer',
          text: `transfer ${fmt(amount, token.decimals)} ${token.symbol} to ${label(counterparty)}`,
          symbol: token.symbol,
          amount,
          decimals: token.decimals,
          counterparty,
          warnings,
        }
      }
      if (functionName === 'approve') {
        const [spender, amount] = args as readonly [Address, bigint]
        const counterparty = nameAddress(config, spender)
        if (amount >= maxUint256 / 2n) warnings.push('UNLIMITED approval')
        return {
          kind: 'approve',
          text: `approve ${label(counterparty)} to spend ${fmt(amount, token.decimals)} ${token.symbol}`,
          symbol: token.symbol,
          amount,
          decimals: token.decimals,
          counterparty,
          warnings,
        }
      }
      if (isAddressEqual(tx.to, weth) && functionName === 'deposit') {
        return {
          kind: 'wrap',
          text: `wrap ${fmt(tx.value, 18)} ETH into WETH`,
          symbol: 'ETH',
          amount: tx.value,
          decimals: 18,
          warnings,
        }
      }
      if (isAddressEqual(tx.to, weth) && functionName === 'withdraw') {
        const [amount] = args as readonly [bigint]
        return {
          kind: 'unwrap',
          text: `unwrap ${fmt(amount, 18)} WETH into ETH`,
          symbol: 'WETH',
          amount,
          decimals: 18,
          warnings,
        }
      }
    } catch {
      // Not a known ERC-20 / WETH function: fall through to a raw call.
    }
  }

  const target = nameAddress(config, tx.to)
  if (target.source === 'unknown') warnings.push('Target is not a known contract')
  return {
    kind: 'call',
    text: `call ${label(target)} with selector ${tx.data.slice(0, 10)}${tx.value ? ` and ${fmt(tx.value, 18)} ETH` : ''}`,
    ...(tx.value ? { symbol: 'ETH', amount: tx.value, decimals: 18 } : {}),
    warnings,
  }
}

const parseAmount = (value: string | undefined, decimals: number): bigint => {
  if (!value) throw new CliError('Missing --amount.', 'Pass a decimal amount, e.g. --amount 1.5')
  try {
    const amount = parseUnits(value, decimals)
    if (amount < 0n) throw new Error()
    return amount
  } catch {
    throw new CliError(
      `Invalid amount "${value}".`,
      'Use a plain decimal number, e.g. 1.5 (no units, no "max").',
    )
  }
}

/** A recipient or spender: an address-book name, `safe`, or an address. The policies decide. */
function counterparty(config: Config, input: string | undefined, flag: string): Resolved {
  if (!input) throw new CliError(`Missing --${flag}.`)
  return resolveAddress(config, input)
}

export type PlanArgs = Record<string, string | undefined>

/** Builds the module transaction for an action. Every action is a plain CALL from the Safe. */
export function buildTx(config: Config, action: string, args: PlanArgs): ModuleTx {
  const call = (to: Address, data: Hex, value = 0n): ModuleTx => ({
    to,
    value,
    data,
    operation: Operation.CALL,
  })
  switch (action) {
    case 'transfer': {
      const token = resolveToken(args.token ?? '')
      const to = counterparty(config, args.to, 'to')
      const amount = parseAmount(args.amount, token.decimals)
      if (!token.address) return call(to.address, '0x', amount)
      return call(
        token.address,
        encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to.address, amount] }),
      )
    }
    case 'approve': {
      const token = resolveToken(args.token ?? '')
      if (!token.address) throw new CliError('ETH cannot be approved; pick an ERC-20.')
      const spender = counterparty(config, args.spender, 'spender')
      const amount = parseAmount(args.amount, token.decimals)
      return call(
        token.address,
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender.address, amount] }),
      )
    }
    case 'wrap':
      return call(
        weth,
        encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
        parseAmount(args.amount, 18),
      )
    case 'unwrap':
      return call(
        weth,
        encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [parseAmount(args.amount, 18)] }),
      )
    case 'call': {
      if (!args.to) throw new CliError('Missing --to.')
      const data = (args.data ?? '0x') as Hex
      if (!isHex(data)) throw new CliError('--data must be 0x-prefixed hex calldata.')
      const value = args.value ? parseAmount(args.value, 18) : 0n
      return call(resolveAddress(config, args.to).address, data, value)
    }
    default:
      throw new CliError(
        `Unknown action "${action}".`,
        'Actions: transfer, approve, swap, wrap, unwrap, call.',
      )
  }
}

export function createPlan(config: Config, tx: ModuleTx, cow?: CowAttachment): Plan {
  const hash = planHash(config.chainId, config.safe, config.role, tx)
  const plan: Plan = {
    id: hash.slice(2, 12),
    hash,
    chainId: config.chainId,
    safe: config.safe,
    role: config.role,
    tx: { to: tx.to, value: tx.value.toString(), data: tx.data, operation: 0 },
    createdAt: new Date().toISOString(),
    ...(cow ? { cow } : {}),
  }
  savePlan(plan)
  return plan
}

export function savePlan(plan: Plan): void {
  mkdirSync(PLANS_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(join(PLANS_DIR, `${plan.id}.json`), JSON.stringify(plan, null, 2) + '\n')
}

/** Loads a plan by id (or unique prefix) and checks its hash still matches its content. */
export function loadPlan(config: Config, id: string | undefined): Plan {
  if (!id) throw new CliError('Missing plan id.', 'Create one with `safe-role plan <action> ...`.')
  const matches = existsSync(PLANS_DIR)
    ? readdirSync(PLANS_DIR).filter((f) => f.endsWith('.json') && f.startsWith(id.replace(/^0x/, '')))
    : []
  if (matches.length !== 1) {
    throw new CliError(
      matches.length ? `Plan id "${id}" is ambiguous.` : `No plan "${id}" in ${PLANS_DIR}.`,
      'Use the `id` printed by `safe-role plan`.',
    )
  }
  const plan = JSON.parse(readFileSync(join(PLANS_DIR, matches[0]!), 'utf8')) as Plan
  const expected = planHash(plan.chainId, getAddress(plan.safe), getAddress(plan.role), planTx(plan))
  if (expected !== plan.hash)
    throw new CliError('Plan file was modified after it was created. Create a new plan.')
  if (
    plan.chainId !== config.chainId ||
    !isAddressEqual(plan.safe, config.safe) ||
    !isAddressEqual(plan.role, config.role)
  ) {
    throw new CliError('Plan was made for another chain, Safe or role. Create a new plan.')
  }
  return plan
}
