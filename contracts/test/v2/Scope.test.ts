import { expect } from 'chai'
import {
  AbiCoder,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  id,
  keccak256,
  solidityPacked,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { readFileSync } from 'fs'
import { ethers } from 'hardhat'
import { join } from 'path'
import { ModuleKind, transpileModule } from 'typescript'
import { runInNewContext } from 'vm'
import type * as Mirror from '../../../src/lib/v2/rev3/types'
import type { ScopeHarness } from '../../typechain-types'

/**
 * WP0 (rev 3) frozen definitions: scope keys, the 6 levels, attachment ids, op masks, caps, the
 * module call hash and the batch cap, checked against an independent ethers encoding, and the TS
 * mirror `src/lib/v2/rev3/types.ts` checked against the Solidity harness.
 */

// The root package is ESM and this one CommonJS, so the mirror (import-free by design) is
// transpiled and evaluated here instead of required.
const MIRROR = join(__dirname, '../../../src/lib/v2/rev3/types.ts')
const ts = (() => {
  const { outputText } = transpileModule(readFileSync(MIRROR, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS },
  })
  const exports = {}
  runInNewContext(outputText, { exports })
  return exports as typeof Mirror
})()

const coder = AbiCoder.defaultAbiCoder()
const { ANY, OWNERS, CallMatch, Kind } = ts
const TRANSFER = id('transfer(address,uint256)').slice(0, 10)
const NO_SELECTOR = '0x00000000'

const scopeKey = (actor: string, to: string, selector: string, callMatch: number) =>
  keccak256(coder.encode(['address', 'address', 'bytes4', 'uint8'], [actor, to, selector, callMatch]))
const attachmentId = (key: string, kind: number, policy: string) =>
  keccak256(coder.encode(['bytes32', 'uint8', 'address'], [key, kind, policy]))
const scope = (actor: string, to: string, selector: string, callMatch: number) => ({
  actor,
  to,
  selector,
  callMatch,
})

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

