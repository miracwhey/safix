import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

import * as pendingPushRoute from '../../src/lib/notifications/pendingPushRoute'

describe('Block 7.2 / B2 — pendingPushRoute', () => {
  beforeEach(() => {
    pendingPushRoute.__testOnly_reset()
  })

  afterEach(() => {
    pendingPushRoute.__testOnly_reset()
  })

  describe('set / peek / consume / clear', () => {
    it('peek returns null when no route is queued', () => {
      expect(pendingPushRoute.peek()).toBeNull()
      expect(pendingPushRoute.consume()).toBeNull()
    })

    it('set then peek returns the route without clearing', () => {
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      expect(pendingPushRoute.peek()).toEqual({
        path: '/craftsman/jobs/j-1',
        search: '',
      })
      expect(pendingPushRoute.peek()).toEqual({
        path: '/craftsman/jobs/j-1',
        search: '',
      })
    })

    it('consume returns the route AND clears atomically', () => {
      pendingPushRoute.set({
        path: '/craftsman/korrekturen/c-1',
        search: '?focus=documents',
      })
      const first = pendingPushRoute.consume()
      const second = pendingPushRoute.consume()
      expect(first).toEqual({
        path: '/craftsman/korrekturen/c-1',
        search: '?focus=documents',
      })
      expect(second).toBeNull()
    })

    it('multiple set calls — last one wins (no queue stack)', () => {
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      pendingPushRoute.set({ path: '/craftsman/jobs/j-2', search: '' })
      pendingPushRoute.set({ path: '/projects/p-7', search: '?focus=payment' })
      expect(pendingPushRoute.peek()).toEqual({
        path: '/projects/p-7',
        search: '?focus=payment',
      })
    })

    it('clear removes a queued route', () => {
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      pendingPushRoute.clear()
      expect(pendingPushRoute.peek()).toBeNull()
    })

    it('clear on empty state is a no-op', () => {
      expect(() => pendingPushRoute.clear()).not.toThrow()
      expect(pendingPushRoute.peek()).toBeNull()
    })
  })

  describe('subscribers', () => {
    it('subscriber is called on set', () => {
      const handler = vi.fn()
      pendingPushRoute.subscribe(handler)
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      expect(handler).toHaveBeenCalledWith({
        path: '/craftsman/jobs/j-1',
        search: '',
      })
    })

    it('subscriber is called on consume with null', () => {
      const handler = vi.fn()
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      pendingPushRoute.subscribe(handler)
      handler.mockClear()
      pendingPushRoute.consume()
      expect(handler).toHaveBeenCalledWith(null)
    })

    it('subscriber is called on clear (only when something was queued)', () => {
      const handler = vi.fn()
      pendingPushRoute.subscribe(handler)
      pendingPushRoute.clear() // no-op, kein subscriber-call
      expect(handler).not.toHaveBeenCalled()
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      handler.mockClear()
      pendingPushRoute.clear()
      expect(handler).toHaveBeenCalledWith(null)
    })

    it('unsubscribe stops further notifications', () => {
      const handler = vi.fn()
      const unsubscribe = pendingPushRoute.subscribe(handler)
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      expect(handler).toHaveBeenCalledTimes(1)
      unsubscribe()
      pendingPushRoute.set({ path: '/craftsman/jobs/j-2', search: '' })
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('one subscriber throwing does not block other subscribers', () => {
      const throwing = vi.fn(() => {
        throw new Error('intentional test failure')
      })
      const ok = vi.fn()
      pendingPushRoute.subscribe(throwing)
      pendingPushRoute.subscribe(ok)
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      expect(throwing).toHaveBeenCalled()
      expect(ok).toHaveBeenCalled()
    })

    it('multiple subscribers all receive set events in order', () => {
      const calls: string[] = []
      pendingPushRoute.subscribe(() => calls.push('a'))
      pendingPushRoute.subscribe(() => calls.push('b'))
      pendingPushRoute.subscribe(() => calls.push('c'))
      pendingPushRoute.set({ path: '/craftsman/jobs/j-1', search: '' })
      expect(calls).toEqual(['a', 'b', 'c'])
    })
  })
})
