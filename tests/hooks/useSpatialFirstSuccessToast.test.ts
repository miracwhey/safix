// @vitest-environment jsdom
/**
 * useSpatialFirstSuccessToast · Phase 4 0→1 transition toast.
 *
 * Coverage:
 *   - no toast at baseline=0 stays 0
 *   - no toast if baseline=N>=1 (returning customer already has scans)
 *   - fires once on 0→1 customer-scan transition
 *   - does not re-fire after flag is persisted (re-renders ignored)
 *   - craftsman-only scan count never triggers
 *   - waits for isHydrated before establishing baseline
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

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

const successSpy = vi.fn()
vi.mock('../../src/hooks/useToast', () => ({
  useToast: () => ({ success: successSpy, error: vi.fn(), info: vi.fn() }),
}))

import { useSpatialFirstSuccessToast } from '../../src/hooks/useSpatialFirstSuccessToast'
import type { Scan } from '../../src/lib/spatial/types'

function customerScan(id: string): Scan {
  return {
    id,
    jobId: null,
    projectId: null,
    presalesProjectId: null,
    parentScanId: null,
    status: 'captured',
    source: 'manual',
    capturedBy: 'u',
    deviceMeta: {},
    scanStartedAt: null,
    scanEndedAt: null,
    archivedAt: null,
    ownerType: 'customer',
    sharedWithCustomer: false,
    sharedAt: null,
    sharedWithProviderId: null,
    sharedWithProviderAt: null,
    createdAt: 0,
    updatedAt: 0,
    qualityScore: null,
    qualityLabel: null,
  } as Scan
}

function craftsmanScan(id: string): Scan {
  return { ...customerScan(id), ownerType: 'craftsman' } as Scan
}

beforeEach(() => {
  memoryStorage.clear()
  successSpy.mockReset()
})

describe('useSpatialFirstSuccessToast', () => {
  it('does not fire while isHydrated=false', () => {
    renderHook(() =>
      useSpatialFirstSuccessToast({ scans: [], isHydrated: false }),
    )
    expect(successSpy).not.toHaveBeenCalled()
  })

  it('does not fire if baseline already has a customer scan (returning user)', () => {
    renderHook(() =>
      useSpatialFirstSuccessToast({
        scans: [customerScan('s1')],
        isHydrated: true,
      }),
    )
    expect(successSpy).not.toHaveBeenCalled()
  })

  it('fires once on 0 → 1 customer-scan transition', () => {
    const { rerender } = renderHook(
      ({ scans }: { scans: Scan[] }) =>
        useSpatialFirstSuccessToast({ scans, isHydrated: true }),
      { initialProps: { scans: [] as Scan[] } },
    )
    expect(successSpy).not.toHaveBeenCalled()
    act(() => {
      rerender({ scans: [customerScan('s1')] })
    })
    expect(successSpy).toHaveBeenCalledOnce()
    expect(successSpy).toHaveBeenCalledWith(
      expect.stringMatching(/erster Raum ist vermessen/i),
    )
  })

  it('does not re-fire after the flag is persisted (second transition ignored)', () => {
    const { rerender } = renderHook(
      ({ scans }: { scans: Scan[] }) =>
        useSpatialFirstSuccessToast({ scans, isHydrated: true }),
      { initialProps: { scans: [] as Scan[] } },
    )
    act(() => rerender({ scans: [customerScan('s1')] }))
    expect(successSpy).toHaveBeenCalledTimes(1)
    act(() => rerender({ scans: [customerScan('s1'), customerScan('s2')] }))
    expect(successSpy).toHaveBeenCalledTimes(1)
  })

  it('craftsman-only scans never trigger the customer-first toast', () => {
    const { rerender } = renderHook(
      ({ scans }: { scans: Scan[] }) =>
        useSpatialFirstSuccessToast({ scans, isHydrated: true }),
      { initialProps: { scans: [] as Scan[] } },
    )
    act(() => rerender({ scans: [craftsmanScan('hw1')] }))
    expect(successSpy).not.toHaveBeenCalled()
  })
})
