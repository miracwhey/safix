/**
 * Block D Slice 3 — Voice composer overlay.
 *
 * Renders the recording UI that replaces the standard ChatComposer input row
 * while a voice note is being captured. Two visual variants:
 *
 *   1. Drag-controlled bar — user holds the mic, the bar shows the live
 *      waveform + elapsed time + "← Abbrechen" slide hint.
 *   2. Locked bar — user lifted away with `dy <= -80px`, the bar now has a
 *      trash button (discard) and a send button.
 *
 * The component is dumb: state + transitions live in `useVoiceRecorder`.
 * The parent (`ChatComposer`) attaches pointer events on the mic handle.
 */

import { VOICE_WAVEFORM_BAR_COUNT, type VoiceRecorderState } from '../../lib/chat/voice/types'

type Props = {
  state: VoiceRecorderState
  elapsedMs: number
  liveBars: number[]
  warningVisible: boolean
  /**
   * Horizontal cancel-pull distance in px (always >= 0, capped at the
   * cancel threshold by the caller). Drives the bar-mic follow-cursor and
   * the centered X-pulse during the slide-to-cancel gesture.
   */
  cancelPullPx: number
  /** Locked-state actions. */
  onSend: () => void
  onDiscard: () => void
}

export function VoiceComposerOverlay({
  state,
  elapsedMs,
  liveBars,
  warningVisible,
  cancelPullPx,
  onSend,
  onDiscard,
}: Props) {
  const isLocked = state === 'locked' || state === 'stopping'
  const isCancelArmed = state === 'cancel-armed'
  const isRecordingActive = state === 'recording' || isCancelArmed || state === 'lock-armed'
  const elapsedLabel = formatElapsed(elapsedMs)
  const bars = padBars(liveBars)
  // Bar-mic follows the finger up to the cancel threshold so the user sees
  // exactly how close they are to discarding. Negative direction = leftward.
  const barMicTranslateX = isRecordingActive ? -Math.min(cancelPullPx, 80) : 0
  const barMicScale = isCancelArmed ? 0.85 : 1
  const waveformShrink = isCancelArmed ? `scaleY(${0.72})` : 'scaleY(1)'

  return (
    <div
      role="region"
      aria-label={isLocked ? 'Aufnahme gesperrt — bereit zum Senden' : 'Aufnahme läuft'}
      className={`relative flex h-[44px] flex-1 items-center gap-2 rounded-full px-3 ring-1 transition-colors duration-[160ms] ${
        isCancelArmed
          ? 'bg-rose-50/80 ring-rose-200'
          : warningVisible
            ? 'bg-amber-50/80 ring-amber-200'
            : 'bg-slate-50/80 ring-slate-200/70'
      }`}
      data-voice-state={state}
    >
      {isLocked ? (
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Aufnahme verwerfen"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-rose-500 ring-1 ring-rose-200 transition active:scale-95"
        >
          <TrashIcon />
        </button>
      ) : (
        <span
          aria-hidden
          className={`flex h-2.5 w-2.5 shrink-0 rounded-full ${
            isCancelArmed ? 'bg-rose-500' : 'bg-rose-500'
          } animate-pulse`}
        />
      )}

      <span
        className={`shrink-0 font-mono text-[13px] tabular-nums ${
          isCancelArmed ? 'text-rose-700' : warningVisible ? 'text-amber-700' : 'text-slate-700'
        }`}
      >
        {elapsedLabel}
      </span>

      <div
        className="flex h-7 flex-1 items-center gap-[2px] overflow-hidden"
        style={{
          transform: waveformShrink,
          transformOrigin: 'center',
          transition: 'transform 180ms cubic-bezier(.22,.61,.36,1), opacity 160ms ease-out',
          opacity: isCancelArmed ? 0.55 : 1,
        }}
      >
        {bars.map((value, i) => (
          <span
            key={i}
            aria-hidden
            className={`inline-block w-[3px] rounded-full ${
              isCancelArmed ? 'bg-rose-300' : 'bg-slate-400/70'
            }`}
            style={{
              height: `${Math.round(value * 100)}%`,
              transition: 'height 80ms linear, background-color 160ms ease-out',
            }}
          />
        ))}
      </div>

      {isCancelArmed ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/95 text-white shadow-[0_2px_8px_-2px_rgba(244,63,94,0.55)] animate-pulse"
        >
          <XIcon />
        </span>
      ) : null}

      {isLocked ? (
        <button
          type="button"
          onClick={onSend}
          aria-label="Aufnahme senden"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition active:scale-95"
        >
          <SendIcon />
        </button>
      ) : isRecordingActive ? (
        <>
          <span className="select-none whitespace-nowrap text-[11.5px] text-slate-500" aria-hidden>
            {isCancelArmed ? 'Loslassen verwirft' : '← Abbrechen ziehen'}
          </span>
          <span
            aria-hidden
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
              isCancelArmed ? 'bg-rose-500 text-white' : 'bg-slate-200 text-slate-600'
            }`}
            style={{
              transform: `translateX(${barMicTranslateX}px) scale(${barMicScale})`,
              transition: 'transform 140ms cubic-bezier(.22,.61,.36,1), background-color 160ms ease-out',
            }}
          >
            <BarMicIcon />
          </span>
        </>
      ) : null}
    </div>
  )
}

function padBars(bars: number[]): number[] {
  if (bars.length >= VOICE_WAVEFORM_BAR_COUNT) {
    return bars.slice(bars.length - VOICE_WAVEFORM_BAR_COUNT)
  }
  const padding = new Array<number>(VOICE_WAVEFORM_BAR_COUNT - bars.length).fill(0.18)
  return [...padding, ...bars]
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s < 10 ? `0${s}` : s}`
}

function BarMicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8a4 4 0 0 0 8 0M8 12v2.5M5.5 14.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M5 4.5l.5 9a1.5 1.5 0 0 0 1.5 1.4h2a1.5 1.5 0 0 0 1.5-1.4l.5-9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="m2 8 12-5-5 12-2-5-5-2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="currentColor"
      />
    </svg>
  )
}
