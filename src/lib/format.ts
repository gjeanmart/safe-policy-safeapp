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

/** How long ago `ms` was, Safe{Wallet} style: `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  const days = Math.floor(s / 86_400)
  return `${days} day${days === 1 ? '' : 's'} ago`
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

/** Local time of a unix timestamp (seconds) as `HH:mm`, with the date when it is not today. */
export function formatClock(seconds: bigint | number): string {
  const d = new Date(Number(seconds) * 1000)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${formatTime(d.getTime()).slice(0, 10)} ${time}`
}
