import { ActivePolicies } from './ActivePolicies'
import { PendingConfigs } from './PendingConfigs'
import { PolicyBuilder } from './PolicyBuilder'
import { SafeStatus } from './SafeStatus'

export function SetupPanel() {
  return (
    <>
      <SafeStatus showGuardSetup />
      <ActivePolicies />
      <PendingConfigs />
      <PolicyBuilder />
    </>
  )
}
