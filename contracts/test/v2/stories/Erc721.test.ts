import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { type Interface, ZeroAddress } from 'ethers'
import { ethers } from 'hardhat'
import type { StoryNft } from '../../../typechain-types'
import {
  ArgsOp,
  Kind,
  MONTH,
  OWNERS,
  SEL,
  type World,
  addrOf,
  allow,
  anyCall,
  argsSettings,
  attach,
  attachmentId,
  call,
  deny,
  deployWorld,
  execModule,
  execOwners,
  expectEngineError,
  expectPolicyDenied,
  install,
  limitSettings,
  onContract,
  onFunction,
  onWord,
  sel,
  transfer,
  usdc,
} from './world'

/**
 * Story: ERC-721 transfers by an ops actor (COOKBOOK "ERC-721"). ERC-721 shares the ERC-20
 * `transferFrom` and `approve` selectors, so a Limit at `(Ops, *)` would read an NFT transfer as an
 * ERC-20 spend of an unlisted token and deny it (`Unpriced`, always). The Limit is placed per token
 * contract instead: `(Ops, USDC.*)`.
 */

const SAFE_TRANSFER = sel('safeTransferFrom(address,address,uint256)')
const SAFE_TRANSFER_DATA = sel('safeTransferFrom(address,address,uint256,bytes)')
const SET_APPROVAL_FOR_ALL = sel('setApprovalForAll(address,bool)')

async function base() {
  const w = await deployWorld()
  const nft = (await ethers.deployContract('StoryNft')) as unknown as StoryNft
  const nftAddress = addrOf(nft)
  for (const id of [1n, 2n, 3n]) await nft.mint(w.safeAddress, id)
  return { ...w, nft, nftAddress }
}
type W = World & Awaited<ReturnType<typeof base>>

/** Allow + Args (recipient word IN [vendorA]) for the three transfer functions of the NFT. */
function nftTransfers(w: W) {
  const ops = w.ops.address
  return [
    [SEL.transferFrom, 1],
    [SAFE_TRANSFER, 1],
    [SAFE_TRANSFER_DATA, 1],
  ].flatMap(([selector, index]) => {
    const s = onFunction(ops, w.nftAddress, selector as string)
    return [
      allow(s),
      attach(
        s,
        w.args,
        argsSettings([onWord(selector as string, index as number, ArgsOp.IN, [w.vendorA.address])]),
      ),
    ]
  })
}

async function world() {
  const w = await base()
  const ops = w.ops.address
  await install(
    w,
    [
      allow(anyCall(OWNERS)),
      deny(onFunction(ZeroAddress, w.nftAddress, SET_APPROVAL_FOR_ALL)),
      ...nftTransfers(w),
      allow(onFunction(ops, w.tokenAddress, SEL.transfer)),
      // The budget sits on the token contract, not on (Ops, *).
      attach(
        onContract(ops, w.tokenAddress),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(1_000), period: MONTH }]),
      ),
    ],
    { modules: [ops] },
  )
  return w
}

/** The same, with the Limit misplaced at `(Ops, *)`: it also matches the NFT calls. */
async function misplaced() {
  const w = await base()
  const ops = w.ops.address
  await install(
    w,
    [
      ...nftTransfers(w),
      attach(
        anyCall(ops),
        w.limit,
        limitSettings([{ token: w.tokenAddress, amount: usdc(1_000), period: MONTH }], true),
      ),
    ],
    { modules: [ops] },
  )
  return w
}

const nftCall = (w: W, fn: string, args: unknown[]) =>
  call(w.nftAddress, (w.nft.interface as Interface).encodeFunctionData(fn, args))

