import {
  AbiCoder,
  Contract,
  type BigNumberish,
  type BytesLike,
  type ContractTransactionResponse,
  type Interface,
  type Signer,
  TypedDataEncoder,
  ZeroAddress,
  concat,
  dataLength,
  getAddress,
  id,
  keccak256,
  solidityPacked,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { ethers } from 'hardhat'
import type {
  CompatibilityFallbackHandler,
  MultiSend,
  MultiSendCallOnly,
  Safe,
  SafeProxyFactory,
  SignMessageLib,
} from '../../../typechain-types'

/**
 * A real Safe 1.5.0 (vendored in `contracts/vendor/safe-smart-account`) for V2 end-to-end tests:
 * deployment through the proxy factory, owner and module execution, guards, MultiSend and
 * ERC-1271 messages. ethers v6, no hardhat-chai-matchers.
 */

const coder = AbiCoder.defaultAbiCoder()
const VENDOR = 'contracts/vendor/safe-smart-account'

export const Operation = { CALL: 0, DELEGATECALL: 1 } as const

/** `keccak256("SafePolicyGuardV2.PolicyContext.v1")`, the owner-path context type (SPEC §6.6). */
export const CONTEXT_TYPE_HASH = id('SafePolicyGuardV2.PolicyContext.v1')

/** Safe 1.5.0 storage slots of the two guards (`getStorageAt` reads them). */
export const GUARD_STORAGE_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
export const MODULE_GUARD_STORAGE_SLOT = '0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947'

export const EIP1271_MAGIC_VALUE = '0x1626ba7e'

export interface SafeInfra {
  singleton: Safe
  factory: SafeProxyFactory
  fallbackHandler: CompatibilityFallbackHandler
  multiSendCallOnly: MultiSendCallOnly
  multiSend: MultiSend
  signMessageLib: SignMessageLib
}

/** A Safe transaction; omitted fields are zero (`nonce` defaults to the Safe's current nonce). */
export interface SafeTx {
  to: string
  value?: BigNumberish
  data?: BytesLike
  operation?: number
  safeTxGas?: BigNumberish
  baseGas?: BigNumberish
  gasPrice?: BigNumberish
  gasToken?: string
  refundReceiver?: string
  nonce?: BigNumberish
}

/** One call of a MultiSend batch. */
export interface MetaTx {
  to: string
  value?: BigNumberish
  data?: BytesLike
  operation?: number
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
}

const SAFE_MESSAGE_TYPES = { SafeMessage: [{ name: 'message', type: 'bytes' }] }

/** Deploys the Safe 1.5.0 singleton, proxy factory, fallback handler and libraries. */
export async function deploySafeInfra(): Promise<SafeInfra> {
  const deploy = async <T>(path: string, name: string) =>
    (await ethers.deployContract(`${VENDOR}/${path}:${name}`)) as unknown as T
  return {
    singleton: await deploy<Safe>('Safe.sol', 'Safe'),
    factory: await deploy<SafeProxyFactory>('proxies/SafeProxyFactory.sol', 'SafeProxyFactory'),
    fallbackHandler: await deploy<CompatibilityFallbackHandler>(
      'handler/CompatibilityFallbackHandler.sol',
      'CompatibilityFallbackHandler',
    ),
    multiSendCallOnly: await deploy<MultiSendCallOnly>(
      'libraries/MultiSendCallOnly.sol',
      'MultiSendCallOnly',
    ),
    multiSend: await deploy<MultiSend>('libraries/MultiSend.sol', 'MultiSend'),
    signMessageLib: await deploy<SignMessageLib>('libraries/SignMessageLib.sol', 'SignMessageLib'),
  }
}

export interface DeploySafeOptions {
  /** Infrastructure to deploy from; a fresh one is deployed when omitted. */
  infra?: SafeInfra
  /** Fallback handler; defaults to `infra.fallbackHandler`, `null` installs none. */
  fallbackHandler?: string | null
  saltNonce?: BigNumberish
}

/** Deploys a Safe 1.5.0 proxy with `owners` and `threshold` (and the compatibility fallback handler). */
export async function deploySafe(
  owners: (string | Signer)[],
  threshold: number,
  opts: DeploySafeOptions = {},
): Promise<Safe> {
  const infra = opts.infra ?? (await deploySafeInfra())
  const ownerAddresses = await Promise.all(owners.map(addressOf))
  const handler =
    opts.fallbackHandler === null
      ? ZeroAddress
      : (opts.fallbackHandler ?? (await infra.fallbackHandler.getAddress()))
  const initializer = infra.singleton.interface.encodeFunctionData('setup', [
    ownerAddresses,
    threshold,
    ZeroAddress,
    '0x',
    handler,
    ZeroAddress,
    0,
    ZeroAddress,
  ])
  const singleton = await infra.singleton.getAddress()
  const salt = opts.saltNonce ?? BigInt(keccak256(ethers.randomBytes(32)))
  const proxy = await infra.factory.createProxyWithNonce.staticCall(singleton, initializer, salt)
  await (await infra.factory.createProxyWithNonce(singleton, initializer, salt)).wait()
  return infra.singleton.attach(proxy) as Safe
}

/** Fills the defaults of `tx`, reading the Safe's nonce when `tx.nonce` is unset. */
export async function completeTx(safe: Safe, tx: SafeTx): Promise<Required<SafeTx>> {
  return {
    to: getAddress(tx.to),
    value: tx.value ?? 0n,
    data: tx.data ?? '0x',
    operation: tx.operation ?? Operation.CALL,
    safeTxGas: tx.safeTxGas ?? 0n,
    baseGas: tx.baseGas ?? 0n,
    gasPrice: tx.gasPrice ?? 0n,
    gasToken: tx.gasToken ?? ZeroAddress,
    refundReceiver: tx.refundReceiver ?? ZeroAddress,
    nonce: tx.nonce ?? (await safe.nonce()),
  }
}

async function domainOf(safe: Safe) {
  const { chainId } = await ethers.provider.getNetwork()
  return { chainId, verifyingContract: await safe.getAddress() }
}

/** The EIP-712 `safeTxHash` of `tx`, computed off-chain (equals `safe.getTransactionHash`). */
export async function safeTxHash(safe: Safe, tx: SafeTx): Promise<string> {
  return TypedDataEncoder.hash(await domainOf(safe), SAFE_TX_TYPES, await completeTx(safe, tx))
}

/**
 * Concatenates 65-byte ECDSA signatures sorted by signer address, as `checkNSignatures` requires.
 * `sign` returns each signer's signature over whatever is being approved.
 */
async function packSorted(signers: Signer[], sign: (s: Signer) => Promise<string>): Promise<string> {
  const signed = await Promise.all(
    signers.map(async (s) => ({ owner: BigInt(await s.getAddress()), sig: await sign(s) })),
  )
  signed.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  return concat(signed.map((s) => s.sig))
}

/** Owners' EIP-712 signatures over `tx`, sorted and packed. */
export async function signSafeTx(safe: Safe, tx: SafeTx, signers: Signer[]): Promise<string> {
  const domain = await domainOf(safe)
  const values = await completeTx(safe, tx)
  return packSorted(signers, (s) => s.signTypedData(domain, SAFE_TX_TYPES, values))
}

/** A `SignatureExtension` envelope: `payload ‖ uint256(payload.length) ‖ typeHash`. */
export function signatureExtension(payload: BytesLike, typeHash: BytesLike): string {
  return concat([payload, toBeHex(dataLength(payload), 32), zeroPadValue(typeHash, 32)])
}

/** The owner-path policy context tail of SPEC §6.6: `abi.encode(PolicyContext[])` in a context envelope. */
export function policyContextTail(entries: { policy: string; data: BytesLike }[]): string {
  const payload = coder.encode(
    ['tuple(address policy, bytes data)[]'],
    [entries.map((e) => [e.policy, e.data])],
  )
  return signatureExtension(payload, CONTEXT_TYPE_HASH)
}

export interface ExecAsOwnersOptions {
  /** Bytes appended after the owner signatures (e.g. {@link policyContextTail}). */
  tail?: BytesLike
  /** Who submits `execTransaction`; defaults to the first signer. */
  executor?: Signer
}

/** Signs `tx` with `signers` (sorted, packed, plus `opts.tail`) and executes it. */
export async function execAsOwners(
  safe: Safe,
  tx: SafeTx,
  signers: Signer[],
  opts: ExecAsOwnersOptions = {},
): Promise<ContractTransactionResponse> {
  const full = await completeTx(safe, tx)
  const signatures = concat([await signSafeTx(safe, full, signers), opts.tail ?? '0x'])
  const executor = opts.executor ?? signers[0]
  return safe
    .connect(executor)
    .execTransaction(
      full.to,
      full.value,
      full.data,
      full.operation,
      full.safeTxGas,
      full.baseGas,
      full.gasPrice,
      full.gasToken,
      full.refundReceiver,
      signatures,
    )
}

/** Executes `tx` through `execTransactionFromModule`, sent by `module` (an enabled module). */
export async function execAsModule(
  safe: Safe,
  module: Signer,
  tx: MetaTx,
): Promise<ContractTransactionResponse> {
  return safe
    .connect(module)
    .execTransactionFromModule(tx.to, tx.value ?? 0n, tx.data ?? '0x', tx.operation ?? Operation.CALL)
}

/** An owner transaction calling the Safe itself. */
async function selfCall(
  safe: Safe,
  signers: Signer[],
  fn: 'enableModule' | 'setGuard' | 'setModuleGuard',
  arg: string,
) {
  const data = (safe.interface as Interface).encodeFunctionData(fn, [arg])
  return execAsOwners(safe, { to: await safe.getAddress(), data }, signers)
}

export async function enableModule(safe: Safe, module: string | Signer, signers: Signer[]) {
  return selfCall(safe, signers, 'enableModule', await addressOf(module))
}

/** Installs the transaction guard (owner path). `ZeroAddress` removes it. */
export async function setGuard(safe: Safe, guard: string, signers: Signer[]) {
  return selfCall(safe, signers, 'setGuard', guard)
}

/** Installs the Safe 1.5.0 module guard (module path). `ZeroAddress` removes it. */
export async function setModuleGuard(safe: Safe, guard: string, signers: Signer[]) {
  return selfCall(safe, signers, 'setModuleGuard', guard)
}

/** The installed guard and module guard, read from storage. */
export async function guardsOf(safe: Safe): Promise<{ guard: string; moduleGuard: string }> {
  const word = async (slot: string) => getAddress('0x' + (await safe.getStorageAt(slot, 1)).slice(26))
  return { guard: await word(GUARD_STORAGE_SLOT), moduleGuard: await word(MODULE_GUARD_STORAGE_SLOT) }
}

/** The packed `transactions` argument of `multiSend`: `op ‖ to ‖ value ‖ len ‖ data` per call. */
export function encodeMultiSend(calls: MetaTx[]): string {
  return concat(
    calls.map((c) => {
      const data = c.data ?? '0x'
      return solidityPacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [c.operation ?? Operation.CALL, c.to, c.value ?? 0n, dataLength(data), data],
      )
    }),
  )
}

