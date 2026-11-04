import { useSandbox } from '../context'
import { activityStore, uiStore } from '../store'
import { ActivityList, useSettleSentEntries } from './ActivityPanel'
import { ChevronIcon } from './icons'
import { Badge } from './ui'
import { QueueCount, QueuePanel, TimelockHistory } from './v2/Queue'

type DockTab = 'queue' | 'activity'

/**
 * The panel at the bottom of every tab: Queue (what waits on someone, with its one next action)
 * and Activity (history: what the app sent, then everything the Timelock closed). Collapsible; the open state and the tab survive reloads.
 */
export function Dock() {
  const { v2Installed } = useSandbox()
  const activity = activityStore.use()
  const { activityOpen: open, dockTab } = uiStore.use()
  useSettleSentEntries(activity)
  const tab: DockTab = dockTab ?? 'activity'
  const inFlight = activity.filter((a) => a.status === 'sent').length
  const show = (next: DockTab) =>
    uiStore.set((s) => ({ ...s, dockTab: next, activityOpen: s.dockTab === next ? !s.activityOpen : true }))

  return (
    <section className="card activity-panel">
      <header className="card-header">
        <div className="row dock-tabs" role="tablist" aria-label="Queue and activity">
          <button
            type="button"
            className="activity-toggle"
            aria-expanded={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => uiStore.set((s) => ({ ...s, activityOpen: !s.activityOpen }))}
          >
            <span className={open ? 'chevron open' : 'chevron'}>
              <ChevronIcon />
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'queue'}
            className={tab === 'queue' ? 'dock-tab active' : 'dock-tab'}
            onClick={() => show('queue')}
          >
            Queue {v2Installed && <QueueCount />}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'activity'}
            className={tab === 'activity' ? 'dock-tab active' : 'dock-tab'}
            onClick={() => show('activity')}
          >
            Activity <span className="muted small">{activity.length}</span>
            {inFlight > 0 && <Badge tone="warn">{inFlight} pending</Badge>}
          </button>
        </div>
        {open && tab === 'activity' && activity.length > 0 && (
          <button type="button" className="btn" onClick={() => activityStore.set([])}>
            Clear
          </button>
        )}
      </header>
      {open && (
        <div className="dock-body">
          {tab === 'queue' ? (
            <QueuePanel />
          ) : (
            <>
              <ActivityList activity={activity} />
              {v2Installed && <TimelockHistory />}
            </>
          )}
        </div>
      )}
    </section>
  )
}
