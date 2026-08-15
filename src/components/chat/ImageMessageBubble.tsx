/**
 * Block D Slice B — Image-message bubble with optimistic pending state.
 *
 * Pending: shows local thumbnail (localBlobUrl) immediately + shimmer overlay + spinner.
 * Sent: signed URL loaded, clean tap-to-lightbox.
 * Failed: rose overlay + retry tap.
 * Transition pending→sent: 160ms opacity fade (--t-fast token).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatAttachment, ChatMessageStatus } from '../../lib/chat'
import {
  resolveChatAttachmentUrl,
  invalidateChatAttachmentUrl,
} from '../../lib/chat/voice/storageUrl'
import { logWarning } from '../../lib/observability'
import { ChatStatusIcon } from './ChatStatusIcon'
import { BubbleTail } from './BubbleTail'
import { bubbleAlignClass, bubbleRadiusClass, bubbleTailSide } from './chatBubbleSide'
import Spinner from '../system/Spinner'

/**
 * Signed chat-URLs live ~1 h. Re-resolve proactively after 45 min (mirrors
 * VideoMessageBubble) so a bubble left on screen never starts pointing at an
 * expired URL.
 */
const SIGNED_URL_TTL_MS = 45 * 60 * 1000

type Props = {
  attachment: ChatAttachment
  caption?: string | null
  createdAt: number
  status: ChatMessageStatus
  isOwnBubble: boolean
  /** Called when user taps the failed bubble to retry (own bubbles only). */
  onRetry?: () => void
  /** Called when the user discards a permanently-failed send (3+ retries). */
  onDiscardFailed?: () => void
  /** How many retries have already failed (3+ → discard CTA). */
  failedRetryCount?: number
}

