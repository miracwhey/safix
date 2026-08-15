/**
 * Portfolio Item Service — provider_media (kind='portfolio') CRUD.
 *
 * Single write path for the Block 2 portfolio system. Reads/writes go
 * through `provider_media` directly (Block 2 contract); `media_uploads`
 * is used as the rollback handle owned by {@link uploadMediaFile}.
 *
 * Three creation paths:
 *   1. createPortfolioItemFromUpload — uploads a new file, then inserts
 *      the row. Phase-2-Hardening: uploadMediaFile owns Storage write +
 *      pre-upload pipeline (magic-byte sniff, EXIF strip, JPEG re-encode
 *      for bitmaps, MIME/size validation, bucket-policy gate). On any
 *      provider_media failure the just-uploaded record is rolled back
 *      so quota is never leaked and retries start clean.
 *   2. createPortfolioItemFromJob — references an existing job photo
 *      (no re-upload, no rollback needed).
 *   3. updatePortfolioItem — metadata-only update (no media change).
 *
 * Read paths:
 *   fetchPublicPortfolio — published=true only (used by public Explore).
 *   fetchOwnerPortfolio  — all items including unpublished (owner view).
 *
 * Note on job photo references:
 *   Job photos are stored in the public 'media' bucket — their public_url
 *   is already publicly accessible. They become an Arbeitsprobe via
 *   EXPLICIT owner selection in the "Aus Projekt übernehmen" flow only;
 *   there is no automatic promotion of job documentation to the public
 *   portfolio. Storage deletion of those files is owned by the job/job
 *   media layer, not the portfolio service.
 */

import { supabase } from '../supabase'
import { uploadMediaFile, MEDIA_STORAGE_BUCKET } from '../media/mediaUploadService'
import { logInfo, logError } from '../observability'
import { describePostgrestError, rollbackOrphanedUpload } from './uploadRollback'
import type { PortfolioAsset, PortfolioItem, ProviderMediaRowV2 } from './providerMediaTypes'

// ---------------------------------------------------------------------------
// M1: provider_media_assets types and mapper
// ---------------------------------------------------------------------------

type ProviderMediaAssetRow = {
  id: string
  portfolio_item_id: string
  provider_id: string
  sort_order: number
  media_type: string
  storage_path: string | null
  public_url: string
  poster_url: string | null
  h264_url: string | null
  trim_start_ms: number
  trim_end_ms: number | null
  created_at: string
  updated_at: string
}

