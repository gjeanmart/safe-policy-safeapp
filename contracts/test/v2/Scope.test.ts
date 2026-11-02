import { expect } from 'chai'
import {
  AbiCoder,
  ZeroAddress,
  concat,
  getAddress,
  id,
  keccak256,
  solidityPacked,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type { V2Harness } from '../../typechain-types'

/**
 * WP0 frozen definitions: scope keys, levels, ids, hashes and the MultiSend decoder, checked
 * against an independent ethers encoding. `src/lib/v2/scopes.ts` mirrors the same formulas.
 */

const coder = AbiCoder.defaultAbiCoder()
const ANY = ZeroAddress
const OWNERS = getAddress('0x0000000000000000000000000000000000000001')
const CallMatch = { ANY: 0, TO: 1, SELECTOR: 2, TO_SELECTOR: 3 } as const
const Kind = { ALLOW: 0, DENY: 1, POLICY: 2 } as const
const TRANSFER = id('transfer(address,uint256)').slice(0, 10)

const scopeKey = (actor: string, to: string, selector: string, callMatch: number) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [actor, to, selector, callMatch]))

type Tx = { op: number; to: string; value: bigint; data: string }
const multiSendData = (txs: Tx[]) =>
  concat([
    '0x8d80ff0a',
    coder.encode(
      ['bytes'],
      [
        concat(
          txs.map((t) =>
            solidityPacked(
              ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
              [t.op, t.to, t.value, (t.data.length - 2) / 2, t.data],
            ),
          ),
        ),
      ],
    ),
  ])

