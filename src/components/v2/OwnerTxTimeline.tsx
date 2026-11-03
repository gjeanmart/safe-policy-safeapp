/** The four steps of a delayed owner transaction; `done` once it executed. */
export type OwnerStep = 'sign' | 'schedule' | 'wait' | 'execute' | 'done'

const STEPS: { key: Exclude<OwnerStep, 'done'>; label: string }[] = [
  { key: 'sign', label: 'Sign' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'wait', label: 'Wait' },
  { key: 'execute', label: 'Execute' },
]

/** Sign → schedule → wait → execute, with the current step highlighted. */
export function OwnerTxTimeline({ current, delay }: { current: OwnerStep; delay?: string }) {
  const at = current === 'done' ? STEPS.length : STEPS.findIndex((s) => s.key === current)
  return (
    <ol className="timeline" aria-label="Steps of an owner transaction">
      {STEPS.map((s, i) => (
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
