/**
 * Presales · Hook · useStartPresalesRoomScan (V1.5 · Phase B-P2)
 *
 * One-tap entry-point for the FirstLoginEmpty "Erstes 3D-Projekt anlegen"
 * CTA. Internally:
 *   1. Creates the `provider_presales_projects` row via the workflow.
 *   2. Hands the projectId to {@link useStartRoomScan} as `presalesProjectId`
 *      so the spatial-layer captures + promotes the scan against the new
 *      presales anchor.
 *   3. Once the scan-and-scene path succeeds, updates the presales row to
 *      `status='scanned'` + `scannedAt=now`.
 *
 * The wrapper is intentionally THIN — it does not duplicate `useStartRoomScan`'s
 * LiDAR check, toast, error-mapping, or upload retry logic. Failures in any
 * step bubble through the existing toast pipeline; the presales row stays in
 * `draft` if the scan never completes (so the next attempt is idempotent on
 * the project but creates a new scan).
 */

import { useCallback, useState } from 'react'
import type { RoomScanResult } from '@fixup/capacitor-roomplan'
import type { SpatialScene } from '../lib/spatial/canonical/repository/SpatialSceneRepository'
import { useStartRoomScan } from './useStartRoomScan'
import { useToast } from './useToast'
import { logError } from '../lib/observability'
import { createProviderPresalesProject } from '../lib/presales/workflow/createProviderPresalesProject'
import { getPresalesProjectRepository } from '../lib/presales/repository/registry'
import type { PresalesProject } from '../domain/presales/presalesProjectTypes'

export interface StartPresalesRoomScanOptions {
  title?: string
  locationHint?: string
  /**
   * When set, the hook skips `createProviderPresalesProject` and reuses this
   * existing draft row for the scan (Phase B-P5 retry-from-draft path). If
   * the row no longer exists or belongs to another org the hook surfaces an
   * error toast and bails — same UX as a create failure.
   */
  existingProjectId?: string
  /**
   * Called when the project has been created AND the scan+scene have been
   * persisted. `scene` is undefined if scan succeeded but promotion failed —
   * caller can still navigate to the presales detail view.
   */
  onSuccess?: (project: PresalesProject, result: RoomScanResult, scene?: SpatialScene) => void
  onSettled?: () => void
}

export interface StartPresalesRoomScanApi {
  startPresalesScan: (opts?: StartPresalesRoomScanOptions) => Promise<void>
  busy: boolean
  lidarAvailable: boolean | null
}

export function useStartPresalesRoomScan(): StartPresalesRoomScanApi {
  const toast = useToast()
  const { startScan, busy: scanBusy, lidarAvailable } = useStartRoomScan()
  const [projectBusy, setProjectBusy] = useState(false)

  const startPresalesScan = useCallback(
    async (opts: StartPresalesRoomScanOptions = {}) => {
      if (lidarAvailable === false) {
        toast.info('Dein Gerät hat keinen LiDAR-Sensor. Aufmaß benötigt iPad Pro / iPhone Pro mit LiDAR.')
        opts.onSettled?.()
        return
      }

      const repo = getPresalesProjectRepository()
      let project: PresalesProject

      if (opts.existingProjectId) {
        // B-P5: retry-from-draft — reuse the existing row (no new project).
        try {
          const existing = await repo.findById(opts.existingProjectId)
          if (!existing) {
            toast.error('Aufmaß wurde nicht gefunden.')
            opts.onSettled?.()
            return
          }
          if (existing.status !== 'draft' && existing.status !== 'scanned') {
            toast.info('Dieses Projekt ist bereits konvertiert oder archiviert.')
            opts.onSettled?.()
            return
          }
          project = existing
        } catch (err) {
          logError('presales.retryScan_lookup_failed', err, { projectId: opts.existingProjectId })
          toast.error('Aufmaß konnte nicht geladen werden.')
          opts.onSettled?.()
          return
        }
      } else {
        setProjectBusy(true)
        const projectResult = await createProviderPresalesProject({
          title: opts.title,
          locationHint: opts.locationHint,
        })
        if (!projectResult.ok) {
          toast.error(projectResult.message)
          setProjectBusy(false)
          opts.onSettled?.()
          return
        }
        project = projectResult.project
        setProjectBusy(false)
      }

      await startScan({
        presalesProjectId: project.id,
        onSuccess: async (result, scene) => {
          // V1.5 hotfix F-06: only flip presales→'scanned' when the canonical
          // scene was actually created. Without this gate, a promote-failure
          // (e.g. transient RPC error after Stream-A fix) would leave the
          // user on a "Gescannt"-card with a broken 3D-view. Keeping the row
          // in 'draft' lets the recovery-card with the "Scan jetzt starten"
          // CTA catch the next attempt. Caller's onSuccess still fires so
          // navigation/refetch logic does not regress.
          if (!scene) {
            opts.onSuccess?.(project, result, scene)
            return
          }
          // Bump status to 'scanned' once the spatial pipeline succeeded. Non-
          // fatal — if the update fails the scan is still persisted and the
          // user can re-trigger via the detail screen.
          try {
            await repo.update(project.id, {
              status: 'scanned',
              scannedAt: new Date().toISOString(),
            })
          } catch (err) {
            logError('presales.markScanned_failed', err, { projectId: project.id })
          }
          opts.onSuccess?.(project, result, scene)
        },
        onSettled: opts.onSettled,
      })
    },
    [lidarAvailable, startScan, toast],
  )

  return {
    startPresalesScan,
    busy: projectBusy || scanBusy,
    lidarAvailable,
  }
}
