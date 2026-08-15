import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

import { handlePushTapRoute } from '../../src/lib/notifications/pushNotificationBridge'
import * as pendingPushRoute from '../../src/lib/notifications/pendingPushRoute'
import {
  attachNavigationAdapter,
  __testOnly_resetAdapter,
} from '../../src/lib/notifications/pushBridgeNavigationAdapter'
import { PUSH_ROUTE_SCHEMA_VERSION } from '../../src/lib/notifications/pushRoutes'

describe('Block 7.2 / B2 — handlePushTapRoute integration', () => {
  beforeEach(() => {
    pendingPushRoute.__testOnly_reset()
    __testOnly_resetAdapter()
  })

  afterEach(() => {
    pendingPushRoute.__testOnly_reset()
    __testOnly_resetAdapter()
  })

  describe('warm-state (navigation adapter attached)', () => {
    it('navigates immediately for valid whitelisted route', () => {
      const navigate = vi.fn()
      attachNavigationAdapter(navigate)

      handlePushTapRoute({
        route: '/craftsman/korrekturen/c-1',
        focus: 'documents',
        actionVersion: PUSH_ROUTE_SCHEMA_VERSION,
      })

      expect(navigate).toHaveBeenCalledWith(
        '/craftsman/korrekturen/c-1?focus=documents',
        { replace: false },
      )
      // No queue when warm-navigate succeeds
      expect(pendingPushRoute.peek()).toBeNull()
    })

    it('navigates to fallback when route is not whitelisted', () => {
      const navigate = vi.fn()
      attachNavigationAdapter(navigate)

      handlePushTapRoute({
        route: '/admin/dropped',
        fallbackRoute: '/craftsman/korrekturen',
      })

      expect(navigate).toHaveBeenCalledWith('/craftsman/korrekturen', {
        replace: false,
      })
    })

    it('drops malformed payload — neither navigate nor queue', () => {
      const navigate = vi.fn()
      attachNavigationAdapter(navigate)

      handlePushTapRoute(null)

      expect(navigate).not.toHaveBeenCalled()
      expect(pendingPushRoute.peek()).toBeNull()
    })

    it('drops payload without route — no navigate, no queue', () => {
      const navigate = vi.fn()
      attachNavigationAdapter(navigate)

      handlePushTapRoute({ focus: 'documents' })

      expect(navigate).not.toHaveBeenCalled()
      expect(pendingPushRoute.peek()).toBeNull()
    })

    it('drops payload with unknown actionVersion', () => {
      const navigate = vi.fn()
      attachNavigationAdapter(navigate)

      handlePushTapRoute({
        route: '/craftsman/korrekturen/c-1',
        actionVersion: 999,
      })

      expect(navigate).not.toHaveBeenCalled()
      expect(pendingPushRoute.peek()).toBeNull()
    })
  })

  describe('cold-state (no adapter attached)', () => {
    it('queues pending route when adapter is not attached', () => {
      handlePushTapRoute({
        route: '/craftsman/korrekturen/c-1',
        focus: 'documents',
      })

      expect(pendingPushRoute.peek()).toEqual({
        path: '/craftsman/korrekturen/c-1',
        search: '?focus=documents',
      })
    })

    it('queues fallback route when adapter is not attached and route is not whitelisted', () => {
      handlePushTapRoute({
        route: '/admin/dropped',
        fallbackRoute: '/craftsman/korrekturen',
      })

      expect(pendingPushRoute.peek()).toEqual({
        path: '/craftsman/korrekturen',
        search: '',
      })
    })

    it('does not queue malformed payload in cold state', () => {
      handlePushTapRoute('totally-wrong-shape')
      expect(pendingPushRoute.peek()).toBeNull()
    })

    it('cold queue uses last-write-wins on multiple cold pushes', () => {
      handlePushTapRoute({ route: '/craftsman/jobs/j-1' })
      handlePushTapRoute({
        route: '/projects/p-7',
        focus: 'payment',
      })
      expect(pendingPushRoute.peek()).toEqual({
        path: '/projects/p-7',
        search: '?focus=payment',
      })
    })
  })
})
