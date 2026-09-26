import { useState } from 'react'
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
import { InfoTip } from './Tooltip'
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
              <button
                key={preset.url}
                type="button"
                className="link"
                title={`Use ${preset.url}`}
                onClick={() => {
                  setInput(preset.url)
                  setResult(undefined)
                }}
              >
                {preset.label}
              </button>
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
            title="Save and reload the app with this endpoint"
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
  )
}
