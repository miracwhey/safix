/**
 * Spatial V1.6 · Phase 2 · useStartCustomerLidarScan
 *
 * Customer-side single-shot entry-point for the LiDAR self-scan flow. Wraps
 * the full pipeline (DSGVO-Gate → LiDAR-Check → RoomPlan.startScan → USDZ
 * blob hand-off → `createCustomerLidarScene`) and surfaces typed callbacks
 * so the calling screen can drive sheets + toasts without leaking workflow
 * internals into the UI layer.
 *
 * ## Differences vs `useStartRoomScan` / `useStartPresalesRoomScan`
 *
 *   - DSGVO-Konsent gate (PRIV-D1, locked 2026-05-26): before any native
 *     capture starts, we check localStorage for the persisted consent flag.
 *     When missing, the hook fires `onConsentRequired()` and returns early —
 *     the screen mounts the `CaptureDsgvoConsentSheet`, persists the consent
 *     on accept, then re-invokes the hook.
 *   - Uses `createCustomerLidarScene` (Result-typed) instead of `captureScan
 *     + promoteScanToScene`. Customer flow runs its own three-tier quality
 *     wrapper, no canonical promotion in MVP scope.
 *   - No project/presales pre-create. Customer scans MAY land jobless
 *     (Block-1 relaxed CHECK); jobId is optional input.
 *   - Tile-Wording LOCKED ("📐 Mit iPhone scannen") in the CustomerNewRoomSheet
 *     (chunk 2d). This hook is unaware of UI copy; it just orchestrates.
 *
 * ## Direct workflow import (no barrel)
 *
 * `createCustomerLidarScene` is imported directly from its file (not via the
 * spatial barrel) — see `feedback_spatial_barrel_no_session_imports`. The
 * workflow itself pulls `session`-ish code via `supabase.auth.getUser`; the
 * hook level is the right boundary for that.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import {
  RoomPlan,
  type RoomScanResult,
} from '@fixup/capacitor-roomplan'
import { supabase } from '../lib/supabase'
import { useToast } from './useToast'
import { logError } from '../lib/observability'
import {
  mark,
  measure,
  reportMeasureAsSpan,
  startSpan,
} from '../lib/observability/perf'
import {
  createCustomerLidarScene,
  type CreateCustomerLidarSceneResult,
} from '../lib/spatial/workflow/createCustomerLidarScene'
import type { CustomerScanQuality } from '../lib/spatial/quality/scanQualityScore'
import {
  CUSTOMER_LIDAR_DSGVO_CONSENT_KEY,
  hasCustomerLidarConsent,
  recordCustomerLidarConsent,
} from './customerLidarConsent'

// Re-export the consent helpers so existing consumers that import from this
// hook keep working (consent gate is logically a part of the start-flow API).
export {
  CUSTOMER_LIDAR_DSGVO_CONSENT_KEY,
  hasCustomerLidarConsent,
  recordCustomerLidarConsent,
}

export interface StartCustomerLidarScanOptions {
  /** Optional job anchor — Customer self-scans may be jobless (Block-1 relaxed CHECK).
   *  When set, the scan is attached on creation and HW can later toggle sharing. */
  jobId?: string
  /** Re-scan chain (B4-D7: new row, old preserved). */
  parentScanId?: string | null
  /** Called when DSGVO consent is missing. The caller mounts the consent sheet,
   *  persists the flag via `recordCustomerLidarConsent()`, then re-invokes. */
  onConsentRequired?: () => void
  /** Called after the full pipeline succeeded — pass the scanId so the caller
   *  can navigate to /customer/spatial/scan/:id, plus the quality for an
   *  immediate pill render. */
  onSuccess?: (scanId: string, quality: CustomerScanQuality) => void
  /** Fired on every terminal path (success, cancel, failure) so the screen
   *  can reset its busy state without inspecting the outcome. */
  onSettled?: () => void
  /** Phase 4 · classifies a RECOVERABLE scan failure so the screen can
   *  surface `ScanErrorRecoverySheet`. Fatal errors (camera permission,
   *  device unavailable) handle their own UX (settings deeplink + tile hide)
   *  and do NOT fire this callback — see P4-3 binding. */
  onRecoverableError?: (kind: 'cancelled' | 'loop-fail') => void
}

