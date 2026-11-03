import { expect } from 'chai'
import { Interface, MaxUint256, ZeroAddress, ZeroHash, getAddress, id, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import type { LimitEngineStub, MockTokenV2, RecipientsPolicy } from '../../../typechain-types'
import { expectRevert } from '../helpers'

/**
 * RecipientsPolicy (SPEC.md §8.3), called through an engine stub. Every matched attachment must
 * accept the party; the native-value target is checked on any call with value.
 */

const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CALL = 0
const DELEGATECALL = 1
const scope = { actor: ZeroAddress, to: ZeroAddress, selector: '0x00000000', callMatch: 0 }
const erc20 = new Interface([
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function approve(address,uint256)',
  'function increaseAllowance(address,uint256)',
  'function decreaseAllowance(address,uint256)',
  'function deposit()',
])
const signLibAbi = new Interface([
  'function signPermit(address token, address spender, uint256 value, uint256 deadline, uint256 nonce)',
  'function signPermit2(address token, address spender, uint160 amount, uint48 expiration, uint48 nonce, uint256 sigDeadline)',
  'function signCowOrder((address sellToken, address buyToken, address receiver, uint256 sellAmount, uint256 buyAmount, uint32 validTo, bytes32 appData, uint256 feeAmount, bytes32 kind, bool partiallyFillable, bytes32 sellTokenBalance, bytes32 buyTokenBalance) order)',
  'function signMessage(bytes32)',
])

type Settings = { recipients: string[]; spenders: string[]; maxApproval: bigint; strict: boolean }
const settings = (s: Partial<Settings> = {}): Settings => ({
  recipients: [],
  spenders: [],
  maxApproval: MaxUint256,
  strict: false,
  ...s,
})

describe('V2 RecipientsPolicy', () => {
  let policy: RecipientsPolicy
  let engine: LimitEngineStub
  let token: MockTokenV2
  let tokenAddr: string
  const safe = getAddress('0x00000000000000000000000000000000000005af')
  const alice = getAddress('0x000000000000000000000000000000000000a11c')
  const bob = getAddress('0x0000000000000000000000000000000000000b0b')
  const router = getAddress('0x00000000000000000000000000000000000004a7')
  const signLib = getAddress('0x0000000000000000000000000000000000005160')
  const A = id('attachment A')
  const B = id('attachment B')
  const ctx = { safe, actor: OWNERS, txHash: ZeroHash, nonce: 0n, executor: ZeroAddress }

  const call = (to: string, data = '0x', value = 0n, operation = CALL) => ({ to, value, data, operation })
  const tokenCall = (fn: string, args: unknown[]) => call(tokenAddr, erc20.encodeFunctionData(fn, args))
  const configure = async (attachmentId: string, s: Settings) =>
    engine.configure(policy, safe, attachmentId, scope, 1, await policy.encodeSettings(s))
  const check = (c: ReturnType<typeof call>, ids = [A]) => engine.checkCall(policy, ctx, c, ids)
  const cowOrder = (receiver: string) => ({
    sellToken: tokenAddr,
    buyToken: bob,
    receiver,
    sellAmount: 10n,
    buyAmount: 9n,
    validTo: 1,
    appData: ZeroHash,
    feeAmount: 1n,
    kind: ZeroHash,
    partiallyFillable: false,
    sellTokenBalance: ZeroHash,
    buyTokenBalance: ZeroHash,
  })

  beforeEach(async () => {
    policy = await ethers.deployContract('RecipientsPolicy')
    engine = await ethers.deployContract('LimitEngineStub')
    token = await ethers.deployContract('MockTokenV2')
    tokenAddr = await token.getAddress()
    await engine.setSignLib(signLib)
  })

  describe('settings', () => {
    it('stores, reads back and replaces lists on reconfiguration', async () => {
      const engineAddr = await engine.getAddress()
      await configure(A, settings({ recipients: [alice], spenders: [router], maxApproval: 5n, strict: true }))
      const s = await policy.getSettings(engineAddr, safe, A)
      expect(s.recipients).to.deep.equal([alice])
      expect(s.spenders).to.deep.equal([router])
      expect(s.maxApproval).to.equal(5n)
      expect(s.strict).to.equal(true)
      expect(await policy.isRecipient(engineAddr, safe, A, alice)).to.equal(true)
      expect(await policy.isSpender(engineAddr, safe, A, alice)).to.equal(false)
      expect(await policy.isSpender(engineAddr, safe, A, router)).to.equal(true)

      await configure(A, settings({ recipients: [bob] }))
      expect(await policy.isRecipient(engineAddr, safe, A, alice)).to.equal(false)
      expect(await policy.isRecipient(engineAddr, safe, A, bob)).to.equal(true)
      expect(await policy.isSpender(engineAddr, safe, A, router)).to.equal(false)
      await expectRevert(check(call(alice, '0x', 1n)), policy, 'RecipientNotAllowed', [alice])
    })

    it('namespaces settings by engine', async () => {
      await configure(A, settings({ recipients: [alice] }))
      const [other] = await ethers.getSigners()
      expect(await policy.isRecipient(other.address, safe, A, alice)).to.equal(false)
    })

    it('accepts an address as both recipient and spender', async () => {
      await configure(A, settings({ recipients: [alice], spenders: [alice] }))
      await check(tokenCall('approve', [alice, 1n]))
      await check(tokenCall('transfer', [alice, 1n]))
    })

    it('rejects lists over 64, duplicates and the zero address', async () => {
      const many = Array.from({ length: 65 }, (_, i) => zeroPadValue(`0x${(i + 16).toString(16)}`, 20))
      await expectRevert(configure(A, settings({ recipients: many })), policy, 'InvalidSettings')
      await expectRevert(configure(A, settings({ spenders: many })), policy, 'InvalidSettings')
      await configure(A, settings({ recipients: many.slice(0, 64), spenders: many.slice(0, 64) }))
      await expectRevert(configure(A, settings({ recipients: [alice, alice] })), policy, 'InvalidSettings')
      await expectRevert(configure(A, settings({ spenders: [bob, bob] })), policy, 'InvalidSettings')
      await expectRevert(configure(A, settings({ recipients: [ZeroAddress] })), policy, 'InvalidSettings')
    })

    it('round-trips encodeSettings with abi.encode', async () => {
      const s = settings({ recipients: [alice], spenders: [bob], maxApproval: 7n, strict: true })
      const encoded = await policy.encodeSettings(s)
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['tuple(address[] recipients, address[] spenders, uint256 maxApproval, bool strict)'],
        encoded,
      )
      expect(decoded[0].recipients).to.deep.equal([alice])
      expect(decoded[0].maxApproval).to.equal(7n)
    })

    it('is a call-level IPolicyV2 and returns no delay floor', async () => {
      expect(await policy.policyLevel()).to.equal(0n)
      expect(await policy.supportsInterface('0x55872811')).to.equal(true)
      expect(await policy.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await policy.supportsInterface('0xffffffff')).to.equal(false)
      const s = await policy.encodeSettings(settings())
      expect(await engine.configure.staticCall(policy, safe, A, scope, 1, s)).to.equal(0n)
    })

    it('denies a transaction-level call and an empty attachment list (PolicyBaseV2)', async () => {
      await expectRevert(policy.checkCall(ctx, call(alice), []), policy, 'NoAttachments')
      await expectRevert(policy.checkTransaction(ctx, [], '0x', '0x', [A]), policy, 'WrongPolicyLevel')
    })
  })

  describe('native value (any selector)', () => {
    beforeEach(async () => {
      await configure(A, settings({ recipients: [alice] }))
    })

    it('checks the target of a plain ETH transfer', async () => {
      await check(call(alice, '0x', 1n))
      await expectRevert(check(call(bob, '0x', 1n)), policy, 'RecipientNotAllowed', [bob])
    })

    it('checks the target of value sent with calldata (deposit())', async () => {
      const deposit = erc20.encodeFunctionData('deposit')
      await check(call(alice, deposit, 1n))
      await expectRevert(check(call(bob, deposit, 1n)), policy, 'RecipientNotAllowed', [bob])
    })

    it('always accepts the Safe itself', async () => {
      await check(call(safe, '0x', 1n))
    })

    it("works next to an Allow fallback: zero-value calls pass, value only to listed targets", async () => {
      await check(call(bob, erc20.encodeFunctionData('deposit')))
      await check(call(bob))
      await expectRevert(check(call(bob, '0x', 1n)), policy, 'RecipientNotAllowed', [bob])
    })

    it('checks both the value target and the token recipient', async () => {
      await expectRevert(
        check(call(tokenAddr, erc20.encodeFunctionData('transfer', [alice, 1n]), 1n)),
        policy,
        'RecipientNotAllowed',
        [tokenAddr],
      )
    })
  })

  describe('ERC-20 recipients', () => {
    beforeEach(async () => {
      await configure(A, settings({ recipients: [alice] }))
    })

    it('checks transfer(to)', async () => {
      await check(tokenCall('transfer', [alice, 100n]))
      await check(tokenCall('transfer', [safe, 100n]))
      await expectRevert(check(tokenCall('transfer', [bob, 100n])), policy, 'RecipientNotAllowed', [bob])
    })

    it('checks transferFrom(from, to)', async () => {
      await check(tokenCall('transferFrom', [bob, alice, 1n]))
      await check(tokenCall('transferFrom', [alice, safe, 1n]))
      await expectRevert(check(tokenCall('transferFrom', [safe, bob, 1n])), policy, 'RecipientNotAllowed', [
        bob,
      ])
    })

    it('denies malformed calldata of a known selector', async () => {
      const short = erc20.encodeFunctionData('transfer', [alice, 1n]).slice(0, 2 + 8 + 64)
      await expectRevert(check(call(tokenAddr, short)), policy, 'MalformedCall', ['0xa9059cbb'])
      const dirty = '0xa9059cbb' + 'ff'.repeat(12) + alice.slice(2).toLowerCase() + '00'.repeat(32)
      await expectRevert(check(call(tokenAddr, dirty)), policy, 'MalformedCall', ['0xa9059cbb'])
    })

    it('treats ERC-20 selectors under DELEGATECALL as unclassified', async () => {
      const data = erc20.encodeFunctionData('transfer', [bob, 1n])
      await check(call(tokenAddr, data, 0n, DELEGATECALL))
      await configure(A, settings({ recipients: [alice], strict: true }))
      await expectRevert(check(call(tokenAddr, data, 0n, DELEGATECALL)), policy, 'UnclassifiedCall', [
        '0xa9059cbb',
      ])
    })
  })

  describe('approvals', () => {
    beforeEach(async () => {
      await configure(A, settings({ spenders: [router], maxApproval: 100n }))
    })

    it('checks approve(spender) and the amount cap', async () => {
      await check(tokenCall('approve', [router, 100n]))
      await expectRevert(check(tokenCall('approve', [bob, 1n])), policy, 'SpenderNotAllowed', [bob])
      await expectRevert(check(tokenCall('approve', [router, 101n])), policy, 'ApprovalTooLarge', [
        101n,
        100n,
      ])
      await expectRevert(check(tokenCall('approve', [router, MaxUint256])), policy, 'ApprovalTooLarge', [
        MaxUint256,
        100n,
      ])
    })

    it('lets any revocation pass: approve(x, 0) and decreaseAllowance', async () => {
      await check(tokenCall('approve', [bob, 0n]))
      await check(tokenCall('decreaseAllowance', [bob, 5n]))
    })

    it('allows unlimited approvals with maxApproval = max uint', async () => {
      await configure(A, settings({ spenders: [router], maxApproval: MaxUint256 }))
      await check(tokenCall('approve', [router, MaxUint256]))
      await check(tokenCall('increaseAllowance', [router, MaxUint256]))
    })

    it('caps increaseAllowance at the resulting allowance', async () => {
      await token.setAllowance(safe, router, 60n)
      await check(tokenCall('increaseAllowance', [router, 40n]))
      await expectRevert(check(tokenCall('increaseAllowance', [router, 41n])), policy, 'ApprovalTooLarge', [
        101n,
        100n,
      ])
      await expectRevert(check(tokenCall('increaseAllowance', [bob, 1n])), policy, 'SpenderNotAllowed', [bob])
    })

    it('sees an approve earlier in the same batch when capping increaseAllowance', async () => {
      const batch = [tokenCall('approve', [router, 100n]), tokenCall('increaseAllowance', [router, 1n])]
      await expectRevert(engine.checkBatch(policy, ctx, batch, [A]), policy, 'ApprovalTooLarge', [101n, 100n])
      await engine.checkBatch(policy, ctx, [tokenCall('approve', [router, 99n]), batch[1]], [A])
    })

    it('judges [approve(x, 0), increaseAllowance(x, a)] as a, not on-chain + a (review F8)', async () => {
      await token.setAllowance(safe, router, 90n)
      const reset = tokenCall('approve', [router, 0n])
      await engine.checkBatch(policy, ctx, [reset, tokenCall('increaseAllowance', [router, 50n])], [A])
      await expectRevert(
        engine.checkBatch(policy, ctx, [reset, tokenCall('increaseAllowance', [router, 101n])], [A]),
        policy,
        'ApprovalTooLarge',
        [101n, 100n],
      )
      // Without the reset, the on-chain allowance still counts.
      await expectRevert(
        engine.checkBatch(policy, ctx, [tokenCall('increaseAllowance', [router, 50n])], [A]),
        policy,
        'ApprovalTooLarge',
        [140n, 100n],
      )
    })

    it('saturates the resulting allowance instead of overflowing', async () => {
      await token.setAllowance(safe, router, MaxUint256)
      await expectRevert(check(tokenCall('increaseAllowance', [router, 1n])), policy, 'ApprovalTooLarge', [
        MaxUint256,
        100n,
      ])
    })
  })

  describe('PolicySignLib typed entries', () => {
    const permit = (spender: string, value: bigint) =>
      call(
        signLib,
        signLibAbi.encodeFunctionData('signPermit', [tokenAddr, spender, value, 1n, 0n]),
        0n,
        DELEGATECALL,
      )

    beforeEach(async () => {
      await configure(A, settings({ recipients: [alice], spenders: [router], maxApproval: 100n }))
    })

    it('uses the selectors of the spec', () => {
      expect(signLibAbi.getFunction('signPermit')!.selector).to.equal('0x51bdfa61')
      expect(signLibAbi.getFunction('signCowOrder')!.selector).to.equal('0x3d296e04')
      expect(signLibAbi.getFunction('signPermit2')!.selector).to.equal('0xda3c0cb0')
    })

    it('checks signPermit spender and amount', async () => {
      await check(permit(router, 100n))
      await expectRevert(check(permit(bob, 1n)), policy, 'SpenderNotAllowed', [bob])
      await expectRevert(check(permit(router, 101n)), policy, 'ApprovalTooLarge', [101n, 100n])
    })

    it('checks signPermit2 spender and amount', async () => {
      const p2 = (spender: string, amount: bigint) =>
        call(
          signLib,
          signLibAbi.encodeFunctionData('signPermit2', [tokenAddr, spender, amount, 1n, 0n, 1n]),
          0n,
          DELEGATECALL,
        )
      await check(p2(router, 100n))
      await expectRevert(check(p2(bob, 1n)), policy, 'SpenderNotAllowed', [bob])
      await expectRevert(check(p2(router, 2n ** 160n - 1n)), policy, 'ApprovalTooLarge', [
        2n ** 160n - 1n,
        100n,
      ])
    })

    it('checks the CoW order receiver, 0 meaning the Safe', async () => {
      const cow = (receiver: string) =>
        call(signLib, signLibAbi.encodeFunctionData('signCowOrder', [cowOrder(receiver)]), 0n, DELEGATECALL)
      await check(cow(alice))
      await check(cow(ZeroAddress))
      await check(cow(safe))
      await expectRevert(check(cow(bob)), policy, 'RecipientNotAllowed', [bob])
    })

    it('only recognises them as DELEGATECALLs to the engine SIGN_LIB', async () => {
      await configure(
        A,
        settings({ recipients: [alice], spenders: [router], maxApproval: 100n, strict: true }),
      )
      const data = signLibAbi.encodeFunctionData('signPermit', [tokenAddr, bob, 1n, 1n, 0n])
      await expectRevert(check(call(bob, data, 0n, DELEGATECALL)), policy, 'UnclassifiedCall', ['0x51bdfa61'])
      await expectRevert(check(call(signLib, data, 0n, CALL)), policy, 'UnclassifiedCall', ['0x51bdfa61'])
      const raw = call(signLib, signLibAbi.encodeFunctionData('signMessage', [ZeroHash]), 0n, DELEGATECALL)
      await expectRevert(check(raw), policy, 'UnclassifiedCall', [raw.data.slice(0, 10)])
    })

    it('denies a truncated typed entry', async () => {
      const short = permit(router, 1n)
      short.data = short.data.slice(0, short.data.length - 64)
      await expectRevert(check(short), policy, 'MalformedCall', ['0x51bdfa61'])
    })
  })

  describe('strict', () => {
    it('denies what it cannot classify, with or without value', async () => {
      await configure(A, settings({ recipients: [alice], strict: true }))
      const deposit = erc20.encodeFunctionData('deposit')
      await expectRevert(check(call(alice, deposit)), policy, 'UnclassifiedCall', [deposit])
      await expectRevert(check(call(alice, deposit, 1n)), policy, 'UnclassifiedCall', [deposit])
      await expectRevert(check(call(alice)), policy, 'UnclassifiedCall', ['0x00000000'])
      await check(call(alice, '0x', 1n))
    })

    it('passes unclassified calls when not strict', async () => {
      await configure(A, settings())
      await check(call(alice, erc20.encodeFunctionData('deposit')))
    })
  })

  describe('several attachments (merge)', () => {
    it('requires every list to contain the party', async () => {
      await configure(A, settings({ recipients: [alice, bob] }))
      await configure(B, settings({ recipients: [alice] }))
      await check(tokenCall('transfer', [alice, 1n]), [A, B])
      await check(tokenCall('transfer', [bob, 1n]), [A])
      await expectRevert(check(tokenCall('transfer', [bob, 1n]), [A, B]), policy, 'RecipientNotAllowed', [
        bob,
      ])
      await expectRevert(check(call(bob, '0x', 1n), [A, B]), policy, 'RecipientNotAllowed', [bob])
    })

    it('applies the smallest maxApproval and strict if any', async () => {
      await configure(A, settings({ spenders: [router], maxApproval: 100n }))
      await configure(B, settings({ spenders: [router], maxApproval: 50n, strict: true }))
      await check(tokenCall('approve', [router, 60n]), [A])
      await expectRevert(check(tokenCall('approve', [router, 60n]), [A, B]), policy, 'ApprovalTooLarge', [
        60n,
        50n,
      ])
      const deposit = erc20.encodeFunctionData('deposit')
      await check(call(alice, deposit), [A])
      await expectRevert(check(call(alice, deposit), [A, B]), policy, 'UnclassifiedCall', [deposit])
    })
  })
})
