import { formatUnits } from 'viem'

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

/** Formats a token amount with at most `digits` fractional digits. */
export function formatAmount(amount: bigint, decimals: number, digits = 4): string {
  const [whole, fraction = ''] = formatUnits(amount, decimals).split('.')
  const trimmed = fraction.slice(0, digits).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole!
}

export function formatDuration(seconds: bigint | number): string {
  const s = Number(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local date and time as `yyyy-mm-dd HH:mm:ss` (24h). */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}
