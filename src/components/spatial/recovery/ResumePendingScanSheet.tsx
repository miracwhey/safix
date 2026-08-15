/**
 * Spatial · Lane 2.5 · Stream A · ResumePendingScanSheet
 *
 * Bottom-sheet shown by the Spatial Hub at mount when the local capture cache
 * holds at least one resumable entry (`pending`, `failed`, or `aborted`).
 *
 * Each row offers two terminal actions:
 *   - **Hochladen & Weitermachen** — runs `resumePendingCapture()`, which
 *     starts a fresh `captureScan()` cycle against the cached blob and
 *     surfaces success/failure as a toast.
 *   - **Verwerfen** — drops the cache entry with no upload. Confirmation is
 *     inline (a second click within 4 s) so the destructive action is not
 *     gated behind an extra dialog.
 *
 * The sheet auto-closes when the last entry has been resolved (entries.length
 * === 0). The host owns the open/close state for the initial gate so the
 * sheet does not re-pop after a manual close in the same session.
 *
 * Mirrors `HubFilterSheet` for visual + interaction conventions (liquid-glass
 * panel, focus trap, Escape, click-outside) — no new design tokens.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Box,
  Briefcase,
  Hourglass,
  Lock,
  RefreshCcw,
  Trash2,
  X,
} from 'lucide-react'

import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'
import type {
  CaptureCacheEntry,
  CaptureCacheStatus,
} from '../../../lib/spatial/storage'
import type { ResumePendingCaptureResult } from '../../../lib/spatial/workflow/resumePendingCapture'

export interface ResumePendingScanSheetProps {
  entries: CaptureCacheEntry[]
  busyScanIds: Set<string>
  onResume: (entry: CaptureCacheEntry) => Promise<ResumePendingCaptureResult>
  onDiscard: (entry: CaptureCacheEntry) => Promise<void>
  onClose: () => void
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.84)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow:
    '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
}

const DISCARD_CONFIRM_WINDOW_MS = 4_000

interface ToastSpec {
  kind: 'success' | 'error' | 'info'
  text: string
}

export function ResumePendingScanSheet({
  entries,
  busyScanIds,
  onResume,
  onDiscard,
  onClose,
}: ResumePendingScanSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  const [discardArmed, setDiscardArmed] = useState<string | null>(null)
  const [inlineToast, setInlineToast] = useState<ToastSpec | null>(null)

  // Escape closes (parent re-opens iff entries reappear).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Auto-close once every entry has been resolved by the user.
  useEffect(() => {
    if (entries.length === 0) onClose()
  }, [entries.length, onClose])

  // Drop the inline toast after a few seconds so the next action starts
  // clean. State-resets are cheap, no debounce gymnastics needed.
  useEffect(() => {
    if (!inlineToast) return
    const handle = window.setTimeout(() => setInlineToast(null), 3_500)
    return () => window.clearTimeout(handle)
  }, [inlineToast])

  // Arming a "Verwerfen" tap is a 4-s window so a stray double-tap can't
  // delete a recovery. Resetting on tap of a different row keeps the
  // mental model tight.
  useEffect(() => {
    if (!discardArmed) return
    const handle = window.setTimeout(
      () => setDiscardArmed(null),
      DISCARD_CONFIRM_WINDOW_MS,
    )
    return () => window.clearTimeout(handle)
  }, [discardArmed])

  const handleResume = useCallback(
    async (entry: CaptureCacheEntry) => {
      setDiscardArmed(null)
      const result = await onResume(entry)
      if (result.ok) {
        setInlineToast({
          kind: 'success',
          text: result.scene
            ? 'Scan wiederhergestellt — 3D-Szene erstellt.'
            : 'Scan wiederhergestellt — 3D-Modell wird generiert.',
        })
      } else {
        setInlineToast({
          kind: 'error',
          text: result.message,
        })
      }
    },
    [onResume],
  )

  const handleDiscard = useCallback(
    async (entry: CaptureCacheEntry) => {
      if (discardArmed !== entry.scanId) {
        setDiscardArmed(entry.scanId)
        setInlineToast({
          kind: 'info',
          text: 'Erneut tippen, um den Scan endgültig zu verwerfen.',
        })
        return
      }
      setDiscardArmed(null)
      await onDiscard(entry)
      setInlineToast({ kind: 'info', text: 'Scan verworfen.' })
    },
    [discardArmed, onDiscard],
  )

  const subtitle = useMemo(() => {
    if (entries.length === 1) return '1 unfertiger Scan'
    return `${entries.length} unfertige Scans`
  }, [entries.length])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-pending-scan-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={SHEET_GLASS}
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15"
        />

        <div className="flex items-start justify-between">
          <div>
            <h2
              id="resume-pending-scan-title"
              className="text-[19px] font-bold text-slate-900"
            >
              Scan fortsetzen
            </h2>
            <p className="mt-0.5 text-[12.5px] text-slate-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-900/5 hover:text-slate-600 active:scale-90"
          >
            <X className="size-5" />
          </button>
        </div>

        <p className="mt-2 rounded-[14px] bg-amber-50 px-3 py-2.5 text-[12px] leading-snug text-amber-900 ring-1 ring-amber-200">
          Diese Scans haben das Hochladen nicht abgeschlossen. Tippe
          „Hochladen & Weitermachen", um sie jetzt zu sichern, oder
          „Verwerfen", wenn du sie nicht mehr brauchst.
        </p>

        {inlineToast && (
          <div
            role="status"
            aria-live="polite"
            className={[
              'mt-2 rounded-[12px] px-3 py-2 text-[12px] font-medium',
              inlineToast.kind === 'success'
                ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
                : inlineToast.kind === 'error'
                  ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-200'
                  : 'bg-slate-100 text-slate-700 ring-1 ring-slate-200',
            ].join(' ')}
          >
            {inlineToast.text}
          </div>
        )}

        <ul className="mt-3 flex-1 list-none space-y-2.5 overflow-y-auto overscroll-contain pb-2">
          {entries.map((entry) => (
            <PendingScanRow
              key={entry.scanId}
              entry={entry}
              busy={busyScanIds.has(entry.scanId)}
              armed={discardArmed === entry.scanId}
              onResume={() => handleResume(entry)}
              onDiscard={() => handleDiscard(entry)}
            />
          ))}
        </ul>

        <button
          type="button"
          onClick={onClose}
          className="mt-3 self-center rounded-full px-4 py-2 text-[12.5px] font-semibold text-slate-500 hover:bg-slate-900/5"
        >
          Später erinnern
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────

interface PendingScanRowProps {
  entry: CaptureCacheEntry
  busy: boolean
  armed: boolean
  onResume: () => void
  onDiscard: () => void
}

function PendingScanRow({
  entry,
  busy,
  armed,
  onResume,
  onDiscard,
}: PendingScanRowProps) {
  const anchorLabel = anchorLabelFor(entry)
  const statusBadge = STATUS_BADGE[entry.status]

  return (
    <li className="rounded-[16px] bg-white/85 px-3 py-3 ring-1 ring-slate-200 shadow-[0_8px_24px_-12px_rgba(15,23,42,0.18)]">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-slate-100 text-slate-600"
        >
          {anchorLabel.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-bold text-slate-900">
              {anchorLabel.title}
            </span>
            <span
              className={[
                'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                statusBadge.className,
              ].join(' ')}
            >
              {statusBadge.icon}
              {statusBadge.label}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
            {formatBytes(entry.bytes)} · {relativeTime(entry.capturedAt)}
          </div>
          {entry.lastError && entry.status === 'failed' && (
            <div className="mt-1 truncate text-[11px] text-rose-600">
              Fehler: {entry.lastError}
            </div>
          )}
          {entry.abortReason && entry.status === 'aborted' && (
            <div className="mt-1 truncate text-[11px] text-slate-500">
              Abgebrochen: {entry.abortReason}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[12px] bg-slate-900 px-3 py-2.5 text-[12.5px] font-bold text-white shadow-md active:scale-[0.98] disabled:opacity-50"
        >
          <RefreshCcw className="size-4" />
          {busy ? 'Lade hoch …' : 'Hochladen & Weitermachen'}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          aria-pressed={armed}
          className={[
            'flex shrink-0 items-center gap-1.5 rounded-[12px] px-3 py-2.5 text-[12px] font-semibold ring-1 active:scale-[0.98] disabled:opacity-50',
            armed
              ? 'bg-rose-600 text-white ring-rose-700'
              : 'bg-white/80 text-rose-600 ring-rose-200 hover:bg-rose-50',
          ].join(' ')}
        >
          <Trash2 className="size-4" />
          {armed ? 'Wirklich?' : 'Verwerfen'}
        </button>
      </div>
    </li>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Display helpers
// ────────────────────────────────────────────────────────────────────────────

interface AnchorLabel {
  title: string
  icon: React.ReactNode
}

function anchorLabelFor(entry: CaptureCacheEntry): AnchorLabel {
  if (entry.jobId) {
    return {
      title: 'Job-Scan',
      icon: <Briefcase className="size-4" />,
    }
  }
  if (entry.projectId) {
    return {
      title: 'Projekt-Scan',
      icon: <Box className="size-4" />,
    }
  }
  if (entry.presalesProjectId) {
    return {
      title: 'Aufmaß',
      icon: <Box className="size-4" />,
    }
  }
  return {
    title: 'Scan',
    icon: <Box className="size-4" />,
  }
}

interface StatusBadge {
  label: string
  className: string
  icon: React.ReactNode
}

const STATUS_BADGE: Record<CaptureCacheStatus, StatusBadge> = {
  pending: {
    label: 'Wartet',
    className: 'bg-amber-100 text-amber-800',
    icon: <Hourglass className="size-3" />,
  },
  failed: {
    label: 'Fehler',
    className: 'bg-rose-100 text-rose-800',
    icon: <AlertTriangle className="size-3" />,
  },
  aborted: {
    label: 'Abgebrochen',
    className: 'bg-slate-100 text-slate-700',
    icon: <Lock className="size-3" />,
  },
  uploaded: {
    label: 'Hochgeladen',
    className: 'bg-emerald-100 text-emerald-800',
    icon: <Hourglass className="size-3" />,
  },
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function relativeTime(atMs: number, nowMs: number = Date.now()): string {
  const min = Math.max(0, Math.round((nowMs - atMs) / 60_000))
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} Min`
  const hrs = Math.round(min / 60)
  if (hrs < 24) return `vor ${hrs} Std`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'gestern' : `vor ${days} Tagen`
}
