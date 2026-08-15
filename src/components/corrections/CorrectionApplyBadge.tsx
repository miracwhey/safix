import type { CorrectionRequest } from '../../lib/corrections'

/**
 * Block 7.2.7b — Visualisiert den Auto-Apply-Status nach Approve.
 *
 * - appliedAt set → emerald "Eintrag automatisch aktualisiert"
 * - skipReason 'invalid_time_format' / 'missing_calendar_entry' → amber Hinweis
 * - skipReason 'repository_error' → rot mit Wiederholungs-Aufforderung
 * - skipReason 'kind_not_supported' (oder kein Trace) → kein Badge (erwartet)
 *
 * Nur sichtbar bei status === 'resolved'.
 */
export default function CorrectionApplyBadge({
  request,
}: {
  request: CorrectionRequest
}) {
  if (request.status !== 'resolved') return null

  if (request.appliedAt) {
    return (
      <div
        data-testid="correction-apply-badge"
        data-state="applied"
        className="rounded-[14px] bg-emerald-50 border border-emerald-200 px-3.5 py-3"
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
          Auto-Update
        </div>
        <div className="mt-0.5 text-[13px] font-semibold text-emerald-700">
          Eintrag automatisch aktualisiert
        </div>
      </div>
    )
  }

  const skip = request.applySkipReason
  if (skip === 'invalid_time_format' || skip === 'missing_calendar_entry') {
    return (
      <div
        data-testid="correction-apply-badge"
        data-state="manual"
        className="rounded-[14px] bg-amber-50 border border-amber-200 px-3.5 py-3"
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-600">
          Hinweis
        </div>
        <div className="mt-0.5 text-[13px] font-semibold text-amber-700">
          Bitte Eintrag manuell anpassen
        </div>
      </div>
    )
  }

  if (skip === 'repository_error') {
    return (
      <div
        data-testid="correction-apply-badge"
        data-state="error"
        className="rounded-[14px] bg-red-50 border border-red-200 px-3.5 py-3"
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-red-500">
          Fehler
        </div>
        <div className="mt-0.5 text-[13px] font-semibold text-red-700">
          Eintrag-Update fehlgeschlagen, bitte erneut versuchen oder manuell anpassen
        </div>
      </div>
    )
  }

  return null
}
