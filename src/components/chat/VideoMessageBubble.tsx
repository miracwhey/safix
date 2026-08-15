/**
 * Block D Slice 4 — Video-message bubble.
 *
 * Pending:  shows poster thumbnail immediately (localBlobUrl) + progress ring.
 * Sent:     inline player — play/pause overlay, muted autoplay on scroll into
 *           view, full-screen on tap, duration badge.
 * Failed:   rose overlay + retry / discard (≥3 retries).
 * HEVC decode error: fallback CTA "Im Browser öffnen".
 *
 * Progress ring: driven by `uploadProgress` prop (0–100, live from workflow
 * onProgress callback). Indeterminate ring when progress is unknown.
 *
 * Signed-URL strategy: resolved on mount for the sent state. Re-resolved on
 * every play-tap if > 45 minutes have elapsed since the last resolve, to
 * avoid starting playback with an expired URL.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachment, ChatMessageStatus } from '../../lib/chat'
import { resolveChatAttachmentUrl } from '../../lib/chat/voice/storageUrl'
import { noopMediaProcessingAdapter } from '../../lib/chat/media/mediaProcessingAdapter'
import { openExternal } from '../../lib/platform'
import { logWarning } from '../../lib/observability'
import { ChatStatusIcon } from './ChatStatusIcon'
import { BubbleTail } from './BubbleTail'
import { bubbleAlignClass, bubbleRadiusClass, bubbleTailSide } from './chatBubbleSide'
import Spinner from '../system/Spinner'

const SIGNED_URL_TTL_MS = 45 * 60 * 1000

type Props = {
  attachment: ChatAttachment
  caption?: string | null
  createdAt: number
  status: ChatMessageStatus
  isOwnBubble: boolean
  /** 0–100 during upload; undefined = not uploading. */
  uploadProgress?: number
  onRetry?: () => void
  onDiscardFailed?: () => void
  failedRetryCount?: number
}

