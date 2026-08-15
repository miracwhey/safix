import { useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import { useCorrections } from '../hooks/useCorrections'
import type { CorrectionKind, CorrectionStatus } from '../lib/corrections'
import CorrectionMiniTimeline from '../components/corrections/CorrectionMiniTimeline'
import CorrectionApplyBadge from '../components/corrections/CorrectionApplyBadge'
import { useSmartBack } from '../hooks/useSmartBack'

// ── Labels ────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<CorrectionKind, string> = {
  missing_time: 'Fehlende Zeit',
  wrong_time: 'Falsche Zeit',
  wrong_assignment: 'Falscher Einsatz',
  other: 'Sonstiges',
}

const STATUS_CONFIG: Record<
  CorrectionStatus,
  { label: string; bg: string; text: string }
> = {
  open: { label: 'Offen', bg: 'bg-amber-50', text: 'text-amber-600' },
  in_review: { label: 'In Prüfung', bg: 'bg-blue-50', text: 'text-blue-600' },
  resolved: { label: 'Erledigt', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  rejected: { label: 'Abgelehnt', bg: 'bg-slate-100', text: 'text-slate-500' },
}

// ── Field component ───────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] text-slate-700">{value}</div>
    </div>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function WorkerKorrekturDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const goBack = useSmartBack('/worker/korrekturen')
  const { requests } = useCorrections()

  const request = requests.find((r) => r.id === id)

  const statusCfg = request ? STATUS_CONFIG[request.status] : null
  const dateLabel = request?.requestedDate
    ? new Date(request.requestedDate + 'T12:00:00').toLocaleDateString('de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null
  const submittedLabel = request
    ? new Date(request.createdAt).toLocaleDateString('de-DE', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null

  return (
    <AppShell active="worker-konto" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-12">
        <div className="mx-auto w-full max-w-[420px] space-y-5">

          {/* Header */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              className="h-9 w-9 shrink-0 rounded-full bg-slate-100 flex items-center justify-center active:bg-slate-200 transition-colors"
              aria-label="Zurück"
            >
              <ArrowLeft size={16} strokeWidth={2} className="text-slate-600" />
            </button>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Korrekturen
              </p>
              <h1 className="text-[20px] font-bold tracking-tight text-slate-900 leading-tight">
                Detail
              </h1>
            </div>
          </div>

          {!request ? (
            <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70">
              <p className="text-[13px] text-slate-400">Korrektur nicht gefunden.</p>
            </div>
          ) : (
            <>
              {/* Status banner */}
              <div
                className={`rounded-[18px] px-4 py-3 flex items-center gap-3 ${statusCfg!.bg}`}
              >
                <span className={`text-[13px] font-semibold ${statusCfg!.text}`}>
                  {statusCfg!.label}
                </span>
                {submittedLabel && (
                  <span className="ml-auto text-[11px] text-slate-400">
                    Eingereicht: {submittedLabel}
                  </span>
                )}
              </div>

              {/* Mini-Timeline (Block 7.2.5) */}
              <CorrectionMiniTimeline request={request} />

              {/* Auto-Apply-Badge (Block 7.2.7b) — nur bei resolved */}
              <CorrectionApplyBadge request={request} />

              {/* Fields */}
              <div className="space-y-3">
                <Field label="Art" value={KIND_LABELS[request.kind]} />
                {dateLabel && <Field label="Datum" value={dateLabel} />}
                <div className="rounded-[14px] bg-slate-50 px-3.5 py-3 ring-1 ring-slate-100">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                    Beschreibung
                  </div>
                  <p className="mt-1 text-[13px] text-slate-700 whitespace-pre-wrap">
                    {request.description}
                  </p>
                </div>
              </div>

              {/* Strukturierte Felder (Block 7.2.3) — read-only Worker-Sicht */}
              {(request.field || request.currentValue || request.proposedValue || request.reason) && (
                <div data-testid="correction-structured-fields" className="space-y-2">
                  {request.field && <Field label="Was" value={request.field} />}
                  {request.currentValue && (
                    <div className="rounded-[14px] bg-red-50 border border-red-200 px-3.5 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-red-500">
                        Aktuell
                      </div>
                      <div className="mt-0.5 text-[13px] font-semibold text-red-700">
                        {request.currentValue}
                      </div>
                    </div>
                  )}
                  {request.proposedValue && (
                    <div className="rounded-[14px] bg-emerald-50 border border-emerald-200 px-3.5 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-600">
                        Vorschlag
                      </div>
                      <div className="mt-0.5 text-[13px] font-semibold text-emerald-700">
                        {request.proposedValue}
                      </div>
                    </div>
                  )}
                  {request.reason && <Field label="Begründung" value={request.reason} />}
                </div>
              )}

              {/* Owner note (resolved/rejected → prominenter Banner) */}
              {request.ownerNote && (
                <div
                  data-testid="correction-owner-note-banner"
                  className={`rounded-[18px] px-4 py-3.5 ring-1 ${
                    request.status === 'rejected'
                      ? 'bg-red-50 ring-red-100'
                      : 'bg-blue-50 ring-blue-100'
                  }`}
                >
                  <div
                    className={`text-[10px] font-semibold uppercase tracking-[0.14em] mb-1 ${
                      request.status === 'rejected' ? 'text-red-500' : 'text-blue-400'
                    }`}
                  >
                    {request.status === 'rejected' ? 'Begründung der Ablehnung' : 'Antwort'}
                  </div>
                  <p
                    className={`text-[13px] ${
                      request.status === 'rejected' ? 'text-red-700' : 'text-blue-700'
                    }`}
                  >
                    {request.ownerNote}
                  </p>
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </AppShell>
  )
}
