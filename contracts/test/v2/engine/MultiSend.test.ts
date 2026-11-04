import { expect } from 'chai'
import { Interface, ZeroAddress, concat, getAddress, hexlify, toBeHex, zeroPadValue } from 'ethers'
import { ethers } from 'hardhat'
import type { Safe } from '../../../typechain-types'
import {
  Operation,
  deploySafe,
  deploySafeInfra,
  enableModule,
  encodeMultiSend,
  execAsModule,
} from '../fixtures/safe'
import { OWNERS, deployEngine } from './fixtures'

/**
 * Review B8: the engine's MultiSend decoder against real execution. Seeded random batches (1 to 9
 * entries, CALL / DELEGATECALL, zero and non-zero `to`, 0 to 100 bytes of data) and mutations of
 * their encoding (truncated tail, wrong head offset, over- and under-stated lengths, op 2, extra
 * bytes) run through a guard-less Safe on the real MultiSendCallOnly and MultiSend 1.5.0, every
 * target a `BatchRecorder` (the Safe's fallback handler too, for `to == 0`). Compared with
 * `engine.matches`: a batch the decoder accepts either reverts as a whole or executes exactly the
 * decoded calls; a batch it rejects (`MalformedBatch`, `BatchTooLarge`) may execute anything, the
 * engine denies it.
 */

const MULTI_SEND = '0x8d80ff0a'
type Entry = { op: number; to: string; value: bigint; data: string }
type Seen = { op: number; to: string; value: bigint; data: string }

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const batchData = (payload: string, offset = 0x20) =>
  concat([
    MULTI_SEND,
    toBeHex(offset, 32),
    toBeHex((payload.length - 2) / 2, 32),
    payload,
    '0x' + '00'.repeat(32),
  ])

