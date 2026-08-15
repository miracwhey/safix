import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceRecorder } from '@independo/capacitor-voice-recorder'
import { logError, logWarning } from '../lib/observability'
import {
  VOICE_MAX_DURATION_MS,
  VOICE_WARN_BEFORE_MS,
  VOICE_WAVEFORM_BAR_COUNT,
  type VoiceRecorderError,
  type VoiceRecorderState,
  type VoiceRecording,
} from '../lib/chat/voice/types'

/**
 * Block D Slice 3 — Voice-recorder hook.
 *
 * Encapsulates the @independo/capacitor-voice-recorder lifecycle behind a
 * deterministic state machine driven by composer pointer events.
 *
 * Plugin exposes NO live amplitude callback; the `liveBars` array animates
 * with a smoothed pseudo-random walk for visual feedback only. The persisted
 * waveform (used in the played-back bubble) is computed lazily on first play
 * from the audio blob — see `lib/chat/voice/waveform.ts`.
 *
 * State transitions:
 *
 *   idle
 *     ── start() ──▶ requesting-permission ──(granted)──▶ recording
 *                                          │
 *                                          └─(denied)──▶ idle + error
 *
 *   recording
 *     ── updateDrag(dx < -CANCEL_PX) ──▶ cancel-armed
 *     ── updateDrag(dy < -LOCK_PX)  ──▶ lock-armed
 *     ── release()                  ──▶ stopping ──▶ idle (with recording)
 *     ── 5-min auto-stop            ──▶ stopping ──▶ idle (with recording)
 *
 *   cancel-armed
 *     ── release() ──▶ idle (blob discarded)
 *
 *   lock-armed
 *     ── release() ──▶ locked
 *
 *   locked
 *     ── sendFromLocked()    ──▶ stopping ──▶ idle (with recording)
 *     ── discardFromLocked() ──▶ idle (blob discarded)
 *
 *   * (any non-idle)
 *     ── app backgrounded ──▶ locked (preserves the take for foreground-return)
 */

/** Intent captured on pointer-release while start() is still in flight. */
type PendingGesture = 'none' | 'stop' | 'lock'

const CANCEL_THRESHOLD_PX = 80
const LOCK_THRESHOLD_PX = 80
const LIVE_BAR_TICK_MS = 90

interface UseVoiceRecorderResult {
  state: VoiceRecorderState
  elapsedMs: number
  liveBars: number[]
  warningVisible: boolean
  error: VoiceRecorderError | null
  recording: VoiceRecording | null
  start: () => Promise<void>
  updateDrag: (dx: number, dy: number) => void
  release: () => Promise<void>
  lockFromTap: () => Promise<void>
  sendFromLocked: () => Promise<void>
  discardFromLocked: () => void
  reset: () => void
}

function makeFlatBars(): number[] {
  return new Array<number>(VOICE_WAVEFORM_BAR_COUNT).fill(0.18)
}

function pluginError(code: VoiceRecorderError['code'], message: string): VoiceRecorderError {
  return { code, message }
}

function pluginErrorFromException(err: unknown): VoiceRecorderError {
  const msg = err instanceof Error ? err.message : String(err)
  if (/MISSING_PERMISSION/i.test(msg)) return pluginError('permission_denied', msg)
  if (/DEVICE_CANNOT_VOICE_RECORD/i.test(msg)) return pluginError('device_unsupported', msg)
  if (/MICROPHONE_BEING_USED/i.test(msg)) return pluginError('mic_busy', msg)
  if (/ALREADY_RECORDING/i.test(msg)) return pluginError('start_failed', msg)
  if (/EMPTY_RECORDING/i.test(msg)) return pluginError('empty_recording', msg)
  if (/FAILED_TO_FETCH_RECORDING|FAILED_TO_MERGE_RECORDING/i.test(msg))
    return pluginError('stop_failed', msg)
  return pluginError('start_failed', msg)
}

function decodeBase64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

function deriveExtension(mime: string, ext?: string): string {
  if (ext && /^[a-zA-Z0-9]{1,8}$/.test(ext)) return ext.toLowerCase()
  if (/aac/i.test(mime)) return 'aac'
  if (/mp4|m4a/i.test(mime)) return 'm4a'
  if (/webm/i.test(mime)) return 'webm'
  if (/wav/i.test(mime)) return 'wav'
  return 'm4a'
}

