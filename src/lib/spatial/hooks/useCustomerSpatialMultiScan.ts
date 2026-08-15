/**
 * Spatial · V1.6 Phase 1d · useCustomerSpatialMultiScan
 *
 * Multi-Scan picker state — extends Phase 1b's `useCustomerActiveScan` with
 * a per-scope localStorage persistence so the active scan choice survives
 * reload + tab swaps. Phase 1d's `<CustomerMultiScanPicker>` consumes this
 * to drive the dropdown.
 *
 * Scope key:
 *   - When called on the Customer Hub the scope is the authenticated user
 *     (`user:${userId}`). Per-user persistence is the right boundary because
 *     a customer may have scans across multiple jobs and the hub lists them
 *     all in one place.
 *   - When called from a future job-scoped surface (e.g. inside a job
 *     detail), pass `scopeKey="job:${jobId}"` so the choice is per-job.
 *
 * Race-safety:
 *   - The localStorage read is gated on `typeof window` to keep SSR-safe.
 *   - On scope-change the override is reloaded from storage so switching
 *     between contexts doesn't carry the wrong scan.
 *   - When `scans` changes (HW shares a new scan, customer scans a new
 *     room), an override that no longer matches a visible scan is cleared
 *     gracefully (`useCustomerActiveScan` already falls back to newest in
 *     that case — see its tests).
 *
 * Mockup 10 reference: dropdown shows the active scan with quality pill +
 * lets the customer switch. Switching writes through this hook.
 */

import { useCallback, useEffect, useRef } from 'react'

import {
  useCustomerActiveScan,
  type UseCustomerActiveScanResult,
} from './useCustomerActiveScan'
import type { Scan } from '../types'

const STORAGE_PREFIX = 'spatial-active-scan'

export interface UseCustomerSpatialMultiScanArgs {
  scans: ReadonlyArray<Scan>
  /** Stable identifier for the active-scan choice scope. Pass `null` to
   *  disable persistence (hook then behaves identically to
   *  `useCustomerActiveScan`). Typical values: `user:${userId}`. */
  scopeKey: string | null
}

export interface UseCustomerSpatialMultiScanResult
  extends UseCustomerActiveScanResult {
  /** Drops the persisted override (returns to "newest scan" default). */
  resetActiveScan: () => void
}

function storageKeyFor(scopeKey: string): string {
  return `${STORAGE_PREFIX}:${scopeKey}`
}

function readPersistedScanId(scopeKey: string | null): string | null {
  if (!scopeKey || typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(storageKeyFor(scopeKey))
  } catch {
    return null
  }
}

function writePersistedScanId(
  scopeKey: string | null,
  scanId: string | null,
): void {
  if (!scopeKey || typeof window === 'undefined') return
  try {
    if (scanId == null) {
      window.localStorage.removeItem(storageKeyFor(scopeKey))
    } else {
      window.localStorage.setItem(storageKeyFor(scopeKey), scanId)
    }
  } catch {
    /* localStorage unavailable — ignore. The override is still tracked
       in-memory by `useCustomerActiveScan`. */
  }
}

export function useCustomerSpatialMultiScan({
  scans,
  scopeKey,
}: UseCustomerSpatialMultiScanArgs): UseCustomerSpatialMultiScanResult {
  const active = useCustomerActiveScan(scans)
  // Ref instead of state — the setter callback below captures the *current*
  // value at call time. With a `useState` flag the callback closes over a
  // stale value during the async restore window (between `setHydrated(false)`
  // and the post-tick `setHydrated(true)`) which silently drops persisted
  // writes for a picker tap landing in that gap (screen-auditor Finding 1).
  const hydratedRef = useRef(false)

  // On scope change, restore from storage so the picker reflects the
  // customer's last choice. Empty scope = disable persistence entirely.
  useEffect(() => {
    hydratedRef.current = false
    let alive = true
    // `await Promise.resolve()` upfront pushes the setter off the
    // synchronous tick (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => {
      if (!alive) return
      const persisted = readPersistedScanId(scopeKey)
      active.setActiveScanId(persisted)
      hydratedRef.current = true
    })
    return () => {
      alive = false
    }
    // `active.setActiveScanId` is stable via useState's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  // Mirror writes to storage so a reload restores the choice. The persisted
  // value is the override id — the resolver in `useCustomerActiveScan`
  // gracefully falls back to "newest" when the id is no longer visible.
  const setActiveScanId = useCallback(
    (scanId: string | null) => {
      active.setActiveScanId(scanId)
      if (hydratedRef.current) writePersistedScanId(scopeKey, scanId)
    },
    [active, scopeKey],
  )

  const resetActiveScan = useCallback(() => {
    setActiveScanId(null)
  }, [setActiveScanId])

  return {
    activeScan: active.activeScan,
    activeScanId: active.activeScanId,
    setActiveScanId,
    resetActiveScan,
  }
}
