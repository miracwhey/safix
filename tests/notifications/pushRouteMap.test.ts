import { describe, it, expect } from 'vitest'

import {
  PUSH_ROUTE_MAP,
  PUSH_ROUTE_SCHEMA_VERSION,
  interpolateRoute,
} from '../../src/lib/notifications/pushRouteMap'
import {
  isWhitelistedRoute,
  isAttentionFocus,
} from '../../src/lib/notifications/pushRoutes'

const MOCK_JOB_ID = 'job-test-123'
const MOCK_WORKER_ID = 'worker-test-9'
const MOCK_PIN_ID = 'pin-test-7'
const MOCK_ENTITY_ID = 'entity-test-42'

describe('Block 7.2 / B3 — pushRouteMap', () => {
  describe('whitelist invariant', () => {
    it('every map route resolves to a whitelisted path after token substitution', () => {
      for (const [type, entry] of Object.entries(PUSH_ROUTE_MAP)) {
        const interpolated = interpolateRoute(entry.route, {
          jobId: MOCK_JOB_ID,
          workerId: MOCK_WORKER_ID,
          pinId: MOCK_PIN_ID,
          entityId: MOCK_ENTITY_ID,
        })
        // Strip query if present (spatial deep-links carry tokens in query).
        const path = interpolated.split('?')[0]
        expect(
          isWhitelistedRoute(path),
          `${type}.route → ${interpolated} must be in PUSH_ROUTE_WHITELIST`,
        ).toBe(true)
      }
    })

    it('every map fallbackRoute is whitelisted as-is (no template substitution)', () => {
      for (const [type, entry] of Object.entries(PUSH_ROUTE_MAP)) {
        const path = entry.fallbackRoute.split('?')[0]
        expect(
          isWhitelistedRoute(path),
          `${type}.fallbackRoute → ${entry.fallbackRoute} must be in PUSH_ROUTE_WHITELIST`,
        ).toBe(true)
      }
    })

    it('every focus value is a valid AttentionFocus', () => {
      for (const [type, entry] of Object.entries(PUSH_ROUTE_MAP)) {
        if (entry.focus === undefined) continue
        expect(
          isAttentionFocus(entry.focus),
          `${type}.focus → ${entry.focus} must be a valid AttentionFocus`,
        ).toBe(true)
      }
    })
  })

  describe('coverage invariant', () => {
    it('covers at least 5 notification event types (MVP requirement)', () => {
      expect(Object.keys(PUSH_ROUTE_MAP).length).toBeGreaterThanOrEqual(5)
    })

    it('covers all notification types referenced in user-facing block plan', () => {
      // Lock the MVP set explicitly. Adding/removing requires touching the
      // Plan + Mockup + Memory — keeps drift visible.
      // Block A · M1 — correction_resolved hinzugefügt: Worker-facing
      // approval-Push war vorher als no_route gedroppt.
      const expectedTypes = [
        'correction_created',
        'correction_rejected',
        'correction_resolved',
        'worker_marked_complete',
        'admin_confirmed_complete',
        'dispute_under_review',
        // Phase C · C-9 — spatial deep-links (provider-hub-spec §10.4).
        'spatial_worker_pins_added',
        'spatial_customer_pin_high',
        'spatial_quote_deadline_soon',
        'spatial_validator_warning',
        'spatial_rescan_response',
        // C-10 customer push-deep-link — spatial quote sent.
        'offer_sent',
      ] as const
      for (const type of expectedTypes) {
        expect(
          PUSH_ROUTE_MAP[type],
          `${type} should be present in PUSH_ROUTE_MAP`,
        ).toBeDefined()
      }
    })
  })

  describe('inline-action category invariant', () => {
    it('correction_created has CORRECTION_DECISION category for iOS Approve/Reject buttons', () => {
      // Block A · M1 — iOS rendert Inline-Action-Buttons nur, wenn die
      // APNs-Payload `aps.category` setzt. Das wird in der Edge-Function
      // aus PUSH_ROUTE_MAP[type].category gezogen. Lockt die Verbindung
      // zu pushActionRegistry.PUSH_ACTION_CATEGORIES.
      expect(PUSH_ROUTE_MAP.correction_created?.category).toBe('CORRECTION_DECISION')
    })

    it('only types with reversible kontext-arme Entscheidung have a category', () => {
      // Allowlist — wer hier landet, muss in pushActionRegistry registriert
      // sein. Drift-Schutz: ein neuer Type mit category zwingt einen
      // bewussten Plan-Review (Memory: feedback_push_action_security_default).
      const typesWithCategory = Object.entries(PUSH_ROUTE_MAP)
        .filter(([, entry]) => entry.category !== undefined)
        .map(([type]) => type)
      expect(typesWithCategory).toEqual(['correction_created'])
    })
  })

  describe('interpolateRoute', () => {
    it('substitutes single {jobId} placeholder', () => {
      expect(
        interpolateRoute('/craftsman/jobs/{jobId}', { jobId: 'j-1' }),
      ).toBe('/craftsman/jobs/j-1')
    })

    it('leaves template unchanged when no placeholder present', () => {
      expect(
        interpolateRoute('/craftsman/korrekturen', { jobId: 'j-1' }),
      ).toBe('/craftsman/korrekturen')
    })

    it('only substitutes the first {jobId} occurrence', () => {
      // We have no use case for multiple substitutions — this test locks
      // current behavior so a future regression to "replaceAll" is loud.
      expect(
        interpolateRoute('/x/{jobId}/y/{jobId}', { jobId: 'j-1' }),
      ).toBe('/x/j-1/y/{jobId}')
    })

    it('substitutes {workerId} / {pinId} when supplied (C-9 spatial)', () => {
      expect(
        interpolateRoute('/craftsman/jobs/{jobId}/spatial?tab=pins&author={workerId}', {
          jobId: 'j-1',
          workerId: 'w-9',
        }),
      ).toBe('/craftsman/jobs/j-1/spatial?tab=pins&author=w-9')
      // Leaves a token untouched when its value is absent.
      expect(
        interpolateRoute('/craftsman/jobs/{jobId}/spatial?pin={pinId}', { jobId: 'j-1' }),
      ).toBe('/craftsman/jobs/j-1/spatial?pin={pinId}')
    })

    it('substitutes {entityId} when supplied (C-10 customer offer push)', () => {
      // The offer_sent route carries entityId = offers.id in the PATH (not
      // query), so substitution is mandatory for the path to reach the
      // whitelisted /quotes/:offerId mount.
      expect(
        interpolateRoute('/quotes/{entityId}', {
          jobId: 'j-1',
          entityId: 'offer-abc',
        }),
      ).toBe('/quotes/offer-abc')
    })
  })

  describe('schema version invariant', () => {
    it('exposes PUSH_ROUTE_SCHEMA_VERSION matching the central constant', () => {
      // Re-export sanity — make sure the constant is stable across files.
      expect(PUSH_ROUTE_SCHEMA_VERSION).toBe(1)
    })
  })
})
