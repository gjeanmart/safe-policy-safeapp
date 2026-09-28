import { type FormEvent, useState } from 'react'
import { createPublicClient, http } from 'viem'
import {
  DEFAULT_RPC_URL,
  LOGS_BLOCK_RANGE,
  RPC_PRESETS,
  chain,
  isAllowedRpcUrl,
  rpcUrl,
  rpcUrlStore,
} from '../config/client'
import { GUARDS } from '../config/contracts'
import { describeError } from '../lib/errors'
import { fieldError, parseRpcUrlInput } from '../lib/validation'
import { MIN_PASSWORD_LENGTH, changeVaultPassword, unlockForSession, vaultStore } from '../lib/vault'
import { InfoTip, Tooltip } from './Tooltip'
import { AsyncButton, Badge, Card, Field, Notice } from './ui'

type CheckResult = { ok: boolean; lines: { label: string; ok: boolean; detail: string }[] }

/**
 * Checks an RPC for what this app relies on: Sepolia, reachable from the browser (CORS), and
 * `eth_getLogs` over a full 50k-block chunk with an address filter (policy rebuild).
 */
async function checkRpc(url: string): Promise<CheckResult> {
  const client = createPublicClient({ chain, transport: http(url, { timeout: 15_000, retryCount: 0 }) })
  const lines: CheckResult['lines'] = []
  try {
    const chainId = await client.getChainId()
    lines.push({ label: 'Chain', ok: chainId === chain.id, detail: `chain id ${chainId}` })
    const head = await client.getBlockNumber()
    lines.push({ label: 'Head block', ok: true, detail: head.toString() })
    try {
      await client.getLogs({ address: GUARDS[0].address, fromBlock: head - LOGS_BLOCK_RANGE, toBlock: head })
      lines.push({ label: 'getLogs (50k blocks)', ok: true, detail: 'supported' })
    } catch (error) {
      lines.push({ label: 'getLogs (50k blocks)', ok: false, detail: describeError(error) })
    }
  } catch (error) {
    // A CORS rejection surfaces here as a generic network error.
    lines.push({ label: 'Reachable', ok: false, detail: describeError(error) })
  }
  return { ok: lines.every((l) => l.ok), lines }
}

export function SettingsPanel() {
  const saved = rpcUrlStore.use()
  const [input, setInput] = useState(rpcUrl())
  const [result, setResult] = useState<CheckResult>()

  const current = saved ?? DEFAULT_RPC_URL
  const isValidUrl = isAllowedRpcUrl(input)

  // Every cached read came from the previous endpoint: reload so all data is refetched.
  const apply = (url: string | undefined) => {
    rpcUrlStore.set(url)
    window.location.reload()
  }

  return (
    <>
      <Card title="Settings">
        <h3 className="row">
          Sepolia RPC endpoint
          <InfoTip>
            Used for every read and for the transactions roles send as modules. Multisig proposals go through
            Safe{'{Wallet}'} and are not affected. The endpoint must allow browser requests (CORS) and
            eth_getLogs over 50k blocks.
          </InfoTip>
        </h3>
        <p className="small">
          In use: <span className="mono">{current}</span>{' '}
          {saved ? <Badge>custom</Badge> : <Badge tone="ok">default</Badge>}
        </p>

        <div className="stack">
          <Field label="RPC URL" error={fieldError(parseRpcUrlInput(input, isAllowedRpcUrl), false)}>
            <input
              className="mono"
              value={input}
              onChange={(e) => {
                setInput(e.target.value.trim())
                setResult(undefined)
              }}
              placeholder={DEFAULT_RPC_URL}
            />
            <span className="preset-links">
              {RPC_PRESETS.map((preset) => (
                <Tooltip content={`Use ${preset.url}`}>
                  <button
                    key={preset.url}
                    type="button"
                    className="link"
                    onClick={() => {
                      setInput(preset.url)
                      setResult(undefined)
                    }}
                  >
                    {preset.label}
                  </button>
                </Tooltip>
              ))}
            </span>
          </Field>

          <div className="row wrap">
            <AsyncButton
              disabled={!isValidUrl}
              title="Check chain id, reachability from the browser and getLogs support"
              onClick={async () => setResult(await checkRpc(input))}
            >
              Test
            </AsyncButton>
            <AsyncButton
              variant="primary"
              disabled={!isValidUrl || input === current}
              onClick={() => apply(input === DEFAULT_RPC_URL ? undefined : input)}
            >
              Save &amp; reload
            </AsyncButton>
            {saved && (
              <AsyncButton title={`Go back to ${DEFAULT_RPC_URL}`} onClick={() => apply(undefined)}>
                Reset to default
              </AsyncButton>
            )}
          </div>

          {result && (
            <Notice tone={result.ok ? 'info' : 'bad'}>
              <ul className="plain small">
                {result.lines.map((line) => (
                  <li key={line.label}>
                    {line.ok ? '✓' : '✗'} <strong>{line.label}</strong>:{' '}
                    <span className="break">{line.detail}</span>
                  </li>
                ))}
              </ul>
              {!result.ok && (
                <div className="small">Saving is still possible, but parts of the app may not work.</div>
              )}
            </Notice>
          )}
        </div>
      </Card>
      <PasswordSettings />
    </>
  )
}

/**
 * Role keys password: change it (re-encrypts every key), or create it when none exists yet.
 * Validation follows the app's form rules: mismatches show under the field, empty fields only
 * after a submit attempt.
 */
function PasswordSettings() {
  const vault = vaultStore.use()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!vault) {
    return (
      <Card title="Role keys password">
        <p className="muted small">No password yet: it is created when you add your first role.</p>
        <AsyncButton onClick={unlockForSession}>Create a password</AsyncButton>
      </Card>
    )
  }

  const errors = {
    current: submitted && !current ? 'Enter your current password.' : undefined,
    next:
      submitted && next.length < MIN_PASSWORD_LENGTH
        ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
        : undefined,
    confirm: confirm && confirm !== next ? 'The passwords do not match.' : undefined,
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    setDone(false)
    setError(undefined)
    if (!current || next.length < MIN_PASSWORD_LENGTH || confirm !== next) return
    setBusy(true)
    try {
      await changeVaultPassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      setSubmitted(false)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Role keys password">
      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <Field label="Current password" error={errors.current ?? error}>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setError(undefined)
              }}
            />
          </Field>
          <Field label="New password" error={errors.next}>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password" error={errors.confirm}>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Re-encrypting…' : 'Change password'}
          </button>
          <InfoTip>
            Every role key is decrypted and re-encrypted with the new password (fresh salt) before anything is
            saved, so a failure keeps the old password. There is still no recovery if you forget it.
          </InfoTip>
          {done && <span className="muted small">Password changed.</span>}
        </div>
      </form>
    </Card>
  )
}
