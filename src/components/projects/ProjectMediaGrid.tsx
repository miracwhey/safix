/**
 * ProjectMediaGrid — BLOCK 58E: Project Media Integration
 *
 * Displays persisted project photos fetched from Supabase via
 * `fetchMediaForEntity('project', projectId)`.
 *
 * Used in both the customer project view and the craftsman intake view to
 * answer the core question: "What exactly does the customer want?"
 *
 * Designed for clarity and scannability:
 * - up to 6 images in a responsive 3-column grid
 * - "Projektbilder" label with item count
 * - clean empty state when no images have been uploaded
 * - error-safe: broken image URLs show a fallback placeholder
 * - skeleton loading state while fetching
 * - reload-safe: fetches from DB on every mount
 *
 * Emits `media_viewed_project` analytics event when images are actually shown.
 */

import { useEffect, useState } from 'react'
import { fetchMediaForEntity } from '../../lib/media/mediaUploadService'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import { useMediaPrivateUrl } from '../../lib/media/resolveMediaUrl'
import { recordAnalyticsEvent } from '../../lib/analytics/analyticsService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  projectId: string
  viewerUserId?: string
  /**
   * Maximum number of images to display.
   * Default: 6.
   */
  maxItems?: number
  /**
   * When true, show a clean empty state instead of nothing when no photos
   * exist. Useful in the project summary card so the customer knows they
   * can add photos.
   * Default: false (section is hidden when empty).
   */
  showEmptyState?: boolean
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProjectPhotoItem({ record }: { record: PersistedMediaRecord }) {
  const [errored, setErrored] = useState(false)

  // Resolve signed URL from file_path. Fall back to legacy publicUrl for the
  // 9 un-migrated project blobs until the backfill operational step completes.
  const effectivePath = record.filePath || null
  const { url: signedUrl, isHydrated } = useMediaPrivateUrl(effectivePath)
  const displayUrl = effectivePath
    ? (isHydrated ? (signedUrl ?? '') : '')
    : record.publicUrl

  return (
    <div className="relative aspect-square overflow-hidden rounded-[14px] bg-slate-100 ring-1 ring-slate-200/70">
      {effectivePath && !isHydrated ? (
        // Loading skeleton while the signed URL is being fetched from Storage
        <div className="h-full w-full animate-pulse bg-slate-200" />
      ) : !errored && displayUrl ? (
        <img
          src={displayUrl}
          alt={`Projektbild vom ${new Date(record.createdAt).toLocaleDateString('de-DE')}`}
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-[11px] text-slate-400">{errored ? 'Fehler' : ''}</span>
        </div>
      )}
    </div>
  )
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="aspect-square rounded-[14px] animate-pulse bg-slate-100 ring-1 ring-slate-200/60"
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProjectMediaGrid({
  projectId,
  viewerUserId,
  maxItems = 6,
  showEmptyState = false,
}: Props) {
  const [photos, setPhotos] = useState<PersistedMediaRecord[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    fetchMediaForEntity('project', projectId)
      .then((records) => {
        if (cancelled) return
        const limited = records.slice(0, maxItems)
        setPhotos(limited)

        if (limited.length > 0) {
          recordAnalyticsEvent({
            eventType: 'media_viewed_project',
            entityType: 'media',
            entityId: projectId,
            actorUserId: viewerUserId,
            metadata: { count: limited.length, projectId },
          })
        }
      })
      .catch(() => {
        if (!cancelled) setPhotos([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, viewerUserId, maxItems])

  if (loading) return <SkeletonGrid count={3} />

  const count = photos?.length ?? 0

  if (count === 0) {
    if (!showEmptyState) return null
    return (
      <div className="rounded-[14px] bg-slate-50 px-4 py-3 text-center text-[13px] text-slate-400 ring-1 ring-slate-200/70">
        Noch keine Projektbilder hochgeladen
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Projektbilder
        </div>
        <div className="text-[12px] text-slate-400">
          {count} {count === 1 ? 'Bild' : 'Bilder'}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(photos ?? []).map((record) => (
          <ProjectPhotoItem key={record.id} record={record} />
        ))}
      </div>
    </div>
  )
}
