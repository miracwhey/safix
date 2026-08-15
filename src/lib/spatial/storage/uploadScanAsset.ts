/**
 * Spatial Core · Block B.2 · Content-Addressable Asset Upload
 *
 * Single entry point for uploading a scan asset (USDZ / glTF / scan.json /
 * mesh_summary / thumbnail / floorplan_svg / worldmap) to the `project-scans`
 * bucket. Dedup is content-based via SHA-256 hex:
 *
 *   1. Hash the blob.
 *   2. Ask the repository whether the scan already has an asset of the same
 *      `kind` AND `sha256` digest.
 *   3. If yes → return the existing row, upload 0 bytes.
 *   4. Else → PUT bytes to `{userId}/{scanId}/{kind}/<sha>.<ext>` then
 *      create the matching scan_assets row.
 *
 * Path schema is enforced by `spatial_scan_storage_path_ok()` + the
 * `spatial_scan_assets_*` RLS policies (Block A.1 migration 20260518000007).
 * The schema PUT contract is: `(storage.foldername(name))[3]` MUST be the
 * `kind`, and the filename extension MUST be on the allow-list. We rebuild
 * the path here so callers cannot accidentally violate the policy.
 *
 * TUS-Resumable for large blobs is wired in Block X. V1-MVP uses a single
 * authenticated PUT via supabase-js — fine up to the bucket's 20 MB cap for
 * USDZ (raised to 50 MB in Block X for glTF + worldmap).
 *
 * Concurrency: two callers uploading the same `(scanId, kind, sha)` race on
 * the storage PUT (idempotent via x-upsert) and on the scan_assets INSERT
 * (UNIQUE(scan_id, kind)). The INSERT loser observes a 23505 conflict —
 * we recover by re-listing and returning whatever ended up persisted.
 */

import type { MeshClassification } from '@fixup/capacitor-roomplan'

import { supabase } from '../../supabase'
import { getSpatialRepository } from '../repository/registry'
import type { ScanAsset, ScanAssetKind } from '../types'
import { computeSha256 } from './computeSha256'
import { tusUploadBlob, TUS_THRESHOLD_BYTES } from './tusUpload'

export interface UploadScanAssetArgs {
  scanId: string
  /** Owner of the scan — used in the storage path. Must equal auth.uid() for
   *  RLS. Pass it explicitly so callers don't assume a session. */
  userId: string
  kind: ScanAssetKind
  blob: Blob
  /** MIME type for the storage object. Defaults from `kind`. */
  contentType?: string
  /** Optional reference to the source asset row when this asset is derived
   *  (D1: glTF → source USDZ). */
  convertedFrom?: string | null
  /** Block X.4: progress callback for the TUS path (large blobs only).
   *  Receives `(loaded, total)` in bytes. */
  onProgress?: (loaded: number, total: number) => void
  /** Block X.4: abort the in-flight upload from the caller side. */
  signal?: AbortSignal
}

export interface UploadScanAssetResult {
  asset: ScanAsset
  /** `true` when the asset was de-duped — no bytes were written this call. */
  reused: boolean
  /** SHA-256 hex digest of the blob, regardless of whether bytes were sent. */
  sha256: string
}

export const SCAN_ASSET_BUCKET = 'project-scans'

const EXTENSION_BY_KIND: Record<ScanAssetKind, string> = {
  usdz: 'usdz',
  gltf: 'glb',
  scan_json: 'json',
  mesh_summary: 'json',
  thumbnail: 'png',
  floorplan_svg: 'svg',
  worldmap: 'bin',
}

const CONTENT_TYPE_BY_KIND: Record<ScanAssetKind, string> = {
  usdz: 'model/vnd.usdz+zip',
  gltf: 'model/gltf-binary',
  scan_json: 'application/json',
  mesh_summary: 'application/json',
  thumbnail: 'image/png',
  floorplan_svg: 'image/svg+xml',
  worldmap: 'application/octet-stream',
}

export function scanAssetStoragePath(args: {
  userId: string
  scanId: string
  kind: ScanAssetKind
  sha256: string
}): string {
  return `${args.userId}/${args.scanId}/${args.kind}/${args.sha256}.${EXTENSION_BY_KIND[args.kind]}`
}

