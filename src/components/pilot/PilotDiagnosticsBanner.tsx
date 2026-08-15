import { useEffect, useState } from 'react'
import type {
  PilotDiagnosticsSummary,
  PilotSignal,
  PilotSignalSeverity,
} from '../../lib/pilot'

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function getSeverityDotClass(severity: PilotSignalSeverity): string {
  if (severity === 'critical') return 'bg-rose-500'
  if (severity === 'warning') return 'bg-amber-400'
  return 'bg-slate-400'
}

function getSeverityRowStyle(severity: PilotSignalSeverity): string {
  if (severity === 'critical') return 'border-l-2 border-rose-300 pl-3'
  if (severity === 'warning') return 'border-l-2 border-amber-300 pl-3'
  return 'border-l-2 border-slate-200 pl-3'
}

// ---------------------------------------------------------------------------
// Signal row
// ---------------------------------------------------------------------------

function SignalRow({ signal }: { signal: PilotSignal }) {
  return (
    <div className={`py-2 ${getSeverityRowStyle(signal.severity)}`}>
      <div className="flex items-start gap-2">
        <span
          className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${getSeverityDotClass(signal.severity)}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-slate-900">
            {signal.title}
            {signal.ageLabel && (
              <span className="ml-1.5 text-[11px] text-slate-400">{signal.ageLabel}</span>
            )}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-slate-500">
            {signal.detail}
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Count badge
// ---------------------------------------------------------------------------

function CountBadge({
  count,
  label,
  colorClass,
}: {
  count: number
  label: string
  colorClass: string
}) {
  if (count === 0) return null
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${colorClass}`}
    >
      {count} {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// PilotDiagnosticsBanner
// ---------------------------------------------------------------------------

type Props = {
  summary: PilotDiagnosticsSummary
}

/**
 * Collapsible banner that surfaces pilot diagnostic signals from
 * {@link PilotDiagnosticsSummary}. Renders nothing when there are no issues.
 *
 * Expanded by default when there are critical signals, collapsed otherwise.
 */
export default function PilotDiagnosticsBanner({ summary }: Props) {
  const [expanded, setExpanded] = useState(summary.criticalCount > 0)

  // Pre-group signals by severity to avoid repeated filtering on render
  const criticalSignals = summary.signals.filter((s) => s.severity === 'critical')
  const warningSignals = summary.signals.filter((s) => s.severity === 'warning')
  const infoSignals = summary.signals.filter((s) => s.severity === 'info')

  // Auto-expand when new critical issues appear mid-session
  useEffect(() => {
    if (summary.criticalCount > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded(true)
    }
  }, [summary.criticalCount])

  if (!summary.hasIssues) {
    return (
      <div className="rounded-[24px] bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200/80 flex items-center gap-3">
        <span className="text-[18px] leading-none">✅</span>
        <div>
          <div className="text-[13px] font-bold text-emerald-800">Pilot-Diagnose: System OK – Kein Handlungsbedarf.</div>
          <div className="text-[11px] text-emerald-600">Alle Signale im grünen Bereich. Keine Aktion erforderlich.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-[24px] bg-white ring-1 ring-slate-200/70 shadow-[0_12px_28px_-20px_rgba(2,6,23,0.22)] overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-slate-50"
        aria-expanded={expanded}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 ring-1 ring-slate-200">
          <span className="text-[15px] leading-none">🔍</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold uppercase tracking-[0.15em] text-slate-400">
            Pilot-Überwachung
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
            <span className="text-[13px] font-bold text-slate-800">
              Pilot-Diagnose
            </span>
            <CountBadge
              count={summary.criticalCount}
              label="Sofortiger Handlungsbedarf"
              colorClass="bg-rose-50 text-rose-700 ring-rose-200"
            />
            <CountBadge
              count={summary.warningCount}
              label="Prüfen"
              colorClass="bg-amber-50 text-amber-700 ring-amber-200"
            />
            <CountBadge
              count={summary.infoCount}
              label="Beobachten"
              colorClass="bg-slate-50 text-slate-600 ring-slate-200"
            />
          </div>
        </div>

        <span className="shrink-0 text-[13px] font-semibold text-slate-400 select-none">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Signal list */}
      {expanded && (
        <div className="border-t border-slate-100 px-4 pb-3 pt-2 space-y-3">
          {summary.criticalCount > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-rose-500">🔴 Sofortiger Handlungsbedarf</div>
              <div className="space-y-0">
                {criticalSignals.map(signal => (
                  <SignalRow key={signal.id} signal={signal} />
                ))}
              </div>
            </div>
          )}
          {summary.warningCount > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-amber-500">🟡 Prüfen empfohlen</div>
              <div className="space-y-0">
                {warningSignals.map(signal => (
                  <SignalRow key={signal.id} signal={signal} />
                ))}
              </div>
            </div>
          )}
          {summary.infoCount > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">ℹ️ Beobachten</div>
              <div className="space-y-0">
                {infoSignals.map(signal => (
                  <SignalRow key={signal.id} signal={signal} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