function assetRowToPortfolioAsset(row: ProviderMediaAssetRow): PortfolioAsset {
  return {
    id: row.id,
    portfolioItemId: row.portfolio_item_id,
    providerId: row.provider_id,
    sortOrder: row.sort_order,
    mediaType: row.media_type === 'video' ? 'video' : 'image',
    storagePath: row.storage_path,
    publicUrl: row.public_url,
    posterUrl: row.poster_url,
    h264Url: row.h264_url,
    trimStartMs: row.trim_start_ms,
    trimEndMs: row.trim_end_ms,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

async function fetchAssetsForPortfolioItems(
  ids: string[]
): Promise<Record<string, PortfolioAsset[]>> {
  if (ids.length === 0) return {}

  const { data, error } = await supabase
    .from('provider_media_assets')
    .select('*')
    .in('portfolio_item_id', ids)
    .order('sort_order', { ascending: true })

  if (error) {
    logError('portfolio.fetch_assets_failed', error, { count: ids.length })
    return {}
  }

  const byItem: Record<string, PortfolioAsset[]> = {}
  for (const row of (data ?? []) as unknown as ProviderMediaAssetRow[]) {
    const asset = assetRowToPortfolioAsset(row)
    if (!byItem[row.portfolio_item_id]) byItem[row.portfolio_item_id] = []
    byItem[row.portfolio_item_id].push(asset)
  }
  return byItem
}

// ---------------------------------------------------------------------------
// Column list (all Block 2 columns)
// ---------------------------------------------------------------------------

const PORTFOLIO_COLUMNS = [
  'id', 'provider_id', 'kind', 'storage_path', 'public_url', 'caption', 'sort_order',
  'created_at', 'updated_at',
  // Block 2 columns:
  'media_type', 'title', 'description', 'trade_tags', 'published',
  'show_price', 'show_duration', 'source_job_id',
  'project_title_snapshot', 'location_snapshot', 'duration_snapshot',
  'amount_snapshot', 'trade_tags_snapshot',
  // Block 3 (poster frame for cross-platform video display):
  'poster_url',
  // Block 0 (H.264 transcode for cross-platform video playback):
  'h264_url',
].join(', ')

// ---------------------------------------------------------------------------
// Row → PortfolioItem mapper
// ---------------------------------------------------------------------------

function rowToPortfolioItem(row: ProviderMediaRowV2): PortfolioItem {
  return {
    id: row.id,
    providerId: row.provider_id,
    kind: 'portfolio',
    storagePath: row.storage_path,
    publicUrl: row.public_url,
    mediaType: (row.media_type === 'video' ? 'video' : 'image'),
    title: row.title,
    caption: row.caption,
    description: row.description,
    tradeTags: row.trade_tags ?? [],
    sortOrder: row.sort_order ?? 0,
    posterUrl: row.poster_url ?? null,
    h264Url: row.h264_url ?? null,
    published: row.published ?? true,
    showPrice: row.show_price ?? false,
    showDuration: row.show_duration ?? false,
    sourceJobId: row.source_job_id,
    projectTitleSnapshot: row.project_title_snapshot,
    locationSnapshot: row.location_snapshot,
    durationSnapshot: row.duration_snapshot,
    amountSnapshot: row.amount_snapshot,
    tradeTagsSnapshot: row.trade_tags_snapshot ?? [],
    assets: [],
    createdAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  }
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Merges a fresh DB read into an in-memory list while preserving recent
 * optimistic prepends that have not yet propagated through the read path.
 *
 * Why this exists
 *   The owner profile uses an optimistic-prepend pattern after a publish:
 *   `setPortfolioItems(prev => [item, ...prev])` followed by an awaited
 *   `fetchOwnerPortfolio` resync. If the resync fires before PostgREST /
 *   Supabase replication surfaces the just-inserted row, a naive
 *   `setPortfolioItems(items)` would erase the optimistic entry and the
 *   user would see their freshly published Reel disappear for a few
 *   hundred ms — exactly the symptom that motivated the M1 refresh
 *   block. Keeping optimistic-only IDs at the head closes that window
 *   without hiding genuine deletes (deletes go through their own
 *   filtering path; this helper only runs on a save).
 *
 * Contract
 *   - Items present in `fresh` always win (DB is the truth)
 *   - Items present only in `prev` are kept and prepended
 *   - Order: optimistic-only first (newest publish on top), then `fresh`
 *     in its DB order (now sort_order DESC since M1)
 */
export function mergePortfolioById(
  prev: PortfolioItem[] | null,
  fresh: PortfolioItem[]
): PortfolioItem[] {
  if (!prev || prev.length === 0) return fresh
  const freshIds = new Set(fresh.map((it) => it.id))
  const optimisticOnly = prev.filter((it) => !freshIds.has(it.id))
  if (optimisticOnly.length === 0) return fresh
  return [...optimisticOnly, ...fresh]
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetches published portfolio items for a provider.
 * Used by the public Explore profile screen — only published=true items visible.
 *
 * Order: `sort_order DESC` so the newest publish surfaces at the top of the
 * Reels grid. Inserts use `sort_order = Date.now()`, where a larger value
 * means "more recent". The previous ascending order put the oldest item
 * first and pushed every fresh upload to the bottom of the list — the user
 * symptom that newly published Reels seemed to vanish on profiles with a
 * non-trivial backlog.
 */
export async function fetchPublicPortfolio(
  providerId: string
): Promise<PortfolioItem[]> {
  const { data, error } = await supabase
    .from('provider_media')
    .select(PORTFOLIO_COLUMNS)
    .eq('provider_id', providerId)
    .eq('kind', 'portfolio')
    .eq('published', true)
    .order('sort_order', { ascending: false })

  if (error) {
    logError('portfolio.fetch_public_failed', error, { providerId })
    return []
  }

  const items = ((data ?? []) as unknown as ProviderMediaRowV2[]).map(rowToPortfolioItem)
  const assetsByItem = await fetchAssetsForPortfolioItems(items.map((i) => i.id))
  return items.map((item) => ({ ...item, assets: assetsByItem[item.id] ?? [] }))
}

/**
 * Fetches ALL portfolio items for a provider (including published=false).
 * Used by the owner's CraftsmanProfile screen. RLS ensures only the owner
 * can read their own unpublished items.
 *
 * Order: matches {@link fetchPublicPortfolio} — newest first so a freshly
 * published item is the first thing the owner sees after returning to the
 * Reels tab. See that function for the rationale.
 */
export async function fetchOwnerPortfolio(
  providerId: string
): Promise<PortfolioItem[]> {
  const { data, error } = await supabase
    .from('provider_media')
    .select(PORTFOLIO_COLUMNS)
    .eq('provider_id', providerId)
    .eq('kind', 'portfolio')
    .order('sort_order', { ascending: false })

  if (error) {
    logError('portfolio.fetch_owner_failed', error, { providerId })
    return []
  }

  const items = ((data ?? []) as unknown as ProviderMediaRowV2[]).map(rowToPortfolioItem)
  const assetsByItem = await fetchAssetsForPortfolioItems(items.map((i) => i.id))
  return items.map((item) => ({ ...item, assets: assetsByItem[item.id] ?? [] }))
}

// ---------------------------------------------------------------------------
// Create: direct upload
// ---------------------------------------------------------------------------

export type CreatePortfolioFromUploadInput = {
  file: File
  /** providers.id (DB UUID) */
  providerId: string
  /** auth.users.id — used by uploadMediaFile to satisfy the media_uploads
   *  RLS check (owner_user_id = auth.uid()). */
  ownerUserId: string
  title?: string
  description?: string
  /** Gewerke explicitly chosen by the owner in the Composer */
  tradeTags?: string[]
  published?: boolean
  showPrice?: boolean
  showDuration?: boolean
  /**
   * M2: additional files uploaded as assets[1..N] in the same post.
   * files[0] (the cover) is always `input.file`; these are appended
   * with sort_order=1,2,...  Failures are logged but do not roll back
   * the cover or the portfolio item itself.
   */
  additionalFiles?: File[]
}

/**
 * Uploads a portfolio file via {@link uploadMediaFile} (which runs the
 * pre-upload pipeline — MIME/size validation, magic-byte sniff, EXIF
 * strip, JPEG re-encode for bitmap images, bucket-policy gate, and
 * media_uploads bookkeeping) and inserts the matching row in
 * `provider_media` with kind='portfolio'.
 *
 * On any failure during the provider_media insert, the just-uploaded
 * Storage object + media_uploads row are rolled back via
 * {@link rollbackOrphanedUpload} so retries start clean and storage
 * quota is not leaked. The original PostgREST error is preserved with
 * its full `details/hint/code` so the UI can show something
 * actionable instead of a generic message.
 *
 * Throws on validation failure, storage error, or DB error.
 */
export async function createPortfolioItemFromUpload(
  input: CreatePortfolioFromUploadInput
): Promise<PortfolioItem> {
  const {
    file,
    providerId,
    ownerUserId,
    title,
    description,
    tradeTags = [],
    published = true,
    showPrice = false,
    showDuration = false,
  } = input

  // 1. Upload via the shared media pipeline. uploadMediaFile validates
  //    MIME + size, runs magic-byte sniff, strips EXIF + compresses
  //    bitmap images to JPEG, writes the Storage object under
  //    `portfolio/{providerId}/{uuid}.{ext}`, and inserts the
  //    media_uploads bookkeeping row. Any failure here surfaces with
  //    its own cleanup already done by uploadMediaFile — no orphan to
  //    roll back at this layer.
  const record = await uploadMediaFile({
    file,
    entityType: 'portfolio',
    entityId: providerId,
    ownerUserId,
    mediaRole: 'portfolio',
  })

  logInfo('portfolio.upload_started', {
    providerId,
    mediaType: record.mediaType,
    size: file.size,
    mediaUploadId: record.id,
  })

  // 2. Insert the provider_media row pointing at the just-uploaded file.
  //    Wrapped in try/catch so any DB-side failure rolls back the
  //    Storage object + media_uploads row before the original error is
  //    rethrown.
  try {
    const sortOrder = Date.now()
    const { data: insertData, error: dbError } = await supabase
      .from('provider_media')
      .insert({
        provider_id: providerId,
        kind: 'portfolio',
        storage_path: record.filePath,
        public_url: record.publicUrl,
        media_type: record.mediaType,
        title: title ?? null,
        caption: title ?? null,
        description: description ?? null,
        trade_tags: tradeTags,
        published,
        show_price: showPrice,
        show_duration: showDuration,
        sort_order: sortOrder,
        trade_tags_snapshot: tradeTags,
        // null for image uploads or when poster extraction failed
        poster_url: record.posterUrl,
      })
      .select(PORTFOLIO_COLUMNS)
      .single()

    if (dbError || !insertData) {
      const detail = describePostgrestError(dbError)
      logError('portfolio.db_insert_failed', dbError, {
        providerId,
        ownerUserId,
        storagePath: record.filePath,
        mediaUploadId: record.id,
        detail,
      })
      throw new Error(`Arbeitsprobe konnte nicht gespeichert werden: ${detail}`)
    }

    const portfolioItemId = (insertData as unknown as ProviderMediaRowV2).id

    // 3. Insert the cover asset row. The trigger sync_provider_media_cover fires
    //    and writes back the same values — effectively a no-op on the first asset.
    const { error: assetError } = await supabase
      .from('provider_media_assets')
      .insert({
        portfolio_item_id: portfolioItemId,
        provider_id: providerId,
        sort_order: 0,
        media_type: record.mediaType,
        storage_path: record.filePath,
        public_url: record.publicUrl,
        poster_url: record.posterUrl ?? null,
        h264_url: null,
      })

    if (assetError) {
      logError('portfolio.asset_insert_failed', assetError, { portfolioItemId, providerId })
    }

    // 4. M2: upload and insert additional assets (sort_order=1,2,...).
    //    Failures are logged per-asset and do not abort the item creation.
    const additionalFiles = input.additionalFiles ?? []
    for (let i = 0; i < additionalFiles.length; i++) {
      const addFile = additionalFiles[i]!
      try {
        const addRecord = await uploadMediaFile({
          file: addFile,
          entityType: 'portfolio',
          entityId: providerId,
          ownerUserId,
          mediaRole: 'portfolio',
        })
        const { error: addAssetError } = await supabase
          .from('provider_media_assets')
          .insert({
            portfolio_item_id: portfolioItemId,
            provider_id: providerId,
            sort_order: i + 1,
            media_type: addRecord.mediaType,
            storage_path: addRecord.filePath,
            public_url: addRecord.publicUrl,
            poster_url: addRecord.posterUrl ?? null,
            h264_url: null,
          })
        if (addAssetError) {
          logError('portfolio.additional_asset_db_failed', addAssetError, { portfolioItemId, index: i })
        }
      } catch (err) {
        logError('portfolio.additional_asset_upload_failed', err, { portfolioItemId, index: i })
      }
    }

    logInfo('portfolio.item_created_from_upload', {
      providerId,
      publicUrl: record.publicUrl,
      mediaType: record.mediaType,
      assetCount: 1 + additionalFiles.length,
    })
    const item = rowToPortfolioItem(insertData as unknown as ProviderMediaRowV2)
    // fetchAssetsForPortfolioItems is outside the rollback-scope: a failure
    // here must not trigger rollbackOrphanedUpload (the item was already
    // committed successfully; the caller can retry or show stale data).
    try {
      const assetsByItem = await fetchAssetsForPortfolioItems([item.id])
      return { ...item, assets: assetsByItem[item.id] ?? [] }
    } catch {
      return { ...item, assets: [] }
    }
  } catch (err) {
    await rollbackOrphanedUpload(
      { id: record.id, filePath: record.filePath },
      { stage: 'portfolio_pipeline', ownerUserId },
    )
    throw err
  }
}

// ---------------------------------------------------------------------------
// Create: from job photo (no re-upload)
// ---------------------------------------------------------------------------

export type JobPhotoSelection = {
  /** jobs.id — text, not uuid */
  jobId: string
  jobTitle: string
  jobLocation: string
  jobAmount: string
  /** The media_uploads record id for the selected photo */
  mediaRecordId: string
  /** Already-public URL from the media bucket */
  publicUrl: string
  storagePath: string
  mediaType: 'image' | 'video'
}

export type CreatePortfolioFromJobInput = {
  providerId: string
  ownerUserId: string
  selection: JobPhotoSelection
  title?: string
  description?: string
  /** Gewerke explicitly chosen by the owner in the Composer */
  tradeTags?: string[]
  published?: boolean
  showPrice?: boolean
  showDuration?: boolean
}

/**
 * Creates a portfolio item by referencing an existing job photo.
 * No file upload is performed. The job photo's existing public_url is used directly.
 *
 * The job photo becomes an Arbeitsprobe ONLY via this explicit owner selection.
 * There is no automatic promotion of job documentation to the portfolio.
 *
 * Deletion safety: the storage file is NOT deleted when this portfolio item is
 * removed (it belongs to the job). See deletePortfolioItem.
 */
export async function createPortfolioItemFromJob(
  input: CreatePortfolioFromJobInput
): Promise<PortfolioItem> {
  const {
    providerId,
    selection,
    title,
    description,
    tradeTags = [],
    published = true,
    showPrice = false,
    showDuration = false,
  } = input

  const sortOrder = Date.now()

  const { data: insertData, error: dbError } = await supabase
    .from('provider_media')
    .insert({
      provider_id: providerId,
      kind: 'portfolio',
      storage_path: selection.storagePath,
      public_url: selection.publicUrl,
      media_type: selection.mediaType,
      title: title ?? selection.jobTitle ?? null,
      caption: title ?? selection.jobTitle ?? null,
      description: description ?? null,
      trade_tags: tradeTags,
      published,
      show_price: showPrice,
      show_duration: showDuration,
      sort_order: sortOrder,
      // Back-reference (jobs.id is text)
      source_job_id: selection.jobId,
      // Immutable snapshots captured at creation time
      project_title_snapshot: selection.jobTitle ?? null,
      location_snapshot: selection.jobLocation ?? null,
      amount_snapshot: selection.jobAmount ?? null,
      // tradeTagsSnapshot = what the owner explicitly selected in the Composer
      trade_tags_snapshot: tradeTags,
    })
    .select(PORTFOLIO_COLUMNS)
    .single()

  if (dbError || !insertData) {
    const detail = describePostgrestError(dbError)
    logError('portfolio.db_insert_from_job_failed', dbError, {
      providerId,
      jobId: selection.jobId,
      detail,
    })
    throw new Error(`Arbeitsprobe konnte nicht gespeichert werden: ${detail}`)
  }

  // Insert the cover asset row.
  const { error: assetError } = await supabase
    .from('provider_media_assets')
    .insert({
      portfolio_item_id: (insertData as unknown as ProviderMediaRowV2).id,
      provider_id: providerId,
      sort_order: 0,
      media_type: selection.mediaType,
      storage_path: selection.storagePath,
      public_url: selection.publicUrl,
      poster_url: null,
      h264_url: null,
    })

  if (assetError) {
    logError('portfolio.asset_insert_from_job_failed', assetError, {
      portfolioItemId: (insertData as unknown as ProviderMediaRowV2).id,
      providerId,
    })
  }

  logInfo('portfolio.item_created_from_job', {
    providerId,
    jobId: selection.jobId,
    publicUrl: selection.publicUrl,
  })
  const item = rowToPortfolioItem(insertData as unknown as ProviderMediaRowV2)
  const assetsByItem = await fetchAssetsForPortfolioItems([item.id])
  return { ...item, assets: assetsByItem[item.id] ?? [] }
}

// ---------------------------------------------------------------------------
// Update (metadata only — no media change)
// ---------------------------------------------------------------------------

export type UpdatePortfolioItemInput = {
  id: string
  title?: string
  caption?: string
  description?: string
  tradeTags?: string[]
  published?: boolean
  showPrice?: boolean
  showDuration?: boolean
  sortOrder?: number
}

/**
 * Partially updates a portfolio item's metadata.
 * The media file itself is never changed via this function.
 * RLS ensures only the owning provider can update.
 */
export async function updatePortfolioItem(
  input: UpdatePortfolioItemInput
): Promise<PortfolioItem> {
  const { id, ...rest } = input

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (rest.title !== undefined) { patch.title = rest.title; patch.caption = rest.title }
  if (rest.caption !== undefined && rest.title === undefined) patch.caption = rest.caption
  if (rest.description !== undefined) patch.description = rest.description
  if (rest.tradeTags !== undefined) patch.trade_tags = rest.tradeTags
  if (rest.published !== undefined) patch.published = rest.published
  if (rest.showPrice !== undefined) patch.show_price = rest.showPrice
  if (rest.showDuration !== undefined) patch.show_duration = rest.showDuration
  if (rest.sortOrder !== undefined) patch.sort_order = rest.sortOrder

  const { data, error } = await supabase
    .from('provider_media')
    .update(patch)
    .eq('id', id)
    .eq('kind', 'portfolio')
    .select(PORTFOLIO_COLUMNS)
    .single()

  if (error || !data) {
    const detail = describePostgrestError(error)
    logError('portfolio.update_failed', error, { id, detail })
    throw new Error(`Arbeitsprobe konnte nicht aktualisiert werden: ${detail}`)
  }

  const item = rowToPortfolioItem(data as unknown as ProviderMediaRowV2)
  const assetsByItem = await fetchAssetsForPortfolioItems([item.id])
  return { ...item, assets: assetsByItem[item.id] ?? [] }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes a portfolio item.
 *
 * Storage file deletion rule (M2):
 *   - For each asset whose storagePath starts with 'portfolio/', the storage
 *     file was uploaded directly for this portfolio item and is deleted.
 *   - Assets whose storagePath starts with 'job/' (or similar) belong to the
 *     job documentation — the storage file is left untouched; only the DB row
 *     is removed (ON DELETE CASCADE removes provider_media_assets rows).
 *
 * Throws on failure.
 */
export async function deletePortfolioItem(
  id: string,
  assets: PortfolioAsset[]
): Promise<void> {
  // Collect storagePaths for portfolio-owned files (safe to delete)
  const portfolioPaths = assets
    .map((a) => a.storagePath)
    .filter((p): p is string => !!p && p.startsWith('portfolio/'))

  if (portfolioPaths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from(MEDIA_STORAGE_BUCKET)
      .remove(portfolioPaths)

    if (storageError) {
      const isNotFound = /not.?found|404|does not exist/i.test(storageError.message ?? '')
      if (!isNotFound) {
        // Log but continue — DB delete is the canonical removal. Storage orphans
        // are acceptable; a missing DB row is not.
        logError('portfolio.delete_storage_failed', storageError, { id, paths: portfolioPaths })
      } else {
        logInfo('portfolio.delete_storage_already_gone', { id, paths: portfolioPaths })
      }
    }
  }

  // Always delete the DB row
  const { error: dbError } = await supabase
    .from('provider_media')
    .delete()
    .eq('id', id)
    .eq('kind', 'portfolio')

  if (dbError) {
    const detail = describePostgrestError(dbError)
    logError('portfolio.delete_db_failed', dbError, { id, detail })
    throw new Error(`Arbeitsprobe konnte nicht entfernt werden: ${detail}`)
  }

  logInfo('portfolio.item_deleted', { id, assetCount: assets.length })
}