describe('V2 engine: MultiSend decoding against real execution (review B8)', () => {
  it('300 random batches and their mutations: decoded batches execute exactly as decoded', async function () {
    this.timeout(600_000)
    const [, owner, module] = await ethers.getSigners()
    const infra = await deploySafeInfra()
    const callOnly = await infra.multiSendCallOnly.getAddress()
    const full = await infra.multiSend.getAddress()
    const { engine } = await deployEngine([callOnly, full])
    const recorders = await Promise.all([0, 1, 2].map(() => ethers.deployContract('BatchRecorder')))
    const targets = await Promise.all(recorders.map((r) => r.getAddress()))
    const handler = targets[2]
    const safe: Safe = await deploySafe([owner], 1, { infra, fallbackHandler: handler })
    const safeAddress = await safe.getAddress()
    await enableModule(safe, module, [owner])
    await owner.sendTransaction({ to: safeAddress, value: ethers.parseEther('100') })
    const recorderIface = recorders[0].interface
    const safeIface = safe.interface as Interface

    /** What the Safe did, in order, as calls. */
    async function execute(batch: string, data: string): Promise<Seen[] | null> {
      const receipt = await (
        await execAsModule(safe, module, { to: batch, data, operation: Operation.DELEGATECALL })
      ).wait()
      const seen: Seen[] = []
      let ok = false
      for (const log of receipt!.logs) {
        const fromSafe = getAddress(log.address) === safeAddress
        if (fromSafe) {
          const parsed = safeIface.parseLog(log)
          if (parsed?.name === 'ExecutionFromModuleSuccess') ok = true
          if (parsed?.name === 'SafeReceived')
            seen.push({ op: 0, to: safeAddress, value: parsed.args.value, data: '0x' })
        }
        const rec = (() => {
          try {
            return recorderIface.parseLog(log)
          } catch {
            return null
          }
        })()
        if (rec?.name !== 'Recorded') continue
        const [id, self, value, callData] = rec.args as unknown as [string, string, bigint, string]
        if (getAddress(self) === safeAddress)
          seen.push({ op: 1, to: getAddress(id), value: 0n, data: callData })
        else if (getAddress(id) === handler)
          // A call to the Safe reached its fallback handler: the Safe appends the caller.
          seen.push({ op: 0, to: safeAddress, value, data: hexlify(callData).slice(0, -40) })
        else seen.push({ op: 0, to: getAddress(id), value, data: callData })
      }
      return ok ? seen : null
    }

    function randomEntry(random: () => number): Entry {
      const op = random() < 0.25 ? 1 : 0
      const zeroTo = op === 0 && random() < 0.2
      const length = Math.floor(random() * 101)
      const data = hexlify(Uint8Array.from({ length }, () => Math.floor(random() * 256)))
      const value = BigInt(Math.floor(random() * 1000))
      if (zeroTo)
        // The Safe's fallback is not payable: value only with empty data (its `receive`).
        return length === 0 || random() < 0.5
          ? { op, to: ZeroAddress, value, data: '0x' }
          : { op, to: ZeroAddress, value: 0n, data }
      return { op, to: targets[Math.floor(random() * 2)], value: op === 1 ? 0n : value, data }
    }

    const encode = (entries: Entry[]) =>
      encodeMultiSend(entries.map((e) => ({ operation: e.op, to: e.to, value: e.value, data: e.data })))

    /** Valid payloads, then mutations of their encoding. */
    function cases(seed: number): { label: string; data: string }[] {
      const random = rng(seed)
      const entries = Array.from({ length: 1 + Math.floor(random() * 9) }, () => randomEntry(random))
      const payload = encode(entries)
      const bytes = (payload.length - 2) / 2
      const cut = Math.max(1, Math.floor(random() * bytes))
      const opIndex = 0 // the first entry's op byte
      return [
        { label: 'valid', data: batchData(payload) },
        { label: 'truncated tail', data: batchData(payload.slice(0, 2 + 2 * cut)) },
        {
          label: 'head offset 0x40',
          data: concat([MULTI_SEND, toBeHex(0x40, 32), zeroPadValue('0x', 32), toBeHex(bytes, 32), payload]),
        },
        {
          label: 'length over',
          data: concat([
            MULTI_SEND,
            toBeHex(0x20, 32),
            toBeHex(bytes + 1 + Math.floor(random() * 64), 32),
            payload,
          ]),
        },
        {
          label: 'length under',
          data: concat([
            MULTI_SEND,
            toBeHex(0x20, 32),
            toBeHex(Math.max(0, bytes - 1 - Math.floor(random() * 40)), 32),
            payload,
            '0x' + '00'.repeat(64),
          ]),
        },
        { label: 'op 2', data: batchData('0x02' + payload.slice(2 + 2 * (opIndex + 1))) },
        {
          label: 'trailing bytes',
          data: batchData(
            concat([
              payload,
              hexlify(
                Uint8Array.from({ length: 1 + Math.floor(random() * 84) }, () => Math.floor(random() * 256)),
              ),
            ]),
          ),
        },
        {
          label: 'nine entries',
          data: batchData(encode(Array.from({ length: 9 }, () => randomEntry(random)))),
        },
      ]
    }

    const norm = (calls: Seen[]) =>
      calls.map((c) => [c.op, getAddress(c.to), c.value, hexlify(c.data).toLowerCase()])
    const counts = { decoded: 0, executedAsDecoded: 0, decodedReverted: 0, rejected: 0, rejectedExecuted: 0 }
    const rejectedButRan: string[] = []
    for (let seed = 1; seed <= 300; seed++) {
      for (const { label, data } of cases(seed)) {
        for (const batch of [callOnly, full]) {
          const [calls, , engineError] = await engine.matches(
            safeAddress,
            OWNERS,
            batch,
            0,
            data,
            Operation.DELEGATECALL,
          )
          const error = engineError === '0x' ? undefined : engine.interface.parseError(engineError)?.name
          const decoded = error !== 'MalformedBatch' && error !== 'BatchTooLarge'
          const ran = await execute(batch, data)
          const where = `seed ${seed}, ${label}, ${batch === callOnly ? 'MultiSendCallOnly' : 'MultiSend'}`
          if (decoded) {
            counts.decoded++
            expect(calls.length, where).to.be.greaterThan(0)
            if (ran === null) {
              // The only expected reason: MultiSendCallOnly refusing a DELEGATECALL entry. Anything
              // else would be MultiSend failing on a batch the decoder vouched for.
              expect(
                batch === callOnly && calls.some((c) => Number(c.operation) === 1),
                `${where}: a decoded batch reverted for another reason`,
              ).to.equal(true)
              counts.decodedReverted++
              continue
            }
            // The decoder judged a DELEGATECALL's value; it moves none (the safe side): compare with 0.
            const expected = calls.map((c) => ({
              op: Number(c.operation),
              to: c.to,
              value: Number(c.operation) === 1 ? 0n : c.value,
              data: c.data,
            }))
            expect(norm(ran), where).to.deep.equal(norm(expected))
            counts.executedAsDecoded++
          } else {
            counts.rejected++
            if (ran !== null) {
              counts.rejectedExecuted++
              if (rejectedButRan.length < 10) rejectedButRan.push(`${where}: ${ran.length} call(s) ran`)
            }
          }
        }
      }
    }
    // Rejected batches that MultiSend executes anyway: the engine denies them (the safe side).
    console.log('      MultiSend differential:', JSON.stringify(counts))
    for (const line of rejectedButRan) console.log('       ', line)
    expect(counts.executedAsDecoded).to.be.greaterThan(300)
    expect(counts.rejected).to.be.greaterThan(300)
  })
})
