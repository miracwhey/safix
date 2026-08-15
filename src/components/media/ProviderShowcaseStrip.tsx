/**
 * ProviderShowcaseStrip — BLOCK 58D: Media Usage Integration
 *
 * Displays a horizontal scrolling strip of a provider's showcase media
 * (photos and short video clips) fetched from Supabase via
 * `fetchProviderShowcase()`.
 *
 * This surfaces the provider's actual work to customers browsing profiles,
 * directly answering "Can I trust this craftsman?" through visual evidence.
 *
 * Supports both images and videos:
 * - Images are rendered as aspect-ratio-square thumbnails.
 * - Videos show a play-button overlay with a basic <video> element (no sound
 *   autoplay, user-controlled — foundation level, no streaming).
 *
 * Empty state: renders nothing (section heading is shown by the caller).
 * Loading state: subtle skeleton placeholders.
 * Error state: renders nothing (callers remain stable).
 */

import { useEffect, useState, useCallback } from 'react'
import { fetchProviderShowcase, deleteShowcaseMedia } from '../../lib/providerMedia/showcaseUploadService'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import { recordAnalyticsEvent } from '../../lib/analytics/analyticsService'
import { logInfo } from '../../lib/observability'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  /** providers.id (DB-generated UUID) used to fetch showcase media */
  providerId: string
  /** auth.users.id of the viewing user (for analytics) */
  viewerUserId?: string
  /**
   * Maximum number of showcase items to display.
   * Default: 6 (keeps the strip scannable without overwhelming the profile).
   */
  maxItems?: number
  /**
   * When true, shows a delete button on each media item.
   * Used in the provider's own profile management view.
   */
  editable?: boolean
  /** Called after a media item is successfully deleted (for parent refresh) */
  onDeleted?: () => void
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ShowcaseImage({ record }: { record: PersistedMediaRecord }) {
  const [errored, setErrored] = useState(false)

  if (errored) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-100">
        <span className="text-[11px] text-slate-400">Fehler</span>
      </div>
    )
  }

  return (
    <img
      src={record.publicUrl}
      alt="Arbeitsreferenz"
      className="h-full w-full object-cover"
      onError={() => setErrored(true)}
    />
  )
}

function ShowcaseVideo({ record }: { record: PersistedMediaRecord }) {
  const [playing, setPlaying] = useState(false)

  return (
    <div className="relative h-full w-full bg-slate-900">
      {playing ? (
        <video
          src={record.publicUrl}
          className="h-full w-full object-cover"
          controls
          autoPlay
          playsInline
        />
      ) : (
        <>
          {/* Dark placeholder + play button before user taps */}
          <div className="flex h-full w-full items-center justify-center bg-slate-800">
            <button
              type="button"
              aria-label="Video abspielen"
              onClick={() => setPlaying(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 transition active:scale-95"
            >
              <span className="ml-0.5 text-[18px] text-white">▶</span>
            </button>
          </div>
          {/* Video badge */}
          <div className="absolute right-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
            VIDEO
          </div>
        </>
      )}
    </div>
  )
}

function SkeletonStrip({ count }: { count: number }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-24 w-24 shrink-0 rounded-[16px] bg-slate-100 animate-pulse ring-1 ring-slate-200/60"
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProviderShowcaseStrip({
  providerId,
  viewerUserId,
  maxItems = 6,
  editable = false,
  onDeleted,
}: Props) {
  const [items, setItems] = useState<PersistedMediaRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetchProviderShowcase(providerId)
      .then((records) => {
        if (cancelled) return
        const limited = records.slice(0, maxItems)
        setItems(limited)

        if (limited.length > 0) {
          // Emit view event when showcase is actually visible
          recordAnalyticsEvent({
            eventType: 'media_viewed_profile',
            entityType: 'media',
            entityId: providerId,
            actorUserId: viewerUserId,
            metadata: { itemCount: limited.length, providerId },
          })
        }
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [providerId, viewerUserId, maxItems])

  const handleDelete = useCallback(async (record: PersistedMediaRecord) => {
    setDeletingId(record.id)
    setDeleteError(null)
    try {
      await deleteShowcaseMedia({ id: record.id, filePath: record.filePath })
      logInfo('ui.showcase_media_deleted', { recordId: record.id })
      // Remove from local state immediately
      setItems((prev) => prev ? prev.filter((r) => r.id !== record.id) : prev)
      onDeleted?.()
    } catch (err) {
      console.error(err)
      setDeleteError('Löschen fehlgeschlagen')
    } finally {
      setDeletingId(null)
    }
  }, [onDeleted])

  if (loading) return <SkeletonStrip count={3} />

  if (!items || items.length === 0) return null

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Arbeitsproben
        </div>
        <div className="text-[12px] text-slate-400">
          {items.length} {items.length === 1 ? 'Beitrag' : 'Beiträge'}
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {items.map((record) => (
          <div
            key={record.id}
            className="relative h-24 w-24 shrink-0 overflow-hidden rounded-[16px] bg-slate-100 ring-1 ring-slate-200/70"
          >
            {record.mediaType === 'video' ? (
              <ShowcaseVideo record={record} />
            ) : (
              <ShowcaseImage record={record} />
            )}

            {editable && (
              <button
                type="button"
                aria-label="Arbeitsprobe löschen"
                disabled={deletingId === record.id}
                onClick={() => void handleDelete(record)}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-[12px] text-white transition hover:bg-red-600 active:scale-90 disabled:opacity-50"
              >
                {deletingId === record.id ? '…' : '✕'}
              </button>
            )}
          </div>
        ))}
      </div>

      {deleteError && (
        <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[12px] text-rose-700 ring-1 ring-rose-200">
          {deleteError}
          <button
            type="button"
            onClick={() => setDeleteError(null)}
            className="ml-2 font-semibold underline"
          >
            OK
          </button>
        </div>
      )}
    </div>
  )
}
