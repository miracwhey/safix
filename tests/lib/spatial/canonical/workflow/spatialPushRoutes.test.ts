/**
 * spatialPushRoutes — the 5 spatial deep-link builders (Phase B · B-7).
 * Every route targets the `?tab=` shell stem and is whitelist-matchable.
 */
import { describe, expect, it } from 'vitest'
import {
  SPATIAL_PUSH_ROUTES,
  SPATIAL_PUSH_ROUTE_WHITELIST_PATTERN,
  spatialCustomerPinHighPath,
  spatialQuoteDeadlineSoonPath,
  spatialRescanResponsePath,
  spatialValidatorWarningPath,
  spatialWorkerPinsAddedPath,
  type SpatialPushRouteKey,
} from '../../../../../src/lib/spatial/canonical/workflow/spatialPushRoutes.ts'

const JOB = 'job-abc-123'
const WORKER = 'worker-xyz-456'
const PIN = 'pin-def-789'

/** Path with the query stripped — what the resolver whitelist-tests. */
function stem(path: string): string {
  return path.split('?')[0]
}

describe('spatial push-route builders', () => {
  it('worker-pins-added → Pins tab, author-filtered', () => {
    expect(spatialWorkerPinsAddedPath({ jobId: JOB, workerId: WORKER })).toBe(
      `/craftsman/jobs/${JOB}/spatial?tab=pins&author=${WORKER}`,
    )
  })

  it('customer-pin-high → Pins tab scrolled to the pin', () => {
    expect(spatialCustomerPinHighPath({ jobId: JOB, pinId: PIN })).toBe(
      `/craftsman/jobs/${JOB}/spatial?tab=pins&pin=${PIN}`,
    )
  })

  it('quote-deadline-soon → BoM tab', () => {
    expect(spatialQuoteDeadlineSoonPath({ jobId: JOB })).toBe(
      `/craftsman/jobs/${JOB}/spatial?tab=bom`,
    )
  })

  it('validator-warning → 3D viewer (bare stem)', () => {
    expect(spatialValidatorWarningPath({ jobId: JOB })).toBe(`/craftsman/jobs/${JOB}/spatial`)
  })

  it('rescan-response → Re-Scan tab', () => {
    expect(spatialRescanResponsePath({ jobId: JOB, accepted: true })).toBe(
      `/craftsman/jobs/${JOB}/spatial?tab=rescan`,
    )
  })
})

describe('whitelist compatibility', () => {
  it('every route stem matches the whitelist pattern', () => {
    const routes = [
      spatialWorkerPinsAddedPath({ jobId: JOB, workerId: WORKER }),
      spatialCustomerPinHighPath({ jobId: JOB, pinId: PIN }),
      spatialQuoteDeadlineSoonPath({ jobId: JOB }),
      spatialValidatorWarningPath({ jobId: JOB }),
      spatialRescanResponsePath({ jobId: JOB, accepted: false }),
    ]
    for (const route of routes) {
      expect(SPATIAL_PUSH_ROUTE_WHITELIST_PATTERN.test(stem(route))).toBe(true)
    }
  })

  it('all 5 keys are present and callable', () => {
    const keys: SpatialPushRouteKey[] = [
      'spatial_worker_pins_added',
      'spatial_customer_pin_high',
      'spatial_quote_deadline_soon',
      'spatial_validator_warning',
      'spatial_rescan_response',
    ]
    expect(Object.keys(SPATIAL_PUSH_ROUTES).sort()).toEqual([...keys].sort())
  })

  it('the map is frozen', () => {
    expect(Object.isFrozen(SPATIAL_PUSH_ROUTES)).toBe(true)
  })
})
