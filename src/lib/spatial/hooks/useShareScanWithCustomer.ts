/**
 * Spatial · Lane 3 V1.6 Block 2 · Hook · useShareScanWithCustomer
 *
 * Pure mutation hook wrapping {@link shareScanWithCustomer}. Holds the
 * in-flight busy + error state for the toggle UI; does NOT subscribe to
 * realtime — that's the separate `useJobScanRealtime` hook (Block 2 D1).
 *
 * The hook lives in `lib/spatial/hooks/` (alongside `useFocusTrap` /
 * `useCustomerSpatialDetail`) but imports `shareScanWithCustomer` directly
 * from its file rather than the workflow barrel — the workflow drags in
 * `session.ts` via its RBAC guard, and the spatial barrel must stay
 * `session`-free to keep offline unit tests green (see the carve-out note
 * in `lib/spatial/workflow/index.ts`).
 *
 * Pattern reference: `useStartPresalesRoomScan` (V1.5 Phase B-P2).
 */

import { useCallback, useState } from 'react'

import {
  shareScanWithCustomer,
  type ShareScanWithCustomerInput,
  type ShareScanWithCustomerResult,
} from '../workflow/shareScanWithCustomer'

export interface UseShareScanWithCustomerApi {
  /** Trigger the mutation. Resolves with the typed result; never rejects. */
  toggle: (input: ShareScanWithCustomerInput) => Promise<ShareScanWithCustomerResult>
  /** True while the workflow call is in flight. Re-entry is blocked. */
  busy: boolean
  /** Last-failed message — cleared on the next call. */
  error: string | null
  /** Clear the stored error message (e.g. after the toast was shown). */
  resetError: () => void
}

export function useShareScanWithCustomer(): UseShareScanWithCustomerApi {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback(
    async (
      input: ShareScanWithCustomerInput,
    ): Promise<ShareScanWithCustomerResult> => {
      if (busy) {
        // Re-entry guard — keeps the UI from racing two writes against the
        // same scan when the user double-taps.
        return {
          ok: false,
          reason: 'persistence_failed',
          message: 'Freigabe wird gerade geändert — bitte kurz warten.',
        }
      }
      setBusy(true)
      setError(null)
      const result = await shareScanWithCustomer(input)
      if (!result.ok) setError(result.message)
      setBusy(false)
      return result
    },
    [busy],
  )

  const resetError = useCallback(() => setError(null), [])

  return { toggle, busy, error, resetError }
}
