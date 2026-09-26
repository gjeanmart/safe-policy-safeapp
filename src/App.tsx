import { useMemo, useState } from 'react'
import { type Address, getAddress, isAddress, zeroAddress } from 'viem'
import { RolesPanel } from './components/RolesPanel'
import { Notes } from './components/Notes'
import { SettingsPanel } from './components/SettingsPanel'
import { Playground } from './components/playground/Playground'
import { SetupPanel } from './components/setup/SetupPanel'
import { AddressView, Badge, Notice } from './components/ui'
import { chain } from './config/client'
import { type Sandbox, SandboxContext } from './context'
import { useAsync } from './hooks/useAsync'
import { isSupportedChain, useSafeApp } from './hooks/useSafeApp'
import { describeError } from './lib/errors'
import { activeGuard, fetchSafeState, isKnownGuard } from './lib/safe'
import { settingsStore } from './store'

const TABS = {
  roles: '1 · Roles',
  setup: '2 · Guard & policies',
  playground: '3 · Playground',
  notes: 'Notes',
  settings: 'Settings',
} as const
type TabKey = keyof typeof TABS

const STATE_REFRESH_MS = 15_000

/** Outside Safe{Wallet}: pick a Safe to inspect and drive modules for. */
function StandalonePicker() {
  const [input, setInput] = useState('')
  return (
    <div className="card">
      <p>
        Not running inside Safe{'{Wallet}'}. Add this app as a custom Safe App to propose multisig
        transactions, or enter a Sepolia Safe address to inspect it and act as its modules.
      </p>
      <div className="row">
        <input
          className="grow mono"
          placeholder="Safe address"
          value={input}
          onChange={(e) => setInput(e.target.value.trim())}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!isAddress(input)}
          onClick={() => settingsStore.set((s) => ({ ...s, standaloneSafe: getAddress(input) }))}
        >
          Use Safe
        </button>
      </div>
    </div>
  )
}

function Workspace({ safe, propose }: { safe: Address; propose?: Sandbox['propose'] }) {
  const [tab, setTab] = useState<TabKey>('roles')
  const settings = settingsStore.use()
  const safeState = useAsync(() => fetchSafeState(safe), safe, STATE_REFRESH_MS)
  const state = safeState.data

  const sandbox = useMemo<Sandbox>(() => {
    const installed = state && activeGuard(state)
    return {
      safe,
      state,
      reloadState: safeState.reload,
      guard: installed ?? settings.guard,
      guardInstalled: installed !== undefined,
      propose,
    }
  }, [safe, state, safeState.reload, settings.guard, propose])

  const unknownGuard = state && state.moduleGuard !== zeroAddress && !isKnownGuard(state.moduleGuard)

  return (
    <SandboxContext.Provider value={sandbox}>
      <header className="app-header">
        <h1>Safe Policy Sandbox</h1>
        <AddressView address={safe} />
        {propose ? (
          <Badge tone="ok">Safe App</Badge>
        ) : (
          <Badge tone="warn">standalone · read + modules only</Badge>
        )}
        {sandbox.guardInstalled ? <Badge tone="ok">guard installed</Badge> : <Badge>no guard</Badge>}
        {!propose && (
          <button
            type="button"
            className="link"
            onClick={() => settingsStore.set((s) => ({ ...s, standaloneSafe: undefined }))}
          >
            change Safe
          </button>
        )}
      </header>

      {safeState.error !== undefined && (
        <Notice tone="bad">Could not read the Safe: {describeError(safeState.error)}</Notice>
      )}
      {unknownGuard && (
        <Notice tone="warn">The Safe has a module guard that is not one of the known policy guards.</Notice>
      )}

      <nav className="tabs">
        {(Object.keys(TABS) as TabKey[]).map((key) => (
          <button
            key={key}
            type="button"
            className={key === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {TABS[key]}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'roles' && <RolesPanel />}
        {tab === 'setup' && <SetupPanel />}
        {tab === 'playground' && <Playground />}
        {tab === 'notes' && <Notes />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </SandboxContext.Provider>
  )
}

export function App() {
  const connection = useSafeApp()
  const settings = settingsStore.use()

  if (connection.mode === 'loading') return <p className="container">Connecting to Safe{'{Wallet}'}…</p>

  if (connection.mode === 'safe-app') {
    if (!isSupportedChain(connection.chainId)) {
      return (
        <div className="container">
          <Notice tone="bad">
            This sandbox only supports {chain.name}. Switch the Safe{'{Wallet}'} network.
          </Notice>
        </div>
      )
    }
    return (
      <div className="container">
        <Workspace safe={connection.safe} propose={connection.propose} />
      </div>
    )
  }

  return (
    <div className="container">
      {settings.standaloneSafe ? <Workspace safe={settings.standaloneSafe} /> : <StandalonePicker />}
    </div>
  )
}
