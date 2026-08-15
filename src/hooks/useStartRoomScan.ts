/**
 * Phase 1 — Reusable Room-Scan entry-point.
 *
 * Single handler for "Raum scannen" buttons across the app (ProjectBuilder
 * scan step, CraftsmanJobDetailScreen empty-state, future Provider Spatial
 * Hub). Owns the full UX contract:
 *
 *   - LiDAR availability check (toast + early return on no-LiDAR devices)
 *   - Native error-code → toast severity mapping (silent cancel vs error)
 *   - Camera-permission-denied → Settings deep-link
 *   - Awaited scan → captureScan() (no fire-and-forget)
 *   - File-system read with USDZ → blob hand-off
 *   - Toast at start ("Scan wird hochgeladen…") + end (success / failure)
 *
 * The hook is layer-pure on JS side: it dispatches into the spatial
 * workflow (captureScan) and surfaces toasts. It never touches React
 * state directly — callers decide whether to refetch / navigate.
 *
 * NOTE: This duplicates a chunk of logic that ProjectBuilderScreen still
 * inlines (handleScan + uploadScanAfterCreate). The builder flow stays
 * inlined because it has draft-persistence interactions that don't fit
 * a generic hook. Once Phase-3 Provider Spatial Hub lands we should
 * pull both call-sites onto this hook.
 */

