/**
 * Block D Slice 3 — Voice-Notes types.
 *
 * Recorder state machine + cache shapes shared between hook, workflow, and UI.
 */

export type VoiceRecorderState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'cancel-armed'
  | 'lock-armed'
  | 'locked'
  | 'stopping'

export type VoiceRecorderErrorCode =
  | 'permission_denied'
  | 'device_unsupported'
  | 'mic_busy'
  | 'plugin_unavailable'
  | 'empty_recording'
  | 'start_failed'
  | 'stop_failed'
  | 'interrupted_unrecoverable'

export interface VoiceRecorderError {
  code: VoiceRecorderErrorCode
  message: string
}

export interface VoiceRecording {
  /** Stable id assigned at startRecording, persisted with cached blob. */
  clientMessageId: string
  /** Decoded audio file produced from the plugin output. */
  file: File
  /** Plugin-reported duration in ms (authoritative). */
  durationMs: number
  /** Mime type as reported by the plugin (audio/aac, audio/mp4, audio/webm). */
  mimeType: string
}

/** Persisted blob entry for app-restart recovery + failed-send retry. */
export interface CachedVoiceRecording {
  clientMessageId: string
  threadId: string
  channelType: string
  blob: Blob
  durationMs: number
  mimeType: string
  fileExtension: string
  /** When the recording was finalised — used to age stale entries. */
  createdAt: number
}

/** Max recording length per Plan Decision #5 (Slice 3). */
export const VOICE_MAX_DURATION_MS = 5 * 60 * 1000

/** Pre-stop warning threshold (10s before auto-stop). */
export const VOICE_WARN_BEFORE_MS = 10 * 1000

/** Number of bars rendered in the static waveform per ADR Decision #10. */
export const VOICE_WAVEFORM_BAR_COUNT = 25
