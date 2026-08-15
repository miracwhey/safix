/**
 * @deprecated 2026-05-17 (Spatial Block B). Direct project-column persistence
 * is superseded by `captureScan()` in `src/lib/spatial/workflow/captureScan.ts`,
 * which writes to `public.scans` + `public.scan_assets` with FSM enforcement,
 * audit events, content-addressed dedup and sub-path RLS.
 *
 * Kept here for one release as backwards-compat for any out-of-tree caller and
 * for `useRoomScan()` until that hook is either dropped or rewritten on top of
 * the spatial domain. Will be removed in a post-V1-ship cleanup.
 */
import { supabase } from '../supabase'
import { logError } from '../observability'
import type { RoomScanMetadata } from './types'

const BUCKET = 'project-scans'

function scanStoragePath(userId: string, projectId: string): string {
  return `${userId}/${projectId}/scan.usdz`
}

export async function uploadScanBlob(
  userId: string,
  projectId: string,
  blob: Blob,
  onProgress: (pct: number) => void,
): Promise<string> {
  const path = scanStoragePath(userId, projectId)

  const storageBaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token ?? anonKey
  const url = `${storageBaseUrl}/storage/v1/object/${BUCKET}/${path}`

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`Upload fehlgeschlagen (${xhr.status})`))
      }
    })
    xhr.addEventListener('error', () => reject(new Error('Netzwerkfehler beim Upload')))
    xhr.addEventListener('abort', () => reject(new Error('Upload abgebrochen')))
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', anonKey)
    xhr.setRequestHeader('Content-Type', 'model/vnd.usdz+zip')
    xhr.setRequestHeader('x-upsert', 'true') // allow re-scan overwrite
    xhr.send(blob)
  })

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export async function deleteScanBlob(userId: string, projectId: string): Promise<void> {
  const path = scanStoragePath(userId, projectId)
  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) {
    logError('roomScan.delete_blob_failed', error, { userId, projectId, path })
  }
}

export async function persistScanToProject(
  projectId: string,
  scanUrl: string,
  metadata: RoomScanMetadata,
): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ room_scan_url: scanUrl, room_scan_metadata: metadata })
    .eq('id', projectId)
  if (error) {
    logError('roomScan.persist_failed', error, { projectId })
    throw new Error('Scan konnte nicht gespeichert werden.')
  }
}

export async function clearScanFromProject(projectId: string): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({ room_scan_url: null, room_scan_metadata: null })
    .eq('id', projectId)
  if (error) {
    logError('roomScan.clear_failed', error, { projectId })
    throw new Error('Scan konnte nicht entfernt werden.')
  }
}
