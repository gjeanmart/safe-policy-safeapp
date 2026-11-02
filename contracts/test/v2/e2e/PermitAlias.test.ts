import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import { expectAnyRevert } from '../helpers'
import {
  MONTH,
  OPS_BUDGET,
  OWNERS,
  Op,
  addr,
  allow,
  attach,
  call,
  deployWorld,
  execOwners,
  expectError,
  expectPolicyDenied,
  install,
  limitSettings,
  recipientsSettings,
  scope,
  signPermitCall,
  usdc,
} from './world'

/**
 * Review regressions for `PolicySignLib.signPermit` on a real Safe 1.5.0 with the real engine
 * (review-opus H-1 and M-1). Owners: `Allow (Owners, *)` + Recipients(router, unlimited approval)
 * + Limit 5,000 USDC / month with `passUnpriced = false`.
 *
 * - H-1: a contract returning USDC's domain separator (and an unlimited allowance) made the Safe
 *   sign a real USDC permit that Limit priced as a free call of that contract. The sign library now
 *   requires the domain to be the token's own (`DomainMismatch`).
 * - M-1: a permit was priced as `value - allowance(now)`, so permits at or below an existing
 *   allowance were free and each one re-armed it. Limit now debits the full value.
 */

/** Runtime: `DOMAIN_SEPARATOR()` returns `domainSeparator`; any other call returns 2^256 - 1. */
function aliasBytecode(domainSeparator: string): string {
  const x = domainSeparator.slice(2)
  const runtime =
    '600035' +
    '60e01c' +
    '633644e515' +
    '14' +
    '601a' +
    '57' +
    '600019' +
    '600052' +
    '6020' +
    '6000' +
    'f3' +
    '5b' +
    '7f' +
    x +
    '600052' +
    '6020' +
    '6000' +
    'f3'
  const len = runtime.length / 2
  const init = '60' + len.toString(16).padStart(2, '0') + '80' + '600b' + '6000' + '39' + '6000' + 'f3'
  return '0x' + init + runtime
}

async function deployWith(passUnpriced: boolean) {
  const w = await deployWorld()
  const router = w.outsider
  const owners = scope(OWNERS)
  await install(w, [
    allow(owners),
    attach(
      owners,
      addr(w.recipients),
      recipientsSettings({ spenders: [router.address], maxApproval: ethers.MaxUint256 }),
    ),
    attach(
      owners,
      addr(w.limit),
      limitSettings([{ token: w.tokenAddress, amount: OPS_BUDGET, period: MONTH }], passUnpriced),
    ),
  ])
  const factory = new ethers.ContractFactory([], aliasBytecode(await w.token.DOMAIN_SEPARATOR()), w.attacker)
  const alias = await (await factory.deploy()).waitForDeployment()
  const limitId = await w.engine.attachmentId(await w.engine.scopeKey(owners), 2, addr(w.limit))
  const available = async () =>
    (await w.limit.remaining(w.engineAddress, w.safeAddress, limitId, w.tokenAddress)).available
  return { ...w, router, alias: await alias.getAddress(), limitId, available }
}

/** The strict setting (`passUnpriced = false`), as in the review PoC. */
const deploy = () => deployWith(false)
/** The owners' template setting (`passUnpriced = true`): only the sign library's check stands. */
const deployPassUnpriced = () => deployWith(true)

const aliasPermit = (
  w: Awaited<ReturnType<typeof deploy>>,
  amount: bigint,
  deadline: bigint,
  nonce: bigint,
) =>
  call(
    w.signLibAddress,
    w.signLib.interface.encodeFunctionData('signPermit', [
      w.alias,
      w.router.address,
      amount,
      deadline,
      nonce,
    ]),
    0n,
    Op.DELEGATECALL,
  )

describe('E2E review regression: signPermit cannot alias a token or re-arm an allowance', () => {
  it('control: a 100,000 USDC permit through signPermit(USDC) is LimitExceeded', async () => {
    const w = await loadFixture(deploy)
    const deadline = BigInt(await time.latest()) + 3600n
    await expectPolicyDenied(
      execOwners(w, signPermitCall(w, w.router.address, usdc(100_000), deadline)),
      w.engine,
      w.limit,
      'LimitExceeded',
    )
  })

  it('H-1 denied (passUnpriced = false): Limit prices the alias as an unlisted token, Unpriced', async () => {
    const w = await loadFixture(deploy)
    const deadline = BigInt(await time.latest()) + 3600n
    const nonce = await w.token.nonces(w.safeAddress)
    // The alias' unlimited allowance no longer makes the permit free (Shape.NONE before the fix).
    await expectPolicyDenied(
      execOwners(w, aliasPermit(w, usdc(100_000), deadline, nonce)),
      w.engine,
      w.limit,
      'Unpriced',
      [w.limitId, w.alias, w.signLib.interface.getFunction('signPermit').selector],
    )
    expect(await w.available()).to.equal(OPS_BUDGET)
  })

  it('H-1 denied (passUnpriced = true): signPermit(aliasToken) reverts DomainMismatch; no USDC permit, nothing moves', async () => {
    const w = await loadFixture(deployPassUnpriced)
    const deadline = BigInt(await time.latest()) + 3600n
    const amount = usdc(100_000)
    const nonce = await w.token.nonces(w.safeAddress)
    await expectError(execOwners(w, aliasPermit(w, amount, deadline, nonce)), w.signLib, 'DomainMismatch', [
      w.alias,
    ])

    // The Safe's ERC-1271 does not validate the USDC permit: the token rejects it.
    await expectAnyRevert(
      w.token.connect(w.router).permit(w.safeAddress, w.router.address, amount, deadline, '0x'),
    )
    expect(await w.token.allowance(w.safeAddress, w.router.address)).to.equal(0n)
    expect(await w.token.balanceOf(w.router.address)).to.equal(0n)
    expect(await w.available()).to.equal(OPS_BUDGET)
  })

  it('M-1 denied: after approve(5,000) spends the budget, a permit of 5,000 is LimitExceeded, not free', async () => {
    const w = await loadFixture(deploy)
    const deadline = BigInt(await time.latest()) + 3600n
    const budget = OPS_BUDGET
    await execOwners(
      w,
      call(w.tokenAddress, w.token.interface.encodeFunctionData('approve', [w.router.address, budget])),
    )
    expect(await w.available()).to.equal(0n)
    await expectPolicyDenied(
      execOwners(w, signPermitCall(w, w.router.address, budget, deadline, 0n)),
      w.engine,
      w.limit,
      'LimitExceeded',
    )

    // The router can pull the approved budget once, and no more.
    await w.token.connect(w.router).transferFrom(w.safeAddress, w.router.address, budget)
    await expectAnyRevert(w.token.connect(w.router).transferFrom(w.safeAddress, w.router.address, 1n))
    expect(await w.token.balanceOf(w.router.address)).to.equal(budget)
  })

  it('M-1: two permits within the budget each debit their full value', async () => {
    const w = await loadFixture(deploy)
    const deadline = BigInt(await time.latest()) + 3600n
    const half = OPS_BUDGET / 2n
    await execOwners(w, signPermitCall(w, w.router.address, half, deadline, 0n))
    await execOwners(w, signPermitCall(w, w.router.address, half, deadline, 1n))
    expect(await w.available()).to.equal(0n)
    await expectPolicyDenied(
      execOwners(w, signPermitCall(w, w.router.address, 1n, deadline, 2n)),
      w.engine,
      w.limit,
      'LimitExceeded',
    )
  })
})
