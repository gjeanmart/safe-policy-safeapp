import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { type Address, type Hex, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { KEYSTORE_PATH, ensureHome } from './config'
import { CliError } from './output'

/**
 * The role key at rest: scrypt-derived AES-256-GCM. Only the signer (and `init`) ever decrypt it,
 * and both need a password typed in a real terminal, which the agent does not have.
 */
type Keystore = {
  version: 1
  address: Address
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; data: string }
}

/** scrypt N = 2^17, r = 8: ~128 MiB and ~0.3 s per unlock, the usual interactive-login setting. */
const KDF = { N: 2 ** 17, r: 8, p: 1 }
const MAXMEM = 256 * 1024 * 1024
export const MIN_PASSWORD_LENGTH = 8

const deriveKey = (password: string, salt: Buffer, kdf = KDF) =>
  scryptSync(password.normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM })

export function writeKeystore(privateKey: Hex, password: string): Address {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CliError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  const address = privateKeyToAccount(privateKey).address
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  const data = Buffer.concat([cipher.update(privateKey.slice(2), 'hex'), cipher.final()])
  const keystore: Keystore = {
    version: 1,
    address,
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('hex') },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: data.toString('hex'),
    },
  }
  ensureHome()
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2) + '\n', { mode: 0o600 })
  return address
}

export function keystoreAddress(): Address | undefined {
  if (!existsSync(KEYSTORE_PATH)) return undefined
  return getAddress((JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8')) as Keystore).address)
}

export function readKeystore(password: string): Hex {
  if (!existsSync(KEYSTORE_PATH)) {
    throw new CliError(`No keystore at ${KEYSTORE_PATH}.`, 'Run `safe-role init` first.')
  }
  const keystore = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8')) as Keystore
  const { kdf, cipher } = keystore
  const key = deriveKey(password, Buffer.from(kdf.salt, 'hex'), kdf)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(cipher.tag, 'hex'))
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(cipher.data, 'hex')), decipher.final()])
  } catch {
    throw new CliError('Wrong password.')
  }
  return `0x${plain.toString('hex')}`
}

/**
 * Commands that handle the key or change what the agent may do only run in an interactive
 * terminal. Agent shells (Claude Code, Codex) have no TTY, so they cannot run them.
 */
export function requireTty(command: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      `\`safe-role ${command}\` needs an interactive terminal.`,
      `Only the user can run it: ask them to run \`safe-role ${command}\` in their own terminal.`,
    )
  }
}

/** Reads one line from the terminal; with `hidden`, nothing is echoed. Resolves `''` on timeout. */
export function prompt(
  question: string,
  { hidden = false, timeoutMs }: { hidden?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) {
    const target = rl as unknown as { _writeToOutput: (s: string) => void }
    const write = target._writeToOutput
    target._writeToOutput = (s: string) =>
      write.call(rl, s.startsWith(question) ? question : s.includes('\n') ? '\n' : '')
  }
  return new Promise((resolve) => {
    const timer = timeoutMs
      ? setTimeout(() => {
          process.stdout.write('\n(timed out)\n')
          rl.close()
          resolve('')
        }, timeoutMs)
      : undefined
    rl.question(question, (answer) => {
      clearTimeout(timer)
      rl.close()
      resolve(answer.trim())
    })
  })
}
