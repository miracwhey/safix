/**
 * Spatial Core · Phase 2 · Read-back the harvester-emitted mesh aggregate.
 *
 * Companion to `uploadMeshSummaryAsset`. Used by the manual quality re-run
 * path (`useScanQualityReport.rerun()`) so a user who fixes a scan and re-
 * triggers Quality from the UI gets R6 + R7 evaluated against the SAME
 * mesh data the live-capture path used — not Plan B.
 *
 * Returns `null` (never throws) on any storage / parse failure. The caller
 * treats null as "no mesh available", which falls through to Plan B in
 * runQualityEngine — exactly the same behaviour as a non-LiDAR scan.
 *
 * Storage shape: the stored JSON is the raw `MeshClassification` from the
 * Capacitor plugin (so Phase 4's Hub can re-render forensics). Consumers
 * MUST map through `meshSummaryFromClassification()` before passing the
 * value to `runQualityEngine`. This helper returns the raw shape; the
 * caller does the mapping so the contract stays in one place.
 */

import type { MeshClassification } from '@fixup/capacitor-roomplan'

import { supabase } from '../../supabase'
import { getSpatialRepository } from '../repository/registry'
import { SCAN_ASSET_BUCKET } from './uploadScanAsset'

export async function loadMeshClassificationAsset(
  scanId: string,
): Promise<MeshClassification | null> {
  try {
    const repo = getSpatialRepository()
    const assets = await repo.listScanAssets(scanId)
    const meshAsset = assets.find(a => a.kind === 'mesh_summary')
    if (!meshAsset) return null
    const { data, error } = await supabase.storage
      .from(SCAN_ASSET_BUCKET)
      .download(meshAsset.storagePath)
    if (error || !data) return null
    const text = await data.text()
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as MeshClassification
  } catch {
    // Best-effort read — any failure (storage 404, JSON parse, repo init,
    // network) falls through to Plan B silently. Caller never needs to
    // handle this — null is the standard "no mesh" signal.
    return null
  }
}
