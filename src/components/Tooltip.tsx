import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { InfoIcon } from './icons'

/** Room to keep between the bubble and the viewport edges. */
const EDGE = 8
const GAP = 6

type Placement = { top: number; left: number; below: boolean }

/**
 * Shows `content` instantly on hover or keyboard focus (the native `title` tooltip waits ~1s).
 * Rendered in a portal with fixed positioning, so scrolling containers do not clip it; placed
 * above the anchor, or below when there is no room.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<Placement>()

  // Measure after the bubble renders so it can be clamped to the viewport.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return
    const a = anchor.current.getBoundingClientRect()
    const b = bubble.current.getBoundingClientRect()
    const below = a.top - b.height - GAP < EDGE
    const left = Math.min(
      Math.max(a.left + a.width / 2 - b.width / 2, EDGE),
      window.innerWidth - b.width - EDGE,
    )
    setPlacement({ top: below ? a.bottom + GAP : a.top - b.height - GAP, left, below })
  }, [open])

  // No content (e.g. an AsyncButton without a title): render the children untouched.
  if (content === undefined || content === null || content === '') return <>{children}</>

  const show = () => setOpen(true)
  const hide = () => {
    setOpen(false)
    setPlacement(undefined)
  }

  return (
    <span
      ref={anchor}
      className="tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={bubble}
            role="tooltip"
            className={placement?.below ? 'tooltip tooltip-below' : 'tooltip'}
            // Invisible until measured, to avoid a one-frame jump.
            style={placement ? { top: placement.top, left: placement.left } : { visibility: 'hidden' }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}

/** Small ⓘ icon that reveals explanatory copy on hover / focus. */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <span className="info-icon" tabIndex={0} role="img" aria-label="More information">
        <InfoIcon />
      </span>
    </Tooltip>
  )
}