describe('V2 rev 3 scope library (WP0)', () => {
  let h: ScopeHarness
  const module = getAddress(Wallet.createRandom().address)
  const token = getAddress(Wallet.createRandom().address)
  const safe = getAddress(Wallet.createRandom().address)

  before(async () => {
    h = await ethers.deployContract('ScopeHarness')
  })

  describe('keys', () => {
    it('a scope key is keccak256(abi.encode(actor, to, selector, uint8(callMatch)))', async () => {
      for (const s of [
        scope(ANY, ZeroAddress, NO_SELECTOR, CallMatch.ANY),
        scope(OWNERS, token, NO_SELECTOR, CallMatch.CONTRACT),
        scope(module, token, TRANSFER, CallMatch.FUNCTION),
        scope(module, token, NO_SELECTOR, CallMatch.FUNCTION),
      ])
        expect(await h.key(s)).to.equal(scopeKey(s.actor, s.to, s.selector, s.callMatch))
    })

    it('a FUNCTION scope on empty calldata never collides with the CONTRACT scope of the same target', async () => {
      expect(await h.key(scope(module, token, NO_SELECTOR, CallMatch.FUNCTION))).to.not.equal(
        await h.key(scope(module, token, NO_SELECTOR, CallMatch.CONTRACT)),
      )
    })

    it('keyAt(level) equals the key of the scope attached at that level, zeroing the open parts', async () => {
      const expected = [
        scopeKey(ANY, ZeroAddress, NO_SELECTOR, CallMatch.ANY),
        scopeKey(ANY, token, NO_SELECTOR, CallMatch.CONTRACT),
        scopeKey(ANY, token, TRANSFER, CallMatch.FUNCTION),
        scopeKey(module, ZeroAddress, NO_SELECTOR, CallMatch.ANY),
        scopeKey(module, token, NO_SELECTOR, CallMatch.CONTRACT),
        scopeKey(module, token, TRANSFER, CallMatch.FUNCTION),
      ]
      for (let lvl = 0; lvl < ts.LEVEL_COUNT; lvl++)
        expect(await h.keyAt(lvl, module, token, TRANSFER), `level ${lvl}`).to.equal(expected[lvl])
      expect(new Set(expected).size).to.equal(6)
    })
  })

  describe('levels', () => {
    it('level = (actor == ANY ? 0 : 3) + callMatch, 0..5, exact level 5', async () => {
      const cases: [string, number, number][] = [
        [ANY, CallMatch.ANY, 0],
        [ANY, CallMatch.CONTRACT, 1],
        [ANY, CallMatch.FUNCTION, 2],
        [OWNERS, CallMatch.ANY, 3],
        [OWNERS, CallMatch.CONTRACT, 4],
        [module, CallMatch.FUNCTION, 5],
      ]
      for (const [actor, callMatch, lvl] of cases) {
        expect(Number(await h.level(actor, callMatch))).to.equal(lvl)
        expect(ts.levelOf(actor, callMatch as Mirror.CallMatch)).to.equal(lvl)
      }
      expect(ts.EXACT_LEVEL).to.equal(ts.Level.ACTOR_FUNCTION)
    })

    it('there is no fourth call shape ("any contract, this selector")', async () => {
      let reverted = false
      try {
        await h.level(module, 3)
      } catch {
        reverted = true
      }
      expect(reverted).to.equal(true)
    })

    it('isNormalized: to is zero iff ANY, selector zero unless FUNCTION', async () => {
      const ok = [
        scope(ANY, ZeroAddress, NO_SELECTOR, CallMatch.ANY),
        scope(module, token, NO_SELECTOR, CallMatch.CONTRACT),
        scope(module, token, TRANSFER, CallMatch.FUNCTION),
        scope(OWNERS, token, NO_SELECTOR, CallMatch.FUNCTION),
      ]
      const bad = [
        scope(ANY, token, NO_SELECTOR, CallMatch.ANY),
        scope(ANY, ZeroAddress, TRANSFER, CallMatch.ANY),
        scope(module, ZeroAddress, NO_SELECTOR, CallMatch.CONTRACT),
        scope(module, token, TRANSFER, CallMatch.CONTRACT),
        scope(module, ZeroAddress, TRANSFER, CallMatch.FUNCTION),
      ]
      for (const s of ok) expect(await h.isNormalized(s), JSON.stringify(s)).to.equal(true)
      for (const s of bad) expect(await h.isNormalized(s), JSON.stringify(s)).to.equal(false)
    })
  })

  describe('attachment ids and op masks', () => {
    it('an attachment id is keccak256(abi.encode(scopeKey, uint8(kind), policy)), one per (scope, kind, policy)', async () => {
      const key = scopeKey(module, token, TRANSFER, CallMatch.FUNCTION)
      const policy = getAddress(Wallet.createRandom().address)
      const ids = [
        await h.attachmentId(key, Kind.ALLOW, ZeroAddress),
        await h.attachmentId(key, Kind.DENY, ZeroAddress),
        await h.attachmentId(key, Kind.POLICY, policy),
      ]
      expect(ids).to.deep.equal([
        attachmentId(key, Kind.ALLOW, ZeroAddress),
        attachmentId(key, Kind.DENY, ZeroAddress),
        attachmentId(key, Kind.POLICY, policy),
      ])
      expect(new Set(ids).size).to.equal(3)
    })

    it('op bits are 1 << op; a zero mask defaults to CALL for ALLOW and both ops otherwise', async () => {
      expect(Number(await h.opBit(ts.Operation.CALL))).to.equal(ts.OP_CALL)
      expect(Number(await h.opBit(ts.Operation.DELEGATECALL))).to.equal(ts.OP_DELEGATECALL)
      expect(Number(await h.normalizeOpMask(Kind.ALLOW, 0))).to.equal(ts.OP_CALL)
      expect(Number(await h.normalizeOpMask(Kind.DENY, 0))).to.equal(ts.OP_ALL)
      expect(Number(await h.normalizeOpMask(Kind.POLICY, 0))).to.equal(ts.OP_ALL)
      expect(Number(await h.normalizeOpMask(Kind.ALLOW, ts.OP_DELEGATECALL))).to.equal(ts.OP_DELEGATECALL)
      expect(Number(await h.normalizeOpMask(Kind.POLICY, ts.OP_CALL))).to.equal(ts.OP_CALL)
    })
  })

  describe('calls', () => {
    it('selectorOf: 4+ bytes give the selector, empty gives 0, 1..3 bytes are invalid', async () => {
      expect(await h.selectorOf(concat([TRANSFER, zeroPadValue(token, 32)]))).to.deep.equal([true, TRANSFER])
      expect(await h.selectorOf('0x')).to.deep.equal([true, NO_SELECTOR])
      for (const data of ['0x01', '0x0102', '0x010203']) expect((await h.selectorOf(data))[0]).to.equal(false)
    })

    it('moduleCallHash = keccak256(abi.encode(safe, actor, to, value, data, uint8(op)))', async () => {
      const data = concat([TRANSFER, zeroPadValue(module, 32), toBeHex(5n, 32)])
      expect(await h.moduleCallHash(safe, module, token, 7n, data, 1)).to.equal(
        keccak256(
          coder.encode(
            ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
            [safe, module, token, 7n, data, 1],
          ),
        ),
      )
    })
  })

  describe('caps', () => {
    it('level counters: 6 packed uint32, bitmap of the populated levels', async () => {
      const counts = (1n << 0n) | (3n << 64n) | (8n << 160n) // levels 0, 2, 5
      expect(await h.countAt(counts, 0)).to.equal(1n)
      expect(await h.countAt(counts, 1)).to.equal(0n)
      expect(await h.countAt(counts, 2)).to.equal(3n)
      expect(await h.countAt(counts, 5)).to.equal(8n)
      expect(Number(await h.bitmap(counts))).to.equal(0b100101)
      expect(Number(await h.bitmap(0n))).to.equal(0)
    })

    it('a trusted batch decodes up to MAX_BATCH_CALLS calls; one more is reported as too many', async () => {
      const call = (i: number): Tx => ({ op: 0, to: token, value: BigInt(i), data: TRANSFER })
      const max = Array.from({ length: ts.MAX_BATCH_CALLS }, (_, i) => call(i))
      const [ok, tooMany, calls] = await h.decodeMultiSend(safe, multiSendData(max))
      expect([ok, tooMany, calls.length]).to.deep.equal([true, false, ts.MAX_BATCH_CALLS])
      const over = await h.decodeMultiSend(safe, multiSendData([...max, call(8)]))
      expect([over[0], over[1], over[2].length]).to.deep.equal([false, true, 0])
    })

    it('a zero target in a batch resolves to the Safe', async () => {
      const [ok, , calls] = await h.decodeMultiSend(
        safe,
        multiSendData([{ op: 0, to: ZeroAddress, value: 0n, data: '0x' }]),
      )
      expect(ok).to.equal(true)
      expect(calls[0].to).to.equal(safe)
    })
  })

  describe('TS mirror (src/lib/v2/rev3/types.ts)', () => {
    it('sentinels and caps equal the Solidity constants', async () => {
      const [actors, values] = await h.constants()
      expect(actors).to.deep.equal([getAddress(ts.ANY), getAddress(ts.OWNERS)])
      expect(values.map(Number)).to.deep.equal([
        ts.OP_CALL,
        ts.OP_DELEGATECALL,
        ts.OP_ALL,
        ts.LEVEL_COUNT,
        ts.ACTOR_LEVEL_OFFSET,
        ts.EXACT_LEVEL,
        ts.MAX_ATTACHMENTS_PER_SCOPE,
        ts.MAX_BATCH_CALLS,
        ts.MAX_TRUSTED_BATCHES,
        ts.MAX_REASON_LENGTH,
        ts.MAX_ROLE_MEMBERS,
        ts.MAX_ARGS_CONSTRAINTS,
        ts.MAX_ARGS_VALUES,
        ts.MAX_LIMIT_TOKENS,
      ])
    })

    it('selectors and magic values equal the Solidity ones and their signatures', async () => {
      const S = ts.Selectors
      expect(await h.selectors()).to.deep.equal([
        S.multiSend,
        ts.ERC1271_MAGIC_VALUE,
        ts.ANY_SELECTOR,
        S.erc20Transfer,
        S.erc20TransferFrom,
        S.erc20Approve,
        S.erc20IncreaseAllowance,
        S.erc20DecreaseAllowance,
        S.configure,
        S.check,
      ])
      const sig = (s: string) => id(s).slice(0, 10)
      expect(S.configure).to.equal(
        sig('configure((bool,(address,address,bytes4,uint8),uint8,address,uint8,bytes)[])'),
      )
      expect(S.check).to.equal(
        sig('check((address,address,bytes32),(address,uint256,bytes,uint8)[],(uint16,uint8,bytes32)[])'),
      )
      expect(S.multiSend).to.equal(sig('multiSend(bytes)'))
      expect(S.erc20IncreaseAllowance).to.equal(sig('increaseAllowance(address,uint256)'))
      expect(S.erc20DecreaseAllowance).to.equal(sig('decreaseAllowance(address,uint256)'))
      expect(ts.ERC1271_MAGIC_VALUE).to.equal(sig('isValidSignature(bytes32,bytes)'))
    })

    it('interface ids equal type(I).interfaceId', async () => {
      const I = ts.InterfaceIds
      expect(await h.interfaceIds()).to.deep.equal([
        I.IPolicyGuard,
        I.IPolicy,
        I.ITimelockPolicy,
        I.IArgsPolicy,
        I.ILimitPolicy,
        I.ICoSignerPolicy,
        I.ISafenetPolicy,
      ])
    })
  })
})