export function VideoMessageBubble({
  attachment,
  caption,
  createdAt,
  status,
  isOwnBubble,
  uploadProgress,
  onRetry,
  onDiscardFailed,
  failedRetryCount = 0,
}: Props) {
  const isPending = status === 'pending'
  const isFailed = status === 'failed'

  const [signedVideoUrl, setSignedVideoUrl] = useState<string | null>(null)
  const [signedPosterUrl, setSignedPosterUrl] = useState<string | null>(null)
  const [urlResolvedAt, setUrlResolvedAt] = useState<number>(0)
  const [playing, setPlaying] = useState(false)
  const [decodeError, setDecodeError] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(isPending)
  const prevPendingRef = useRef(isPending)
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Resolve signed storage URLs once path is available.
  // If h264Url / posterUrl (CDN) are set, signed-URL resolution is skipped
  // for that field — CDN URLs need no signing. V1: both always null.
  useEffect(() => {
    if (!attachment.storagePath || isPending) return
    let cancelled = false
    void (async () => {
      try {
        const [rawVideoUrl, rawPosterUrl] = await Promise.all([
          attachment.h264Url
            ? Promise.resolve(attachment.h264Url)
            : resolveChatAttachmentUrl(attachment.storageBucket, attachment.storagePath),
          attachment.posterUrl
            ? Promise.resolve(attachment.posterUrl)
            : attachment.posterStoragePath
              ? resolveChatAttachmentUrl(attachment.storageBucket, attachment.posterStoragePath)
              : Promise.resolve(null),
        ])
        if (!cancelled) {
          setSignedVideoUrl(noopMediaProcessingAdapter.getPlaybackUrl(attachment.h264Url, rawVideoUrl))
          setSignedPosterUrl(noopMediaProcessingAdapter.getPosterUrl(attachment.posterUrl, rawPosterUrl))
          setUrlResolvedAt(Date.now())
        }
      } catch (err) {
        logWarning('chat.video.url_resolve_failed', {
          attachmentId: attachment.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => { cancelled = true }
  }, [attachment.id, attachment.storageBucket, attachment.storagePath, attachment.posterStoragePath, attachment.h264Url, attachment.posterUrl, isPending])

  // Pending → sent: fade out overlay. Non-pending → pending (retry): restore immediately.
  useEffect(() => {
    const prev = prevPendingRef.current
    prevPendingRef.current = isPending
    if (prev && !isPending) {
      queueMicrotask(() => setOverlayVisible(false))
    } else if (!prev && isPending) {
      queueMicrotask(() => setOverlayVisible(true))
    }
  }, [isPending])

  // Muted autoplay via IntersectionObserver.
  // `playing` is intentionally excluded from deps: the observer controls the
  // video element directly and syncs React state via setPlaying — re-registering
  // on every play/pause would cause observer churn and stale-closure issues.
  useEffect(() => {
    const video = videoRef.current
    if (!video || isPending || isFailed) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.muted = true
          video.play().then(() => setPlaying(true)).catch(() => undefined)
        } else {
          video.pause()
          setPlaying(false)
        }
      },
      { threshold: 0.5 },
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [isPending, isFailed])

  // Release the media element on unmount. Playback can be UNMUTED (manual tap
  // sets video.muted=false in resolveAndPlay) and the IntersectionObserver
  // cleanup only disconnects — it does not pause — so a thread unmount mid-play
  // would otherwise leave the removed <video> holding the iOS WKWebView audio
  // session (sound trails, next clip blocked). Keyed on hasVideo (a boolean) so
  // it captures the element once it mounts and fires ONLY on unmount, never on a
  // stale-URL re-resolve that keeps signedVideoUrl truthy and re-points src.
  const hasVideo = !isPending && !isFailed && Boolean(signedVideoUrl)
  useEffect(() => {
    if (!hasVideo) return
    const video = videoRef.current
    if (!video) return
    return () => {
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        // element already torn down — nothing to release
      }
    }
  }, [hasVideo])

  const resolveAndPlay = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    // Re-resolve if URL is stale (> 45 min). h264Url (CDN) never expires.
    let url = signedVideoUrl
    if (!url || (!attachment.h264Url && Date.now() - urlResolvedAt > SIGNED_URL_TTL_MS)) {
      try {
        const freshStorageUrl = await resolveChatAttachmentUrl(attachment.storageBucket, attachment.storagePath)
        url = noopMediaProcessingAdapter.getPlaybackUrl(attachment.h264Url, freshStorageUrl)
        setSignedVideoUrl(url)
        setUrlResolvedAt(Date.now())
      } catch {
        return
      }
    }
    if (video.src !== url) video.src = url
    if (playing) {
      video.pause()
      setPlaying(false)
    } else {
      video.muted = false
      video.play().catch(() => { video.muted = true; void video.play().catch(() => undefined) })
      setPlaying(true)
    }
  }, [signedVideoUrl, urlResolvedAt, playing, attachment.storageBucket, attachment.storagePath, attachment.h264Url])

  const requestFullScreen = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.requestFullscreen) { void video.requestFullscreen() }
    else if ((video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen) {
      ;(video as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen()
    }
  }, [])

  const handleTap = useCallback(() => {
    if (isFailed && isOwnBubble) {
      if (failedRetryCount >= 3 && onDiscardFailed) {
        onDiscardFailed()
      } else {
        onRetry?.()
      }
      return
    }
    if (isPending || decodeError) return
    if (playing) {
      requestFullScreen()
    } else {
      void resolveAndPlay()
    }
  }, [isFailed, isOwnBubble, failedRetryCount, onDiscardFailed, onRetry, isPending, decodeError, playing, requestFullScreen, resolveAndPlay])

  const displayPosterUrl = attachment.localBlobUrl ?? signedPosterUrl ?? undefined
  const durationLabel = formatDuration(attachment.durationMs ?? 0)

  const aspectRatio =
    attachment.width && attachment.height && attachment.width > 0
      ? `${attachment.width} / ${attachment.height}`
      : '16 / 9'

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
        ref={containerRef}
        data-message-type="video"
        data-status={status}
      >
        <button
          type="button"
          onClick={handleTap}
          className={`relative block w-[240px] max-w-full overflow-hidden rounded-xl bg-slate-900`}
          style={{ aspectRatio }}
          aria-label={
            isFailed
              ? 'Senden fehlgeschlagen — antippen für Wiederholung'
              : isPending
                ? 'Video wird gesendet…'
                : decodeError
                  ? 'Video kann nicht abgespielt werden'
                  : playing
                    ? 'Video im Vollbild öffnen'
                    : 'Video abspielen'
          }
        >
          {/* Poster / first-frame thumbnail */}
          {displayPosterUrl ? (
            <img
              src={displayPosterUrl}
              alt=""
              className="h-full w-full object-cover"
              aria-hidden
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-slate-800">
              <VideoPlaceholderIcon />
            </div>
          )}

          {/* Video element — hidden until playing; avoids layout shift */}
          {!isPending && !isFailed && signedVideoUrl ? (
            <video
              ref={videoRef}
              // No generated poster (iOS WKWebView can't probe .mov/HEVC client-
              // side, so posterStoragePath is usually empty) → render the video's
              // OWN first frame as the thumbnail instead of a grey placeholder.
              // The #t fragment forces iOS to paint a frame; preload=metadata
              // loads just enough for it. With a real poster we stay lazy.
              src={displayPosterUrl ? signedVideoUrl : `${signedVideoUrl}#t=0.1`}
              poster={signedPosterUrl ?? undefined}
              playsInline
              muted
              preload={displayPosterUrl ? 'none' : 'metadata'}
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
                playing
                  ? 'opacity-100'
                  : displayPosterUrl
                    ? 'opacity-0 pointer-events-none'
                    : 'opacity-100 pointer-events-none'
              }`}
              onEnded={() => setPlaying(false)}
              onError={() => {
                // MediaError.MEDIA_ERR_DECODE = 3 — codec not supported
                const code = videoRef.current?.error?.code
                if (code === 3 || code === 4) setDecodeError(true)
                setPlaying(false)
              }}
            />
          ) : null}

          {/* Duration badge — bottom left */}
          {!isFailed && durationLabel ? (
            <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
              {durationLabel}
            </span>
          ) : null}

          {/* Pending overlay — progress ring + shimmer */}
          {(isPending || overlayVisible) ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-[1px] transition-opacity duration-[160ms]"
              style={{ opacity: overlayVisible ? 1 : 0 }}
              aria-hidden
            >
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute inset-y-0 w-[60%] animate-[fx-skeleton-sweep_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/15 to-transparent" />
              </div>
              <ProgressRing progress={uploadProgress} />
            </div>
          ) : null}

          {/* Sent — play/pause overlay when not auto-playing */}
          {!isPending && !isFailed && !playing && !decodeError ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20" aria-hidden>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45">
                <PlayIcon />
              </div>
            </div>
          ) : null}

          {/* HEVC / decode error fallback */}
          {decodeError ? (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-3"
              onClick={async (e) => {
                e.stopPropagation()
                if (signedVideoUrl) await openExternal(signedVideoUrl, 'tab').catch(() => undefined)
              }}
            >
              <span className="text-[12px] text-white/80 text-center leading-tight">
                Kann hier nicht abgespielt werden
              </span>
              <span className="rounded-full bg-white/20 px-3 py-1 text-[12px] font-medium text-white">
                Im Browser öffnen
              </span>
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
    </div>
  )
}

// ── Progress ring ─────────────────────────────────────────────────────────

function ProgressRing({ progress }: { progress?: number }) {
  const radius = 22
  const stroke = 3
  const circumference = 2 * Math.PI * radius
  const known = typeof progress === 'number' && progress >= 0

  if (!known) {
    // Indeterminate — spinning arc
    return (
      <div className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-black/30">
        <Spinner size="md" tone="onDark" />
      </div>
    )
  }

  const offset = circumference - (progress / 100) * circumference

  return (
    <div className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-black/30">
      <svg
        width={radius * 2 + stroke * 2}
        height={radius * 2 + stroke * 2}
        className="absolute -rotate-90"
        aria-hidden
      >
        {/* Track */}
        <circle
          cx={radius + stroke}
          cy={radius + stroke}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={stroke}
        />
        {/* Fill */}
        <circle
          cx={radius + stroke}
          cy={radius + stroke}
          r={radius}
          fill="none"
          stroke="white"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 200ms linear' }}
        />
      </svg>
      <span className="text-[11px] font-semibold tabular-nums text-white">
        {progress}%
      </span>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s < 10 ? `0${s}` : s}`
}

function formatClockTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`
}

// ── Icons ─────────────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M6 4.5l10 5.5-10 5.5V4.5Z" fill="white" />
    </svg>
  )
}

function VideoPlaceholderIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14.5 8.5L19 6v12l-4.5-2.5M3 7h11.5v10H3z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity="0.5"
      />
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
