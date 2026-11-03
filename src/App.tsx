import { useMemo, useState } from 'react'
import { type Address, getAddress, isAddress, zeroAddress } from 'viem'
import { RolesPanel } from './components/RolesPanel'
import { Footer } from './components/Footer'
import { Notes } from './components/Notes'
import { VaultDialogs } from './components/PasswordDialogs'
import { VaultLockButton } from './components/VaultLockButton'
import { SettingsPanel } from './components/SettingsPanel'
import { Playground } from './components/playground/Playground'
import { SetupPanel } from './components/setup/SetupPanel'
import { EngineSwitch } from './components/v2/EngineSwitch'
import { V2SetupPanel } from './components/v2/V2SetupPanel'
import { WhyV2 } from './components/v2/WhyV2'
import { AddressView, Badge, Notice } from './components/ui'
import { chain, publicClient } from './config/client'
import { deployedV2Engines, v2EngineFor } from './config/contracts'
import { type Sandbox, SandboxContext } from './context'
import { useAsync } from './hooks/useAsync'
import { isSupportedChain, useSafeApp } from './hooks/useSafeApp'
import { describeError } from './lib/errors'
import { activeGuard, fetchSafeState, isKnownGuard } from './lib/safe'
import { isEngineV2 } from './lib/v2/attachments'
import { settingsStore } from './store'

/** The three steps, left to right; Settings sits at the far right and Notes in the footer. */
const STEPS = {
  roles: '1 · Roles',
  setup: '2 · Guard & policies',
  playground: '3 · Playground',
  why: 'Why V2',
} as const
type TabKey = keyof typeof STEPS | 'settings' | 'notes'

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

/** The V2 engine installed in either guard slot (its `supportsInterface` says so), if any. */
async function installedV2Engine(guards: readonly Address[]): Promise<Address | null> {
  for (const guard of guards) if (await isEngineV2(publicClient, guard)) return guard
  return null
}

function Workspace({
  safe,
  propose,
  getQueuedTx,
}: {
  safe: Address
  propose?: Sandbox['propose']
  getQueuedTx?: Sandbox['getQueuedTx']
}) {
  const [tab, setTab] = useState<TabKey>('roles')
  const settings = settingsStore.use()
  const safeState = useAsync(() => fetchSafeState(safe), safe, STATE_REFRESH_MS)
  const state = safeState.data
  const guards = state ? [state.moduleGuard, state.guard].filter((g) => g !== zeroAddress) : []
  const v2Guard = useAsync(() => installedV2Engine(guards), guards.join(',')).data ?? undefined

  const sandbox = useMemo<Sandbox>(() => {
    const installedV1 = state && activeGuard(state)
    const engineVersion = v2Guard ? 'v2' : installedV1 ? 'v1' : (settings.engineVersion ?? 'v1')
    const deployed = deployedV2Engines()
    const v2 = v2Guard ? v2EngineFor(v2Guard) : deployed[0]
    return {
      safe,
      state,
      reloadState: safeState.reload,
      guard: v2Guard ?? installedV1 ?? settings.guard,
      guardInstalled: v2Guard !== undefined || installedV1 !== undefined,
      propose,
      getQueuedTx,
      engineVersion,
      v2,
      v2Installed: v2Guard !== undefined,
    }
  }, [safe, state, safeState.reload, settings, propose, getQueuedTx, v2Guard])

  const unknownGuard =
    state && state.moduleGuard !== zeroAddress && !isKnownGuard(state.moduleGuard) && !v2Guard

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
        {sandbox.v2Installed ? (
          <Badge tone="ok">Policy Engine V2 installed</Badge>
        ) : sandbox.guardInstalled ? (
          <Badge tone="ok">guard installed</Badge>
        ) : (
          <Badge>no guard</Badge>
        )}
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
        {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((key) => (
          <button
            key={key}
            type="button"
            className={key === tab ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {STEPS[key]}
          </button>
        ))}
        <div className="tabs-end">
          <VaultLockButton />
          <button
            type="button"
            className={tab === 'settings' ? 'tab active' : 'tab'}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </div>
      </nav>

      <main>
        {tab === 'roles' && <RolesPanel />}
        {tab === 'setup' && (
          <>
            {!sandbox.guardInstalled && <EngineSwitch />}
            {sandbox.engineVersion === 'v2' ? <V2SetupPanel /> : <SetupPanel />}
          </>
        )}
        {tab === 'why' && <WhyV2 />}
        {tab === 'playground' && <Playground />}
        {tab === 'notes' && <Notes />}
        {tab === 'settings' && <SettingsPanel />}
      </main>

      <Footer onOpenNotes={() => setTab('notes')} />
      <VaultDialogs />
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
        <Workspace safe={connection.safe} propose={connection.propose} getQueuedTx={connection.getQueuedTx} />
      </div>
    )
  }

  return (
    <div className="container">
      {settings.standaloneSafe ? <Workspace safe={settings.standaloneSafe} /> : <StandalonePicker />}
    </div>
  )
}