export interface StartCustomerLidarScanApi {
  startCustomerLidarScan: (opts?: StartCustomerLidarScanOptions) => Promise<void>
  /** True while a scan or upload is in-flight. Re-entry is blocked. */
  busy: boolean
  /** Native availability probe result. null = not yet checked. */
  lidarAvailable: boolean | null
  /** Persisted consent flag — caller may use to gate the LiDAR tile copy
   *  ("Konsent bereits gegeben" vs default). */
  dsgvoConsented: boolean
}

export function useStartCustomerLidarScan(): StartCustomerLidarScanApi {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  // Phase 4 fix · double-tap race: React state busy is mirrored to a ref so
  // the re-entry guard sees the in-flight call synchronously, before React
  // has flushed the setBusy(true). Without this, two same-tick taps both
  // pass the `if (busy) return` guard and start two concurrent scans.
  const busyRef = useRef(false)
  const [lidarAvailable, setLidarAvailable] = useState<boolean | null>(null)
  const [dsgvoConsented, setDsgvoConsented] = useState<boolean>(() =>
    hasCustomerLidarConsent(),
  )

  // One-shot availability probe — same pattern as useStartRoomScan but with
  // its own bailout because non-iOS is a hard no for Customer LiDAR (the
  // Manual-Preset and Custom-Canvas tiles handle the fallback path).
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'ios') {
      setLidarAvailable(false)
      return
    }
    let cancelled = false
    void RoomPlan.checkAvailability()
      .then(({ available }) => { if (!cancelled) setLidarAvailable(available) })
      .catch(() => { if (!cancelled) setLidarAvailable(false) })
    return () => {
      cancelled = true
    }
  }, [])

  // Storage events from a different tab may flip the consent flag (rare on
  // mobile but possible on iPadOS Stage Manager). Stay in sync so a stale
  // hook state doesn't re-trigger the consent sheet after acceptance.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key === CUSTOMER_LIDAR_DSGVO_CONSENT_KEY) {
        setDsgvoConsented(hasCustomerLidarConsent())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage) }
  }, [])

  const startCustomerLidarScan = useCallback(async (
    opts: StartCustomerLidarScanOptions = {},
  ) => {
    // Phase 4 fix · synchronous ref guard so a same-tick double-tap cannot
    // queue two concurrent scans. The React-state `busy` is still kept in
    // sync for UI consumers (button-disabled etc.), but the gate here is
    // the ref.
    if (busyRef.current) return
    busyRef.current = true

    try {

    // DSGVO gate (PRIV-D1) — hard precondition. Re-check storage in case
    // another tab persisted in the meantime; the React state could lag.
    if (!hasCustomerLidarConsent()) {
      setDsgvoConsented(false)
      opts.onConsentRequired?.()
      opts.onSettled?.()
      return
    }
    setDsgvoConsented(true)

    if (lidarAvailable === false) {
      toast.info(
        'Dein iPhone hat keinen LiDAR-Sensor. Wähle "Aus Vorlage" oder "Leerer Raum".',
      )
      opts.onSettled?.()
      return
    }

    setBusy(true)
    // Phase 5 perf-KPI · lidar.capture-start opens the lidar-scene timing
    // window. Matching close mark `spatial.lidar.scene-created` fires
    // after `createCustomerLidarScene` succeeds — the measure + Sentry
    // post-hoc span are emitted there.
    mark('spatial.lidar.capture-start')
    let result: RoomScanResult
    try {
      result = await RoomPlan.startScan()
    } catch (err) {
      // Mirror useStartRoomScan error-mapping so Customer + HW surfaces share
      // a single mental model. SCAN_CANCELLED is silent (user pressed cancel);
      // everything else surfaces a toast.
      const code = err instanceof Error ? (err as Error & { code?: string }).code ?? '' : ''
      const msg = err instanceof Error ? err.message : String(err)
      const matches = (token: string) => code === token || msg.includes(token)

      setBusy(false)
      opts.onSettled?.()

      // Phase 4: recoverable error classification — drives the recovery
      // sheet variant in the Hub. Cancelled = user-stop · loop-fail
      // covers the three "couldn't make sense of the data" classes.
      // Fatal errors below this block do NOT call onRecoverableError; the
      // hub keeps showing the toast it already shows today.
      if (matches('SCAN_CANCELLED')) {
        opts.onRecoverableError?.('cancelled')
        return
      }
      if (matches('SCAN_BACKGROUNDED')) {
        opts.onRecoverableError?.('loop-fail')
        return
      }
      if (matches('SCAN_PROCESSING_TIMEOUT')) {
        opts.onRecoverableError?.('loop-fail')
        logError('customer.lidar.processing_timeout', err)
        return
      }
      if (matches('SCAN_INSUFFICIENT_DATA')) {
        opts.onRecoverableError?.('loop-fail')
        return
      }
      if (matches('ROOMPLAN_V2_UNAVAILABLE')) {
        setLidarAvailable(false)
        toast.info('Dein Gerät hat keinen LiDAR-Sensor.')
        return
      }
      if (matches('CAMERA_PERMISSION_DENIED')) {
        toast.error('Kamera-Zugriff verweigert. Bitte in iOS-Einstellungen aktivieren.')
        try { window.open('app-settings:') } catch { /* ignore */ }
        return
      }
      toast.error('Scan fehlgeschlagen. Bitte erneut versuchen.')
      logError('customer.lidar.start_failed', err, { code, msg })
      return
    }

    // Persist phase — gated by createCustomerLidarScene's typed failures.
    try {
      const { Filesystem } = await import('@capacitor/filesystem')
      const absolutePath = result.usdzPath.replace(/^file:\/\//, '')
      const { data } = await Filesystem.readFile({ path: absolutePath })
      const base64 = typeof data === 'string' ? data : await blobToBase64(data as Blob)
      const usdzBlob = base64ToBlob(base64, 'model/vnd.usdz+zip')

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        toast.error('Du bist nicht eingeloggt. Bitte erneut anmelden.')
        logError('customer.lidar.no_authenticated_user', new Error('auth.getUser returned null'))
        return
      }

      const outcome: CreateCustomerLidarSceneResult = await startSpan(
        'spatial.lidar.scene',
        'app.workflow',
        () =>
          createCustomerLidarScene({
            userId: user.id,
            jobId: opts.jobId ?? null,
            parentScanId: opts.parentScanId ?? null,
            roomScan: result,
            usdzBlob,
          }),
        {
          jobId: opts.jobId ?? null,
          parentScanId: opts.parentScanId ?? null,
        },
      )

      if (!outcome.ok) {
        // Toast text picked per failure reason — see workflow Result type.
        switch (outcome.reason) {
          case 'rbac_user_required':
            toast.error('Du bist nicht eingeloggt. Bitte erneut anmelden.')
            break
          case 'scan_creation_failed':
            toast.error('Scan konnte nicht gespeichert werden. Bitte erneut versuchen.')
            break
          case 'quality_persist_failed':
            // Scan is saved without quality_score — non-fatal but worth a softer toast
            // so the user knows the room is captured but the pill won't render yet.
            toast.info('Scan gespeichert. Qualitäts-Auswertung folgt.')
            break
          case 'mesh_upload_failed':
            // Scan + quality persisted, mesh-mirror failed — Customer can still
            // view in HW-bucket path while a retry runs in the background.
            toast.info('Scan gespeichert. Detailansicht in Kürze verfügbar.')
            break
        }
        logError('customer.lidar.workflow_failure', outcome.cause as unknown, {
          reason: outcome.reason,
        })
        return
      }

      // Phase 5 perf-KPI close. Measure spans the full capture-start →
      // scene-created window (RoomPlan native run + USDZ read + workflow
      // round-trip). Post-hoc span gives Sentry the duration alongside the
      // active `spatial.lidar.scene` span from `startSpan` above (the
      // active span tracks the workflow only; this measure is the wider
      // perceived-latency).
      mark('spatial.lidar.scene-created')
      const duration = measure(
        'spatial.lidar.scene-total',
        'spatial.lidar.capture-start',
        'spatial.lidar.scene-created',
      )
      if (duration !== undefined) {
        reportMeasureAsSpan('spatial.lidar.scene', 'app.workflow', duration, {
          scanId: outcome.scanId,
          jobId: opts.jobId ?? null,
        })
      }
      toast.success('Raum gespeichert ✓')
      opts.onSuccess?.(outcome.scanId, outcome.quality)
    } catch (err) {
      toast.error('Scan-Upload fehlgeschlagen — bitte später erneut versuchen.')
      logError('customer.lidar.upload_failed', err, { jobId: opts.jobId })
    } finally {
      setBusy(false)
      opts.onSettled?.()
    }

    } finally {
      // Phase 4 fix · always release the synchronous double-tap gate, even
      // if an early-return path skipped the React-state setBusy(false).
      busyRef.current = false
    }
  }, [lidarAvailable, toast])

  return {
    startCustomerLidarScan,
    busy,
    lidarAvailable,
    dsgvoConsented,
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
