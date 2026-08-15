/**
 * Spatial · Push-Route Builders (Phase-B · B-7)
 *
 * The 5 spatial deep-link routes from provider-hub-spec §10.4. Every route
 * targets the Provider Job-Spatial-Detail shell `/craftsman/jobs/{jobId}/spatial`
 * and selects a tab / focus via the query string — matching the shell's
 * `?tab=` routing (B-2 `CraftsmanJobSpatialDetailScreen`). All 5 therefore
 * share ONE path stem; the resolver strips the query before whitelist-testing.
 *
 * PHASE-C WIRED (C-9): `SPATIAL_PUSH_ROUTE_WHITELIST_PATTERN` is mirrored in
 * `PUSH_ROUTE_WHITELIST`; the 5 dispatch entries live in `pushRouteMap.ts` +
 * its Deno mirror (`interpolateRoute` substitutes `{jobId}`/`{workerId}`/
 * `{pinId}`); the shell + Pins tab read `?tab=`/`?author=`/`?pin=`. These
 * builders are kept query-identical to the push-route-map templates.
 */

// ── route param types ───────────────────────────────────────────────────────

export interface SpatialWorkerPinsAddedParams {
  jobId: string
  workerId: string
}

export interface SpatialCustomerPinHighParams {
  jobId: string
  pinId: string
}

export interface SpatialQuoteDeadlineSoonParams {
  jobId: string
}

export interface SpatialValidatorWarningParams {
  jobId: string
}

export interface SpatialRescanResponseParams {
  jobId: string
  /** true = customer accepted · false = customer rejected. */
  accepted: boolean
}

/** Shared shell stem for every spatial deep-link. */
function spatialStem(jobId: string): string {
  return `/craftsman/jobs/${jobId}/spatial`
}

// ── route builders (pure) ───────────────────────────────────────────────────

/** Worker added pins — Foreman should review. Opens the Pins tab, author-focused. */
export function spatialWorkerPinsAddedPath(params: SpatialWorkerPinsAddedParams): string {
  return `${spatialStem(params.jobId)}?tab=pins&author=${params.workerId}`
}

/** Customer set a high-severity pin — opens the Pins tab scrolled to that pin. */
export function spatialCustomerPinHighPath(params: SpatialCustomerPinHighParams): string {
  return `${spatialStem(params.jobId)}?tab=pins&pin=${params.pinId}`
}

/** Quote deadline approaching — opens the Stückliste (BoM) tab. */
export function spatialQuoteDeadlineSoonPath(params: SpatialQuoteDeadlineSoonParams): string {
  return `${spatialStem(params.jobId)}?tab=bom`
}

/** Scene has new validator warnings — opens the 3D viewer. */
export function spatialValidatorWarningPath(params: SpatialValidatorWarningParams): string {
  return spatialStem(params.jobId)
}

/** Customer responded to a re-scan request — opens the Re-Scan tab. */
export function spatialRescanResponsePath(params: SpatialRescanResponseParams): string {
  return `${spatialStem(params.jobId)}?tab=rescan`
}

// ── typed map (single source of truth for tests + Phase-C wiring) ───────────

export const SPATIAL_PUSH_ROUTES = Object.freeze({
  spatial_worker_pins_added: spatialWorkerPinsAddedPath,
  spatial_customer_pin_high: spatialCustomerPinHighPath,
  spatial_quote_deadline_soon: spatialQuoteDeadlineSoonPath,
  spatial_validator_warning: spatialValidatorWarningPath,
  spatial_rescan_response: spatialRescanResponsePath,
})

export type SpatialPushRouteKey = keyof typeof SPATIAL_PUSH_ROUTES

/** The single whitelist pattern Phase-C adds to `PUSH_ROUTE_WHITELIST`. */
export const SPATIAL_PUSH_ROUTE_WHITELIST_PATTERN = /^\/craftsman\/jobs\/[a-zA-Z0-9_-]+\/spatial$/
