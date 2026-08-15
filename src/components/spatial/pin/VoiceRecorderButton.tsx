/**
 * Spatial Core · Block F.3 · Inline Voice Recorder Button
 *
 * Thin wrapper around `useVoiceRecorder` that surfaces the record/stop
 * state-machine as a single touch target inside the Pin-Detail Sheet.
 *
 * The recorder hook already enforces the WhatsApp-style hold/release/lock
 * UX in the chat surface; here we use the lock path because pin-editing
 * isn't a quick-fire send — the craftsman opens the sheet, taps record,
 * speaks, taps stop. No drag-to-lock gesture.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceRecorder } from '../../../hooks/useVoiceRecorder'

export interface VoiceRecorderButtonProps {
  /** Stable id for the recording session — fed to `useVoiceRecorder` so
   *  the hook can de-dupe a finished blob from a re-render after release. */
  clientMessageId: () => string
  onRecorded: (file: File, durationMs: number) => void
  /** Disable the button while a parent action (upload, save) is in flight. */
  disabled?: boolean
}

export function VoiceRecorderButton(props: VoiceRecorderButtonProps) {
  const recorder = useVoiceRecorder(props.clientMessageId)
  const [busy, setBusy] = useState(false)
  // Track which recording-instance we've already handed up so a parent
  // re-render doesn't refire the upload. The hook keeps `recording` set
  // until the next `start()` per its contract, so without this guard the
  // useEffect re-runs on every parent render → duplicate uploads + duplicate
  // scan_events. Hard-review post-#925 finding B1.
  const handledRef = useRef<unknown>(null)
  // Stash the callback in a ref so it doesn't drive the effect deps. Parent
  // typically passes an inline arrow, which is a new identity every render.
  const onRecordedRef = useRef(props.onRecorded)
  useEffect(() => { onRecordedRef.current = props.onRecorded }, [props.onRecorded])

  // Hand the finished blob up to the parent once the recorder lands a fresh
  // recording. `recording` is identity-stable per recording session so the
  // ref-guard fires exactly once per blob.
  useEffect(() => {
    const rec = recorder.recording
    if (!rec || handledRef.current === rec) return
    handledRef.current = rec
    onRecordedRef.current(rec.file, rec.durationMs)
  }, [recorder.recording])

  const isRecording = recorder.elapsedMs > 0
  const elapsedLabel = formatElapsed(recorder.elapsedMs)

  const onTap = useCallback(async () => {
    if (busy || props.disabled) return
    setBusy(true)
    try {
      if (isRecording) {
        await recorder.release()
      } else {
        await recorder.start()
      }
    } finally {
      setBusy(false)
    }
  }, [busy, props.disabled, isRecording, recorder])

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onTap}
        disabled={props.disabled || busy}
        aria-pressed={isRecording}
        aria-label={isRecording ? 'Aufnahme stoppen' : 'Sprachnotiz aufnehmen'}
        className={
          'flex h-12 w-12 items-center justify-center rounded-full text-lg transition ' +
          (isRecording
            ? 'bg-rose-600 text-white hover:bg-rose-700'
            : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200')
        }
      >
        {isRecording ? '■' : '🎙'}
      </button>
      <div className="flex flex-col">
        <span className="text-xs font-medium text-neutral-700">
          {isRecording ? 'Aufnahme läuft' : 'Sprachnotiz aufnehmen'}
        </span>
        <span className="text-[11px] tabular-nums text-neutral-500">
          {isRecording ? elapsedLabel : 'Tippen, um zu starten'}
        </span>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const r = totalSec % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}
