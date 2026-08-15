import { useCallback, useEffect, useState } from 'react'
import { logWarning } from '../lib/observability'
import { resolveChatAttachmentUrl } from '../lib/chat/voice/storageUrl'

/**
 * Block D Slice 3 — Voice-note playback hook.
 *
 * Single shared HTMLAudioElement so playing one voice bubble automatically
 * pauses any other voice bubble currently playing in the same view. The
 * player is module-scoped, not React-scoped, so it survives prop reflows in
 * the chat stream.
 *
 * Robustness (iOS WKWebView): the audio renderer's connection to the system
 * audio server can drop ("AudioComponentRegistrar was invalidated"), typically
 * right after a record session contends for the audio session. To keep
 * play/stop/seek always clean we:
 *   • mirror the REAL element state via play/pause/playing/waiting listeners
 *     (so a system pause — call, route change — is reflected, not stuck);
 *   • expose an explicit `isLoading` between tap and first audio (no frozen UI);
 *   • surface `hasError` and, on a failed play(), recreate the element + retry
 *     once (re-establishes the dropped renderer connection);
 *   • buffer a seek issued before metadata is ready and apply it on load.
 *
 * Speed: 1× default. The UI cycles 1×/1.5×/2× in place; the player accepts 0.5×
 * via {@link setRate} (kept capable, just not surfaced in the bubble UI).
 *
 * Signed URLs are cached per attachment for the session (60-min TTL).
 */

export type VoicePlayerSpeed = 0.5 | 1 | 1.5 | 2

interface PlayerSnapshot {
  attachmentId: string | null
  isPlaying: boolean
  isLoading: boolean
  positionMs: number
  durationMs: number
  rate: VoicePlayerSpeed
  hasError: boolean
}

const SUPPORTED_SPEEDS: readonly VoicePlayerSpeed[] = [0.5, 1, 1.5, 2]

/** Exported for unit testing the transport state machine. App code uses the
 *  module singleton via {@link useVoicePlayer}. */
