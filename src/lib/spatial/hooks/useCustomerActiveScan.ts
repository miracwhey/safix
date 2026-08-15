/**
 * Spatial · V1.6 Phase 1b · useCustomerActiveScan
 *
 * Picks the customer's active scan from a list (Hub's 3D-Background scan).
 *
 * Strategy:
 *   - Default = newest scan (createdAt desc) — the most recent capture is
 *     the most relevant view for a customer landing on the hub.
 *   - `setActiveScanId(id)` overrides the default; passing `null` clears the
 *     override and falls back to "newest". Phase 1d's multi-scan picker calls
 *     this when the customer taps a different scan in the dropdown.
 *   - Persistence (localStorage `spatial-active-scan-${jobId}`) lands in
 *     Phase 1d alongside the picker so the choice survives reload — Phase 1b
 *     intentionally keeps the hook stateless on disk to avoid race-y double
 *     reads against the eventual picker write path.
 *
 * Filtering convention: callers pass scans already filtered to what the
 * customer should see in the hub (e.g. the `scans` array from
 * `useCustomerSpatialScans`). This hook does not re-filter — it only selects
 * which scan to surface as active.
 */

import { useMemo, useState } from 'react'

import type { Scan } from '../types'

export interface UseCustomerActiveScanResult {
  activeScan: Scan | null
  activeScanId: string | null
  /**
   * Override the picker default. Passing `null` clears the override so the
   * "newest scan" default takes over again. Phase 1d's multi-scan picker
   * wires this up; in Phase 1b the hub leaves it untouched.
   */
  setActiveScanId: (scanId: string | null) => void
}

export function useCustomerActiveScan(
  scans: ReadonlyArray<Scan>,
): UseCustomerActiveScanResult {
  const [overrideId, setOverrideId] = useState<string | null>(null)

  const activeScan = useMemo<Scan | null>(() => {
    if (scans.length === 0) return null
    if (overrideId != null) {
      const match = scans.find(s => s.id === overrideId)
      if (match) return match
      // Override points at a scan that's no longer in the list (e.g. unshared
      // by the HW while the customer had it pinned). Fall back to newest.
    }
    let newest = scans[0]
    for (let i = 1; i < scans.length; i++) {
      const candidate = scans[i]
      if (candidate.createdAt > newest.createdAt) {
        newest = candidate
      }
    }
    return newest
  }, [scans, overrideId])

  return {
    activeScan,
    activeScanId: activeScan?.id ?? null,
    setActiveScanId: setOverrideId,
  }
}
