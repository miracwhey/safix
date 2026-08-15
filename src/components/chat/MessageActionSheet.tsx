/**
 * Block 3 — message-delete UI: long-press wrapper, action sheet, tombstone.
 *
 * All bubble types — including voice — are wrapped in <LongPressBubble> for
 * delete. The voice bubble's speed control is now an in-place tap-cycle toggle
 * (not a long-press), so the 380ms long-press is free to own delete; the voice
 * waveform stops pointer propagation so scrubbing never arms this gesture.
 */
import { useCallback, useRef, type MouseEvent, type ReactNode } from 'react'

/** 15-minute "Für alle löschen" (unsend) window, mirrored by the RPC. */
export const UNSEND_WINDOW_MS = 15 * 60 * 1000

const LONG_PRESS_MS = 380

/**
 * Wraps a message bubble so a 380ms long-press opens the delete sheet. A short
 * tap passes through to the bubble's own handlers; the click that *ends* a
 * long-press is swallowed so it doesn't also fire the bubble tap.
 * `onLongPress` undefined → inert passthrough (e.g. pending/failed sends).
 */
export function LongPressBubble({
  onLongPress,
  children,
}: {
  onLongPress?: () => void
  children: ReactNode
}) {
  const timer = useRef<number | null>(null)
  const fired = useRef(false)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const onPointerDown = useCallback(() => {
    if (!onLongPress) return
    fired.current = false
    clear()
    timer.current = window.setTimeout(() => {
      fired.current = true
      onLongPress()
    }, LONG_PRESS_MS)
  }, [onLongPress, clear])

  const onPointerUp = useCallback(() => clear(), [clear])

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (fired.current) {
      e.preventDefault()
      e.stopPropagation()
      fired.current = false
    }
  }, [])

  return (
    // voice-no-select suppresses the iOS WKWebView selection magnifier /
    // Save-Image callout that would otherwise fire during the 380ms press and
    // collide with the long-press gesture (same class the voice overlay uses).
    <div
      className="voice-no-select"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onClickCapture={onClickCapture}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  )
}

/** Tombstone shown after "Für alle löschen": dezent, no bubble fill, the
 *  timestamp survives. */
export function MessageTombstone({
  createdAt,
  isOwnBubble,
}: {
  createdAt: number
  isOwnBubble: boolean
}) {
  return (
    <div className={`flex flex-col ${isOwnBubble ? 'items-end' : 'items-start'} mt-1.5`}>
      <div className="flex max-w-[78%] items-center gap-1.5 rounded-2xl px-3 py-2 text-[12.5px] italic text-slate-400">
        <span aria-hidden>🚫</span>
        <span>Diese Nachricht wurde gelöscht</span>
        <span className="ml-1 text-[10px] not-italic tabular-nums text-slate-300">
          {formatClockTime(createdAt)}
        </span>
      </div>
    </div>
  )
}

/** Bottom action sheet (V5 glass) offering the delete modes. */
export function MessageActionSheet({
  canDeleteForAll,
  busy,
  error,
  onPick,
  onDismiss,
}: {
  canDeleteForAll: boolean
  busy: boolean
  error: string | null
  onPick: (mode: 'self' | 'all') => void
  onDismiss: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-label="Nachricht löschen"
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mb-3 w-full max-w-md rounded-2xl bg-white px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 shadow-xl"
      >
        <div className="mb-2 px-1 text-center text-[12px] font-semibold uppercase tracking-wider text-slate-400">
          Nachricht
        </div>
        {error && (
          <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-center text-[12.5px] text-red-600">
            {error}
          </p>
        )}
        <div className="space-y-1.5">
          {canDeleteForAll && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPick('all')}
              className="w-full rounded-xl bg-red-50 px-4 py-3 text-left text-[15px] font-semibold text-red-600 transition active:scale-[0.98] disabled:opacity-60"
            >
              Für alle löschen
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick('self')}
            className="w-full rounded-xl bg-slate-100 px-4 py-3 text-left text-[15px] font-semibold text-slate-700 transition active:scale-[0.98] disabled:opacity-60"
          >
            Für mich löschen
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="w-full rounded-xl px-4 py-3 text-center text-[15px] font-semibold text-slate-500 transition active:scale-[0.98] disabled:opacity-60"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}

function formatClockTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`
}
