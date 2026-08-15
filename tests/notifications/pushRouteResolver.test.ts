import { describe, it, expect } from 'vitest'

import { pushRouteResolver } from '../../src/lib/notifications/pushRouteResolver'
import {
  PUSH_ROUTE_SCHEMA_VERSION,
  PUSH_ROUTE_WHITELIST,
  isWhitelistedRoute,
} from '../../src/lib/notifications/pushRoutes'

const NOW = 1_746_288_000_000 // 2026-05-03T12:00:00.000Z, deterministic

describe('Block 7.2 / B1 — pushRouteResolver', () => {
  describe('valid payloads', () => {
    it('returns ok for whitelisted route + valid focus', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/korrekturen/c-123',
          focus: 'documents',
          actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
          expiresAt: NOW + 60_000,
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'ok',
        path: '/craftsman/korrekturen/c-123',
        search: '?focus=documents',
      })
    })

    it('returns ok for whitelisted route without focus', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/jobs/job-1',
          actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'ok',
        path: '/craftsman/jobs/job-1',
        search: '',
      })
    })

    it('preserves existing query and appends focus', () => {
      const result = pushRouteResolver(
        {
          route: '/projects/p-77?ref=push',
          focus: 'payment',
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'ok',
        path: '/projects/p-77',
        search: '?ref=push&focus=payment',
      })
    })

    it('strips fragment hash from route before matching', () => {
      const result = pushRouteResolver(
        { route: '/craftsman/korrekturen#scroll' },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'ok',
        path: '/craftsman/korrekturen',
        search: '',
      })
    })
  })

  describe('drop reasons', () => {
    it('drops payload with unknown actionVersion', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/korrekturen/c-1',
          actionVersion: 999,
        },
        { now: NOW },
      )
      expect(result).toEqual({ kind: 'drop', reason: 'unknown_version' })
    })

    it('drops payload with expired expiresAt', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/korrekturen/c-1',
          expiresAt: NOW - 1,
        },
        { now: NOW },
      )
      expect(result).toEqual({ kind: 'drop', reason: 'expired' })
    })

    it('drops payload with expiresAt exactly at now (treated as expired)', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/korrekturen/c-1',
          expiresAt: NOW,
        },
        { now: NOW },
      )
      expect(result).toEqual({ kind: 'drop', reason: 'expired' })
    })

    it('drops payload with empty route', () => {
      const result = pushRouteResolver({ route: '' }, { now: NOW })
      expect(result).toEqual({ kind: 'drop', reason: 'no_route' })
    })

    it('drops payload with missing route', () => {
      const result = pushRouteResolver({}, { now: NOW })
      expect(result).toEqual({ kind: 'drop', reason: 'no_route' })
    })

    it('drops null/undefined payload as malformed', () => {
      expect(pushRouteResolver(null, { now: NOW })).toEqual({
        kind: 'drop',
        reason: 'malformed',
      })
      expect(pushRouteResolver(undefined, { now: NOW })).toEqual({
        kind: 'drop',
        reason: 'malformed',
      })
    })

    it('drops non-object payload as malformed', () => {
      // Cast through unknown to test runtime-resilience against malformed
      // payloads delivered by the Capacitor bridge — we never trust the
      // wire format blindly.
      const result = pushRouteResolver(
        'not-an-object' as unknown as null,
        { now: NOW },
      )
      expect(result).toEqual({ kind: 'drop', reason: 'malformed' })
    })

    it('drops when route is not whitelisted and no fallbackRoute provided', () => {
      const result = pushRouteResolver(
        { route: '/admin/secret-panel' },
        { now: NOW },
      )
      expect(result).toEqual({ kind: 'drop', reason: 'no_route' })
    })

    it('drops when both route and fallbackRoute are not whitelisted', () => {
      const result = pushRouteResolver(
        {
          route: '/admin/secret-panel',
          fallbackRoute: '/admin/another-secret',
        },
        { now: NOW },
      )
      expect(result).toEqual({ kind: 'drop', reason: 'no_route' })
    })
  })

  describe('fallback paths', () => {
    it('falls back when route is not whitelisted but fallbackRoute is', () => {
      const result = pushRouteResolver(
        {
          route: '/admin/dropped-feature',
          fallbackRoute: '/craftsman/korrekturen',
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'fallback',
        reason: 'route_not_whitelisted',
        path: '/craftsman/korrekturen',
        search: '',
      })
    })

    it('falls back when focus is invalid even if route is whitelisted', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/jobs/j-1',
          focus: 'not-a-real-focus',
          fallbackRoute: '/craftsman/korrekturen',
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'fallback',
        reason: 'invalid_focus',
        path: '/craftsman/korrekturen',
        search: '',
      })
    })

    it('preserves fallbackRoute query when falling back', () => {
      const result = pushRouteResolver(
        {
          route: '/admin/x',
          fallbackRoute: '/craftsman/korrekturen?from=push',
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'fallback',
        reason: 'route_not_whitelisted',
        path: '/craftsman/korrekturen',
        search: '?from=push',
      })
    })
  })

  describe('whitelist invariants', () => {
    it('whitelist contains the four MVP route families', () => {
      // Smoke each pattern against a representative path. Lock the four
      // families to make accidental removals fail loudly.
      const samples = [
        '/craftsman/korrekturen',
        '/craftsman/korrekturen/c-abc-123',
        '/craftsman/jobs/j-uuid-xyz',
        '/projects/p-99',
      ]
      for (const sample of samples) {
        expect(
          isWhitelistedRoute(sample),
          `expected ${sample} to be whitelisted`,
        ).toBe(true)
      }
      expect(PUSH_ROUTE_WHITELIST.length).toBeGreaterThanOrEqual(4)
    })

    it('rejects routes outside the four MVP families', () => {
      const samples = [
        '/admin/users',
        '/craftsman/korrekturen/c-1/extra',
        '/jobs/j-1', // missing /craftsman prefix
        '/projects/p-1/edit',
        '',
      ]
      for (const sample of samples) {
        expect(
          isWhitelistedRoute(sample),
          `expected ${sample} to NOT be whitelisted`,
        ).toBe(false)
      }
    })
  })

  describe('CHAT-3 — chat-message deep-link routes', () => {
    // Payload shape mirrors what the chat_messages_dispatch_push DB-trigger
    // pre-enriches (route/fallbackRoute/actionVersion — no jobId, so the
    // Edge enricher passes it through untouched).
    it('resolves the craftsman thread deep-link', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/messages/0b8f2c1a-9d4e-4f6b-8a3c-5e7d9f1b2c3d',
          fallbackRoute: '/craftsman/messages',
          actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'ok',
        path: '/craftsman/messages/0b8f2c1a-9d4e-4f6b-8a3c-5e7d9f1b2c3d',
        search: '',
      })
    })

    it('resolves the customer thread deep-link', () => {
      const result = pushRouteResolver(
        {
          route: '/messages/0b8f2c1a-9d4e-4f6b-8a3c-5e7d9f1b2c3d',
          fallbackRoute: '/messages',
          actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'ok',
        path: '/messages/0b8f2c1a-9d4e-4f6b-8a3c-5e7d9f1b2c3d',
        search: '',
      })
    })

    it('whitelists both list tabs as fallback targets', () => {
      expect(isWhitelistedRoute('/messages')).toBe(true)
      expect(isWhitelistedRoute('/craftsman/messages')).toBe(true)
    })

    it('falls back to the list tab when the thread route is not reachable', () => {
      const result = pushRouteResolver(
        {
          route: '/craftsman/nachrichten/internal-1',
          fallbackRoute: '/craftsman/messages',
        },
        { now: NOW },
      )
      expect(result).toEqual({
        kind: 'fallback',
        reason: 'route_not_whitelisted',
        path: '/craftsman/messages',
        search: '',
      })
    })

    it('keeps neighbouring internal-message routes off the whitelist', () => {
      // /craftsman/nachrichten[/:id] is the internal office/team surface
      // (different repo + screens) — chat pushes must never land there, and
      // the surface gets its own routes in a follow-up block.
      const samples = [
        '/craftsman/nachrichten',
        '/craftsman/nachrichten/thread-1',
        '/messages/thread-1/extra',
        '/craftsman/messages/thread-1/extra',
      ]
      for (const sample of samples) {
        expect(
          isWhitelistedRoute(sample),
          `expected ${sample} to NOT be whitelisted`,
        ).toBe(false)
      }
    })
  })

  describe('schema-version invariant', () => {
    it('schema version is set to 1 for the MVP cluster', () => {
      // Lock the version explicitly — bumping it requires touching the
      // server-side enricher (B3) and the bridge (B2) in lock-step.
      expect(PUSH_ROUTE_SCHEMA_VERSION).toBe(1)
    })

    it('payload without actionVersion is treated as compatible', () => {
      // Backward-compat: pre-B3 backends emit pushes without actionVersion;
      // these must continue to route, otherwise rollout would brick old
      // pushes still in the notification center.
      const result = pushRouteResolver(
        { route: '/craftsman/korrekturen/c-1' },
        { now: NOW },
      )
      expect(result.kind).toBe('ok')
    })
  })
})
