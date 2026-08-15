// @vitest-environment jsdom
/**
 * Spatial · V1.6.1 · useExampleRoomsSeen storage + cross-tab contract.
 *
 * vitest jsdom only ships a partial localStorage — stub it with an
 * in-memory shim (mirrors `MeasureWithRulerSheet.test.tsx`) so `clear` +
 * `setItem` actually work and tests stay isolated from each other.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => {
      store[k] = v
    },
    removeItem: (k: string): void => {
      delete store[k]
    },
    clear: (): void => {
      store = {}
    },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number {
      return Object.keys(store).length
    },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryStorage,
})

import { useExampleRoomsSeen } from '../../../src/lib/spatial/hooks/useExampleRoomsSeen'

const STORAGE_KEY = 'spatial-customer-example-rooms-seen-v1'

beforeEach(() => {
  memoryStorage.clear()
})

describe('useExampleRoomsSeen', () => {
  it('reports every example as unseen on first mount', () => {
    const { result } = renderHook(() => useExampleRoomsSeen())
    expect(Array.from(result.current.unseenKinds).sort()).toEqual([
      'bath',
      'kitchen',
      'living',
    ])
    expect(result.current.seen.size).toBe(0)
  })

  it('flipping a kind to seen removes it from unseenKinds + persists', () => {
    const { result } = renderHook(() => useExampleRoomsSeen())
    act(() => {
      result.current.markSeen('bath')
    })
    expect(result.current.seen.has('bath')).toBe(true)
    expect(result.current.unseenKinds.has('bath')).toBe(false)
    expect(result.current.unseenKinds.has('kitchen')).toBe(true)
    // Persisted as a JSON array — survive remount.
    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual(['bath'])
  })

  it('markSeen is idempotent (no double-write, stable identity)', () => {
    const { result } = renderHook(() => useExampleRoomsSeen())
    act(() => {
      result.current.markSeen('kitchen')
    })
    const firstSet = result.current.seen
    act(() => {
      result.current.markSeen('kitchen')
    })
    // Same kind re-marked → React-set identity preserved (no re-render churn).
    expect(result.current.seen).toBe(firstSet)
  })

  it('hydrates from localStorage on remount', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['bath', 'living']))
    const { result } = renderHook(() => useExampleRoomsSeen())
    expect(result.current.seen.has('bath')).toBe(true)
    expect(result.current.seen.has('living')).toBe(true)
    expect(result.current.unseenKinds.has('kitchen')).toBe(true)
  })

  it('ignores corrupt JSON without crashing', () => {
    window.localStorage.setItem(STORAGE_KEY, '<not json>')
    const { result } = renderHook(() => useExampleRoomsSeen())
    expect(result.current.seen.size).toBe(0)
    expect(result.current.unseenKinds.size).toBe(3)
  })

  it('drops unknown values from the persisted set', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['bath', 'bedroom', 42, null]),
    )
    const { result } = renderHook(() => useExampleRoomsSeen())
    expect(Array.from(result.current.seen).sort()).toEqual(['bath'])
  })

  it('cross-tab storage event refreshes the local state', () => {
    const { result } = renderHook(() => useExampleRoomsSeen())
    expect(result.current.seen.size).toBe(0)
    act(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['living']))
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: JSON.stringify(['living']),
        }),
      )
    })
    expect(result.current.seen.has('living')).toBe(true)
  })
})
