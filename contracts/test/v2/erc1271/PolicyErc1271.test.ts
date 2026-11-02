import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  AbiCoder,
  type Interface,
  TypedDataEncoder,
  ZeroAddress,
  id,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from 'ethers'
import { ethers } from 'hardhat'
import type { PolicyFallbackHandler } from '../../../typechain-types'
import { eventsOf, expectEvent, expectRevert } from '../helpers'

/**
 * WP6: ERC-1271 under policy (SPEC.md §10). The Safe here is `SignSafeStub` (Safe 1.5.0 storage layout,
 * domain and FallbackManager forwarding) guarded by `SignEngineStub` (the §6.3 slice ERC-1271 relies on);
 * WP7 replays the attack story on a real Safe 1.5.0 with the real engine.
 */

const coder = AbiCoder.defaultAbiCoder()
const DELEGATECALL = 1
const OP_CALL = 1
const OP_DELEGATECALL = 2
const MAGIC = '0x1626ba7e'
const LEGACY_MAGIC = '0x20c13b0b'
const INVALID = '0xffffffff'
const Behaviour = { PASS: 0, REVERT: 1 } as const

const SafeMessage = { SafeMessage: [{ name: 'message', type: 'bytes' }] }
const Permit = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}
const CowOrder = {
  Order: [
    { name: 'sellToken', type: 'address' },
    { name: 'buyToken', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' },
    { name: 'validTo', type: 'uint32' },
    { name: 'appData', type: 'bytes32' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'partiallyFillable', type: 'bool' },
    { name: 'sellTokenBalance', type: 'string' },
    { name: 'buyTokenBalance', type: 'string' },
  ],
}
const PermitSingle = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
}

async function deploy() {
  const [owner, spender, other] = await ethers.getSigners()
  const chainId = (await ethers.provider.getNetwork()).chainId
  const cow = await ethers.deployContract('CowSettlementStub')
  const permit2 = await ethers.deployContract('Permit2Stub')
  const lib = await ethers.deployContract('PolicySignLib', [
    await cow.getAddress(),
    await permit2.getAddress(),
  ])
  const libAddress = await lib.getAddress()
  const engine = await ethers.deployContract('SignEngineStub', [libAddress])
  const handler = await ethers.deployContract('PolicyFallbackHandler')
  const safe = await ethers.deployContract('SignSafeStub', [
    owner.address,
    await engine.getAddress(),
    handler,
  ])
  const safeAddress = await safe.getAddress()
  const token = await ethers.deployContract('PermitTokenStub')
  await token.mint(safeAddress, 1_000_000n)
  const policy = await ethers.deployContract('MockPolicyV2', [0])
  // `Allow (Owners, *)` covering CALL only: the usual owner set-up.
  await engine.allowAny(OP_CALL)

  const safeAsHandler = (await ethers.getContractAt(
    'PolicyFallbackHandler',
    safeAddress,
  )) as PolicyFallbackHandler
  const libAtSafe = lib.attach(safeAddress) as typeof lib
  const sign = (fn: string, args: unknown[]) =>
    safe
      .connect(owner)
      .exec(libAddress, 0, (lib.interface as Interface).encodeFunctionData(fn, args), DELEGATECALL)
  const safeMsgHash = (safeAddr: string, digest: string) =>
    TypedDataEncoder.hash({ chainId, verifyingContract: safeAddr }, SafeMessage, {
      message: coder.encode(['bytes32'], [digest]),
    })
  const isValid = (digest: string, sig = '0x') =>
    safeAsHandler['isValidSignature(bytes32,bytes)'](digest, sig)

  return {
    owner,
    spender,
    other,
    chainId,
    cow,
    permit2,
    lib,
    libAddress,
    libAtSafe,
    engine,
    handler,
    safe,
    safeAddress,
    safeAsHandler,
    token,
    policy,
    sign,
    safeMsgHash,
    isValid,
  }
}

async function deadline(seconds = 3600) {
  return BigInt(await time.latest()) + BigInt(seconds)
}

