import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import { useCorrections } from '../hooks/useCorrections'
import { useSmartBack } from '../hooks/useSmartBack'
import type { CorrectionKind, CorrectionStatus } from '../lib/corrections'
import { getTeamMembers } from '../lib/jobs'

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

// ── Components ────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: CorrectionStatus }) {
  const c = STATUS_CONFIG[status]
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${c.bg} ${c.text}`}
    >
      {c.label}
    </span>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CraftsmanKorrekturenScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/backoffice')
  const { requests, isHydrated } = useCorrections()
  const teamMembers = getTeamMembers()

  // Show open/in_review first, then resolved/rejected
  const sorted = [...requests].sort((a, b) => {
    const priority: Record<CorrectionStatus, number> = {
      open: 0,
      in_review: 1,
      resolved: 2,
      rejected: 3,
    }
    const diff = priority[a.status] - priority[b.status]
    return diff !== 0 ? diff : b.createdAt - a.createdAt
  })

  const openCount = requests.filter(
    (r) => r.status === 'open' || r.status === 'in_review',
  ).length

  return (
    <AppShell active="verwaltung" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-12">
        <div className="mx-auto w-full max-w-[420px]">

          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <button
              type="button"
              onClick={goBack}
              className="h-9 w-9 shrink-0 rounded-full bg-slate-100 flex items-center justify-center active:bg-slate-200 transition-colors"
              aria-label="Zurück"
            >
              <ArrowLeft size={16} strokeWidth={2} className="text-slate-600" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Team
              </p>
              <h1 className="text-[20px] font-bold tracking-tight text-slate-900 leading-tight">
                Korrekturen
              </h1>
            </div>
          </div>

          {/* Summary */}
          {openCount > 0 && (
            <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 ring-1 ring-amber-200/60">
              <span className="text-[11px] font-semibold text-amber-600">
                {openCount} {openCount === 1 ? 'offen' : 'offen / in Prüfung'}
              </span>
            </div>
          )}

          {/* List */}
          <div className="rounded-[24px] bg-white ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.18)]">
            {!isHydrated ? (
              <div className="px-5 py-6 text-[13px] text-slate-400">Wird geladen…</div>
            ) : sorted.length === 0 ? (
              <div className="px-5 py-6">
                <p className="text-[13px] text-slate-400">Keine Korrekturen vorhanden.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {sorted.map((r) => {
                  const dateLabel = r.requestedDate
                    ? new Date(r.requestedDate + 'T12:00:00').toLocaleDateString('de-DE', {
                        day: 'numeric',
                        month: 'short',
                      })
                    : new Date(r.createdAt).toLocaleDateString('de-DE', {
                        day: 'numeric',
                        month: 'short',
                      })

                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => navigate(`/craftsman/korrekturen/${r.id}`)}
                      className="flex w-full items-start gap-3 px-5 py-3.5 text-left active:bg-slate-50/60 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[12px] font-semibold text-slate-500 tabular-nums">
                            {dateLabel}
                          </span>
                          <span className="text-[13px] font-medium text-slate-800">
                            {KIND_LABELS[r.kind]}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-400 truncate">
                          {teamMembers.find((m) => m.id === r.workerTeamMemberId)?.name ?? r.workerTeamMemberId}
                        </div>
                        {r.description && (
                          <p className="mt-1 text-[12px] text-slate-500 line-clamp-1">
                            {r.description}
                          </p>
                        )}
                      </div>
                      <StatusPill status={r.status} />
                    </button>
                  )
                })}
              </div>
            )}
          </div>

        </div>
      </div>
    </AppShell>
  )
}
