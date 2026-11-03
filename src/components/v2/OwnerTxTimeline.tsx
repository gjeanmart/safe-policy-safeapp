/** The four steps of a delayed owner transaction; `done` once it executed. */
export type OwnerStep = 'sign' | 'schedule' | 'wait' | 'execute' | 'done'

const STEPS: { key: Exclude<OwnerStep, 'done'>; label: string }[] = [
  { key: 'sign', label: 'Sign' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'wait', label: 'Wait' },
  { key: 'execute', label: 'Execute' },
]

/**
 * Sign → schedule → wait → execute, with the current step highlighted. A module schedules its own
 * call, so its timeline (`module`) has no signing step.
 */
export function OwnerTxTimeline({
  current,
  delay,
  module = false,
}: {
  current: OwnerStep
  delay?: string
  module?: boolean
}) {
  const steps = module ? STEPS.slice(1) : STEPS
  const at = current === 'done' ? steps.length : steps.findIndex((s) => s.key === current)
  return (
    <ol className="timeline" aria-label="Steps of a delayed transaction">
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={i < at ? 'done' : i === at ? 'current' : undefined}
          aria-current={i === at ? 'step' : undefined}
        >
          {s.label}
          {s.key === 'wait' && delay ? ` ${delay}` : ''}
        </li>
      ))}
    </ol>
  )
}