describe('V2 ERC-1271: PolicyFallbackHandler', () => {
  it('validates a message the Safe approved on-chain through PolicySignLib', async () => {
    const { engine, libAddress, lib, libAtSafe, sign, safe, safeAddress, safeMsgHash, isValid } =
      await loadFixture(deploy)
    const digest = id('login: example.org, nonce 42')
    expect(await isValid(digest)).to.equal(INVALID)

    // signMessage stays a DELEGATECALL: it needs the exact-scope grant.
    await engine.allowExact(libAddress, lib.interface.getFunction('signMessage').selector, OP_DELEGATECALL)
    const tx = await sign('signMessage', [digest])

    const msgHash = safeMsgHash(safeAddress, digest)
    await expectEvent(tx, libAtSafe, 'SignMsg', [msgHash])
    expect(await safe.signedMessages(msgHash)).to.equal(1n)
    expect(await isValid(digest)).to.equal(MAGIC)
  })

  it('applies the same rule to the legacy bytes overload, over keccak256(data)', async () => {
    const { engine, libAddress, lib, sign, safeAsHandler } = await loadFixture(deploy)
    const data = toUtf8Bytes('legacy message')
    const legacy = safeAsHandler['isValidSignature(bytes,bytes)']
    expect(await legacy(data, '0x')).to.equal(INVALID)

    await engine.allowExact(libAddress, lib.interface.getFunction('signMessage').selector, OP_DELEGATECALL)
    await sign('signMessage', [keccak256(data)])
    expect(await legacy(data, '0x')).to.equal(LEGACY_MAGIC)
    expect(await legacy(data, '0x01')).to.equal(INVALID)
  })

  it('never accepts an owner off-chain signature, even one CompatibilityFallbackHandler would accept', async () => {
    const { owner, chainId, safeAddress, isValid, safeAsHandler } = await loadFixture(deploy)
    const digest = id('anything')
    // The owner's EIP-712 SafeMessage signature: valid input for CompatibilityFallbackHandler's checkSignatures.
    const domain = { chainId, verifyingContract: safeAddress }
    const value = { message: coder.encode(['bytes32'], [digest]) }
    const signature = await owner.signTypedData(domain, SafeMessage, value)
    expect(verifyTypedData(domain, SafeMessage, value, signature)).to.equal(owner.address)

    expect(await isValid(digest, signature)).to.equal(INVALID)
    expect(await isValid(digest)).to.equal(INVALID)
    expect(await safeAsHandler['isValidSignature(bytes,bytes)'](digest, signature)).to.equal(INVALID)
  })

  it('rejects a non-empty signature even for an approved message', async () => {
    const { engine, libAddress, lib, sign, isValid } = await loadFixture(deploy)
    const digest = id('approved')
    await engine.allowExact(libAddress, lib.interface.getFunction('signMessage').selector, OP_DELEGATECALL)
    await sign('signMessage', [digest])
    expect(await isValid(digest)).to.equal(MAGIC)
    expect(await isValid(digest, '0x00')).to.equal(INVALID)
  })

  it('scopes an approval to the Safe that made it', async () => {
    const { owner, engine, handler, libAddress, lib, sign, isValid } = await loadFixture(deploy)
    const digest = id('only for the first Safe')
    await engine.allowExact(libAddress, lib.interface.getFunction('signMessage').selector, OP_DELEGATECALL)
    await sign('signMessage', [digest])
    expect(await isValid(digest)).to.equal(MAGIC)

    const other = await ethers.deployContract('SignSafeStub', [
      owner.address,
      await engine.getAddress(),
      handler,
    ])
    const otherAsHandler = await ethers.getContractAt('PolicyFallbackHandler', await other.getAddress())
    expect(await otherAsHandler['isValidSignature(bytes32,bytes)'](digest, '0x')).to.equal(INVALID)
  })

  it('returns INVALID without any call when a non-Safe caller passes a signature', async () => {
    const { handler } = await loadFixture(deploy)
    // msg.sender is an EOA: with an empty signature the handler would call it and revert; not with one.
    expect(await handler['isValidSignature(bytes32,bytes)'](id('x'), '0x01')).to.equal(INVALID)
  })

  it('exposes the CompatibilityFallbackHandler message hashes', async () => {
    const { handler, safeAsHandler, safeAddress, safeMsgHash } = await loadFixture(deploy)
    const digest = id('hash me')
    const message = coder.encode(['bytes32'], [digest])
    const expected = safeMsgHash(safeAddress, digest)
    expect(await handler.getMessageHashForSafe(safeAddress, message)).to.equal(expected)
    expect(await safeAsHandler.getMessageHash(message)).to.equal(expected)
    expect(keccak256(await handler.encodeMessageDataForSafe(safeAddress, message))).to.equal(expected)
  })

  it('keeps the token callbacks and ERC-165', async () => {
    const { handler, other } = await loadFixture(deploy)
    const a = other.address
    expect(await handler.onERC721Received(a, a, 1, '0x')).to.equal('0x150b7a02')
    expect(await handler.onERC1155Received(a, a, 1, 1, '0x')).to.equal('0xf23a6e61')
    expect(await handler.onERC1155BatchReceived(a, a, [1], [1], '0x')).to.equal('0xbc197c81')
    await handler.tokensReceived(a, a, a, 1, '0x', '0x')

    const handlerInterfaceId = [
      'isValidSignature(bytes32,bytes)',
      'isValidSignature(bytes,bytes)',
      'getMessageHashForSafe(address,bytes)',
      'getMessageHash(bytes)',
    ].reduce((acc, sig) => acc ^ Number.parseInt(id(sig).slice(2, 10), 16), 0)
    const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0')
    for (const iid of ['0x01ffc9a7', '0x150b7a02', '0x4e2312e0', hex(handlerInterfaceId)]) {
      expect(await handler.supportsInterface(iid), iid).to.equal(true)
    }
    expect(await handler.supportsInterface('0xffffffff')).to.equal(false)
  })
})

