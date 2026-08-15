/**
 * Spatial · Canonical · Errors
 *
 * Custom Error hierarchy mirroring Block-A's `ScanFsmViolation` pattern so
 * downstream code can dispatch on `.code` rather than parsing `.message`.
 *
 * V1 ships the minimal base class — concrete subclasses (SpatialFsmViolation,
 * SchemaValidationError) land in Day 8 (XM-6 audit-fix) alongside the
 * repository + FSM layer.
 */

/** Canonical-side error codes used in V1. Extend as new domains land. */
export type CanonicalErrorCode =
  | 'R15_NOT_YET_IMPLEMENTED'
  | 'INVALID_INPUT'
  | 'SCHEMA_VIOLATION'
  | 'FSM_VIOLATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'STORAGE_ERROR'
  // H1 audit-fix · optimistic-concurrency miss on `spatial_scenes`: a
  // compare-and-set UPDATE (`.eq('parametric_version', expected)`) matched zero
  // rows because a concurrent writer incremented the version first. Callers can
  // branch on this to re-fetch + retry instead of silently clobbering the blob.
  | 'CONFLICT'

/**
 * Base error type for the canonical L1 layer. Carries a stable `.code` so
 * callers can branch on the failure mode without scraping the message.
 */
export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode

  constructor(code: CanonicalErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'CanonicalError'
    this.code = code
    // Preserve prototype chain across transpilation (TS pre-4 used to lose it).
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Postgres SQLSTATE used by the Day-7 trigger functions to signal an
 * illegal state transition (`spatial_scenes`, `spatial_change_orders`).
 * Day-8 repositories dispatch on `error.code === SPATIAL_FSM_SQLSTATE`.
 */
export const SPATIAL_FSM_SQLSTATE = '45SPF'

/**
 * Raised by the spatial-scene FSM (`repository/spatialSceneFsm.ts`) when an
 * illegal transition is attempted on `validation_state`, `customer_verify_
 * state`, or `spatial_change_orders.status` (XM-7 audit-fix · mirrors
 * Block-A `ScanFsmViolation` pattern).
 *
 * Distinct subclass so call-sites can `catch (e) if (e instanceof
 * SpatialFsmViolation)` without a code-string check.
 */
export class SpatialFsmViolation extends CanonicalError {
  readonly from: string
  readonly to: string
  readonly fsmName: string

  constructor(fsmName: string, from: string, to: string, message?: string) {
    super(
      'FSM_VIOLATION',
      message ?? `SPATIAL_FSM_VIOLATION: ${fsmName} cannot transition ${from} → ${to}`,
    )
    this.name = 'SpatialFsmViolation'
    this.fsmName = fsmName
    this.from = from
    this.to = to
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Wraps validator-engine output when the caller needs an throwable form
 * (e.g. parametric.json failed JSON-Schema validation pre-save). Day-8
 * `parametric-storage.ts` raises this before writing the blob, so callers
 * never persist an invalid scene.
 */
export class SchemaValidationError extends CanonicalError {
  readonly issues: ReadonlyArray<unknown>

  constructor(issues: ReadonlyArray<unknown>, message?: string) {
    super('SCHEMA_VIOLATION', message ?? `SchemaValidationError: ${issues.length} issue(s)`)
    this.name = 'SchemaValidationError'
    this.issues = issues
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