import { useCallback, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import {
  RoomPlan,
  type RoomScanResult,
} from '@fixup/capacitor-roomplan'
import { captureScan } from '../lib/spatial'
import { promoteScanToScene } from '../lib/spatial/canonical/workflow/promoteScanToScene'
import type { SpatialScene } from '../lib/spatial/canonical/repository/SpatialSceneRepository'
import { supabase } from '../lib/supabase'
import { useToast } from './useToast'
import { logError } from '../lib/observability'

export interface StartRoomScanOptions {
  /** EITHER jobId OR projectId OR presalesProjectId — DB CHECK requires at least one. */
  jobId?: string
  projectId?: string
  /** Provider-presales-project anchor (V1.5). Mutually-exclusive with jobId/projectId at the workflow layer, but DB allows multiple for re-link scenarios. */
  presalesProjectId?: string
  /** Optional parent for re-scan version chains (scan-level linkage). */
  parentScanId?: string | null
  /**
   * Optional parent scene (scene-level linkage, D2 · B7). Stamped onto the
   * promoted scene's `parent_scene_id` so the version chain is intrinsic.
   * Distinct from {@link parentScanId} (capture-level): one scan can root a
   * scene, the scene is the version-graph node.
   */
  parentSceneId?: string | null
  /**
   * The `spatial_rescan_requests` row this scan fulfils (D2 · B7). When set,
   * the `spatial_create_scene` RPC links the new scene as the request's
   * `resulting_scene_id`, enforces request.status='accepted', and verifies
   * the caller is the parent scene's customer. A fulfilled request short-
   * circuits idempotently.
   */
  rescanRequestId?: string | null
  /**
   * Called after the scan + upload succeed so the caller can refetch. When the
   * canonical-scene promotion also succeeded, the created `scene` is supplied
   * so the caller can jump straight into the 3D view; it is `undefined` when
   * promotion failed (the scan itself is still saved).
   */
  onSuccess?: (result: RoomScanResult, scene?: SpatialScene) => void
  /** Called on any failure path (including silent cancel) so the caller
   *  can reset loading state. */
  onSettled?: () => void
}

export interface StartRoomScanApi {
  /** Triggers the full scan + upload flow. */
  startScan: (opts: StartRoomScanOptions) => Promise<void>
  /** True while the scan or upload is running. */
  busy: boolean
  /** LiDAR availability — null = not yet checked, true/false = result. */
  lidarAvailable: boolean | null
}

export function useStartRoomScan(): StartRoomScanApi {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [lidarAvailable, setLidarAvailable] = useState<boolean | null>(null)

  // One-shot availability probe. Telemetry listener lives in
  // src/lib/native/bootstrap.ts (Phase 1 hotfix post-review H3) so multiple
  // hook consumers don't double-attach the same listener.
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

  const startScan = useCallback(async (opts: StartRoomScanOptions) => {
    if (!opts.jobId && !opts.projectId && !opts.presalesProjectId) {
      logError('roomScan.start_invalid_scope', new Error('jobId, projectId or presalesProjectId required'))
      toast.error('Konnte Scan nicht starten — kein Job/Projekt-Kontext.')
      return
    }
    if (lidarAvailable === false) {
      toast.info('Dein Gerät hat keinen LiDAR-Sensor. Maße bitte manuell eintragen.')
      return
    }
    setBusy(true)
    let result: RoomScanResult
    try {
      result = await RoomPlan.startScan()
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code ?? '' : ''
      const msg = err instanceof Error ? err.message : String(err)
      const matches = (token: string) => code === token || msg.includes(token)

      setBusy(false)
      opts.onSettled?.()

      if (matches('SCAN_CANCELLED')) return
      if (matches('SCAN_BACKGROUNDED')) {
        toast.info('Scan unterbrochen — App war im Hintergrund. Bitte erneut starten.')
        return
      }
      if (matches('SCAN_PROCESSING_TIMEOUT')) {
        toast.error('Scan-Verarbeitung dauert zu lange. Bitte erneut versuchen.')
        logError('roomScan.processing_timeout', err)
        return
      }
      if (matches('SCAN_INSUFFICIENT_DATA')) {
        toast.error('Zu wenig Raumdaten. Bitte mehr Wände scannen.')
        return
      }
      if (matches('ROOMPLAN_V2_UNAVAILABLE')) {
        setLidarAvailable(false)
        toast.info('Dein Gerät hat keinen LiDAR-Sensor.')
        return
      }
      if (matches('CAMERA_PERMISSION_DENIED')) {
        toast.error('Kamera-Zugriff verweigert. Bitte in iOS-Einstellungen aktivieren.')
        // iOS WebView routes the `app-settings:` URL scheme to
        // UIApplication.openSettingsURLString, opening the app's entry in
        // Settings.app. @capacitor/app dropped openUrl in v5; window.open
        // is the portable path that works across Capacitor versions.
        try { window.open('app-settings:') } catch { /* ignore */ }
        return
      }
      toast.error('Scan fehlgeschlagen. Bitte erneut versuchen.')
      logError('roomScan.start_failed', err, { code, msg })
      return
    }

    // Upload phase — awaited so a silent failure can't drop the scan.
    // F-05 (L2-F): the two informational start-toasts ("wird hochgeladen…" /
    // "3D-Szene wird erstellt…") used to pop separately for 30s each and
    // stacked four bubbles into the viewport. The persist + promote round-trip
    // is fast enough on production hardware that the success toasts alone
    // surface the relevant milestones; errors keep their explicit toast.
    try {
      const { Filesystem } = await import('@capacitor/filesystem')
      const absolutePath = result.usdzPath.replace(/^file:\/\//, '')
      const { data } = await Filesystem.readFile({ path: absolutePath })
      const base64 = typeof data === 'string' ? data : await blobToBase64(data as Blob)
      const usdzBlob = base64ToBlob(base64, 'model/vnd.usdz+zip')

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('roomScan.upload: no authenticated user')

      const pluginMeta = result.deviceMeta ?? {}
      const captureResult = await captureScan({
        jobId: opts.jobId ?? null,
        projectId: opts.projectId ?? null,
        presalesProjectId: opts.presalesProjectId ?? null,
        parentScanId: opts.parentScanId ?? null,
        userId: user.id,
        usdzBlob,
        deviceMeta: {
          ...pluginMeta,
          appVersion:
            pluginMeta.appVersion ?? (import.meta.env.VITE_APP_VERSION as string | undefined),
        },
        fpsSample: pluginMeta.fpsSample,
        thermalState: pluginMeta.thermalState,
        durationSec: pluginMeta.durationSec,
        // Phase 2 · forward the hybrid-mesh aggregate when the plugin emitted
        // one. Undefined on non-LiDAR / iOS<17 / SPATIAL_HYBRID_MESH_ENABLED=NO.
        meshClassification: result.meshClassification,
        // Phase 2 · auto-run Quality Engine so R6 + R7 evaluate against the
        // live mesh data instead of staying in Plan B. Without this, the
        // meshClassification we just harvested is silently discarded.
        autoQuality: true,
      })
      toast.success('Scan gespeichert ✓')

      // Szenen-Produktion (B5) — promote the captured scan to a canonical 3D
      // scene. Runs against the `CapturedRoom` the native plugin still holds
      // (it is overwritten only by the next startScan). Non-fatal: the scan +
      // USDZ are already persisted, so a promotion failure leaves a saved scan
      // that promoteScanToScene can idempotently re-promote later.
      const promotion = await promoteScanToScene({
        scanId: captureResult.scan.id,
        uploaderUserId: user.id,
        jobId: opts.jobId,
        projectId: opts.projectId,
        parentSceneId: opts.parentSceneId ?? undefined,
        rescanRequestId: opts.rescanRequestId ?? undefined,
      })
      if (promotion.ok) {
        toast.success('3D-Szene erstellt ✓')
        opts.onSuccess?.(result, promotion.scene)
      } else {
        toast.error('Scan gespeichert — 3D-Szene konnte nicht erstellt werden.')
        logError('roomScan.promote_failed', new Error(promotion.message), {
          reason: promotion.reason,
          scanId: captureResult.scan.id,
        })
        opts.onSuccess?.(result)
      }
    } catch (err) {
      toast.error('Scan-Upload fehlgeschlagen — bitte später erneut versuchen.')
      logError('roomScan.upload_failed', err, { jobId: opts.jobId, projectId: opts.projectId })
    } finally {
      setBusy(false)
      opts.onSettled?.()
    }
  }, [lidarAvailable, toast])

  return { startScan, busy, lidarAvailable }
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