describe('V2 scope library (WP0)', () => {
  let harness: V2Harness
  const safe = getAddress('0x00000000000000000000000000000000000005af')
  const agent = getAddress('0x000000000000000000000000000000000000a6e7')
  const usdc = getAddress('0x0000000000000000000000000000000000005dc0')

  before(async () => {
    harness = await ethers.deployContract('V2Harness')
  })

  it('computes scope keys as keccak256(abi.encode(actor, to, selector, callMatch))', async () => {
    const scope = { actor: agent, to: usdc, selector: TRANSFER, callMatch: CallMatch.TO_SELECTOR }
    expect(await harness.key(scope)).to.equal(scopeKey(agent, usdc, TRANSFER, CallMatch.TO_SELECTOR))
  })

  it('looks up the 8 levels with the open parts zeroed', async () => {
    const expected = [
      scopeKey(ANY, ZeroAddress, '0x00000000', CallMatch.ANY),
      scopeKey(ANY, usdc, '0x00000000', CallMatch.TO),
      scopeKey(ANY, ZeroAddress, TRANSFER, CallMatch.SELECTOR),
      scopeKey(ANY, usdc, TRANSFER, CallMatch.TO_SELECTOR),
      scopeKey(agent, ZeroAddress, '0x00000000', CallMatch.ANY),
      scopeKey(agent, usdc, '0x00000000', CallMatch.TO),
      scopeKey(agent, ZeroAddress, TRANSFER, CallMatch.SELECTOR),
      scopeKey(agent, usdc, TRANSFER, CallMatch.TO_SELECTOR),
    ]
    for (let level = 0; level < 8; level++) {
      expect(await harness.keyAt(level, agent, usdc, TRANSFER)).to.equal(expected[level], `level ${level}`)
    }
  })

  it('numbers levels (actor == ANY ? 0 : 4) + callMatch', async () => {
    expect(await harness.level(ANY, CallMatch.ANY)).to.equal(0n)
    expect(await harness.level(ANY, CallMatch.TO_SELECTOR)).to.equal(3n)
    expect(await harness.level(OWNERS, CallMatch.ANY)).to.equal(4n)
    expect(await harness.level(agent, CallMatch.TO_SELECTOR)).to.equal(7n)
  })

  it('accepts only scopes whose open parts are zero', async () => {
    const s = (to: string, selector: string, callMatch: number) => ({ actor: agent, to, selector, callMatch })
    expect(await harness.isNormalized(s(ZeroAddress, '0x00000000', CallMatch.ANY))).to.equal(true)
    expect(await harness.isNormalized(s(usdc, '0x00000000', CallMatch.ANY))).to.equal(false)
    expect(await harness.isNormalized(s(ZeroAddress, TRANSFER, CallMatch.TO))).to.equal(false)
    expect(await harness.isNormalized(s(usdc, TRANSFER, CallMatch.TO))).to.equal(false)
    expect(await harness.isNormalized(s(ZeroAddress, TRANSFER, CallMatch.SELECTOR))).to.equal(true)
    expect(await harness.isNormalized(s(usdc, TRANSFER, CallMatch.TO_SELECTOR))).to.equal(true)
    // Empty calldata has selector 0: an exact scope on it is valid and differs from the wildcard.
    expect(await harness.isNormalized(s(usdc, '0x00000000', CallMatch.TO_SELECTOR))).to.equal(true)
    expect(scopeKey(agent, usdc, '0x00000000', CallMatch.TO_SELECTOR)).to.not.equal(
      scopeKey(agent, usdc, '0x00000000', CallMatch.TO),
    )
  })

  it('computes attachment ids as keccak256(abi.encode(scopeKey, kind, policy))', async () => {
    const key = scopeKey(agent, ZeroAddress, '0x00000000', CallMatch.ANY)
    const policy = getAddress('0x00000000000000000000000000000000000000aa')
    expect(await harness.attachmentId(key, Kind.POLICY, policy)).to.equal(
      keccak256(coder.encode(['bytes32', 'uint8', 'address'], [key, Kind.POLICY, policy])),
    )
    expect(await harness.attachmentId(key, Kind.ALLOW, ZeroAddress)).to.equal(
      keccak256(coder.encode(['bytes32', 'uint8', 'address'], [key, Kind.ALLOW, ZeroAddress])),
    )
  })

  it('decodes selectors like V1 (empty = 0, 1..3 bytes invalid)', async () => {
    expect(await harness.selectorOf('0x')).to.deep.equal([true, '0x00000000'])
    expect(await harness.selectorOf('0xa9059cbb')).to.deep.equal([true, '0xa9059cbb'])
    expect(await harness.selectorOf('0xa9059c')).to.deep.equal([false, '0x00000000'])
  })

  it('computes the module call hash as keccak256(abi.encode(safe, actor, to, value, data, op))', async () => {
    const data = TRANSFER + coder.encode(['address', 'uint256'], [agent, 5n]).slice(2)
    expect(await harness.moduleCallHash(safe, agent, usdc, 7n, data, 0)).to.equal(
      keccak256(
        coder.encode(
          ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
          [safe, agent, usdc, 7n, data, 0],
        ),
      ),
    )
  })

  it('derives the level bitmap from the packed counters', async () => {
    const counts = (1n << (32n * 0n)) | (3n << (32n * 4n)) | (0xffffffffn << (32n * 7n))
    expect(await harness.bitmap(counts)).to.equal(0b10010001n)
    expect(await harness.bitmap(0n)).to.equal(0n)
  })

  it('hashes configuration roots as keccak256(abi.encode(changes, roles))', async () => {
    const changes = [
      {
        changeType: 0,
        scope: { actor: OWNERS, to: ZeroAddress, selector: '0x00000000', callMatch: CallMatch.ANY },
        kind: Kind.ALLOW,
        policy: ZeroAddress,
        opMask: 1,
        data: '0x',
      },
      {
        changeType: 0,
        scope: { actor: agent, to: usdc, selector: TRANSFER, callMatch: CallMatch.TO_SELECTOR },
        kind: Kind.POLICY,
        policy: usdc,
        opMask: 0,
        data: '0x1234',
      },
    ]
    const roles = [{ role: 0, account: agent, enabled: true }]
    const encoded = coder.encode(
      [
        'tuple(uint8 changeType, tuple(address actor, address to, bytes4 selector, uint8 callMatch) scope, uint8 kind, address policy, uint8 opMask, bytes data)[]',
        'tuple(uint8 role, address account, bool enabled)[]',
      ],
      [
        changes.map((c) => [
          c.changeType,
          [c.scope.actor, c.scope.to, c.scope.selector, c.scope.callMatch],
          c.kind,
          c.policy,
          c.opMask,
          c.data,
        ]),
        roles.map((r) => [r.role, r.account, r.enabled]),
      ],
    )
    expect(await harness.configurationRoot(changes, roles)).to.equal(keccak256(encoded))
  })

  it('pins the context type hash, interface ids and sign-lib selectors', async () => {
    expect(await harness.contextTypeHash()).to.equal(id('SafePolicyGuardV2.PolicyContext.v1'))
    const [engineId, policyId] = await harness.interfaceIds()
    // Mirrored in src/lib/v2/abi.ts and SPEC.md; update all three together.
    expect({ engineId, policyId }).to.deep.equal({ engineId: '0xdc1727e9', policyId: '0x55872811' })
    expect(await harness.signLibSelectors()).to.deep.equal([
      id('signPermit(address,address,uint256,uint256,uint256)').slice(0, 10),
      id(
        'signCowOrder((address,address,address,uint256,uint256,uint32,bytes32,uint256,bytes32,bool,bytes32,bytes32))',
      ).slice(0, 10),
      id('signPermit2(address,address,uint160,uint48,uint48,uint256)').slice(0, 10),
      id('signMessage(bytes32)').slice(0, 10),
    ])
  })

  describe('MultiSendDecoder', () => {
    const recipient = getAddress('0x000000000000000000000000000000000000beef')
    const transfer = TRANSFER + coder.encode(['address', 'uint256'], [recipient, 1n]).slice(2)

    it('decodes calls and resolves to == 0 to the Safe', async () => {
      const data = multiSendData([
        { op: 0, to: usdc, value: 0n, data: transfer },
        { op: 0, to: ZeroAddress, value: 3n, data: '0x' },
        { op: 1, to: recipient, value: 0n, data: '0x12345678' },
      ])
      const [ok, tooMany, calls] = await harness.decodeMultiSend(safe, data)
      expect(ok).to.equal(true)
      expect(tooMany).to.equal(false)
      expect(calls.map((c) => [c.to, c.value, c.data, c.operation])).to.deep.equal([
        [usdc, 0n, transfer, 0n],
        [safe, 3n, '0x', 0n],
        [recipient, 0n, '0x12345678', 1n],
      ])
    })

    it('accepts 16 calls and reports more as too many', async () => {
      const tx = { op: 0, to: usdc, value: 0n, data: '0x' }
      const [ok16] = await harness.decodeMultiSend(safe, multiSendData(Array(16).fill(tx)))
      expect(ok16).to.equal(true)
      const [ok17, tooMany17] = await harness.decodeMultiSend(safe, multiSendData(Array(17).fill(tx)))
      expect([ok17, tooMany17]).to.deep.equal([false, true])
    })

    it('rejects malformed batches without reverting', async () => {
      const good = multiSendData([{ op: 0, to: usdc, value: 0n, data: transfer }])
      const bad = [
        '0x', // empty
        '0x12345678' + good.slice(10), // wrong selector
        multiSendData([]), // no calls
        multiSendData([{ op: 2, to: usdc, value: 0n, data: '0x' }]), // op > 1
        good.slice(0, good.length - 64 - 2), // payload cut short
        concat(['0x8d80ff0a', toBeHex(0x40, 32), zeroPadValue('0x', 32), '0x' + good.slice(10 + 64)]), // offset != 0x20
      ]
      for (const data of bad) {
        const [ok, tooMany, calls] = await harness.decodeMultiSend(safe, data)
        expect([ok, tooMany, calls.length]).to.deep.equal([false, false, 0], data.slice(0, 80))
      }
      // A data length running past the payload.
      const header = solidityPacked(['uint8', 'address', 'uint256', 'uint256'], [0, usdc, 0n, 100n])
      const [ok] = await harness.decodeMultiSend(
        safe,
        concat(['0x8d80ff0a', coder.encode(['bytes'], [header])]),
      )
      expect(ok).to.equal(false)
    })
  })
})
