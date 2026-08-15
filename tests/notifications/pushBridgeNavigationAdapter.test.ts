import { afterEach, describe, it, expect, vi } from 'vitest'

import {
  attachNavigationAdapter,
  detachNavigationAdapter,
  tryNavigate,
  __testOnly_isAttached,
  __testOnly_resetAdapter,
} from '../../src/lib/notifications/pushBridgeNavigationAdapter'

describe('Block 7.2 / B2 — pushBridgeNavigationAdapter', () => {
  afterEach(() => {
    __testOnly_resetAdapter()
  })

  it('returns false when no navigate is attached (cold-start)', () => {
    const result = tryNavigate('/craftsman/korrekturen/c-1', '?focus=documents')
    expect(result).toBe(false)
    expect(__testOnly_isAttached()).toBe(false)
  })

  it('returns true and calls navigate when attached', () => {
    const navigate = vi.fn()
    attachNavigationAdapter(navigate)
    const result = tryNavigate('/craftsman/korrekturen/c-1', '?focus=documents')
    expect(result).toBe(true)
    expect(navigate).toHaveBeenCalledWith(
      '/craftsman/korrekturen/c-1?focus=documents',
      { replace: undefined },
    )
  })

  it('passes through replace option', () => {
    const navigate = vi.fn()
    attachNavigationAdapter(navigate)
    tryNavigate('/craftsman/jobs/j-1', '', { replace: true })
    expect(navigate).toHaveBeenCalledWith('/craftsman/jobs/j-1', {
      replace: true,
    })
  })

  it('detach makes tryNavigate return false again', () => {
    attachNavigationAdapter(vi.fn())
    expect(__testOnly_isAttached()).toBe(true)
    detachNavigationAdapter()
    expect(__testOnly_isAttached()).toBe(false)
    expect(tryNavigate('/craftsman/jobs/j-1', '')).toBe(false)
  })

  it('multiple attach calls — last navigate wins', () => {
    const first = vi.fn()
    const second = vi.fn()
    attachNavigationAdapter(first)
    attachNavigationAdapter(second)
    tryNavigate('/craftsman/jobs/j-1', '')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
  })
})
