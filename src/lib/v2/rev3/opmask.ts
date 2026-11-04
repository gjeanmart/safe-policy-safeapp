import { Kind, OP_ALL, OP_CALL, OP_DELEGATECALL } from './types'

/**
 * Op masks (SPEC.md §2): bit 0 CALL, bit 1 DELEGATECALL. Only imports `./types`, so the contract
 * tests check it against `ScopeLib.normalizeOpMask` (`contracts/test/v2/Scope.test.ts`).
 */

/** The stored mask: 0 means CALL for ALLOW, both ops for DENY and POLICY (`ScopeLib.normalizeOpMask`). */
export const normalizeOpMask = (kind: number, opMask: number): number =>
  opMask !== 0 ? opMask : kind === Kind.ALLOW ? OP_CALL : OP_ALL

const OP_NAMES: [number, string][] = [
  [OP_CALL, 'CALL'],
  [OP_DELEGATECALL, 'DELEGATECALL'],
]

/**
 * Why re-configuring an attachment from mask `before` to `after` (both as given in a change or
 * stored; 0 is normalized) protects less: a DENY or a policy that no longer applies to an
 * operation, or an ALLOW that now grants one more. Empty when not weaker.
 */
export function weakerOps(kind: number, before: number, after: number): string[] {
  const [b, a] = [normalizeOpMask(kind, before), normalizeOpMask(kind, after)]
  const changed = kind === Kind.ALLOW ? a & ~b : b & ~a
  return OP_NAMES.filter(([bit]) => changed & bit).map(([, name]) =>
    kind === Kind.ALLOW ? `now also grants ${name}` : `no longer applies to ${name}`,
  )
}