export class VoicePlayer {
  private audio: HTMLAudioElement | null = null
  private currentId: string | null = null
  private currentUrl: string | null = null
  private currentDurationMs = 0
  private positionMs = 0
  private rate: VoicePlayerSpeed = 1
  private hasError = false
  private loading = false
  // True between a play() intent and an explicit pause/stop. Lets a pause issued
  // while play() is still awaiting the signed URL cancel the in-flight start
  // instead of the audio springing to life after the user already paused.
  private wantPlaying = false
  private pendingSeekMs: number | null = null
  private listeners = new Set<() => void>()
  private firstPlayMarked = new Set<string>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): PlayerSnapshot {
    return {
      attachmentId: this.currentId,
      isPlaying: this.audio ? !this.audio.paused && !this.audio.ended : false,
      isLoading: this.loading,
      positionMs: this.positionMs,
      durationMs: this.currentDurationMs,
      rate: this.rate,
      hasError: this.hasError,
    }
  }

  setRate(rate: VoicePlayerSpeed): void {
    if (!SUPPORTED_SPEEDS.includes(rate)) return
    this.rate = rate
    if (this.audio) this.audio.playbackRate = rate
    this.emit()
  }

  // Create the shared element + wire listeners once. Returns the live element.
  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio
    const audio = new Audio()
    audio.preload = 'auto'
    audio.addEventListener('timeupdate', () => {
      if (!this.audio) return
      this.positionMs = Math.round(this.audio.currentTime * 1000)
      this.emit()
    })
    audio.addEventListener('loadedmetadata', () => {
      if (!this.audio) return
      const d = this.audio.duration
      if (this.currentDurationMs <= 0 && Number.isFinite(d) && d > 0) {
        this.currentDurationMs = Math.round(d * 1000)
      }
      this.applyPendingSeek()
      this.emit()
    })
    audio.addEventListener('canplay', () => {
      this.applyPendingSeek()
      this.emit()
    })
    // Reflect the REAL transport state — including system-driven pauses
    // (incoming call, route change, the renderer dropping) so the UI never
    // sticks on "playing" while audio is actually stopped.
    audio.addEventListener('play', () => {
      this.emit()
    })
    audio.addEventListener('playing', () => {
      this.loading = false
      this.emit()
    })
    audio.addEventListener('waiting', () => {
      this.loading = true
      this.emit()
    })
    audio.addEventListener('pause', () => {
      this.loading = false
      this.emit()
    })
    audio.addEventListener('ended', () => {
      // Reset to a clean idle state so the bubble reverts to play-icon + full
      // duration + unfilled waveform, instead of staying the current track.
      this.stopInternal()
      this.emit()
    })
    audio.addEventListener('error', () => {
      this.hasError = true
      this.loading = false
      logWarning('voice.player.element_error', {
        code: this.audio?.error?.code ?? null,
      })
      this.emit()
    })
    this.audio = audio
    return audio
  }

  private applyPendingSeek(): void {
    if (this.pendingSeekMs === null || !this.audio) return
    try {
      this.audio.currentTime = this.pendingSeekMs / 1000
      this.positionMs = this.pendingSeekMs
    } catch {
      // ignore — element not seekable yet; a later canplay will retry
      return
    }
    this.pendingSeekMs = null
  }

  // Tear down a wedged element so the next play() builds a fresh renderer
  // connection (the WKWebView "AudioComponentRegistrar invalidated" recovery).
  private recreateAudio(): void {
    if (this.audio) {
      try {
        this.audio.pause()
      } catch {
        // ignore
      }
      this.audio.removeAttribute('src')
      this.audio = null
    }
    this.currentUrl = null
  }

  async play(
    attachmentId: string,
    storageBucket: string,
    storagePath: string,
    durationMs: number,
    onFirstPlay?: () => void,
  ): Promise<void> {
    this.hasError = false
    const switching = this.currentId !== attachmentId
    if (switching) {
      this.stopInternal()
      this.currentId = attachmentId
      this.currentDurationMs = durationMs
      this.positionMs = 0
    }
    this.loading = true
    this.wantPlaying = true
    this.emit()

    // If the user taps a different bubble while we await the signed URL / play()
    // resolution, currentId advances — bail rather than pre-empt the newer track.
    const requestId = attachmentId
    try {
      const url = await resolveChatAttachmentUrl(storageBucket, storagePath)
      if (this.currentId !== requestId) return
      // Paused (or switched) during the URL await — abandon the start.
      if (!this.wantPlaying) {
        this.loading = false
        this.emit()
        return
      }

      let audio = this.ensureAudio()
      if (switching || this.currentUrl !== url || audio.src !== url) {
        audio.src = url
        this.currentUrl = url
        audio.load()
      }
      audio.playbackRate = this.rate

      try {
        await audio.play()
      } catch (firstErr) {
        if (this.currentId !== requestId) return
        // One-shot recovery: a dropped audio-renderer connection (common in the
        // WKWebView after a record session) rejects the first play(); a fresh
        // element usually reconnects.
        logWarning('voice.player.play_retry', {
          error: firstErr instanceof Error ? firstErr.message : String(firstErr),
        })
        this.recreateAudio()
        audio = this.ensureAudio()
        audio.src = url
        this.currentUrl = url
        audio.load()
        audio.playbackRate = this.rate
        await audio.play()
      }

      if (this.currentId !== requestId) return
      // Paused during the play() promise — honour it rather than play on.
      if (!this.wantPlaying) {
        audio.pause()
        this.loading = false
        this.emit()
        return
      }
      this.loading = false
      if (onFirstPlay && !this.firstPlayMarked.has(requestId)) {
        this.firstPlayMarked.add(requestId)
        try {
          onFirstPlay()
        } catch (err) {
          logWarning('voice.player.first_play_callback_failed', { error: String(err) })
        }
      }
      this.emit()
    } catch (err) {
      if (this.currentId === requestId) {
        this.hasError = true
        this.loading = false
        this.emit()
      }
      logWarning('voice.player.play_failed', {
        attachmentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  pause(attachmentId: string): void {
    if (this.currentId !== attachmentId) return
    this.wantPlaying = false
    this.loading = false
    if (this.audio) this.audio.pause()
    this.emit()
  }

  seek(attachmentId: string, positionMs: number): void {
    if (this.currentId !== attachmentId) return
    const clamped = Math.max(0, Math.min(this.currentDurationMs || positionMs, positionMs))
    this.positionMs = clamped
    if (this.audio && this.audio.readyState >= 1 /* HAVE_METADATA */) {
      try {
        this.audio.currentTime = clamped / 1000
        this.pendingSeekMs = null
      } catch {
        this.pendingSeekMs = clamped
      }
    } else {
      // Element not ready (just started / not current track yet) — apply on load.
      this.pendingSeekMs = clamped
    }
    this.emit()
  }

  stop(attachmentId: string): void {
    if (this.currentId !== attachmentId) return
    this.stopInternal()
    this.emit()
  }

  /** Called when the chat thread / app navigates away; releases audio resources. */
  release(): void {
    this.stopInternal()
    if (this.audio) {
      this.audio.removeAttribute('src')
      this.audio = null
    }
    this.currentUrl = null
    this.emit()
  }

  private stopInternal(): void {
    if (this.audio) {
      this.audio.pause()
      try {
        this.audio.currentTime = 0
      } catch {
        // ignore
      }
    }
    this.currentId = null
    this.currentDurationMs = 0
    this.positionMs = 0
    this.loading = false
    this.wantPlaying = false
    this.pendingSeekMs = null
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // ignore listener errors
      }
    }
  }
}

const player = new VoicePlayer()

export interface UseVoicePlayerArgs {
  attachmentId: string
  storageBucket: string
  storagePath: string
  durationMs: number
  onFirstPlay?: () => void
}

export interface UseVoicePlayerResult {
  isPlaying: boolean
  isLoading: boolean
  isCurrentTrack: boolean
  positionMs: number
  durationMs: number
  rate: VoicePlayerSpeed
  hasError: boolean
  play: () => Promise<void>
  pause: () => void
  toggle: () => Promise<void>
  seek: (positionMs: number) => void
  setRate: (rate: VoicePlayerSpeed) => void
}

export function useVoicePlayer(args: UseVoicePlayerArgs): UseVoicePlayerResult {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => player.snapshot())

  useEffect(() => {
    return player.subscribe(() => setSnapshot(player.snapshot()))
  }, [])

  const isCurrentTrack = snapshot.attachmentId === args.attachmentId

  const play = useCallback(() => {
    return player.play(args.attachmentId, args.storageBucket, args.storagePath, args.durationMs, args.onFirstPlay)
  }, [args.attachmentId, args.storageBucket, args.storagePath, args.durationMs, args.onFirstPlay])

  const pause = useCallback(() => {
    player.pause(args.attachmentId)
  }, [args.attachmentId])

  const toggle = useCallback(async () => {
    // Pause if this track is currently playing or mid-load; otherwise (re)play.
    if (isCurrentTrack && (snapshot.isPlaying || snapshot.isLoading)) {
      player.pause(args.attachmentId)
      return
    }
    await play()
  }, [isCurrentTrack, snapshot.isPlaying, snapshot.isLoading, args.attachmentId, play])

  const seek = useCallback(
    (positionMs: number) => {
      player.seek(args.attachmentId, positionMs)
    },
    [args.attachmentId],
  )

  const setRate = useCallback((rate: VoicePlayerSpeed) => {
    player.setRate(rate)
  }, [])

  return {
    isPlaying: isCurrentTrack && snapshot.isPlaying,
    isLoading: isCurrentTrack && snapshot.isLoading,
    isCurrentTrack,
    positionMs: isCurrentTrack ? snapshot.positionMs : 0,
    durationMs: isCurrentTrack && snapshot.durationMs > 0 ? snapshot.durationMs : args.durationMs,
    rate: snapshot.rate,
    hasError: isCurrentTrack && snapshot.hasError,
    play,
    pause,
    toggle,
    seek,
    setRate,
  }
}

export function releaseVoicePlayer(): void {
  player.release()
}
