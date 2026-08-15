import { describe, it, expect } from 'vitest'

import {
  PUSH_ROUTE_MAP as FE_MAP,
  PUSH_ROUTE_SCHEMA_VERSION as FE_VERSION,
  interpolateRoute as feInterpolate,
} from '../../src/lib/notifications/pushRouteMap'
import {
  PUSH_ROUTE_MAP as EDGE_MAP,
  PUSH_ROUTE_SCHEMA_VERSION as EDGE_VERSION,
  interpolateRoute as edgeInterpolate,
  enrichPushDataWithRoute,
} from '../../supabase/functions/notify-push/routeMap'

describe('Block 7.2 / B3 — pushRouteMap FE↔Edge-Function Parity', () => {
  it('schema versions match', () => {
    expect(EDGE_VERSION).toBe(FE_VERSION)
  })

  it('map shapes are byte-identical (sorted JSON)', () => {
    // Sorted-key JSON normalises object-key-order and is therefore a strict
    // structural equality test. Drift in route, focus or fallbackRoute
    // breaks the test loud, before it reaches the device.
    const sort = (m: Record<string, unknown>): string => {
      const keys = Object.keys(m).sort()
      return JSON.stringify(
        keys.reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = m[k]
          return acc
        }, {}),
      )
    }
    expect(sort(EDGE_MAP)).toBe(sort(FE_MAP))
  })

  it('interpolate behaviour matches', () => {
    const cases = [
      { template: '/craftsman/jobs/{jobId}', jobId: 'job-1' },
      { template: '/craftsman/korrekturen', jobId: 'job-1' },
      { template: '/x/{jobId}/y', jobId: 'job-2' },
    ]
    for (const c of cases) {
      expect(edgeInterpolate(c.template, { jobId: c.jobId })).toBe(
        feInterpolate(c.template, { jobId: c.jobId }),
      )
    }
  })

  describe('enrichPushDataWithRoute', () => {
    it('returns data unchanged when type is unknown', () => {
      const data = {
        jobId: 'job-1',
        type: 'totally_unknown_type',
        signalId: 'sig-1',
        priority: 'action',
      }
      const result = enrichPushDataWithRoute(data)
      expect(result).toEqual(data)
    })

    it('returns data unchanged when jobId is missing', () => {
      const data = {
        type: 'correction_created',
        signalId: 'sig-1',
        priority: 'action',
      }
      const result = enrichPushDataWithRoute(data)
      expect(result).toEqual(data)
    })

    it('enriches with route + focus + fallbackRoute + actionVersion when type is known', () => {
      const data = {
        jobId: 'job-abc',
        type: 'correction_created',
        signalId: 'sig-1',
        priority: 'action',
      }
      const result = enrichPushDataWithRoute(data)
      expect(result).toEqual({
        ...data,
        route: '/craftsman/jobs/job-abc',
        focus: 'timeline',
        fallbackRoute: '/craftsman/korrekturen',
        actionVersion: 1,
      })
    })

    it('does NOT add focus key when map entry has no focus', () => {
      const data = {
        jobId: 'job-abc',
        type: 'correction_rejected',
        signalId: 'sig-1',
        priority: 'action',
      }
      const result = enrichPushDataWithRoute(data) as Record<string, unknown>
      expect(result.route).toBe('/craftsman/korrekturen')
      expect(result.fallbackRoute).toBe('/craftsman/korrekturen')
      expect(result.actionVersion).toBe(1)
      expect('focus' in result).toBe(false)
    })

    it('returns data unchanged when data is undefined', () => {
      expect(enrichPushDataWithRoute(undefined)).toBeUndefined()
    })

    it('interpolates {workerId} for a spatial deep-link (C-9)', () => {
      const result = enrichPushDataWithRoute({
        jobId: 'job-abc',
        type: 'spatial_worker_pins_added',
        workerId: 'worker-7',
        signalId: 'sig-1',
        priority: 'action',
      }) as Record<string, unknown>
      expect(result.route).toBe(
        '/craftsman/jobs/job-abc/spatial?tab=pins&author=worker-7',
      )
      expect(result.fallbackRoute).toBe('/craftsman/korrekturen')
      expect('focus' in result).toBe(false)
    })

    it('interpolates {entityId} for the customer offer_sent push (C-10)', () => {
      // entityId carries offers.id; route resolves to the customer-facing
      // /quotes/:offerId screen.
      const result = enrichPushDataWithRoute({
        jobId: 'job-abc',
        type: 'offer_sent',
        entityId: 'offer-uuid-xyz',
        signalId: 'sig-1',
        priority: 'action',
      }) as Record<string, unknown>
      expect(result.route).toBe('/quotes/offer-uuid-xyz')
      expect(result.fallbackRoute).toBe('/projects')
      expect('focus' in result).toBe(false)
    })
  })
})