export function ImageMessageBubble({
  attachment,
  caption,
  createdAt,
  status,
  isOwnBubble,
  onRetry,
  onDiscardFailed,
  failedRetryCount = 0,
}: Props) {
  const isPending = status === 'pending'
  const isFailed = status === 'failed'

  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [urlResolvedAt, setUrlResolvedAt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  // Track whether the overlay has faded out (triggers CSS transition).
  const [overlayVisible, setOverlayVisible] = useState(isPending)
  const prevPendingRef = useRef(isPending)
  // Endless-loop guard: onError may re-resolve the signed URL AT MOST once. A
  // second failure on the fresh URL is terminal ("Bild nicht verfügbar"). The
  // proactive 45-min refresh resets this so each URL window gets its own budget.
  const reResolvedOnceRef = useRef(false)

  // Force a fresh signed URL: invalidate the shared cache first so the resolve
  // returns a NEW token (a still-cached-but-broken URL would otherwise come
  // back unchanged and never trigger a reload). Used by onError + the 45-min
  // refresh timer. Component is mounted when these fire, so no cancelled-guard
  // is needed here (unlike the mount effect below).
  const reResolveSignedUrl = useCallback(async (): Promise<boolean> => {
    invalidateChatAttachmentUrl(attachment.storageBucket, attachment.storagePath)
    try {
      const resolved = await resolveChatAttachmentUrl(
        attachment.storageBucket,
        attachment.storagePath,
      )
      setSignedUrl(resolved)
      setUrlResolvedAt(Date.now())
      setLoadFailed(false)
      return true
    } catch (err) {
      logWarning('chat.image.url_resolve_failed', {
        attachmentId: attachment.id,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }, [attachment.id, attachment.storageBucket, attachment.storagePath])

  // Resolve signed URL once we have a real storagePath (not pending).
  useEffect(() => {
    if (!attachment.storagePath || isPending) return
    let cancelled = false
    void (async () => {
      try {
        const resolved = await resolveChatAttachmentUrl(
          attachment.storageBucket,
          attachment.storagePath,
        )
        if (!cancelled) {
          setSignedUrl(resolved)
          setUrlResolvedAt(Date.now())
        }
      } catch (err) {
        logWarning('chat.image.url_resolve_failed', {
          attachmentId: attachment.id,
          error: err instanceof Error ? err.message : String(err),
        })
        if (!cancelled) setLoadFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [attachment.id, attachment.storageBucket, attachment.storagePath, isPending])

  // Proactive re-resolve after 45 min (analogous to VideoMessageBubble): swap
  // the signed URL before it expires so a long-lived bubble never renders a
  // dead <img>. Resets the onError budget for the new URL window.
  useEffect(() => {
    if (isPending || isFailed) return
    if (!signedUrl || urlResolvedAt === 0) return
    const delay = Math.max(0, SIGNED_URL_TTL_MS - (Date.now() - urlResolvedAt))
    const timer = setTimeout(() => {
      reResolvedOnceRef.current = false
      void reResolveSignedUrl()
    }, delay)
    return () => clearTimeout(timer)
  }, [signedUrl, urlResolvedAt, isPending, isFailed, reResolveSignedUrl])

  // Sync overlay visibility with pending status transitions (both directions).
  // pending→non-pending: fade out. non-pending→pending (retry): restore immediately.
  // queueMicrotask avoids react-hooks/set-state-in-effect (setState-in-effect rule).
  useEffect(() => {
    const prev = prevPendingRef.current
    prevPendingRef.current = isPending
    if (prev && !isPending) {
      queueMicrotask(() => setOverlayVisible(false))
    } else if (!prev && isPending) {
      queueMicrotask(() => setOverlayVisible(true))
    }
  }, [isPending])

  const displayUrl = attachment.localBlobUrl ?? signedUrl

  const openLightbox = useCallback(() => {
    if (!displayUrl || loadFailed || isPending || isFailed) return
    setLightboxOpen(true)
  }, [displayUrl, loadFailed, isPending, isFailed])

  const closeLightbox = useCallback(() => setLightboxOpen(false), [])

  const handleTap = useCallback(() => {
    if (isFailed && isOwnBubble) {
      if (failedRetryCount >= 3 && onDiscardFailed) {
        onDiscardFailed()
      } else {
        onRetry?.()
      }
      return
    }
    openLightbox()
  }, [isFailed, isOwnBubble, failedRetryCount, onDiscardFailed, onRetry, openLightbox])

  const aspectRatio =
    attachment.width && attachment.height && attachment.width > 0
      ? `${attachment.width} / ${attachment.height}`
      : '4 / 3'

  const showTail = !isFailed

  return (
    <div className={`flex flex-col ${bubbleAlignClass(isOwnBubble)} mt-1.5`}>
      <div className="relative max-w-[78%]">
      <div
        className={`relative overflow-hidden ${bubbleRadiusClass(isOwnBubble)} ${
          isFailed
            ? isOwnBubble
              ? 'bg-rose-500'
              : 'bg-white ring-1 ring-rose-200'
            : isOwnBubble
              ? 'bg-blue-600 p-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_20px_-10px_rgba(15,23,42,0.22)]'
              : 'bg-white p-1.5 ring-1 ring-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_20px_-10px_rgba(15,23,42,0.22)]'
        }`}
        data-message-type="image"
        data-status={status}
      >
        <button
          type="button"
          onClick={handleTap}
          className={`block w-[240px] max-w-full overflow-hidden rounded-xl ${
            isFailed ? 'relative' : 'bg-slate-200/60'
          }`}
          style={{ aspectRatio }}
          aria-label={
            isFailed ? (failedRetryCount >= 3 ? 'Bild verwerfen' : 'Senden fehlgeschlagen — antippen für Wiederholung') :
            isPending ? 'Bild wird gesendet…' :
            loadFailed ? 'Bild nicht verfügbar' :
            'Bild anzeigen'
          }
        >
          {/* Image / placeholder. loadFailed wins over a still-set signedUrl so
              a resolved-but-permanently-broken URL surfaces the placeholder
              instead of a broken <img>. */}
          {loadFailed ? (
            <div className="flex h-full w-full items-center justify-center text-[12px] text-slate-500 bg-slate-100">
              Bild nicht verfügbar
            </div>
          ) : displayUrl ? (
            <img
              src={displayUrl}
              alt={caption ?? 'Bild im Chat'}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
              onError={() => {
                // A failing LOCAL blob preview is not a signed-URL problem — leave it.
                if (attachment.localBlobUrl) return
                // Exactly ONE re-resolve attempt (loop guard). A stale/expired
                // signed URL becomes valid again after cache-invalidated resolve;
                // a genuine miss falls through to "Bild nicht verfügbar".
                if (reResolvedOnceRef.current) { setLoadFailed(true); return }
                reResolvedOnceRef.current = true
                void reResolveSignedUrl().then((ok) => { if (!ok) setLoadFailed(true) })
              }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-slate-200/60">
              <Spinner size="md" tone="neutral" />
            </div>
          )}

          {/* Pending overlay — shimmer + upload spinner */}
          {(isPending || overlayVisible) ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[1px] transition-opacity duration-[160ms]"
              style={{ opacity: overlayVisible ? 1 : 0 }}
              aria-hidden
            >
              {/* Shimmer sweep */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute inset-y-0 w-[60%] animate-[fx-skeleton-sweep_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/15 to-transparent" />
              </div>
              {/* Upload progress ring */}
              <div className="relative z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/30">
                <Spinner size="md" tone="onDark" />
              </div>
            </div>
          ) : null}

          {/* Failed overlay */}
          {isFailed ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-rose-500/75">
              <RetryIcon />
              <span className="px-2 text-center text-[11px] font-semibold text-white leading-tight">
                {failedRetryCount >= 3
                  ? 'Antippen zum Verwerfen'
                  : 'Nicht gesendet\nAntippen für Wiederholung'}
              </span>
            </div>
          ) : null}
        </button>

        {caption ? (
          <div
            className={`mt-1.5 whitespace-pre-wrap px-1.5 text-[14px] leading-snug ${
              isFailed ? (isOwnBubble ? 'text-white' : 'text-rose-800') :
              isOwnBubble ? 'text-white' : 'text-slate-900'
            }`}
          >
            {caption}
          </div>
        ) : null}

        <div
          className={`mt-1 flex items-center justify-end gap-1 px-1.5 text-[10.5px] ${
            isFailed
              ? isOwnBubble ? 'text-white/60' : 'text-rose-400'
              : isOwnBubble ? 'text-white/70' : 'text-slate-400'
          }`}
        >
          <span>{formatClockTime(createdAt)}</span>
          <ChatStatusIcon status={status} isOwnBubble={isOwnBubble} variant="v5" />
        </div>
      </div>
        {showTail ? <BubbleTail side={bubbleTailSide(isOwnBubble)} tone={isOwnBubble ? 'own' : 'peer'} /> : null}
      </div>

      {lightboxOpen && displayUrl ? (
        <ImageLightbox url={displayUrl} alt={caption ?? 'Bild im Chat'} onClose={closeLightbox} />
      ) : null}
    </div>
  )
}

function ImageLightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Portal to document.body so the fullscreen lightbox escapes the chat
  // thread's scroll container (iOS WKWebView fixed-trap).
  const lightbox = (
    <div
      role="dialog"
      aria-label="Bild-Vollansicht"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4"
      onClick={onClose}
    >
      <img
        src={url}
        alt={alt}
        className="max-h-full max-w-full select-none"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Schließen"
        className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-sm transition active:scale-95"
      >
        <CloseIcon />
      </button>
    </div>
  )
  return typeof document === 'undefined' ? lightbox : createPortal(lightbox, document.body)
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function RetryIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
      <circle cx="14" cy="14" r="13" stroke="white" strokeWidth="1.5" />
      <path
        d="M20 14a6 6 0 1 1-2-4.5"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <polyline points="18,8 18,12 22,12" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function formatClockTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`
}
