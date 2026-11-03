import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import {
  AbiCoder,
  type Interface,
  ZeroAddress,
  dataSlice,
  getAddress,
  keccak256,
  parseEther,
  toBeHex,
} from 'ethers'
import { ethers } from 'hardhat'
import {
  IModuleGuard__factory,
  ISafeModuleGuard__factory,
  ISafeTransactionGuard__factory,
  ITransactionGuard__factory,
  type NoopGuardV2,
} from '../../../typechain-types'
import {
  CONTEXT_TYPE_HASH,
  EIP1271_MAGIC_VALUE,
  Operation,
  deploySafe,
  deploySafeInfra,
  enableModule,
  execAsModule,
  execAsOwners,
  guardsOf,
  isValidSignature,
  multiSendData,
  multiSendTx,
  policyContextTail,
  safeMessageHash,
  safeTxHash,
  setGuard,
  setModuleGuard,
  signHashOffchain,
  signHashOnchainTx,
  signSafeTx,
} from '../fixtures/safe'
import { eventsOf, expectAnyRevert, expectEvent, expectRevert } from '../helpers'

/**
 * Smoke tests of the Safe 1.5.0 harness: a real Safe proxy, a no-op guard installed as both the
 * transaction guard and the module guard, and the hook arguments the V2 engine relies on (SPEC §3.1).
 */

const coder = AbiCoder.defaultAbiCoder()

/** ERC-165 id of an interface: XOR of its own function selectors (`supportsInterface` excluded). */
function interfaceId(iface: Interface): string {
  let id = 0n
  iface.forEachFunction((f) => {
    if (f.name !== 'supportsInterface') id ^= BigInt(f.selector)
  })
  return toBeHex(id, 4)
}

