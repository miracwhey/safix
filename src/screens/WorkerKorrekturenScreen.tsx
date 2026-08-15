import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import AppShell from '../components/AppShell'
import { useWorkerCorrections } from '../hooks/useCorrections'
import {
  deriveCorrectionApplySummary,
  initializeCorrectionRepository,
  type CorrectionApplySummary,
} from '../lib/corrections'
import type { CorrectionRequest, CorrectionKind, CorrectionStatus } from '../lib/corrections'
import { useSmartBack } from '../hooks/useSmartBack'

const HYDRATION_TIMEOUT_MS = 15_000

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

// Block 7.2.7d — Apply-Indikator nach dem Status-Pill in der Liste.
const APPLY_INDICATOR_CONFIG: Record<
  CorrectionApplySummary['kind'],
  { label: string; dot: string; text: string; testState: string }
> = {
  applied: {
    label: 'Übernommen',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700',
    testState: 'applied',
  },
  manual_needed: {
    label: 'Manuell prüfen',
    dot: 'bg-amber-500',
    text: 'text-amber-700',
    testState: 'manual',
  },
  error: {
    label: 'Apply fehlgeschlagen',
    dot: 'bg-red-500',
    text: 'text-red-700',
    testState: 'error',
  },
}

function ApplyIndicator({ summary }: { summary: CorrectionApplySummary }) {
  const c = APPLY_INDICATOR_CONFIG[summary.kind]
  return (
    <span
      data-testid="correction-list-apply-indicator"
      data-state={c.testState}
      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${c.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  )
}

function CorrectionRow({
  request,
  onPress,
}: {
  request: CorrectionRequest
  onPress: () => void
}) {
  const dateLabel = request.requestedDate
    ? new Date(request.requestedDate + 'T12:00:00').toLocaleDateString('de-DE', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : new Date(request.createdAt).toLocaleDateString('de-DE', {
        day: 'numeric',
        month: 'short',
      })

  const applySummary = deriveCorrectionApplySummary(request)

  return (
    <button
      type="button"
      onClick={onPress}
      className="flex w-full items-start gap-3.5 py-3.5 text-left active:bg-slate-50/60 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-slate-800">
            {KIND_LABELS[request.kind]}
          </span>
          <StatusPill status={request.status} />
          {applySummary && <ApplyIndicator summary={applySummary} />}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">{dateLabel}</div>
        {request.description.length > 0 && (
          <div className="mt-1 text-[12px] text-slate-500 line-clamp-2">
            {request.description}
          </div>
        )}
      </div>
    </button>
  )
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function WorkerKorrekturenScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/worker/konto')
  const { requests, isHydrated } = useWorkerCorrections()

  const [hydrationTimedOut, setHydrationTimedOut] = useState(false)
  const [hydrationRetryEpoch, setHydrationRetryEpoch] = useState(0)

  useEffect(() => {
    if (isHydrated) return
    const t = setTimeout(() => setHydrationTimedOut(true), HYDRATION_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [isHydrated, hydrationRetryEpoch])

  const openCount = requests.filter((r) => r.status === 'open').length

  return (
    <AppShell active="worker-konto" noSafeTop>
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
                Konto
              </p>
              <h1 className="text-[20px] font-bold tracking-tight text-slate-900 leading-tight">
                Korrekturen
              </h1>
            </div>
            <button
              type="button"
              onClick={() => navigate('/worker/korrekturen/neu')}
              className="flex items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-2 active:bg-slate-700 transition-colors"
            >
              <Plus size={14} strokeWidth={2.5} className="text-white" />
              <span className="text-[12px] font-semibold text-white">Melden</span>
            </button>
          </div>

          {/* Summary pill */}
          {openCount > 0 && (
            <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 ring-1 ring-amber-200/60">
              <span className="text-[11px] font-semibold text-amber-600">
                {openCount} offen
              </span>
            </div>
          )}

          {/* List */}
          <div className="rounded-[24px] bg-white ring-1 ring-slate-200/70 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.18)]">
            {!isHydrated ? (
              hydrationTimedOut ? (
                <div className="px-5 py-5">
                  <div className="text-[13px] font-semibold text-slate-700">
                    Laden fehlgeschlagen
                  </div>
                  <div className="mt-0.5 text-[12px] text-slate-400">
                    Verbindung prüfen und erneut versuchen.
                  </div>
                  <button
                    type="button"
                    onClick={() => { setHydrationTimedOut(false); setHydrationRetryEpoch((n) => n + 1); void initializeCorrectionRepository(true) }}
                    className="mt-3 rounded-full bg-slate-900 px-4 py-2 text-[12px] font-semibold text-white active:bg-slate-700"
                  >
                    Erneut versuchen
                  </button>
                </div>
              ) : (
                <div className="animate-pulse px-5 py-6">
                  <div className="h-3 w-32 rounded-full bg-slate-100" />
                  <div className="mt-3 h-3 w-24 rounded-full bg-slate-100" />
                </div>
              )
            ) : requests.length === 0 ? (
              <div className="px-5 py-6">
                <p className="text-[13px] text-slate-400">Keine Korrekturen eingereicht.</p>
                <p className="mt-1 text-[11px] text-slate-300">
                  Tippe auf „Melden" um eine Korrektur zu erstellen.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 px-5">
                {requests.map((r) => (
                  <CorrectionRow
                    key={r.id}
                    request={r}
                    onPress={() => navigate(`/worker/korrekturen/${r.id}`)}
                  />
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </AppShell>
  )
}
