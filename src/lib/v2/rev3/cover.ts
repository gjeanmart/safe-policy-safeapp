import { ANY, CallMatch, OP_CALL, OP_DELEGATECALL, OWNERS, Selectors } from './types'

/**
 * The Timelock covering rule (SPEC.md §5.1), mirroring `TimelockPolicyFreeze.validate`: let D be
 * the longest delay of the Timelock's attachments at OWNERS or ANY; each owner-path route out of a
 * policy must then be delayed at least D by one of them that matches it (any of its lookup scopes,
 * the route's operation in the op mask). Checked by the engine on the final configuration of every
 * `configure` that touches the Timelock, whatever the order of its changes.
 *
 * Only imports `./types`, so `contracts/test/v2/stories/Configure.test.ts` can load it and check it
 * against the engine on random configurations.
 */

/** One attachment of the Timelock policy (one deployment), with its delay. */
export type CoverAttachment = {
  scope: { actor: string; to: string; selector: string; callMatch: number }
  /** Normalized op mask (`OP_CALL`, `OP_DELEGATECALL` or both). */
  opMask: number
  delay: number
}

export type CoverRoute = {
  name: string
  /** The zero address for "any DELEGATECALL". */
  to: string
  selector: string
  op: number
}

/** The first route not delayed `delay`: the arguments of `TimelockNotCoveringConfiguration`. */
export type UncoveredRoute = CoverRoute & { delay: number }

const ZERO = '0x0000000000000000000000000000000000000000'

/** The seven routes, in the order the contract checks them. */
export const coverRoutes = (engine: string, safe: string): CoverRoute[] => [
  { name: 'any DELEGATECALL', to: ZERO, selector: '0x00000000', op: OP_DELEGATECALL },
  { name: 'engine.configure', to: engine, selector: Selectors.configure, op: OP_CALL },
  { name: 'Safe.setGuard', to: safe, selector: Selectors.safeSetGuard, op: OP_CALL },
  { name: 'Safe.setModuleGuard', to: safe, selector: Selectors.safeSetModuleGuard, op: OP_CALL },
  { name: 'Safe.enableModule', to: safe, selector: Selectors.safeEnableModule, op: OP_CALL },
  { name: 'Safe.disableModule', to: safe, selector: Selectors.safeDisableModule, op: OP_CALL },
  { name: 'Safe.setFallbackHandler', to: safe, selector: Selectors.safeSetFallbackHandler, op: OP_CALL },
]

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The owner path sees attachments at OWNERS and at ANY. */
export const onOwnerPath = (actor: string) => same(actor, OWNERS) || same(actor, ANY)

/** Whether `a` delays `route` by at least `need`. */
function covers(a: CoverAttachment, route: CoverRoute, need: number): boolean {
  if ((a.opMask & route.op) === 0 || a.delay < need) return false
  if (a.scope.callMatch === CallMatch.ANY) return true
  if (!same(a.scope.to, route.to)) return false
  return a.scope.callMatch === CallMatch.CONTRACT || same(a.scope.selector, route.selector)
}

/**
 * The first uncovered route, or `null` when the configuration is valid. `attachments` are the
 * Timelock's attachments in the final configuration (other actors are ignored).
 */
export function uncoveredRoute(
  attachments: readonly CoverAttachment[],
  engine: string,
  safe: string,
): UncoveredRoute | null {
  const owners = attachments.filter((a) => onOwnerPath(a.scope.actor))
  const need = Math.max(0, ...owners.map((a) => a.delay))
  if (need === 0) return null
  const route = coverRoutes(engine, safe).find((r) => !owners.some((a) => covers(a, r, need)))
  return route ? { ...route, delay: need } : null
}
