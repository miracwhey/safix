// @vitest-environment jsdom
/**
 * useCustomerActiveScan · Phase 1b foundation
 *
 * Covers the active-scan selector that the customer hub uses to pick which
 * scan drives the full-bleed 3D background. Phase 1d's multi-scan picker
 * extends this via `setActiveScanId`, so the override-and-fallback contract
 * is locked in early.
 */

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useCustomerActiveScan } from '../../../../src/lib/spatial/hooks/useCustomerActiveScan'
import type { Scan } from '../../../../src/lib/spatial/types'

function makeScan(over: Partial<Scan> & { id: string; createdAt: number }): Scan {
  return {
    id: over.id,
    jobId: null,
    projectId: null,
    presalesProjectId: null,
    parentScanId: null,
    status: 'captured',
    source: 'lidar',
    capturedBy: 'user-1',
    deviceMeta: {},
    scanStartedAt: null,
    scanEndedAt: null,
    archivedAt: null,
    ownerType: 'customer',
    sharedWithCustomer: false,
    sharedAt: null,
    sharedWithProviderId: null,
    sharedWithProviderAt: null,
    createdAt: over.createdAt,
    updatedAt: over.createdAt,
    ...over,
  }
}

describe('useCustomerActiveScan', () => {
  it('returns null when no scans are present', () => {
    const { result } = renderHook(() => useCustomerActiveScan([]))
    expect(result.current.activeScan).toBeNull()
    expect(result.current.activeScanId).toBeNull()
  })

  it('picks the single scan when only one is available', () => {
    const scan = makeScan({ id: 'scan-1', createdAt: 1000 })
    const { result } = renderHook(() => useCustomerActiveScan([scan]))
    expect(result.current.activeScanId).toBe('scan-1')
  })

  it('selects the newest scan by createdAt across multiple scans', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newest', createdAt: 500 }),
      makeScan({ id: 'middle', createdAt: 250 }),
    ]
    const { result } = renderHook(() => useCustomerActiveScan(scans))
    expect(result.current.activeScanId).toBe('newest')
  })

  it('honours setActiveScanId override when the id is in the list', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newest', createdAt: 500 }),
    ]
    const { result } = renderHook(() => useCustomerActiveScan(scans))
    act(() => {
      result.current.setActiveScanId('older')
    })
    expect(result.current.activeScanId).toBe('older')
  })

  it('falls back to newest when override points at a scan no longer in the list', () => {
    const scans = [
      makeScan({ id: 'a', createdAt: 100 }),
      makeScan({ id: 'b', createdAt: 200 }),
    ]
    const { result } = renderHook(() => useCustomerActiveScan(scans))
    act(() => {
      result.current.setActiveScanId('removed-by-hw')
    })
    expect(result.current.activeScanId).toBe('b')
  })

  it('clearing the override via setActiveScanId(null) restores newest pick', () => {
    const scans = [
      makeScan({ id: 'older', createdAt: 100 }),
      makeScan({ id: 'newest', createdAt: 500 }),
    ]
    const { result } = renderHook(() => useCustomerActiveScan(scans))
    act(() => {
      result.current.setActiveScanId('older')
    })
    expect(result.current.activeScanId).toBe('older')
    act(() => {
      result.current.setActiveScanId(null)
    })
    expect(result.current.activeScanId).toBe('newest')
  })
})
