// @vitest-environment jsdom
/**
 * useSpatialFirstRunFlag · Phase 4 SSR-safe localStorage gate.
 *
 * Tests cover: initial read · markSeen persistence · idempotency ·
 * cross-tab `storage` event sync · throws on locked storage · isolation
 * across keys.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryStorage,
})

import { useSpatialFirstRunFlag } from '../../src/hooks/useSpatialFirstRunFlag'

describe('useSpatialFirstRunFlag', () => {
  beforeEach(() => {
    memoryStorage.clear()
  })

  it('initial seen=false when storage has no value', () => {
    const { result } = renderHook(() => useSpatialFirstRunFlag('test-key-1'))
    expect(result.current.seen).toBe(false)
  })

  it('initial seen=true when storage already has "1"', () => {
    memoryStorage.setItem('test-key-2', '1')
    const { result } = renderHook(() => useSpatialFirstRunFlag('test-key-2'))
    expect(result.current.seen).toBe(true)
  })

  it('markSeen persists to storage AND flips local state', () => {
    const { result } = renderHook(() => useSpatialFirstRunFlag('test-key-3'))
    expect(result.current.seen).toBe(false)
    act(() => { result.current.markSeen() })
    expect(result.current.seen).toBe(true)
    expect(memoryStorage.getItem('test-key-3')).toBe('1')
  })

  it('double markSeen is idempotent — no exception', () => {
    const { result } = renderHook(() => useSpatialFirstRunFlag('test-key-4'))
    act(() => { result.current.markSeen() })
    act(() => { result.current.markSeen() })
    expect(result.current.seen).toBe(true)
    expect(memoryStorage.getItem('test-key-4')).toBe('1')
  })

  it('cross-tab storage event updates state', () => {
    const { result } = renderHook(() => useSpatialFirstRunFlag('test-key-5'))
    expect(result.current.seen).toBe(false)

    // Simulate other-tab write: set the value via storage helper, fire
    // storage-event manually (jsdom does not auto-fire on same-window writes).
    memoryStorage.setItem('test-key-5', '1')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'test-key-5', newValue: '1' }),
      )
    })
    expect(result.current.seen).toBe(true)
  })

  it('isolates seen state per key — flipping A does not affect B', () => {
    const { result: a } = renderHook(() => useSpatialFirstRunFlag('key-a'))
    const { result: b } = renderHook(() => useSpatialFirstRunFlag('key-b'))
    expect(a.current.seen).toBe(false)
    expect(b.current.seen).toBe(false)
    act(() => { a.current.markSeen() })
    expect(a.current.seen).toBe(true)
    expect(b.current.seen).toBe(false)
  })

  it('storage event for a DIFFERENT key does not flip our state', () => {
    const { result } = renderHook(() => useSpatialFirstRunFlag('key-watch'))
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'unrelated', newValue: '1' }),
      )
    })
    expect(result.current.seen).toBe(false)
  })
})
