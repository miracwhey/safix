/**
 * @deprecated 2026-05-17 (Spatial Block B). Use `captureScan()` from
 * `src/lib/spatial` for write paths and `useSpatialScan(scope)` from
 * `src/hooks/useSpatialScan.ts` for read paths. This hook keeps the old
 * `projects.room_scan_*` column path alive only to unblock any consumer that
 * imports it; it has zero in-repo callers as of B.5 and will be removed in
 * a post-V1-ship cleanup.
 */
import { useCallback, useState } from 'react'
import { Filesystem } from '@capacitor/filesystem'
import { RoomPlan } from '@fixup/capacitor-roomplan'
import { supabase } from '../supabase'
import { logError, logInfo } from '../observability'
import { uploadScanBlob, deleteScanBlob, persistScanToProject, clearScanFromProject } from './repository'
import type { RoomScanState, RoomScanMetadata } from './types'

const INITIAL_STATE: RoomScanState = {
  status: 'idle',
  uploadProgress: null,
  scanUrl: null,
  metadata: null,
  error: null,
}

// Reads a native temp file:// path and returns a Blob.
// Filesystem.readFile returns base64 when no encoding is specified.
async function readNativeFile(fileUrl: string): Promise<Blob> {
  // Strip file:// scheme — Capacitor Filesystem expects absolute path
  const absolutePath = fileUrl.replace(/^file:\/\//, '')
  const { data } = await Filesystem.readFile({ path: absolutePath })
  // data is a base64 string on native
  const base64 = typeof data === 'string' ? data : await blobToBase64(data as Blob)
  return base64ToBlob(base64, 'model/vnd.usdz+zip')
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

export function useRoomScan(projectId: string) {
  const [state, setState] = useState<RoomScanState>(INITIAL_STATE)

  const startScan = useCallback(async () => {
    setState({ ...INITIAL_STATE, status: 'scanning' })

    let scanResult
    try {
      scanResult = await RoomPlan.startScan()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Cancelled = back to idle, not an error state
      if (msg === 'Scan abgebrochen') {
        setState(INITIAL_STATE)
        return
      }
      logError('roomScan.scan_failed', err, { projectId })
      setState({ ...INITIAL_STATE, status: 'error', error: 'Scan fehlgeschlagen. Bitte erneut versuchen.' })
      return
    }

    setState(prev => ({ ...prev, status: 'uploading', uploadProgress: 0 }))

    let userId: string
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Nicht eingeloggt')
      userId = user.id
    } catch (err) {
      logError('roomScan.auth_failed', err, { projectId })
      setState({ ...INITIAL_STATE, status: 'error', error: 'Authentifizierung fehlgeschlagen.' })
      return
    }

    let blob: Blob
    try {
      blob = await readNativeFile(scanResult.usdzPath)
    } catch (err) {
      logError('roomScan.file_read_failed', err, { projectId, path: scanResult.usdzPath })
      setState({ ...INITIAL_STATE, status: 'error', error: 'Scan-Datei konnte nicht gelesen werden.' })
      return
    }

    let scanUrl: string
    try {
      scanUrl = await uploadScanBlob(userId, projectId, blob, (pct) => {
        setState(prev => ({ ...prev, uploadProgress: pct }))
      })
    } catch (err) {
      logError('roomScan.upload_failed', err, { projectId })
      setState({ ...INITIAL_STATE, status: 'error', error: 'Upload fehlgeschlagen. Bitte erneut versuchen.' })
      return
    }

    const metadata: RoomScanMetadata = {
      capturedAt: scanResult.capturedAt,
      floorAreaM2: scanResult.floorAreaM2,
      ceilingHeightM: scanResult.ceilingHeightM,
      walls: scanResult.walls,
      doors: scanResult.doors,
      windows: scanResult.windows,
      furnitureCount: scanResult.furnitureCount,
      furnitureCategories: scanResult.furnitureCategories,
    }

    try {
      await persistScanToProject(projectId, scanUrl, metadata)
    } catch (err) {
      // Upload succeeded but DB write failed — still surface the scan locally
      logError('roomScan.persist_failed', err, { projectId })
    }

    logInfo('roomScan.completed', { projectId, floorAreaM2: metadata.floorAreaM2 })
    setState({ status: 'done', uploadProgress: 100, scanUrl, metadata, error: null })
  }, [projectId])

  const removeScan = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    try {
      await Promise.all([
        deleteScanBlob(user.id, projectId),
        clearScanFromProject(projectId),
      ])
      setState(INITIAL_STATE)
    } catch (err) {
      logError('roomScan.remove_failed', err, { projectId })
      setState(prev => ({ ...prev, error: 'Scan konnte nicht entfernt werden.' }))
    }
  }, [projectId])

  return { state, startScan, removeScan }
}
