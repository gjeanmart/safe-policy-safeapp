import { V2_ENGINES, deployedV2Engines } from '../../config/contracts'
import { useSandbox } from '../../context'
import { settingsStore } from '../../store'
import { InfoTip } from '../Tooltip'
import { Card, Tag } from '../ui'

/**
 * Before any guard is installed: pick the engine to set up. Once one is installed its
 * `supportsInterface` decides and this switch is hidden.
 */
export function EngineSwitch() {
  const { engineVersion, v2 } = useSandbox()
  const deployed = deployedV2Engines()
  const set = (engine: 'v1' | 'v2') => settingsStore.set((s) => ({ ...s, engineVersion: engine }))
  return (
    <Card
      title={
        <span className="row">
          Policy engine
          <InfoTip>
            V1 binds one policy per (target, selector, operation) for every caller. V2 attaches policies at
            scopes (actor, target, selector) and runs every match: see the Why V2 tab.
          </InfoTip>
        </span>
      }
    >
      <div className="row wrap">
        <div className="tabs" role="group" aria-label="Engine">
          <button
            type="button"
            className={engineVersion === 'v1' ? 'tab active' : 'tab'}
            onClick={() => set('v1')}
          >
            V1 · SafePolicyGuard
          </button>
          <button
            type="button"
            className={engineVersion === 'v2' ? 'tab active' : 'tab'}
            onClick={() => set('v2')}
          >
            V2 · SafePolicyGuardV2 <Tag tone="info">prototype</Tag>
          </button>
        </div>
        {engineVersion === 'v2' && deployed.length > 0 && (
          <label className="row">
            Engine
            <select
              value={v2?.label}
              onChange={(e) => settingsStore.set((s) => ({ ...s, v2Engine: e.target.value }))}
            >
              {V2_ENGINES.map((e) => (
                <option key={e.label} value={e.label} disabled={!deployed.includes(e)}>
                  configuration delay {e.label}
                  {deployed.includes(e) ? '' : ' (not deployed)'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Card>
  )
}