describe('Story: ERC-721 transfers to listed recipients', () => {
  it('transfers an NFT to a listed recipient with each transfer function', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, nftCall(w, 'transferFrom', [w.safeAddress, w.vendorA.address, 1n]))
    await execModule(
      w,
      w.ops,
      nftCall(w, 'safeTransferFrom(address,address,uint256)', [w.safeAddress, w.vendorA.address, 2n]),
    )
    await execModule(
      w,
      w.ops,
      nftCall(w, 'safeTransferFrom(address,address,uint256,bytes)', [
        w.safeAddress,
        w.vendorA.address,
        3n,
        '0x1234',
      ]),
    )
    for (const id of [1n, 2n, 3n]) expect(await w.nft.ownerOf(id)).to.equal(w.vendorA.address)
  })

  it('denies a transfer to an unlisted recipient (Args ConstraintFailed)', async () => {
    const w = await loadFixture(world)
    const id = attachmentId(
      onFunction(w.ops.address, w.nftAddress, SEL.transferFrom),
      Kind.POLICY,
      addrOf(w.args),
    )
    await expectPolicyDenied(
      execModule(w, w.ops, nftCall(w, 'transferFrom', [w.safeAddress, w.attacker.address, 1n])),
      w,
      w.args,
      'ConstraintFailed',
      [0, id, 0],
    )
  })

  it('denies setApprovalForAll to everyone, owners included: a DENY at (ANY, NFT.setApprovalForAll) beats any Allow', async () => {
    const w = await loadFixture(world)
    const op = nftCall(w, 'setApprovalForAll', [w.attacker.address, true])
    const denyId = attachmentId(onFunction(ZeroAddress, w.nftAddress, SET_APPROVAL_FOR_ALL), Kind.DENY)
    // The owners hold Allow (Owners, *); the DENY is checked before any Allow counts.
    await expectEngineError(execOwners(w, op), w, 'Denied', [0, denyId])
    await expectEngineError(execModule(w, w.ops, op), w, 'Denied', [0, denyId])
  })

  it('without the DENY, ops still cannot call setApprovalForAll (NotGranted: no Allow names it)', async () => {
    const w = await loadFixture(world)
    const op = nftCall(w, 'setApprovalForAll', [w.attacker.address, true])
    await execOwners(w, {
      to: w.engineAddress,
      data: w.engine.interface.encodeFunctionData('configure', [
        [{ ...deny(onFunction(ZeroAddress, w.nftAddress, SET_APPROVAL_FOR_ALL)), detach: true }],
      ]),
    })
    await expectEngineError(execModule(w, w.ops, op), w, 'NotGranted', [
      0,
      w.nftAddress,
      SET_APPROVAL_FOR_ALL,
      0,
    ])
    await execOwners(w, op) // the owners' own Allow (Owners, *) now grants it
    expect(await w.nft.isApprovedForAll(w.safeAddress, w.attacker.address)).to.equal(true)
  })

  it('denies an NFT approve without its own Allow (the ERC-20 approve Allow is per contract)', async () => {
    const w = await loadFixture(world)
    await expectEngineError(
      execModule(w, w.ops, nftCall(w, 'approve', [w.vendorA.address, 1n])),
      w,
      'NotGranted',
    )
  })

  it('the Limit per token contract prices USDC and leaves the NFT alone', async () => {
    const w = await loadFixture(world)
    await execModule(w, w.ops, nftCall(w, 'transferFrom', [w.safeAddress, w.vendorA.address, 1n]))
    await execModule(w, w.ops, transfer(w, w.vendorA.address, usdc(1_000)))
    await expectPolicyDenied(
      execModule(w, w.ops, transfer(w, w.vendorA.address, 1n)),
      w,
      w.limit,
      'LimitExceeded',
    )
  })

  it('a Limit at (Ops, *) reads the NFT transfer as an ERC-20 spend of an unlisted token: Unpriced, even with passUnpriced', async () => {
    const w = await loadFixture(misplaced)
    const id = attachmentId(anyCall(w.ops.address), Kind.POLICY, addrOf(w.limit))
    await expectPolicyDenied(
      execModule(w, w.ops, nftCall(w, 'transferFrom', [w.safeAddress, w.vendorA.address, 1n])),
      w,
      w.limit,
      'Unpriced',
      [0, id, w.nftAddress, SEL.transferFrom],
    )
    // safeTransferFrom is not an ERC-20 shape: with passUnpriced it passes.
    await execModule(
      w,
      w.ops,
      nftCall(w, 'safeTransferFrom(address,address,uint256)', [w.safeAddress, w.vendorA.address, 2n]),
    )
  })
})