/** Calldata of `multiSend(bytes)` for `calls`. */
export function multiSendData(calls: MetaTx[]): string {
  return concat(['0x8d80ff0a', coder.encode(['bytes'], [encodeMultiSend(calls)])])
}

/** A Safe transaction DELEGATECALLing `multiSend(calls)` on the batch contract at `batch`. */
export function multiSendTx(batch: string, calls: MetaTx[]): SafeTx {
  return { to: batch, data: multiSendData(calls), operation: Operation.DELEGATECALL }
}

/** The Safe's EIP-712 `SafeMessage` hash of `message` (what owners sign and `signedMessages` keys). */
export async function safeMessageHash(safe: Safe, message: BytesLike): Promise<string> {
  return TypedDataEncoder.hash(await domainOf(safe), SAFE_MESSAGE_TYPES, { message })
}

/**
 * Owners' off-chain signatures over the `SafeMessage` of `abi.encode(hash)`: what
 * `isValidSignature(hash, signatures)` of the compatibility handler checks.
 */
export async function signHashOffchain(safe: Safe, hash: BytesLike, signers: Signer[]): Promise<string> {
  const domain = await domainOf(safe)
  const message = coder.encode(['bytes32'], [hash])
  return packSorted(signers, (s) => s.signTypedData(domain, SAFE_MESSAGE_TYPES, { message }))
}

/** A Safe transaction that marks `abi.encode(hash)` as signed on-chain via `SignMessageLib` (DELEGATECALL). */
export async function signHashOnchainTx(infra: SafeInfra, hash: BytesLike): Promise<SafeTx> {
  return {
    to: await infra.signMessageLib.getAddress(),
    data: infra.signMessageLib.interface.encodeFunctionData('signMessage', [
      coder.encode(['bytes32'], [hash]),
    ]),
    operation: Operation.DELEGATECALL,
  }
}

/** Calls ERC-1271 `isValidSignature(bytes32, bytes)` on the Safe (served by its fallback handler). */
export async function isValidSignature(safe: Safe, hash: BytesLike, signature: BytesLike): Promise<string> {
  const erc1271 = new Contract(
    await safe.getAddress(),
    ['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'],
    ethers.provider,
  )
  return erc1271.isValidSignature(hash, signature)
}

async function addressOf(a: string | Signer): Promise<string> {
  return typeof a === 'string' ? getAddress(a) : a.getAddress()
}