export function useVoiceRecorder(clientMessageId: () => string): UseVoiceRecorderResult {
  const [state, setState] = useState<VoiceRecorderState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [liveBars, setLiveBars] = useState<number[]>(makeFlatBars)
  const [error, setError] = useState<VoiceRecorderError | null>(null)
  const [recording, setRecording] = useState<VoiceRecording | null>(null)
  const [warningVisible, setWarningVisible] = useState(false)

  const stateRef = useRef(state)
  stateRef.current = state
  const startedAtRef = useRef<number | null>(null)
  const liveTickRef = useRef<number | null>(null)
  const elapsedTickRef = useRef<number | null>(null)
  const activeClientIdRef = useRef<string | null>(null)
  const stoppingRef = useRef(false)
  // Captured when the pointer is released while start() is still in flight
  // (requesting permission / native startRecording). start() applies it once
  // recording begins so the take is never orphaned:
  //   'stop' = hold-release → finalize + send
  //   'lock' = quick tap    → keep recording in the locked state
  const pendingGestureRef = useRef<PendingGesture>('none')
  // Forward-declared via ref so timer callbacks bind to a stable identity
  // and don't need to be re-created when finalizeStop's closure changes.
  const finalizeStopRef = useRef<((reason: 'manual' | 'auto-limit' | 'locked-send') => Promise<void>) | null>(null)

  const clearTimers = useCallback(() => {
    if (liveTickRef.current !== null) {
      window.clearInterval(liveTickRef.current)
      liveTickRef.current = null
    }
    if (elapsedTickRef.current !== null) {
      window.clearInterval(elapsedTickRef.current)
      elapsedTickRef.current = null
    }
  }, [])

  const resetInternal = useCallback(() => {
    clearTimers()
    setState('idle')
    setElapsedMs(0)
    setLiveBars(makeFlatBars())
    setRecording(null)
    setWarningVisible(false)
    startedAtRef.current = null
    activeClientIdRef.current = null
    stoppingRef.current = false
    pendingGestureRef.current = 'none'
  }, [clearTimers])

  const reset = useCallback(() => {
    if (stateRef.current === 'recording' || stateRef.current === 'locked' || stateRef.current === 'cancel-armed' || stateRef.current === 'lock-armed') {
      void VoiceRecorder.stopRecording().catch(() => undefined)
    }
    setError(null)
    resetInternal()
  }, [resetInternal])

  const beginTimers = useCallback(() => {
    // startedAtRef is set at the very start of start() (gesture start) so the
    // measured duration stays accurate even when release() fires during the
    // async start window. Do not reset it here.
    elapsedTickRef.current = window.setInterval(() => {
      const startedAt = startedAtRef.current
      if (startedAt === null) return
      const dt = Date.now() - startedAt
      setElapsedMs(dt)
      if (dt >= VOICE_MAX_DURATION_MS - VOICE_WARN_BEFORE_MS) {
        setWarningVisible(true)
      }
      if (dt >= VOICE_MAX_DURATION_MS) {
        // Auto-stop + send: composer reads result via `recording`.
        void finalizeStopRef.current?.('auto-limit')
      }
    }, 200)

    let lastValue = 0.3
    liveTickRef.current = window.setInterval(() => {
      // Smoothed pseudo-random walk so bars feel alive without real signal.
      const drift = (Math.random() - 0.5) * 0.4
      lastValue = Math.max(0.12, Math.min(0.95, lastValue + drift))
      setLiveBars((prev) => {
        const next = prev.slice(1)
        next.push(lastValue)
        return next
      })
    }, LIVE_BAR_TICK_MS)
  }, [])

  const finalizeStop = useCallback(
    async (reason: 'manual' | 'auto-limit' | 'locked-send'): Promise<void> => {
      if (stoppingRef.current) return
      stoppingRef.current = true
      setState('stopping')
      // Capture wall-clock duration BEFORE clearing timers. The native iOS
      // recorder reads file duration synchronously via AVURLAsset.duration,
      // which returns 0 for a freshly-finalized m4a (well-known iOS race) — so
      // value.msDuration cannot be trusted as the "empty recording" signal.
      // Using the measured elapsed time makes the 0-duration race a non-event.
      const measuredMs = startedAtRef.current !== null ? Date.now() - startedAtRef.current : 0
      clearTimers()
      try {
        const result = await VoiceRecorder.stopRecording()
        const value = result.value
        // Genuinely-missing audio data is the only hard "empty" condition.
        if (!value || !value.recordDataBase64) {
          throw new Error('EMPTY_RECORDING')
        }
        const pluginMs =
          typeof value.msDuration === 'number' && Number.isFinite(value.msDuration)
            ? value.msDuration
            : 0
        const durationMs = pluginMs > 0 ? pluginMs : measuredMs
        const mime = value.mimeType ?? 'audio/mp4'
        const ext = deriveExtension(mime, value.fileExtension)
        const blob = decodeBase64ToBlob(value.recordDataBase64, mime)
        // Reject only a truly empty blob or a sub-300ms accidental tap — never
        // a valid multi-second take the native layer mis-reported as 0ms.
        if (blob.size === 0 || durationMs < 300) {
          throw new Error('EMPTY_RECORDING')
        }
        const cid = activeClientIdRef.current ?? clientMessageId()
        const file = new File([blob], `voice-${cid}.${ext}`, { type: mime })
        setRecording({
          clientMessageId: cid,
          file,
          durationMs,
          mimeType: mime,
        })
        setState('idle')
        setElapsedMs(0)
        setLiveBars(makeFlatBars())
        setWarningVisible(false)
        startedAtRef.current = null
      } catch (err) {
        logError('voice.recorder.stop_failed', err, { reason })
        setError(pluginErrorFromException(err))
        resetInternal()
      } finally {
        stoppingRef.current = false
      }
    },
    [clearTimers, clientMessageId, resetInternal],
  )
  useEffect(() => {
    finalizeStopRef.current = finalizeStop
  }, [finalizeStop])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return
    setError(null)
    setRecording(null)
    pendingGestureRef.current = 'none'
    // Stamp the gesture start NOW. start() is async (permission + native
    // startRecording take time on iOS), and the user may release before it
    // reaches 'recording'. Anchoring the duration here keeps a real take from
    // being mis-measured as ~0ms in the deferred-stop path below.
    startedAtRef.current = Date.now()
    setState('requesting-permission')
    activeClientIdRef.current = clientMessageId()
    try {
      const has = await VoiceRecorder.hasAudioRecordingPermission().catch(() => ({ value: false }))
      if (!has.value) {
        const req = await VoiceRecorder.requestAudioRecordingPermission()
        if (!req.value) {
          setError(pluginError('permission_denied', 'Mikrofon-Zugriff abgelehnt'))
          resetInternal()
          return
        }
      }
      // Hold-released during the permission prompt: don't record a 0ms take —
      // the grant now lets the next hold work. Abort cleanly (no error, no
      // orphan). A tap ('lock') instead keeps recording once the grant lands.
      // (Cast: TS narrows the ref to 'none' from the reset above and can't see
      // the release()/lockFromTap() mutation that lands across the awaits.)
      if ((pendingGestureRef.current as PendingGesture) === 'stop') {
        pendingGestureRef.current = 'none'
        resetInternal()
        return
      }
      try {
        await VoiceRecorder.startRecording()
      } catch (err) {
        // Thread-switch / fast-mount race: the previous useVoiceRecorder
        // instance's cleanup may have fired `stopRecording()` but not yet
        // awaited. The plugin still reports ALREADY_RECORDING for a few
        // hundred ms. Stop once, retry once.
        const msg = err instanceof Error ? err.message : String(err)
        if (/ALREADY_RECORDING/i.test(msg)) {
          await VoiceRecorder.stopRecording().catch(() => undefined)
          await VoiceRecorder.startRecording()
        } else {
          throw err
        }
      }
      // The native plugin ignores AVAudioRecorder.record()'s false return, so
      // under audio-session contention (e.g. right after playing a voice note)
      // it reports success while capturing an empty file. Verify the recorder
      // actually started, so the failure surfaces as an error toast instead of
      // a silent, contentless take.
      const status = await VoiceRecorder.getCurrentStatus().catch(() => null)
      if (status && status.status !== 'RECORDING') {
        throw new Error('MICROPHONE_BEING_USED')
      }
      setState('recording')
      beginTimers()
      // Pointer was released while startRecording was in flight (iOS
      // start-latency race): apply the captured intent now instead of silently
      // abandoning the take — this was the "no bubble, no error" voice break.
      const pendingAfterStart = pendingGestureRef.current as PendingGesture
      if (pendingAfterStart === 'stop') {
        pendingGestureRef.current = 'none'
        await finalizeStop('manual')
      } else if (pendingAfterStart === 'lock') {
        pendingGestureRef.current = 'none'
        setState('locked')
      }
    } catch (err) {
      logError('voice.recorder.start_failed', err, {})
      setError(pluginErrorFromException(err))
      resetInternal()
    }
  }, [beginTimers, clientMessageId, resetInternal, finalizeStop])

  const updateDrag = useCallback((dx: number, dy: number) => {
    const current = stateRef.current
    if (current !== 'recording' && current !== 'cancel-armed' && current !== 'lock-armed') {
      return
    }
    // Vertical lock takes precedence over horizontal cancel — matches
    // WhatsApp where pulling up overrides a slight leftward drift.
    if (dy <= -LOCK_THRESHOLD_PX) {
      if (current !== 'lock-armed') setState('lock-armed')
      return
    }
    if (dx <= -CANCEL_THRESHOLD_PX) {
      if (current !== 'cancel-armed') setState('cancel-armed')
      return
    }
    if (current !== 'recording') setState('recording')
  }, [])

  const release = useCallback(async () => {
    const current = stateRef.current
    // Released while start() is still in flight (permission / native
    // startRecording). Defer the stop — start() finalizes once recording
    // actually begins, so the take is never silently orphaned.
    if (current === 'requesting-permission') {
      pendingGestureRef.current = 'stop'
      return
    }
    if (current === 'cancel-armed') {
      try {
        await VoiceRecorder.stopRecording()
      } catch {
        // ignore — discard path
      }
      resetInternal()
      return
    }
    if (current === 'lock-armed') {
      setState('locked')
      return
    }
    if (current === 'recording') {
      await finalizeStop('manual')
    }
  }, [finalizeStop, resetInternal])

  // Quick tap (no sustained hold): keep recording in the locked state so the
  // user can speak hands-free and tap send. Works even while start() is still
  // in flight (defers the intent to start()).
  const lockFromTap = useCallback(async () => {
    const current = stateRef.current
    if (current === 'requesting-permission') {
      pendingGestureRef.current = 'lock'
      return
    }
    if (current === 'recording' || current === 'lock-armed') {
      setState('locked')
      return
    }
    if (current === 'cancel-armed') {
      // Tap that drifted into the cancel zone — discard.
      try {
        await VoiceRecorder.stopRecording()
      } catch {
        // ignore — discard path
      }
      resetInternal()
    }
  }, [resetInternal])

  const sendFromLocked = useCallback(async () => {
    if (stateRef.current !== 'locked') return
    await finalizeStop('locked-send')
  }, [finalizeStop])

  const discardFromLocked = useCallback(() => {
    if (stateRef.current !== 'locked') return
    void VoiceRecorder.stopRecording().catch(() => undefined)
    resetInternal()
  }, [resetInternal])

  // App-background → preserve in locked state so user can decide on resume.
  useEffect(() => {
    function handleVisibility() {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return
      const current = stateRef.current
      if (current === 'recording' || current === 'cancel-armed' || current === 'lock-armed') {
        setState('locked')
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
      return () => document.removeEventListener('visibilitychange', handleVisibility)
    }
    return undefined
  }, [])

  // Plugin interruption (incoming call etc.) → snap to locked.
  useEffect(() => {
    let removed = false
    let handle: { remove: () => Promise<void> } | null = null
    VoiceRecorder.addListener('voiceRecordingInterrupted', () => {
      const current = stateRef.current
      if (current === 'recording' || current === 'cancel-armed' || current === 'lock-armed') {
        setState('locked')
      }
    })
      .then((h) => {
        // If the unmount fired before addListener resolved, drop the handle
        // immediately so the listener doesn't outlive the component.
        if (removed) {
          void h.remove().catch(() => undefined)
          return
        }
        handle = h
      })
      .catch((err) => {
        logWarning('voice.recorder.interrupt_listener_failed', { error: String(err) })
      })
    return () => {
      removed = true
      if (handle) {
        void handle.remove().catch(() => undefined)
      }
    }
  }, [])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      clearTimers()
      if (stateRef.current !== 'idle') {
        void VoiceRecorder.stopRecording().catch(() => undefined)
      }
    }
  }, [clearTimers])

  return {
    state,
    elapsedMs,
    liveBars,
    warningVisible,
    error,
    recording,
    start,
    updateDrag,
    release,
    lockFromTap,
    sendFromLocked,
    discardFromLocked,
    reset,
  }
}
