/**
 * Block D Slice 3 — Voice-message bubble (v3: matches the reference
 * "Sprachnachricht · Komponente" exactly).
 *
 * Layout:  [ play/pause ][ column: waveform + draggable thumb · meta line ]
 *          vertically centered — the large play button spans the column.
 *
 *   • White bubble both sides; the brand accent (#2563EB) lives only on the
 *     play button, the played waveform bars, the scrub thumb, the elapsed-time
 *     text and the speed pill. Side is conveyed by alignment + the bottom spur.
 *   • Meta row (under the waveform): [unheard dot] [elapsed/total time]
 *     [speed pill — only while playing/scrubbed] … pushed right: [clock] [✓✓].
 *   • The waveform is a real scrubber: tap/drag/arrow-key seek.
 *   • No avatar — the reference deliberately drops it.
 *
 * Delete: the screen wraps this bubble in <LongPressBubble>. The waveform stops
 * pointer propagation so scrubbing never arms that long-press; play/speed are
 * quick taps that also stop propagation so a hold never deletes.
 *
 * Failure: a failed bubble taps to retry (onRetry). After 3 failed manual
 * retries (failedRetryCount) the tap routes to onDiscardFailed — the screen
 * wires both via handleVoiceRetry / handleVoiceDiscard → discardFailedMediaMessage.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react'
import type { ChatAttachment, ChatMessageStatus } from '../../lib/chat'
import { useVoicePlayer, type VoicePlayerSpeed } from '../../hooks/useVoicePlayer'
import { computeVoiceWaveform } from '../../lib/chat/voice/waveform'
import { VOICE_WAVEFORM_BAR_COUNT } from '../../lib/chat/voice/types'
import { resolveChatAttachmentUrl } from '../../lib/chat/voice/storageUrl'
import { bubbleAlignClass } from './chatBubbleSide'
import Spinner from '../system/Spinner'

const ACCENT = '#2563EB'
const META = '#94A3B8'
const REST_BAR = '#D3DAE6'
/** WhatsApp's three stops — a single tap cycles through them in place. */
const SPEED_CYCLE: VoicePlayerSpeed[] = [1, 1.5, 2]
/** Keyboard scrubbing step. */
const SEEK_STEP_MS = 5000

type Props = {
  attachment: ChatAttachment
  createdAt: number
  status: ChatMessageStatus
  isOwnBubble: boolean
  /** Marks the message as read on first play (peer bubble only). */
  onFirstPlay?: () => void
  /** Failed-send retry; the caller knows about the IDB-cached blob. */
  onRetry?: () => void
  /** Open the "Aufnahme verwerfen" modal (failed retries exhausted). */
  onDiscardFailed?: () => void
  /** How many retries have already failed (3+ → discard CTA). */
  failedRetryCount?: number
}