describe('V2 ERC-1271: PolicySignLib', () => {
  it('keeps the typed selectors the engine pins (SPEC §6.3)', async () => {
    const { lib } = await loadFixture(deploy)
    expect(lib.interface.getFunction('signPermit').selector).to.equal('0x51bdfa61')
    expect(lib.interface.getFunction('signCowOrder').selector).to.equal('0x3d296e04')
    expect(lib.interface.getFunction('signPermit2').selector).to.equal('0xda3c0cb0')
  })

  it('signs an EIP-2612 permit the token then accepts through the Safe (happy path, end to end)', async () => {
    const { spender, chainId, token, safe, safeAddress, libAtSafe, sign, safeMsgHash, isValid } =
      await loadFixture(deploy)
    const tokenAddress = await token.getAddress()
    const end = await deadline()
    const digest = TypedDataEncoder.hash(
      { name: 'USD Coin', version: '2', chainId, verifyingContract: tokenAddress },
      Permit,
      { owner: safeAddress, spender: spender.address, value: 500n, nonce: 0n, deadline: end },
    )

    const tx = await sign('signPermit', [tokenAddress, spender.address, 500n, end, 0n])
    await expectEvent(tx, libAtSafe, 'SignMsg', [safeMsgHash(safeAddress, digest)])
    expect(await isValid(digest)).to.equal(MAGIC)

    await token.connect(spender).permit(safeAddress, spender.address, 500n, end, '0x')
    await token.connect(spender).transferFrom(safeAddress, spender.address, 500n)
    expect(await token.balanceOf(spender.address)).to.equal(500n)
    expect(await safe.nonce()).to.equal(1n)
  })

  it('shows policies the permit as the call it is: lib, decoded fields, original operation', async () => {
    const { spender, engine, policy, token, safeAddress, libAddress, lib, sign } = await loadFixture(deploy)
    await engine.attachPolicy(policy, safeAddress, coder.encode(['uint8', 'uint256'], [Behaviour.PASS, 0]))
    const tokenAddress = await token.getAddress()
    const end = await deadline()

    const tx = await sign('signPermit', [tokenAddress, spender.address, 777n, end, 3n])
    const [checked] = await eventsOf(tx, policy, 'CallChecked')
    const { ctx, call } = checked.args
    expect(ctx.safe).to.equal(safeAddress)
    expect(call.to).to.equal(libAddress)
    expect(call.value).to.equal(0n)
    expect(call.operation).to.equal(BigInt(DELEGATECALL))
    const decoded = lib.interface.decodeFunctionData('signPermit', call.data)
    expect([...decoded]).to.deep.equal([tokenAddress, spender.address, 777n, end, 3n])
  })

  it('a policy deny stops the signature: nothing approved, the permit fails at the token', async () => {
    const { spender, engine, policy, token, safe, safeAddress, sign, isValid, chainId } =
      await loadFixture(deploy)
    await engine.attachPolicy(policy, safeAddress, coder.encode(['uint8', 'uint256'], [Behaviour.REVERT, 0]))
    const tokenAddress = await token.getAddress()
    const end = await deadline()

    await expectRevert(
      sign('signPermit', [tokenAddress, spender.address, 500n, end, 0n]),
      engine,
      'PolicyDenied',
    )
    const digest = TypedDataEncoder.hash(
      { name: 'USD Coin', version: '2', chainId, verifyingContract: tokenAddress },
      Permit,
      { owner: safeAddress, spender: spender.address, value: 500n, nonce: 0n, deadline: end },
    )
    expect(await isValid(digest)).to.equal(INVALID)
    expect(await safe.nonce()).to.equal(0n)
    await expectRevert(
      token.connect(spender).permit(safeAddress, spender.address, 500n, end, '0x'),
      token,
      'InvalidSignature',
    )
  })

  it('signs a CoW order under the settlement domain', async () => {
    const { other, chainId, cow, token, sign, isValid } = await loadFixture(deploy)
    const validTo = Number(await deadline())
    const order = {
      sellToken: await token.getAddress(),
      buyToken: other.address,
      receiver: ZeroAddress,
      sellAmount: 1000n,
      buyAmount: 990n,
      validTo,
      appData: id('app'),
      feeAmount: 5n,
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    }
    const digest = TypedDataEncoder.hash(
      { name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: await cow.getAddress() },
      CowOrder,
      order,
    )
    // On-chain the marker fields are their keccak256, as GPv2Order.KIND_SELL / BALANCE_ERC20.
    const onchain = {
      ...order,
      kind: id('sell'),
      sellTokenBalance: id('erc20'),
      buyTokenBalance: id('erc20'),
    }

    expect(await isValid(digest)).to.equal(INVALID)
    await sign('signCowOrder', [onchain])
    expect(await isValid(digest)).to.equal(MAGIC)
  })

  it('signs a Permit2 PermitSingle under the Permit2 domain', async () => {
    const { spender, chainId, permit2, token, sign, isValid } = await loadFixture(deploy)
    const sigDeadline = await deadline()
    const details = {
      token: await token.getAddress(),
      amount: 10n ** 30n,
      expiration: 1_900_000_000n,
      nonce: 7n,
    }
    const digest = TypedDataEncoder.hash(
      { name: 'Permit2', chainId, verifyingContract: await permit2.getAddress() },
      PermitSingle,
      { details, spender: spender.address, sigDeadline },
    )

    expect(await isValid(digest)).to.equal(INVALID)
    await sign('signPermit2', [
      details.token,
      spender.address,
      details.amount,
      details.expiration,
      7n,
      sigDeadline,
    ])
    expect(await isValid(digest)).to.equal(MAGIC)
  })

  describe('engine matching (SPEC §6.3 / §10)', () => {
    it('grants typed entries with a CALL-only Allow (matched as CALL)', async () => {
      const { spender, engine, token, sign } = await loadFixture(deploy)
      await sign('signPermit', [await token.getAddress(), spender.address, 1n, await deadline(), 0n])
      await engine.allowAny(0)
      await expectRevert(
        sign('signPermit', [await token.getAddress(), spender.address, 1n, await deadline(), 1n]),
        engine,
        'NotGranted',
      )
    })

    it('keeps signMessage and every other lib selector a DELEGATECALL that a CALL Allow does not grant', async () => {
      const { engine, lib, libAddress, safe, owner, sign } = await loadFixture(deploy)
      const signMessage = lib.interface.getFunction('signMessage').selector
      await expectRevert(sign('signMessage', [id('m')]), engine, 'NotGranted', [
        libAddress,
        signMessage,
        DELEGATECALL,
      ])
      const typehash = lib.interface.encodeFunctionData('PERMIT_TYPEHASH')
      await expectRevert(
        safe.connect(owner).exec(libAddress, 0, typehash, DELEGATECALL),
        engine,
        'NotGranted',
      )

      // The exact-scope Allow covering DELEGATECALL (lib, signMessage) grants it.
      await engine.allowExact(libAddress, signMessage, OP_DELEGATECALL)
      await sign('signMessage', [id('m')])
    })
  })

  describe('errors', () => {
    it('ZeroAddress: settlement or Permit2 missing', async () => {
      const { lib, other } = await loadFixture(deploy)
      const factory = await ethers.getContractFactory('PolicySignLib')
      await expectRevert(factory.deploy(ZeroAddress, other.address), lib, 'ZeroAddress')
      await expectRevert(factory.deploy(other.address, ZeroAddress), lib, 'ZeroAddress')
    })

    it('OnlyDelegateCall: called directly', async () => {
      const { lib, token, spender } = await loadFixture(deploy)
      await expectRevert(lib.signMessage(id('m')), lib, 'OnlyDelegateCall')
      await expectRevert(
        lib.signPermit(await token.getAddress(), spender.address, 1n, await deadline(), 0n),
        lib,
        'OnlyDelegateCall',
      )
    })

    it('DomainSeparatorUnavailable: no code, or no such function', async () => {
      const { lib, handler, other, spender, sign } = await loadFixture(deploy)
      const end = await deadline()
      await expectRevert(
        sign('signPermit', [other.address, spender.address, 1n, end, 0n]),
        lib,
        'DomainSeparatorUnavailable',
        [other.address],
      )
      const handlerAddress = await handler.getAddress()
      await expectRevert(
        sign('signPermit', [handlerAddress, spender.address, 1n, end, 0n]),
        lib,
        'DomainSeparatorUnavailable',
        [handlerAddress],
      )
    })

    it('SignatureExpired: permit deadline, CoW validTo, Permit2 sigDeadline', async () => {
      const { lib, token, spender, sign } = await loadFixture(deploy)
      const past = BigInt(await time.latest()) - 1n
      const tokenAddress = await token.getAddress()
      await expectRevert(
        sign('signPermit', [tokenAddress, spender.address, 1n, past, 0n]),
        lib,
        'SignatureExpired',
        [past],
      )
      const order = [
        tokenAddress,
        tokenAddress,
        ZeroAddress,
        1n,
        1n,
        past,
        id('a'),
        0n,
        id('sell'),
        false,
        id('erc20'),
        id('erc20'),
      ]
      await expectRevert(sign('signCowOrder', [order]), lib, 'SignatureExpired', [past])
      await expectRevert(
        sign('signPermit2', [tokenAddress, spender.address, 1n, 0n, 0n, past]),
        lib,
        'SignatureExpired',
        [past],
      )
    })

    it('PolicyDenied carries the policy revert reason (MockDenied)', async () => {
      const { engine, policy, safeAddress, sign, token, spender } = await loadFixture(deploy)
      await engine.attachPolicy(
        policy,
        safeAddress,
        coder.encode(['uint8', 'uint256'], [Behaviour.REVERT, 0]),
      )
      try {
        await sign('signPermit', [await token.getAddress(), spender.address, 1n, await deadline(), 0n])
        expect.fail('expected PolicyDenied')
      } catch (e) {
        const data = (e as { data?: string }).data!
        const parsed = engine.interface.parseError(data)!
        expect(parsed.name).to.equal('PolicyDenied')
        expect(policy.interface.parseError(parsed.args.reason)?.name).to.equal('MockDenied')
      }
    })
  })
})