export async function uploadScanAsset(
  args: UploadScanAssetArgs,
): Promise<UploadScanAssetResult> {
  const repo = getSpatialRepository()
  const sha256 = await computeSha256(args.blob)

  const existing = (await repo.listScanAssets(args.scanId)).find(
    a => a.kind === args.kind && a.sha256 === sha256,
  )
  if (existing) {
    return { asset: existing, reused: true, sha256 }
  }

  const storagePath = scanAssetStoragePath({
    userId: args.userId,
    scanId: args.scanId,
    kind: args.kind,
    sha256,
  })
  const contentType = args.contentType ?? CONTENT_TYPE_BY_KIND[args.kind]

  // Block X.4 — route >5MiB blobs through TUS for resumable transfer over
  // cellular networks. RoomPlan USDZ files typically land 5-20MiB; the
  // direct PUT path remains for thumbnails / JSON / small assets.
  if (args.blob.size >= TUS_THRESHOLD_BYTES) {
    await tusUploadBlob({
      bucket: SCAN_ASSET_BUCKET,
      path: storagePath,
      blob: args.blob,
      contentType,
      onProgress: args.onProgress,
      signal: args.signal,
    })
  } else {
    const { error: uploadError } = await supabase.storage
      .from(SCAN_ASSET_BUCKET)
      .upload(storagePath, args.blob, {
        contentType,
        cacheControl: '3600',
        upsert: true,
      })
    if (uploadError) {
      throw uploadError
    }
  }

  try {
    const asset = await repo.createScanAsset({
      scanId: args.scanId,
      kind: args.kind,
      storagePath,
      bytes: args.blob.size,
      sha256,
      convertedFrom: args.convertedFrom ?? null,
    })
    return { asset, reused: false, sha256 }
  } catch (createError) {
    // Conflict recovery: another caller raced us to the same
    // (scan_id, kind) slot. Only treat it as a successful dedup when the
    // existing row's sha matches ours — a sha mismatch means our bytes
    // sit orphaned at a fresh path while the row points elsewhere; we
    // surface that as a hard error so callers see the real state instead
    // of silently using the wrong asset.
    const conflict = await repo
      .listScanAssets(args.scanId)
      .then(rows => rows.find(a => a.kind === args.kind && a.sha256 === sha256))
    if (conflict) {
      return { asset: conflict, reused: true, sha256 }
    }
    throw createError
  }
}

/**
 * Phase 2 · Persist the harvested mesh aggregate as `mesh_summary.json`.
 *
 * Storage shape = the raw `MeshClassification` from the Capacitor plugin
 * (forensics + Phase 4 Hub thumbnail rendering). The Quality Engine reads a
 * derived `MeshSummary` (wallCoveragePct + averageConfidence + triangleCount)
 * — consumers MUST map through `meshSummaryFromClassification()` before
 * passing this asset to `runQualityEngine`. The live capture-time path does
 * this in `captureScan.ts`; the re-run path does it in
 * `useScanQualityReport.rerun()` via `loadMeshClassificationAsset`.
 *
 * Returns `null` when the input is missing OR `degraded === true`. We skip
 * the upload in the degraded case to match `meshSummaryFromClassification`'s
 * filter — a degraded snapshot is partial and the Quality Engine ignores it
 * anyway, so persisting it would only mislead Phase 4's Hub forensics about
 * how much real data we collected for this scan.
 */
export async function uploadMeshSummaryAsset(args: {
  scanId: string
  userId: string
  meshClassification: MeshClassification | null | undefined
}): Promise<UploadScanAssetResult | null> {
  const mesh = args.meshClassification
  if (!mesh) return null
  if (mesh.degraded) return null
  // Stable JSON ordering so the SHA-256 dedup hash is reproducible across
  // re-uploads of the same scan (e.g. quality re-run after a network blip).
  const ordered = sortJsonKeysDeep(mesh) as MeshClassification
  const json = JSON.stringify(ordered)
  const blob = new Blob([json], { type: 'application/json' })
  return uploadScanAsset({
    scanId: args.scanId,
    userId: args.userId,
    kind: 'mesh_summary',
    blob,
    contentType: 'application/json',
  })
}

function sortJsonKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeysDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortJsonKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