export function VoiceMessageBubble({
  attachment,
  createdAt,
  status,
  isOwnBubble,
  onFirstPlay,
  onRetry,
  onDiscardFailed,
  failedRetryCount = 0,
}: Props) {
  const player = useVoicePlayer({
    attachmentId: attachment.id,
    storageBucket: attachment.storageBucket,
    storagePath: attachment.storagePath,
    durationMs: attachment.durationMs ?? 0,
    onFirstPlay,
  })
  // Prefer the player's duration — it back-fills from audio.duration on
  // loadedmetadata when the attachment row stored none (0).
  const durationMs = player.durationMs

  const [waveform, setWaveform] = useState<number[] | null>(null)
  const [hasBeenPlayed, setHasBeenPlayed] = useState(false)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (player.isCurrentTrack && player.positionMs > 0 && !hasBeenPlayed) {
      setHasBeenPlayed(true)
    }
  }, [player.isCurrentTrack, player.positionMs, hasBeenPlayed])

  // Lazily decode the waveform on first play to avoid blocking thread render.
  useEffect(() => {
    if (waveform !== null) return
    if (!player.isCurrentTrack) return
    let cancelled = false
    const cacheKey = `${attachment.storageBucket}|${attachment.storagePath}`
    void (async () => {
      try {
        const url = await resolveChatAttachmentUrl(attachment.storageBucket, attachment.storagePath)
        const resp = await fetch(url)
        if (!resp.ok) throw new Error('fetch_failed')
        const blob = await resp.blob()
        const bars = await computeVoiceWaveform(blob, cacheKey)
        if (!cancelled) setWaveform(bars)
      } catch {
        if (!cancelled) setWaveform(flatBars())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attachment.storageBucket, attachment.storagePath, player.isCurrentTrack, waveform])

  const isPending = status === 'pending'
  const isFailed = status === 'failed'
  const isPlaying = player.isPlaying
  const isLoading = player.isLoading && !isFailed && !isPending
  // Playback (decode/renderer) error — distinct from the send-`failed` status.
  const playbackError = player.hasError && !isFailed
  const progressRatio = durationMs > 0 ? Math.min(1, player.positionMs / durationMs) : 0
  // Count up (elapsed) once scrubbed/playing, total duration when idle.
  const timeLabel = progressRatio > 0 ? formatTime(player.positionMs) : formatTime(durationMs)
  const isUnheard = !hasBeenPlayed && !isOwnBubble

  const onPlayPause = useCallback(() => {
    if (isFailed) {
      if (failedRetryCount >= 3 && onDiscardFailed) {
        onDiscardFailed()
        return
      }
      onRetry?.()
      return
    }
    void player.toggle()
  }, [isFailed, failedRetryCount, onDiscardFailed, onRetry, player])

  const cycleSpeed = useCallback(() => {
    const idx = SPEED_CYCLE.indexOf(player.rate)
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length]
    player.setRate(next)
  }, [player])

  // ── Seeking ───────────────────────────────────────────────────────────────
  const posFromClientX = useCallback(
    (clientX: number): number | null => {
      const el = trackRef.current
      if (!el || durationMs <= 0) return null
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return null
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * durationMs
    },
    [durationMs],
  )

  const onTrackPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (isFailed || isPending || durationMs <= 0) return
      // Stop the parent <LongPressBubble> from arming its delete timer mid-scrub.
      e.stopPropagation()
      const pos = posFromClientX(e.clientX)
      draggingRef.current = true
      e.currentTarget.setPointerCapture?.(e.pointerId)
      if (!player.isCurrentTrack) {
        void player.play().then(() => {
          if (pos !== null) player.seek(pos)
        })
      } else if (pos !== null) {
        player.seek(pos)
      }
    },
    [isFailed, isPending, durationMs, posFromClientX, player],
  )

  const onTrackPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      const pos = posFromClientX(e.clientX)
      if (pos !== null) player.seek(pos)
    },
    [posFromClientX, player],
  )

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  const onTrackKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (isFailed || isPending || durationMs <= 0) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const base = player.isCurrentTrack ? player.positionMs : 0
      const delta = e.key === 'ArrowRight' ? SEEK_STEP_MS : -SEEK_STEP_MS
      const target = Math.max(0, Math.min(durationMs, base + delta))
      if (player.isCurrentTrack) {
        player.seek(target)
      } else {
        void player.play().then(() => player.seek(target))
      }
    },
    [isFailed, isPending, durationMs, player],
  )

  const bars = useMemo(() => waveform ?? flatBars(), [waveform])
  const playedIdx = Math.round(bars.length * progressRatio)
  const speedActive = player.rate !== 1
  const showSpeed = (isPlaying || progressRatio > 0) && !isFailed && !isPending

  // Bubble shell — white in the normal/pending state, rose when failed.
  const bubbleBg = isFailed ? (isOwnBubble ? '#F43F5E' : '#FFF1F2') : '#FFFFFF'
  const bubbleColor = isFailed ? (isOwnBubble ? '#FFFFFF' : '#9F1239') : '#1F2937'
  const playBg = isFailed ? (isOwnBubble ? 'rgba(255,255,255,0.2)' : '#FFE4E6') : ACCENT
  const playFg = isFailed ? (isOwnBubble ? '#FFFFFF' : '#BE123C') : '#FFFFFF'

  return (
    <div className={`flex flex-col ${bubbleAlignClass(isOwnBubble)} mt-1.5`}>
      <div
        className="relative flex items-center"
        style={{
          background: bubbleBg,
          color: bubbleColor,
          border: isFailed && !isOwnBubble ? '1px solid #FECDD3' : isFailed ? 'none' : '1px solid #E6E8EE',
          boxShadow: isFailed ? 'none' : '0 1px 2px rgba(15,23,42,0.06), 0 8px 20px -10px rgba(15,23,42,0.22)',
          borderRadius: 20,
          ...(isOwnBubble ? { borderBottomRightRadius: 0 } : { borderBottomLeftRadius: 0 }),
          padding: '9px 14px',
          width: '78%',
          maxWidth: 360,
          gap: 12,
          opacity: isPending ? 0.9 : 1,
        }}
        data-message-type="voice"
        data-status={status}
      >
        {/* bottom spur */}
        {!isFailed ? (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              bottom: 0,
              width: 12,
              height: 13,
              background: bubbleBg,
              ...(isOwnBubble
                ? { right: -5, clipPath: 'polygon(0 0, 0 100%, 100% 100%)' }
                : { left: -5, clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }),
            }}
          />
        ) : null}

        {/* Play / pause */}
        <button
          type="button"
          onClick={onPlayPause}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={
            isFailed
              ? failedRetryCount >= 3
                ? 'Sprachnachricht verwerfen'
                : 'Erneut senden'
              : playbackError
                ? 'Erneut abspielen'
                : isPlaying
                  ? 'Pause'
                  : 'Abspielen'
          }
          style={{
            flexShrink: 0,
            width: 46,
            height: 46,
            padding: 0,
            border: 'none',
            cursor: 'pointer',
            borderRadius: '50%',
            background: playBg,
            color: playFg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: isFailed ? 'none' : `0 4px 12px -3px ${ACCENT}80`,
          }}
          className="transition active:scale-95"
        >
          {isFailed ? (
            <RetryIcon />
          ) : isPending || isLoading ? (
            <Spinner size="sm" tone="onDark" />
          ) : isPlaying ? (
            <PauseIcon />
          ) : (
            <PlayIcon />
          )}
        </button>

        {/* Waveform + meta — a column, vertically centered next to the play button */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Waveform scrubber */}
          <div
            ref={trackRef}
            role="slider"
            tabIndex={isFailed || isPending || durationMs <= 0 ? -1 : 0}
            aria-disabled={isFailed || isPending || durationMs <= 0 || undefined}
            aria-label="Audio-Position"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, Math.round(durationMs))}
            aria-valuenow={Math.round(player.isCurrentTrack ? player.positionMs : 0)}
            aria-valuetext={formatTime(player.isCurrentTrack ? player.positionMs : 0)}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onTrackKeyDown}
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: 2.5,
              height: 28,
              cursor: isFailed || isPending ? 'default' : 'pointer',
              touchAction: 'none',
            }}
          >
            {bars.map((value, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  minWidth: 2.5,
                  height: Math.max(4, Math.round(value * 26 + 3)),
                  borderRadius: 3,
                  background: i < playedIdx ? ACCENT : REST_BAR,
                  transition: draggingRef.current || isPlaying ? 'none' : 'background .1s ease',
                }}
              />
            ))}
            {durationMs > 0 && !isFailed ? (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: `calc(${progressRatio * 100}% - 7px)`,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: '#fff',
                  border: `3px solid ${ACCENT}`,
                  transform: 'translateY(-50%)',
                  boxShadow: '0 1px 3px rgba(15,23,42,0.25)',
                  pointerEvents: 'none',
                }}
              />
            ) : null}
          </div>

          {/* Meta — time · speed · clock, just below the waveform */}
          {isFailed ? (
            <div style={{ fontSize: 11.5, color: isOwnBubble ? 'rgba(255,255,255,0.85)' : '#E11D48' }}>
              {failedRetryCount >= 3
                ? 'Mehrfach fehlgeschlagen — antippen, um zu verwerfen'
                : 'Senden fehlgeschlagen — antippen für Wiederholung'}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              {isUnheard ? (
                <span
                  aria-label="Sprachnachricht ungehört"
                  style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT, flexShrink: 0 }}
                />
              ) : null}
              <span
                style={{
                  color: progressRatio > 0 || isUnheard ? ACCENT : META,
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 600,
                }}
              >
                {timeLabel}
              </span>
              {playbackError ? (
                <span style={{ color: '#E11D48', fontWeight: 600 }}>· nicht abspielbar, erneut tippen</span>
              ) : null}
              {showSpeed && !playbackError ? (
                <button
                  type="button"
                  onClick={cycleSpeed}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label="Wiedergabe-Geschwindigkeit"
                  style={{
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: speedActive ? ACCENT : '#EEF1F6',
                    color: speedActive ? '#fff' : '#64748B',
                    fontSize: 10.5,
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1.5,
                    letterSpacing: 0.2,
                  }}
                >
                  {speedLabel(player.rate)}
                </button>
              ) : null}
              <span
                style={{
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  color: META,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span>{formatClockTime(createdAt)}</span>
                {isOwnBubble ? <StatusGlyph status={status} /> : null}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function flatBars(): number[] {
  return new Array<number>(VOICE_WAVEFORM_BAR_COUNT).fill(0.4)
}

function speedLabel(rate: VoicePlayerSpeed): string {
  return rate === 1 ? '1×' : rate === 1.5 ? '1,5×' : rate === 2 ? '2×' : `${rate}×`
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? `0${s}` : s}`
}

function formatClockTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`
}

/** Read-receipt glyph for own voice bubbles, on the white bubble palette. */
function StatusGlyph({ status }: { status: ChatMessageStatus }) {
  if (status === 'pending') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6.25" stroke={META} strokeWidth="1.4" />
        <path d="M8 4.6V8l2.4 1.6" stroke={META} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  if (status === 'failed') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M4.4 4.4 11.6 11.6 M11.6 4.4 4.4 11.6" stroke="#F43F5E" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  if (status === 'sent') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M3.4 8.4 6.4 11.4 12.6 5.2" stroke={META} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  const c = status === 'read' ? '#22D3EE' : META
  return (
    <svg width="16" height="12" viewBox="0 0 20 14" fill="none" aria-hidden>
      <path d="M1.6 7.4 4.4 10.2 9.8 4.6" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.6 7.4 10.4 10.2 18.4 1.8" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="15" height="16" viewBox="0 0 13 15" fill="currentColor" style={{ marginLeft: 2 }} aria-hidden>
      <path d="M0 0v15l13-7.5L0 0Z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="14" height="15" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <rect x="2" y="1" width="3.6" height="12" rx="1.2" />
      <rect x="8.4" y="1" width="3.6" height="12" rx="1.2" />
    </svg>
  )
}

function RetryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6h-3.5M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13.5V10h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
