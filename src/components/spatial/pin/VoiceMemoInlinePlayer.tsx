/**
 * Spatial Core · Block F.3 · Voice-Memo Inline Player
 *
 * Inline player surfaced inside the Pin-Detail Sheet timeline. Reuses the
 * existing chat-voice signed-URL cache (`resolveChatAttachmentUrl`) so
 * the same playback path the chat surface uses is shared with the pin
 * timeline — no duplicate Storage round-trips on screens that show both.
 *
 * Visual minimal-viable: progress bar, play/pause, elapsed/duration label.
 * Waveform-decode is deferred to Block G or a V1.5 polish pass — getting
 * pin-attached voice memos into V1 ship-shape matters more than the bars.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveChatAttachmentUrl } from '../../../lib/chat/voice/storageUrl'

export interface VoiceMemoInlinePlayerProps {
  bucket: string
  storagePath: string
  /** Optional pre-known duration in seconds for the progress bar before
   *  the audio element loads. */
  durationHintSec?: number
}

export function VoiceMemoInlinePlayer(props: VoiceMemoInlinePlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTimeSec, setCurrentTimeSec] = useState(0)
  const [durationSec, setDurationSec] = useState(props.durationHintSec ?? 0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void resolveChatAttachmentUrl(props.bucket, props.storagePath)
      .then(url => {
        if (alive) setSignedUrl(url)
      })
      .catch(err => {
        if (alive) setError(err instanceof Error ? err.message : 'Sound nicht ladbar')
      })
    return () => {
      alive = false
    }
  }, [props.bucket, props.storagePath])

  const onPlayPause = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      void el.play()
    } else {
      el.pause()
    }
  }, [])

  if (error) {
    return (
      <p className="text-xs text-rose-600">Audio konnte nicht geladen werden.</p>
    )
  }

  if (!signedUrl) {
    return <div className="h-8 w-full animate-pulse rounded bg-neutral-100" />
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-2">
      <button
        type="button"
        aria-label={isPlaying ? 'Pause' : 'Wiedergabe'}
        onClick={onPlayPause}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700"
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>
      <div className="flex flex-1 flex-col gap-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{
              width:
                durationSec > 0
                  ? `${Math.min(100, (currentTimeSec / durationSec) * 100)}%`
                  : '0%',
            }}
          />
        </div>
        <p className="text-[10px] tabular-nums text-neutral-500">
          {formatTime(currentTimeSec)} / {formatTime(durationSec)}
        </p>
      </div>
      <audio
        ref={audioRef}
        src={signedUrl}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={e => setCurrentTimeSec((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={e => {
          const next = (e.target as HTMLAudioElement).duration
          if (Number.isFinite(next)) setDurationSec(next)
        }}
      />
    </div>
  )
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}