describe('Safe 1.5.0 harness', () => {
  async function deploy() {
    const [alice, bob, carol, module, stranger, recipient] = await ethers.getSigners()
    const infra = await deploySafeInfra()
    const owners = [alice, bob, carol]
    const safe = await deploySafe(owners, 2, { infra })
    const safeAddress = await safe.getAddress()
    await alice.sendTransaction({ to: safeAddress, value: parseEther('10') })
    const guard = (await ethers.deployContract('NoopGuardV2')) as unknown as NoopGuardV2
    const guardAddress = await guard.getAddress()
    const signers = [alice, bob]
    return { infra, safe, safeAddress, guard, guardAddress, owners, signers, module, stranger, recipient }
  }

  /** The base fixture with the no-op guard as transaction guard and module guard, and `module` enabled. */
  async function deployGuarded() {
    const f = await deploy()
    await setGuard(f.safe, f.guardAddress, f.signers)
    await setModuleGuard(f.safe, f.guardAddress, f.signers)
    await enableModule(f.safe, f.module, f.signers)
    return f
  }

  describe('deployment', () => {
    it('deploys a 1.5.0 proxy with owners, threshold and the compatibility fallback handler', async () => {
      const { safe, infra, owners } = await loadFixture(deploy)
      expect(await safe.VERSION()).to.equal('1.5.0')
      expect(await safe.getThreshold()).to.equal(2n)
      expect([...(await safe.getOwners())]).to.have.members(
        await Promise.all(owners.map((o) => o.getAddress())),
      )
      // keccak256("fallback_manager.handler.address")
      const slot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'
      const handler = getAddress(dataSlice(await safe.getStorageAt(slot, 1), 12))
      expect(handler).to.equal(await infra.fallbackHandler.getAddress())
    })

    it('computes the same safeTxHash off-chain as getTransactionHash', async () => {
      const { safe, recipient } = await loadFixture(deploy)
      const tx = {
        to: recipient.address,
        value: 5n,
        data: '0x1234',
        operation: Operation.DELEGATECALL,
        nonce: 7n,
      }
      const onchain = await safe.getTransactionHash(
        tx.to,
        5n,
        '0x1234',
        1,
        0,
        0,
        0,
        ZeroAddress,
        ZeroAddress,
        7n,
      )
      expect(await safeTxHash(safe, tx)).to.equal(onchain)
    })
  })

  describe('hook interfaces (SPEC §3.1)', () => {
    it('the engine-side vendored guard interfaces have the same selectors and ids as Safe 1.5.0', async () => {
      const safeTx = ITransactionGuard__factory.createInterface()
      const safeModule = IModuleGuard__factory.createInterface()
      const engineTx = ISafeTransactionGuard__factory.createInterface()
      const engineModule = ISafeModuleGuard__factory.createInterface()

      expect(interfaceId(safeTx)).to.equal('0xe6d7a83a')
      expect(interfaceId(safeModule)).to.equal('0x58401ed8')
      expect(interfaceId(engineTx)).to.equal('0xe6d7a83a')
      expect(interfaceId(engineModule)).to.equal('0x58401ed8')

      const sigs = (i: Interface) => {
        const out: string[] = []
        i.forEachFunction((f) => out.push(f.format('full')))
        return out.sort()
      }
      expect(sigs(engineTx)).to.deep.equal(sigs(safeTx))
      expect(sigs(engineModule)).to.deep.equal(sigs(safeModule))
    })

    it('the Safe 1.5.0 module guard hook is checkModuleTransaction(to, value, data, op, module) returns bytes32', async () => {
      const safeModule = IModuleGuard__factory.createInterface()
      const pre = safeModule.getFunction('checkModuleTransaction')!
      expect(pre.format('sighash')).to.equal('checkModuleTransaction(address,uint256,bytes,uint8,address)')
      expect(pre.outputs.map((o) => o.type)).to.deep.equal(['bytes32'])
      const post = safeModule.getFunction('checkAfterModuleExecution')!
      expect(post.format('sighash')).to.equal('checkAfterModuleExecution(bytes32,bool)')
      const tx = ITransactionGuard__factory.createInterface().getFunction('checkTransaction')!
      expect(tx.format('sighash')).to.equal(
        'checkTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,address)',
      )
    })

    it('setGuard / setModuleGuard accept the no-op guard and store it in separate slots', async () => {
      const { safe, guard, guardAddress } = await loadFixture(deployGuarded)
      expect(await guard.supportsInterface('0xe6d7a83a')).to.equal(true)
      expect(await guard.supportsInterface('0x58401ed8')).to.equal(true)
      expect(await guard.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await guardsOf(safe)).to.deep.equal({ guard: guardAddress, moduleGuard: guardAddress })
    })
  })

  describe('owner path', () => {
    it('runs checkTransaction with the real fields, then checkAfterExecution with the safeTxHash', async () => {
      const { safe, safeAddress, guard, signers, recipient } = await loadFixture(deployGuarded)
      const tx = { to: recipient.address, value: parseEther('1') }
      const nonce = await safe.nonce()
      const hash = await safeTxHash(safe, tx)
      const signatures = await signSafeTx(safe, tx, signers)
      const before = await ethers.provider.getBalance(recipient.address)

      const sent = await execAsOwners(safe, tx, signers, { executor: signers[1] })

      expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + parseEther('1'))
      await expectEvent(sent, guard, 'TransactionChecked', [
        safeAddress,
        recipient.address,
        parseEther('1'),
        '0x',
        Operation.CALL,
        signatures,
        signers[1].address,
        nonce,
        hash, // getTransactionHash(..., nonce() - 1) inside the hook is the executed safeTxHash
      ])
      await expectEvent(sent, guard, 'TransactionGasFields', [safeAddress, 0, 0, 0, ZeroAddress, ZeroAddress])
      await expectEvent(sent, guard, 'AfterExecutionChecked', [safeAddress, hash, true])
      expect(await eventsOf(sent, guard, 'ModuleTransactionChecked')).to.have.length(0)
    })

    it('passes an appended policy-context tail to the guard verbatim; the Safe ignores it', async () => {
      const { safe, guard, guardAddress, signers, recipient } = await loadFixture(deployGuarded)
      const tx = { to: recipient.address, value: 1n }
      const entries = [
        { policy: guardAddress, data: '0xc0ffee' },
        { policy: recipient.address, data: '0x' },
      ]
      const tail = policyContextTail(entries)
      const ownerSigs = await signSafeTx(safe, tx, signers)

      const sent = await execAsOwners(safe, tx, signers, { tail })

      const [log] = await eventsOf(sent, guard, 'TransactionChecked')
      const signatures: string = log.args.signatures
      expect(signatures).to.equal(ownerSigs + tail.slice(2))
      // Decode the SignatureExtension from the end, as the engine will.
      const bytes = ethers.getBytes(signatures)
      expect(ethers.hexlify(bytes.slice(-32))).to.equal(CONTEXT_TYPE_HASH)
      const length = Number(BigInt(ethers.hexlify(bytes.slice(-64, -32))))
      const payload = bytes.slice(bytes.length - 64 - length, bytes.length - 64)
      const [decoded] = coder.decode(['tuple(address policy, bytes data)[]'], payload)
      expect(decoded.map((e: { policy: string; data: string }) => [e.policy, e.data])).to.deep.equal(
        entries.map((e) => [e.policy, e.data]),
      )
    })

    it('reverts the whole Safe transaction when the inner call fails (gas fields zero): no post-hook with false', async () => {
      const { safe, guardAddress, signers } = await loadFixture(deployGuarded)
      const nonce = await safe.nonce()
      // NoopGuardV2 has no fallback, so an unknown selector reverts.
      await expectAnyRevert(execAsOwners(safe, { to: guardAddress, data: '0xdeadbeef' }, signers))
      expect(await safe.nonce()).to.equal(nonce)
    })

    it('a reverting checkTransaction reverts execTransaction with the guard error', async () => {
      const { safe, guard, signers, recipient } = await loadFixture(deployGuarded)
      await guard.setBlocked(true)
      await expectRevert(execAsOwners(safe, { to: recipient.address, value: 1n }, signers), guard, 'Blocked')
    })

    it('rejects too few signatures (GS020) before the guard runs', async () => {
      const { safe, signers, recipient } = await loadFixture(deployGuarded)
      await expectAnyRevert(execAsOwners(safe, { to: recipient.address, value: 1n }, [signers[0]]))
    })
  })

  describe('module path', () => {
    it('runs checkModuleTransaction with the module address, then the post-hook with the returned hash', async () => {
      const { safe, safeAddress, guard, module, recipient } = await loadFixture(deployGuarded)
      const call = { to: recipient.address, value: 3n, data: '0xabcdef' }
      const expectedHash = keccak256(
        coder.encode(
          ['address', 'address', 'address', 'uint256', 'bytes', 'uint8'],
          [safeAddress, module.address, call.to, call.value, call.data, Operation.CALL],
        ),
      )

      const sent = await execAsModule(safe, module, call)

      await expectEvent(sent, guard, 'ModuleTransactionChecked', [
        safeAddress,
        recipient.address,
        3n,
        '0xabcdef',
        Operation.CALL,
        module.address,
        expectedHash,
      ])
      await expectEvent(sent, guard, 'AfterModuleExecutionChecked', [safeAddress, expectedHash, true])
      expect(await eventsOf(sent, guard, 'TransactionChecked')).to.have.length(0)
    })

    it('execTransactionFromModuleReturnData runs the module guard too', async () => {
      const { safe, guard, module, recipient } = await loadFixture(deployGuarded)
      const sent = await safe
        .connect(module)
        .execTransactionFromModuleReturnData(recipient.address, 1n, '0x', 0)
      expect(await eventsOf(sent, guard, 'ModuleTransactionChecked')).to.have.length(1)
      expect(await eventsOf(sent, guard, 'AfterModuleExecutionChecked')).to.have.length(1)
    })

    it('a failing inner call does not revert: the post-hook sees success = false', async () => {
      const { safe, safeAddress, guard, guardAddress, module } = await loadFixture(deployGuarded)
      const sent = await execAsModule(safe, module, { to: guardAddress, data: '0xdeadbeef' })
      const [post] = await eventsOf(sent, guard, 'AfterModuleExecutionChecked')
      expect(post.args.safe).to.equal(safeAddress)
      expect(post.args.success).to.equal(false)
    })

    it('a reverting checkModuleTransaction reverts execTransactionFromModule (not a false return)', async () => {
      const { safe, guard, module, recipient } = await loadFixture(deployGuarded)
      await guard.setBlocked(true)
      await expectRevert(execAsModule(safe, module, { to: recipient.address, value: 1n }), guard, 'Blocked')
    })

    it('rejects a module that is not enabled (GS104)', async () => {
      const { safe, stranger, recipient } = await loadFixture(deployGuarded)
      await expectAnyRevert(execAsModule(safe, stranger, { to: recipient.address, value: 1n }))
    })

    it('the transaction guard and the module guard are independent: each covers only its own path', async () => {
      const f = await loadFixture(deploy)
      await enableModule(f.safe, f.module, f.signers)
      await setGuard(f.safe, f.guardAddress, f.signers)
      const moduleTx = await execAsModule(f.safe, f.module, { to: f.recipient.address, value: 1n })
      expect(await eventsOf(moduleTx, f.guard, 'ModuleTransactionChecked')).to.have.length(0)

      await setGuard(f.safe, ZeroAddress, f.signers)
      await setModuleGuard(f.safe, f.guardAddress, f.signers)
      const ownerTx = await execAsOwners(f.safe, { to: f.recipient.address, value: 1n }, f.signers)
      expect(await eventsOf(ownerTx, f.guard, 'TransactionChecked')).to.have.length(0)
    })
  })

  describe('batches and DELEGATECALL', () => {
    it('executes a MultiSendCallOnly batch as owners; the guard sees one DELEGATECALL to the batch', async () => {
      const { safe, infra, guard, signers, recipient, stranger } = await loadFixture(deployGuarded)
      const batch = await infra.multiSendCallOnly.getAddress()
      const calls = [
        { to: recipient.address, value: 2n },
        { to: stranger.address, value: 3n },
      ]
      const before = [
        await ethers.provider.getBalance(recipient.address),
        await ethers.provider.getBalance(stranger.address),
      ]

      const sent = await execAsOwners(safe, multiSendTx(batch, calls), signers)

      expect(await ethers.provider.getBalance(recipient.address)).to.equal(before[0] + 2n)
      expect(await ethers.provider.getBalance(stranger.address)).to.equal(before[1] + 3n)
      const [log] = await eventsOf(sent, guard, 'TransactionChecked')
      expect(log.args.to).to.equal(batch)
      expect(log.args.operation).to.equal(BigInt(Operation.DELEGATECALL))
      expect(log.args.data).to.equal(multiSendData(calls))
    })

    it('executes a MultiSendCallOnly batch as a module', async () => {
      const { safe, infra, guard, module, recipient } = await loadFixture(deployGuarded)
      const batch = await infra.multiSendCallOnly.getAddress()
      const before = await ethers.provider.getBalance(recipient.address)
      const sent = await execAsModule(
        safe,
        module,
        multiSendTx(batch, [{ to: recipient.address, value: 4n }]),
      )
      expect(await ethers.provider.getBalance(recipient.address)).to.equal(before + 4n)
      const [log] = await eventsOf(sent, guard, 'ModuleTransactionChecked')
      expect(log.args.operation).to.equal(BigInt(Operation.DELEGATECALL))
    })

    it('MultiSendCallOnly rejects a DELEGATECALL sub-call', async () => {
      const { safe, infra, signers, recipient } = await loadFixture(deployGuarded)
      const batch = await infra.multiSendCallOnly.getAddress()
      const tx = multiSendTx(batch, [{ to: recipient.address, operation: Operation.DELEGATECALL }])
      await expectAnyRevert(execAsOwners(safe, tx, signers))
    })

    it('MultiSend (not CallOnly) runs a nested DELEGATECALL sub-call', async () => {
      const { safe, infra, signers } = await loadFixture(deployGuarded)
      const hash = keccak256('0x01')
      const inner = await signHashOnchainTx(infra, hash)
      const tx = multiSendTx(await infra.multiSend.getAddress(), [
        { to: inner.to, data: inner.data, operation: Operation.DELEGATECALL },
      ])
      await execAsOwners(safe, tx, signers)
      const msgHash = await safeMessageHash(safe, coder.encode(['bytes32'], [hash]))
      expect(await safe.signedMessages(msgHash)).to.equal(1n)
    })

    it('runs a plain DELEGATECALL (SignMessageLib) as owners and as a module', async () => {
      const { safe, infra, guard, signers, module } = await loadFixture(deployGuarded)
      const owners = await execAsOwners(safe, await signHashOnchainTx(infra, keccak256('0x02')), signers)
      const [ownerLog] = await eventsOf(owners, guard, 'TransactionChecked')
      expect(ownerLog.args.operation).to.equal(BigInt(Operation.DELEGATECALL))

      const viaModule = await execAsModule(safe, module, await signHashOnchainTx(infra, keccak256('0x03')))
      const [moduleLog] = await eventsOf(viaModule, guard, 'ModuleTransactionChecked')
      expect(moduleLog.args.operation).to.equal(BigInt(Operation.DELEGATECALL))
      const msgHash = await safeMessageHash(safe, coder.encode(['bytes32'], [keccak256('0x03')]))
      expect(await safe.signedMessages(msgHash)).to.equal(1n)
    })
  })

  describe('ERC-1271', () => {
    it('validates a hash signed on-chain via SignMessageLib (empty signature)', async () => {
      const { safe, infra, signers } = await loadFixture(deployGuarded)
      const hash = keccak256('0x1271')
      await expectAnyRevert(isValidSignature(safe, hash, '0x'))

      await execAsOwners(safe, await signHashOnchainTx(infra, hash), signers)

      expect(await isValidSignature(safe, hash, '0x')).to.equal(EIP1271_MAGIC_VALUE)
      // signedMessages is slot 7 of Safe 1.5.0's storage (rev 2 SPEC §10).
      const msgHash = await safeMessageHash(safe, coder.encode(['bytes32'], [hash]))
      const slot = keccak256(coder.encode(['bytes32', 'uint256'], [msgHash, 7]))
      expect(BigInt(await safe.getStorageAt(slot, 1))).to.equal(1n)
    })

    it('validates owners’ off-chain signatures over the SafeMessage hash', async () => {
      const { safe, signers, stranger } = await loadFixture(deploy)
      const hash = keccak256('0xbeef')
      expect(await isValidSignature(safe, hash, await signHashOffchain(safe, hash, signers))).to.equal(
        EIP1271_MAGIC_VALUE,
      )
      await expectAnyRevert(
        isValidSignature(safe, hash, await signHashOffchain(safe, hash, [signers[0], stranger])),
      )
      await expectAnyRevert(isValidSignature(safe, hash, await signHashOffchain(safe, hash, [signers[0]])))
    })
  })
})
