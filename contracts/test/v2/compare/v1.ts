import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import { AbiCoder, type Interface, ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import type {
  E2eV1AllowPolicy,
  E2eV1CoSignerPolicy,
  E2eV1DenyPolicy,
  E2eV1TimelockPolicy,
  ERC20TransferPolicy,
  Safe,
  SafePolicyGuard,
  SpendingLimitPolicy,
} from '../../../typechain-types'
import { type SafeTx, completeTx, deploySafe, execAsOwners, safeTxHash, signSafeTx } from '../fixtures/safe'
import { DAY, EXPIRY, call, type World } from '../e2e/world'

/**
 * V1 side of the comparison: the vendored `SafePolicyGuard` (71b9cb0) on its own Safe 1.5.0 from
 * the same infrastructure, with V1 policies (vendored ERC20TransferPolicy, the repo's
 * SpendingLimitPolicy, and the E2eV1* ports/stand-ins of contracts/v2/test/E2eV1Policies.sol).
 */

const coder = AbiCoder.defaultAbiCoder()

/** V1 `Configuration`: one policy per `(target, selector, operation)`; target 0 + selector 0 = fallback. */
export type V1Config = { target: string; selector: string; operation: number; policy: string; data: string }

export const v1Rule = (
  target: string,
  selector: string,
  policy: string,
  data = '0x',
  operation = 0,
): V1Config => ({
  target,
  selector,
  operation,
  policy,
  data,
})
export const v1Fallback = (policy: string, data = '0x', operation = 0): V1Config =>
  v1Rule(ZeroAddress, '0x00000000', policy, data, operation)

export async function deployV1Policies() {
  const allow = (await ethers.deployContract('E2eV1AllowPolicy')) as unknown as E2eV1AllowPolicy
  const deny = (await ethers.deployContract('E2eV1DenyPolicy')) as unknown as E2eV1DenyPolicy
  const cosigner = (await ethers.deployContract('E2eV1CoSignerPolicy')) as unknown as E2eV1CoSignerPolicy
  const timelock = (await ethers.deployContract('E2eV1TimelockPolicy')) as unknown as E2eV1TimelockPolicy
  const transfer = (await ethers.deployContract('ERC20TransferPolicy')) as unknown as ERC20TransferPolicy
  const spendingLimit = (await ethers.deployContract('SpendingLimitPolicy')) as unknown as SpendingLimitPolicy
  return { allow, deny, cosigner, timelock, transfer, spendingLimit }
}
export type V1Policies = Awaited<ReturnType<typeof deployV1Policies>>

export const recipientList = (recipients: string[]) =>
  coder.encode(
    ['tuple(address recipient, uint8 permission)[]'],
    [recipients.map((r) => [r, 2])], // Permission.ALWAYS
  )

export type V1Safe = { safe: Safe; safeAddress: string; guard: SafePolicyGuard; guardAddress: string }

/**
 * A V1-guarded Safe (owners o1..o3, threshold 2, 100,000 USDC, 10 ETH): `configureImmediately`,
 * modules enabled, then the guard as module guard and guard. `configs` may be a function of the
 * new Safe's address, for rules on calls to the Safe itself.
 */
export async function deployV1(
  w: World,
  configs: V1Config[] | ((self: string) => V1Config[]),
  modules: string[] = [],
): Promise<V1Safe> {
  const safe = await deploySafe(w.owners, 2, { infra: w.infra })
  const safeAddress = await safe.getAddress()
  await w.token.mint(safeAddress, 100_000n * 10n ** 6n)
  await w.deployer.sendTransaction({ to: safeAddress, value: ethers.parseEther('10') })
  const guard = (await ethers.deployContract(
    'contracts/vendor/policy-engine/SafePolicyGuard.sol:SafePolicyGuard',
    [DAY, EXPIRY],
  )) as unknown as SafePolicyGuard
  const guardAddress = await guard.getAddress()
  const iface = safe.interface as Interface
  const own = (data: string, to = safeAddress) => execAsOwners(safe, call(to, data), w.quorum2)
  const list = typeof configs === 'function' ? configs(safeAddress) : configs
  await own(guard.interface.encodeFunctionData('configureImmediately', [list]), guardAddress)
  for (const m of modules) await own(iface.encodeFunctionData('enableModule', [m]))
  await own(iface.encodeFunctionData('setModuleGuard', [guardAddress]))
  await own(iface.encodeFunctionData('setGuard', [guardAddress]))
  return { safe, safeAddress, guard, guardAddress }
}

/** Schedules `tx` in the V1 timelock stand-in with the owners' signatures over its safeTxHash. */
export async function v1Schedule(
  v1: V1Safe,
  timelock: E2eV1TimelockPolicy,
  tx: SafeTx,
  signers: HardhatEthersSigner[],
): Promise<string> {
  const full = await completeTx(v1.safe, tx)
  const hash = await safeTxHash(v1.safe, full)
  await timelock.schedule(v1.guardAddress, v1.safeAddress, hash, await signSafeTx(v1.safe, full, signers))
  return hash
}
